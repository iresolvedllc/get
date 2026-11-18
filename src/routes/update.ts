import type { Context } from 'hono'

import type { AppEnv } from '../env'
import { withEdgeCache } from '../lib/http'
import { presignArtifacts, resolveHead, resolveTarget, type ResolvedRelease } from '../lib/releases'
import { isAcceptableVersion, needsUpdate } from '../lib/versions'
import { productFor } from '../products'
import { isChannel, isPlatform, type ProductDefinition } from '../products/types'

type UpdateContext = Context<AppEnv>

/** Manifests change rarely and presigned URLs live for PRESIGN_TTL_SECONDS. */
const CACHE_SECONDS = 60
const STALE_SECONDS = 300

/**
 * `GET /:product/:apiVersion/update` - the endpoint a client calls to find
 * out whether it needs to update, and where to get the new build from.
 */
export async function handleUpdate(c: UpdateContext): Promise<Response> {
  const product = productFor(c.req.param('product') ?? '')
  if (!product) return c.json({ error: 'unknown product' }, 404)

  const apiVersion = c.req.param('apiVersion') ?? ''
  if (!product.apiVersions.includes(apiVersion)) {
    return c.json(
      { error: `unsupported api version: ${apiVersion}`, supported: product.apiVersions },
      404,
    )
  }

  const params = new URL(c.req.url).searchParams
  const channel = params.get('channel') ?? product.defaultChannel
  if (!isChannel(product, channel)) {
    return c.json(
      { error: `channel must be one of: ${Object.keys(product.channels).join(', ')}` },
      400,
    )
  }

  const platform = params.get('platform') ?? product.defaultPlatform
  if (!isPlatform(product, platform)) {
    return c.json(
      { error: `unsupported platform: ${platform}`, supported: Object.keys(product.platforms) },
      400,
    )
  }

  const current = params.get('version')
  if (current !== null && !isAcceptableVersion(product, current)) {
    return c.json({ error: `invalid version: ${current}` }, 400)
  }

  const target = params.get('target')
  if (target !== null && !isAcceptableVersion(product, target)) {
    return c.json({ error: `invalid target: ${target}` }, 400)
  }

  const format = params.get('format') ?? 'json'
  if (!['json', 'text', 'plain'].includes(format)) {
    return c.json({ error: 'format must be json, text or plain' }, 400)
  }

  return withEdgeCache(c, CACHE_SECONDS, STALE_SECONDS, async () => {
    const dbStart = performance.now()
    const release = target
      ? await resolveTarget(c.env, product, channel, target, platform)
      : await resolveHead(c.env, product, channel, platform)
    const dbMs = Math.round(performance.now() - dbStart)

    if (!release) {
      return c.json({ error: `no release available for channel: ${channel}` }, 404, {
        'Cache-Control': 'no-store',
      })
    }

    // The decision uses the channel the release was *resolved from*, the same
    // channel the Rust client compares under: a nightly or beta caller served the
    // stable release follows the stable rule, not the unordered-track one.
    const update =
      current === null ? true : needsUpdate(product, release.channel, current, release.version)
    if (format === 'plain') {
      return c.text(`${release.version}\n`, 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      })
    }

    const presignStart = performance.now()
    const includeDebug = params.get('debug') === '1'
    const artifacts = await presignArtifacts(c.env, release, includeDebug)
    const presignMs = Math.round(performance.now() - presignStart)
    const primary = primaryArtifact(product, release, artifacts)
    const timing = `db;dur=${dbMs}, presign;dur=${presignMs}`

    if (format === 'text') {
      return c.text(renderText(product, update, current, release, artifacts), 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Server-Timing': timing,
      })
    }

    return c.json(
      {
        product: product.slug,
        update,
        current: current ?? null,
        latest: release.version,
        channel: release.channel,
        platform,
        url: primary?.url ?? null,
        sha256: primary?.sha256 ?? null,
        size: primary?.size ?? null,
        notes: release.notes,
        published_at: release.publishedAt,
        artifacts: artifacts.map((artifact) => ({
          platform: artifact.platform,
          kind: artifact.kind,
          url: artifact.url,
          sha256: artifact.sha256,
          size: artifact.size,
        })),
        metadata: release.metadata,
      },
      200,
      { 'Cache-Control': 'no-store', 'Server-Timing': timing },
    )
  })
}

type Presigned = Awaited<ReturnType<typeof presignArtifacts>>[number]

function primaryArtifact(
  product: ProductDefinition,
  release: ResolvedRelease,
  artifacts: Presigned[],
): Presigned | undefined {
  return artifacts.find((artifact) => artifact.kind === product.primaryKind) ?? artifacts[0]
}

function renderText(
  product: ProductDefinition,
  update: boolean,
  current: string | null,
  release: ResolvedRelease,
  artifacts: Presigned[],
): string {
  const lines: string[] = [
    `product=${product.slug}`,
    `update=${update}`,
    `current=${current ?? ''}`,
    `latest=${release.version}`,
    `channel=${release.channel}`,
    `notes=${oneLine(release.notes)}`,
    `published_at=${release.publishedAt}`,
  ]

  for (const artifact of artifacts) {
    lines.push(
      `artifact=${oneLine(artifact.kind)}`,
      `url=${oneLine(artifact.url)}`,
      `sha256=${oneLine(artifact.sha256)}`,
      `size=${artifact.size}`,
    )
  }

  return `${lines.join('\n')}\n`
}

function oneLine(value: string | null): string {
  if (!value) return ''
  return value.replace(/[\r\n]+/g, ' ').trim()
}
