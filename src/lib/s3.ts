import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { Env } from '../env'

const clients = new Map<string, S3Client>()

/**
 * The S3 client for Neon Object Storage.
 *
 * The gateway speaks path-style addressing only, so `forcePathStyle` is
 * required. The cache key includes the access key and a fingerprint of the
 * secret, so a warm isolate does not keep signing with a rotated credential.
 */
export function s3Client(env: Env, region: string): S3Client {
  const endpoint = env.AWS_ENDPOINT_URL_S3
  const key = `${region}|${endpoint}|${env.AWS_ACCESS_KEY_ID}|${fingerprint(env.AWS_SECRET_ACCESS_KEY)}`
  let client = clients.get(key)
  if (!client) {
    client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
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

export async function presignGet(
  env: Env,
  params: { bucket: string; key: string; region: string },
): Promise<string> {
  return getSignedUrl(
    s3Client(env, params.region),
    new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
    { expiresIn: presignTtl(env) },
  )
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
    const response = await s3Client(env, params.region).send(
      new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }),
    )
    return {
      size: response.ContentLength ?? null,
      sha256: response.Metadata?.sha256?.toLowerCase() ?? null,
    }
  } catch {
    return { size: null, sha256: null }
  }
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
