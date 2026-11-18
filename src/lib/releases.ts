import type { Env } from '../env'
import type { ProductDefinition } from '../products/types'
import {
  type ArtifactRow,
  type HeadRow,
  type ReleaseRow,
  parseArtifacts,
  parseMetadata,
  sql,
  toNumber,
} from './neon'
import { objectInfo, presignGet } from './s3'
import { isNewer } from './versions'

export interface ReleaseArtifact {
  platform: string
  kind: string
  objectKey: string
  sha256: string
  size: number
  contentType: string | null
}

export interface ResolvedRelease {
  product: string
  /** The channel the release was actually resolved from. */
  channel: string
  version: string
  notes: string | null
  metadata: Record<string, unknown>
  publishedAt: string
  artifacts: ReleaseArtifact[]
}

export interface PresignedArtifact extends ReleaseArtifact {
  url: string
}

export interface PublishArtifact {
  platform: string
  kind: string
  objectKey: string
  sha256: string
  size: number
  contentType: string | null
}

export interface PublishPayload {
  channel: string
  version: string
  notes: string | null
  metadata: Record<string, unknown>
  artifacts: PublishArtifact[]
  rollback: boolean
  messageId: string | null
}

export class PublishError extends Error {
  readonly status: 400 | 409 | 503

  constructor(status: 400 | 409 | 503, message: string) {
    super(message)
    this.name = 'PublishError'
    this.status = status
  }
}

export async function resolveHead(
  env: Env,
  product: ProductDefinition,
  channel: string,
  platform: string,
): Promise<ResolvedRelease | null> {
  const rows = (await sql(env)`
    WITH RECURSIVE chain AS (
      SELECT c.name, c.fallback, 0 AS depth
        FROM channels c
       WHERE c.product = ${product.slug}
         AND c.name = ${channel}
      UNION ALL
      SELECT c.name, c.fallback, ch.depth + 1
        FROM channels c
        JOIN chain ch ON c.product = ${product.slug} AND c.name = ch.fallback
    )
    SELECT ch.name AS resolved_channel,
           r.id::text AS release_id, r.channel, r.version, r.notes, r.metadata,
           to_char(r.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
           (SELECT json_agg(json_build_object(
              'platform', a.platform, 'kind', a.kind, 'object_key', a.object_key,
              'sha256', a.sha256, 'size_bytes', a.size_bytes, 'content_type', a.content_type
            ) ORDER BY a.kind)
              FROM artifacts a
             WHERE a.release_id = r.id
               AND a.platform = ${platform}) AS artifacts
      FROM chain ch
      JOIN channel_heads h ON h.product = ${product.slug} AND h.channel = ch.name
      JOIN releases r ON r.id = h.release_id
     ORDER BY ch.depth
     LIMIT 1
  `) as unknown as HeadRow[]

  const row = rows[0]
  if (!row) return null
  const release = toResolvedRelease(row, product.slug)
  return release.artifacts.length > 0 ? release : null
}

export async function resolveTarget(
  env: Env,
  product: ProductDefinition,
  channel: string,
  version: string,
  platform: string,
): Promise<ResolvedRelease | null> {
  const rows = (await sql(env)`
    SELECT r.id::text AS release_id, r.channel, r.version, r.notes, r.metadata,
           to_char(r.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
           (SELECT json_agg(json_build_object(
              'platform', a.platform, 'kind', a.kind, 'object_key', a.object_key,
              'sha256', a.sha256, 'size_bytes', a.size_bytes, 'content_type', a.content_type
            ) ORDER BY a.kind)
              FROM artifacts a
             WHERE a.release_id = r.id
               AND a.platform = ${platform}) AS artifacts
      FROM releases r
     WHERE r.product = ${product.slug}
       AND r.channel = ${channel}
       AND r.version = ${version}
     LIMIT 1
  `) as unknown as ReleaseRow[]

  const row = rows[0]
  if (!row) return null
  const release = toResolvedRelease(row, product.slug)
  return release.artifacts.length > 0 ? release : null
}

