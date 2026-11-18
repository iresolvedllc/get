import type { Context } from 'hono'

import type { AppEnv } from '../env'
import { PublishError, publishRelease, type PublishPayload } from '../lib/releases'
import { receiver } from '../lib/qstash'
import { isAcceptableVersion } from '../lib/versions'
import { productFor } from '../products'
import { isArtifactKind, isChannel, isPlatform, type ProductDefinition } from '../products/types'

const MAX_NOTES_LENGTH = 4096
const MAX_METADATA_BYTES = 8192
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024
const MAX_BODY_BYTES = 1024 * 1024
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9_-]{8,200}$/

type PublishContext = Context<AppEnv>

/**
 * `POST /:product/:apiVersion/publish` - the endpoint QStash delivers to.
 *
 * The bucket and object key are never taken from the message as free
 * pointers: the product config derives the key, and the object must already
 * exist at the declared size before the channel head moves.
 *
 * QStash retries every non-2XX response, so permanent rejections are answered
 * with 489 + `Upstash-NonRetryable-Error: true`, which sends the message to
 * the dead-letter queue immediately. Only 5xx responses (storage or database
 * trouble) are retriable.
 */
export async function handlePublish(c: PublishContext): Promise<Response> {
  const product = productFor(c.req.param('product') ?? '')
  if (!product) return c.json({ error: 'unknown product' }, 404)

  const apiVersion = c.req.param('apiVersion') ?? ''
  if (!product.apiVersions.includes(apiVersion)) {
    return nonRetryable(
      c,
      `unsupported api version: ${apiVersion}`,
      { supported: product.apiVersions },
    )
  }

  const declaredLength = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return nonRetryable(c, 'body is too large')
  }

  const raw = await c.req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return nonRetryable(c, 'body is too large')
  }

  const signature = c.req.header('upstash-signature')
  if (!signature) {
    return c.json({ error: 'missing upstash-signature header' }, 401)
  }
  try {
    await receiver(c.env).verify({ signature, body: raw })
  } catch {
    return c.json({ error: 'invalid qstash signature' }, 401)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return nonRetryable(c, 'body is not valid JSON')
  }

  const messageId = c.req.header('upstash-message-id')
  if (!messageId || !MESSAGE_ID_PATTERN.test(messageId)) {
    return nonRetryable(c, 'invalid upstash-message-id header')
  }

  const parsed = parsePayload(body, product)
  if (!parsed.ok) return nonRetryable(c, parsed.error)

  try {
    const result = await publishRelease(c.env, product, { ...parsed.value, messageId })
    if (result.duplicate) {
      return c.json({
        ok: true,
        duplicate: true,
        product: product.slug,
        channel: result.channel,
        version: result.version,
      })
    }
    return c.json({
      ok: true,
      product: product.slug,
      channel: result.channel,
      version: result.version,
      releaseId: result.releaseId,
    })
  } catch (error) {
    if (error instanceof PublishError) {
      if (error.status === 503) {
        return c.json({ error: error.message }, 503)
      }
      return nonRetryable(c, error.message)
    }
    console.error('publish failed', error instanceof Error ? error.message : 'error')
    return c.json({ error: 'failed to publish release' }, 500)
  }
}

/** 489 + the non-retryable header: QStash moves the message straight to the DLQ. */
function nonRetryable(
  c: PublishContext,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status: 489,
    headers: {
      'Content-Type': 'application/json',
      'Upstash-NonRetryable-Error': 'true',
      'Cache-Control': 'no-store',
    },
  })
}

type ParseResult = { ok: true; value: Omit<PublishPayload, 'messageId'> } | { ok: false; error: string }

function parsePayload(body: unknown, product: ProductDefinition): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const record = body as Record<string, unknown>

  const channel = record.channel
  if (typeof channel !== 'string' || !isChannel(product, channel)) {
    return { ok: false, error: `channel must be one of: ${Object.keys(product.channels).join(', ')}` }
  }

  const version = record.version
  if (typeof version !== 'string' || !isAcceptableVersion(product, version)) {
    return { ok: false, error: 'version must be valid for this product' }
  }

  let notes: string | null
  if (record.notes === undefined || record.notes === null) {
    notes = null
  } else if (typeof record.notes !== 'string') {
    return { ok: false, error: 'notes must be a string' }
  } else if (record.notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, error: `notes must be at most ${MAX_NOTES_LENGTH} characters` }
  } else {
    notes = record.notes
  }

  let metadata: Record<string, unknown> = {}
  if (record.metadata !== undefined && record.metadata !== null) {
    if (
      typeof record.metadata !== 'object' ||
      Array.isArray(record.metadata)
    ) {
      return { ok: false, error: 'metadata must be a JSON object' }
    }
    const serialized = JSON.stringify(record.metadata)
    if (serialized.length > MAX_METADATA_BYTES) {
      return { ok: false, error: `metadata must be at most ${MAX_METADATA_BYTES} bytes` }
    }
    metadata = record.metadata as Record<string, unknown>
  }

  if (record.rollback !== undefined && typeof record.rollback !== 'boolean') {
    return { ok: false, error: 'rollback must be a boolean' }
  }
  const rollback = record.rollback === true

  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    return { ok: false, error: 'artifacts must be a non-empty array' }
  }

  const artifacts: PublishPayload['artifacts'] = []
  const seen = new Set<string>()
  const platforms = new Set<string>()

  for (const entry of record.artifacts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'each artifact must be a JSON object' }
    }
    const artifact = entry as Record<string, unknown>

    const platform = artifact.platform
    if (typeof platform !== 'string' || !isPlatform(product, platform)) {
      return {
        ok: false,
        error: `artifact platform must be one of: ${Object.keys(product.platforms).join(', ')}`,
      }
    }

    const kind = artifact.kind
    if (typeof kind !== 'string' || !isArtifactKind(product, kind)) {
      return {
        ok: false,
        error: `artifact kind must be one of: ${product.artifactKinds.join(', ')}`,
      }
    }

    const identity = `${platform}/${kind}`
    if (seen.has(identity)) {
      return { ok: false, error: `duplicate artifact: ${identity}` }
    }
    seen.add(identity)
    platforms.add(platform)

    const expectedKey = product.artifactKey({ channel, version, platform, kind })
    if (artifact.object_key !== expectedKey) {
      return { ok: false, error: `artifact ${kind} object_key must be ${expectedKey}` }
    }

    const sha256 = artifact.sha256
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      return { ok: false, error: `artifact ${kind} sha256 must be 64 hex characters` }
    }

    const size = parseSize(artifact.size)
    if (size === null) {
      return { ok: false, error: `artifact ${kind} size must be a byte count` }
    }

    const contentType = parseContentType(artifact.content_type)
    if (contentType === undefined) {
      return { ok: false, error: `artifact ${kind} content_type is invalid` }
    }

    artifacts.push({
      platform,
      kind,
      objectKey: expectedKey,
      sha256: sha256.toLowerCase(),
      size,
      contentType,
    })
  }

  for (const platform of platforms) {
    for (const required of product.requiredKinds) {
      if (!seen.has(`${platform}/${required}`)) {
        return {
          ok: false,
          error: `artifact ${required} is required for platform ${platform}`,
        }
      }
    }
  }

  return { ok: true, value: { channel, version, notes, metadata, artifacts, rollback } }
}

function parseSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  if (value < 1 || value > MAX_ARTIFACT_BYTES) return null
  return value
}

/** `undefined` means present but invalid. `null` means absent. */
function parseContentType(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 128 || /[^\t\x20-\x7e]/.test(value)) return undefined
  return value
}
