/**
 * Runtime bindings for the worker.
 *
 * The deploy workflow maps the `GET_*` names in `.env.get` onto these
 * unprefixed binding names. `wrangler dev` reads them from `.dev.vars`,
 * which `scripts/dev.ts` generates from the same file.
 */
export interface Env {
  /** Neon connection string. Source of truth for release metadata. */
  DATABASE_URL: string
  /** S3-compatible credentials for Neon Object Storage. */
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  /** Signing region for the S3-compatible endpoint. */
  AWS_REGION: string
  /** S3-compatible endpoint (Neon Object Storage gateway). */
  AWS_ENDPOINT_URL_S3: string
  /** Bucket that holds every product's artifacts. */
  S3_BUCKET: string
  /** QStash signing keys, used to verify inbound publish events. */
  QSTASH_CURRENT_SIGNING_KEY: string
  QSTASH_NEXT_SIGNING_KEY: string
  /** Lifetime of presigned download URLs, in seconds. Clamped to 60-3600. */
  PRESIGN_TTL_SECONDS?: string
  /** Origin baked into installers for non-loopback requests. */
  CANONICAL_ORIGIN?: string
}