export async function presignArtifacts(
  env: Env,
  release: ResolvedRelease,
  includeDebug: boolean,
): Promise<PresignedArtifact[]> {
  const visible = release.artifacts.filter((artifact) => includeDebug || artifact.kind !== 'debug')
  return Promise.all(
    visible.map(async (artifact) => ({
      ...artifact,
      url: await presignGet(env, {
        bucket: env.S3_BUCKET,
        key: artifact.objectKey,
        region: env.AWS_REGION,
      }),
    })),
  )
}

/**
 * Record a published release and move the product's channel head.
 *
 * The head move, artifact replacement, and QStash message id commit in one
 * statement. A retry of a delivery that already committed does not apply the
 * body again.
 */
export async function publishRelease(
  env: Env,
  product: ProductDefinition,
  payload: PublishPayload,
): Promise<{ channel: string; version: string; releaseId: string; duplicate?: boolean }> {
  const current = await currentHeadVersion(env, product.slug, payload.channel)
  const ordered = !product.unorderedChannels.includes(payload.channel)
  if (ordered && !payload.rollback && current !== null && isNewer(current, payload.version)) {
    throw new PublishError(
      409,
      `refusing to replace ${current} with older version ${payload.version}`,
    )
  }

  await assertArtifactsPresent(env, product, payload)

  const artifacts = JSON.stringify(
    payload.artifacts.map((artifact) => ({
      platform: artifact.platform,
      kind: artifact.kind,
      object_key: artifact.objectKey,
      sha256: artifact.sha256,
      size_bytes: artifact.size,
      content_type: artifact.contentType,
    })),
  )
  const metadata = JSON.stringify(payload.metadata)
  const unordered = ordered ? 'no' : 'yes'
  const rollback = payload.rollback ? 'yes' : 'no'

  const rows = (await sql(env)`
    WITH already AS (
      SELECT message_id FROM publish_messages WHERE message_id = ${payload.messageId}
    ),
    channel_ok AS (
      SELECT name FROM channels WHERE product = ${product.slug} AND name = ${payload.channel}
    ),
    guard AS (
      SELECT 1
       WHERE ${rollback} = 'yes'
          OR ${unordered} = 'yes'
          OR ${current}::text IS NULL
          OR EXISTS (
            SELECT 1
              FROM channel_heads h
              JOIN releases r ON r.id = h.release_id
             WHERE h.product = ${product.slug}
               AND h.channel = ${payload.channel}
               AND r.version = ${current}
          )
    ),
    proceed AS (
      SELECT 1
       WHERE NOT EXISTS (SELECT 1 FROM already)
         AND EXISTS (SELECT 1 FROM channel_ok)
         AND EXISTS (SELECT 1 FROM guard)
    ),
    release_row AS (
      INSERT INTO releases (product, channel, version, notes, metadata)
      SELECT ${product.slug}, ${payload.channel}, ${payload.version}, ${payload.notes}, ${metadata}::jsonb
       WHERE EXISTS (SELECT 1 FROM proceed)
      ON CONFLICT (product, channel, version) DO UPDATE
         SET notes = EXCLUDED.notes,
             metadata = EXCLUDED.metadata
      RETURNING id
    ),
    purged AS (
      DELETE FROM artifacts
       WHERE release_id = (SELECT id FROM release_row)
      RETURNING id
    ),
    inserted AS (
      INSERT INTO artifacts (release_id, platform, kind, object_key, sha256, size_bytes, content_type)
      SELECT (SELECT id FROM release_row), t.platform, t.kind, t.object_key, t.sha256, t.size_bytes, t.content_type
        FROM jsonb_to_recordset(${artifacts}::jsonb)
             AS t(platform text, kind text, object_key text, sha256 text, size_bytes bigint, content_type text)
       WHERE EXISTS (SELECT 1 FROM release_row)
      RETURNING id
    ),
    moved AS (
      INSERT INTO channel_heads (product, channel, release_id)
      SELECT ${product.slug}, ${payload.channel}, id FROM release_row
      ON CONFLICT (product, channel) DO UPDATE
         SET release_id = EXCLUDED.release_id, updated_at = now()
      RETURNING release_id
    ),
    recorded AS (
      INSERT INTO publish_messages (message_id, product, channel, version)
      SELECT ${payload.messageId}, ${product.slug}, ${payload.channel}, ${payload.version}
       WHERE ${payload.messageId}::text IS NOT NULL
         AND EXISTS (SELECT 1 FROM release_row)
      ON CONFLICT (message_id) DO NOTHING
      RETURNING message_id
    )
    SELECT EXISTS (SELECT 1 FROM already) AS duplicate,
           EXISTS (SELECT 1 FROM channel_ok) AS channel_found,
           EXISTS (SELECT 1 FROM guard) AS guard_ok,
           (SELECT id::text FROM release_row) AS release_id,
           (SELECT count(*) FROM purged) AS purged_count,
           (SELECT count(*) FROM inserted) AS inserted_count,
           (SELECT count(*) FROM moved) AS moved_count,
           (SELECT count(*) FROM recorded) AS recorded_count
  `) as unknown as PublishWriteRow[]

  const row = rows[0]
  if (!row) throw new PublishError(503, 'could not record the release')
  if (asBool(row.duplicate)) {
    return { channel: payload.channel, version: payload.version, releaseId: '', duplicate: true }
  }
  if (!asBool(row.channel_found)) {
    throw new PublishError(400, `unknown channel: ${payload.channel}`)
  }
  if (!asBool(row.guard_ok) || !row.release_id) {
    throw new PublishError(409, `refusing to replace the current ${payload.channel} release with ${payload.version}`)
  }

  return { channel: payload.channel, version: payload.version, releaseId: row.release_id }
}

