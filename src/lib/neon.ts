import { neon } from '@neondatabase/serverless'

import type { Env } from '../env'

export type Sql = ReturnType<typeof neon>

const clients = new Map<string, Sql>()

/**
 * The Neon client.
 *
 * The serverless driver speaks to the Neon proxy over `fetch`, so there is
 * no connection to open or close. One client per connection string is
 * reused across requests in an isolate.
 */
export function sql(env: Env): Sql {
  const url = env.DATABASE_URL
  let client = clients.get(url)
  if (!client) {
    client = neon(url)
    clients.set(url, client)
  }
  return client
}

export interface ArtifactRow {
  platform: string
  kind: string
  object_key: string
  sha256: string
  size_bytes: string | number
  content_type: string | null
}

export interface ReleaseRow {
  release_id: string
  channel: string
  version: string
  notes: string | null
  metadata: unknown
  published_at: string
  artifacts: ArtifactRow[] | null
}

export interface HeadRow extends ReleaseRow {
  resolved_channel: string
}

export function parseArtifacts(value: unknown): ArtifactRow[] {
  if (value === null || value === undefined) return []
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value
  if (!Array.isArray(parsed)) return []
  return parsed as ArtifactRow[]
}

export function parseMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  const parsed = typeof value === 'string' ? safeJsonParse(value) : value
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
