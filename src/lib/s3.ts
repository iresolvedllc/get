import { AwsClient } from 'aws4fetch'

import type { Env } from '../env'
import { encodeKey, fingerprint, trimSlash } from './util'
import { withTimeout } from './neon'

const clients = new Map<string, AwsClient>()

/**
 * The S3 client for Neon Object Storage, using aws4fetch.
 *
 * The gateway speaks path-style addressing only. The cache key includes the
 * region and a fingerprint of the secret, so a warm isolate does not keep
 * signing with a rotated credential.
 */
export function s3Client(env: Env, region: string): AwsClient {
  const endpoint = env.AWS_ENDPOINT_URL_S3
  const key = `${region}|${endpoint}|${env.AWS_ACCESS_KEY_ID}|${fingerprint(env.AWS_SECRET_ACCESS_KEY)}`
  let client = clients.get(key)
  if (!client) {
    client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region,
      service: 's3',
    })
    clients.set(key, client)
  }
  return client
}

const MIN_PRESIGN_TTL_SECONDS = 60
const MAX_PRESIGN_TTL_SECONDS = 3600
const DEFAULT_PRESIGN_TTL_SECONDS = 900

export function presignTtl(env: Env): number {
  const parsed = Number(env.PRESIGN_TTL_SECONDS)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PRESIGN_TTL_SECONDS
  return Math.min(MAX_PRESIGN_TTL_SECONDS, Math.max(MIN_PRESIGN_TTL_SECONDS, Math.floor(parsed)))
}

function objectUrl(env: Env, bucket: string, key: string): URL {
  return new URL(`${trimSlash(env.AWS_ENDPOINT_URL_S3)}/${bucket}/${encodeKey(key)}`)
}

/**
 * A presigned GET URL. `X-Amz-Expires` must be part of the query before the
 * request is signed with `signQuery: true`.
 */
export async function presignGet(
  env: Env,
  params: { bucket: string; key: string; region: string },
): Promise<string> {
  const url = objectUrl(env, params.bucket, params.key)
  url.searchParams.set('X-Amz-Expires', String(presignTtl(env)))
  const signed = await s3Client(env, params.region).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  })
  return signed.url
}

export interface ObjectInfo {
  size: number | null
  sha256: string | null
}

/**
 * Read the object's length and, when the uploader recorded it as metadata,
 * its SHA-256. A missing object is reported as `null` size rather than thrown.
 */
export async function objectInfo(
  env: Env,
  params: { bucket: string; key: string; region: string },
): Promise<ObjectInfo> {
  try {
    const signed = await s3Client(env, params.region).sign(
      new Request(objectUrl(env, params.bucket, params.key), { method: 'HEAD' }),
    )
    const response = await withTimeout('storage head', fetch(signed, {
      signal: AbortSignal.timeout(10_000),
    }))
    if (!response.ok) return { size: null, sha256: null }
    const size = response.headers.get('content-length')
    return {
      size: size === null ? null : Number(size),
      sha256: response.headers.get('x-amz-meta-sha256')?.toLowerCase() ?? null,
    }
  } catch {
    return { size: null, sha256: null }
  }
}

export interface PutObjectParams {
  bucket: string
  key: string
  region: string
  body: Uint8Array | string
  contentType?: string
  metadata?: Record<string, string>
}

/** Upload an object. Used by the publish/seed scripts and the integration test. */
export async function putObject(env: Env, params: PutObjectParams): Promise<void> {
  const headers: Record<string, string> = {}
  if (params.contentType) headers['content-type'] = params.contentType
  for (const [name, value] of Object.entries(params.metadata ?? {})) {
    headers[`x-amz-meta-${name}`] = value
  }
  const response = await s3Client(env, params.region).fetch(
    new Request(objectUrl(env, params.bucket, params.key), {
      method: 'PUT',
      headers,
      body: params.body,
    }),
  )
  if (!response.ok) {
    throw new Error(`put object failed: ${response.status} ${await response.text()}`)
  }
}

export async function deleteObject(
  env: Env,
  params: { bucket: string; key: string; region: string },
): Promise<void> {
  const response = await s3Client(env, params.region).fetch(
    new Request(objectUrl(env, params.bucket, params.key), { method: 'DELETE' }),
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(`delete object failed: ${response.status}`)
  }
}