interface PublishWriteRow {
  duplicate: unknown
  channel_found: unknown
  guard_ok: unknown
  release_id: string | null
}

async function currentHeadVersion(env: Env, product: string, channel: string): Promise<string | null> {
  const rows = (await sql(env)`
    SELECT r.version
      FROM channel_heads h
      JOIN releases r ON r.id = h.release_id
     WHERE h.product = ${product}
       AND h.channel = ${channel}
  `) as unknown as { version: string }[]
  return rows[0]?.version ?? null
}

async function assertArtifactsPresent(
  env: Env,
  product: ProductDefinition,
  payload: PublishPayload,
): Promise<void> {
  await Promise.all(
    payload.artifacts.map(async (artifact) => {
      const expected = product.artifactKey({
        channel: payload.channel,
        version: payload.version,
        platform: artifact.platform,
        kind: artifact.kind,
      })
      if (artifact.objectKey !== expected) {
        throw new PublishError(400, `artifact ${artifact.kind} object_key must be ${expected}`)
      }

      let info
      try {
        info = await objectInfo(env, {
          bucket: env.S3_BUCKET,
          key: artifact.objectKey,
          region: env.AWS_REGION,
        })
      } catch (error) {
        console.error('artifact check failed', artifact.kind, error instanceof Error ? error.name : 'error')
        throw new PublishError(503, `could not verify artifact ${artifact.kind}`)
      }

      if (info.size === null) {
        throw new PublishError(400, `artifact ${artifact.kind} is not in the bucket`)
      }
      if (info.size !== artifact.size) {
        throw new PublishError(400, `artifact ${artifact.kind} size does not match the object`)
      }
      if (info.sha256 && info.sha256 !== artifact.sha256) {
        throw new PublishError(400, `artifact ${artifact.kind} sha256 does not match the object metadata`)
      }
    }),
  )
}

function toResolvedRelease(row: ReleaseRow, product: string): ResolvedRelease {
  return {
    product,
    channel: 'resolved_channel' in row ? String((row as HeadRow).resolved_channel) : row.channel,
    version: row.version,
    notes: row.notes,
    metadata: parseMetadata(row.metadata),
    publishedAt: row.published_at,
    artifacts: parseArtifacts(row.artifacts).map((artifact: ArtifactRow) => ({
      platform: artifact.platform,
      kind: artifact.kind,
      objectKey: artifact.object_key,
      sha256: artifact.sha256,
      size: toNumber(artifact.size_bytes) ?? 0,
      contentType: artifact.content_type,
    })),
  }
}

function asBool(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1
}
