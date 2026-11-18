import { neon } from '@neondatabase/serverless'

import type { Env } from '../env'

export type Sql = ReturnType<typeof neon>

const clients = new Map<string, Sql>()

export class UpstreamTimeoutError extends Error {
  readonly operation: string

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`)
    this.name = 'UpstreamTimeoutError'
    this.operation = operation
  }
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Give up on an upstream call instead of pinning the isolate on a hung
 * socket. The underlying request is abandoned, not cancelled; the caller
 * turns the rejection into a 503.
 */
export function withTimeout<T>(operation: string, promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamTimeoutError(operation, timeoutMs)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}


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
