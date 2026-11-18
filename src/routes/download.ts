import type { Context } from 'hono'

import type { AppEnv } from '../env'
import { withEdgeCache } from '../lib/http'
import { presignArtifacts, resolveHead, resolveTarget } from '../lib/releases'
import { isAcceptableVersion } from '../lib/versions'
import { productFor } from '../products'
import { isChannel, isPlatform } from '../products/types'

type DownloadContext = Context<AppEnv>

/** The redirect target is presigned; keep the edge cache inside its lifetime. */
const CACHE_SECONDS = 60
const STALE_SECONDS = 300

/**
 * `GET /:product/:apiVersion/download` - redirect to the primary artifact.
 *
 * This keeps simple clients (and shell one-liners) from having to parse the
 * manifest just to follow a URL. The redirect target is a short-lived
 * presigned URL, so it must be followed promptly.
 */
export async function handleDownload(c: DownloadContext): Promise<Response> {
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

  const target = params.get('target') ?? params.get('version')
  if (target !== null && !isAcceptableVersion(product, target)) {
    return c.json({ error: `invalid version: ${target}` }, 400)
  }

  return withEdgeCache(
    c,
    CACHE_SECONDS,
    STALE_SECONDS,
    async () => {
      const release = target
        ? await resolveTarget(c.env, product, channel, target, platform)
        : await resolveHead(c.env, product, channel, platform)
      if (!release) {
        return c.json({ error: `no release available for channel: ${channel}` }, 404, {
          'Cache-Control': 'no-store',
        })
      }

      const artifacts = await presignArtifacts(c.env, release, false)
      const primary =
        artifacts.find((artifact) => artifact.kind === product.primaryKind) ?? artifacts[0]
      if (!primary) {
        return c.json({ error: 'release has no downloadable artifacts' }, 404)
      }

      return c.redirect(primary.url, 302)
    },
    [200, 302],
  )
}
