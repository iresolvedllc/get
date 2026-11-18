/**
 * Runtime bindings for the worker.
 *
 * The deploy workflow maps the `GET_*` names in `.env` onto these
 * unprefixed binding names. `wrangler dev` reads them from `.dev.vars`,
 * which `scripts/dev-vars.ts` generates from the same file.
 */
export interface Env {
  /** Neon connection string (pooled endpoint; see `.env`). */
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
  /**
   * Upstash Redis (REST API), backing the sliding-window rate limiters.
   * When absent — dev without `.dev.vars`, unit tests — the fine-grained
   * limiter is disabled and only the coarse Cloudflare binding applies.
   */
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
  /**
   * Cloudflare rate-limit binding: a coarse fixed-window per-IP cap that
   * runs at the edge and keeps working when Upstash Redis is unreachable.
   */
  IP_RATE_LIMIT?: RateLimit
  /** Lifetime of presigned download URLs, in seconds. Clamped to 60-3600. */
  PRESIGN_TTL_SECONDS?: string
  /** Origin baked into installers for non-loopback requests. */
  CANONICAL_ORIGIN?: string
}

/** Hono app environment: bindings plus the request-scoped variables the pipeline sets. */
export type AppEnv = {
  Bindings: Env
  Variables: {
    /** Stable per-request id: the cf-ray, or a UUID when it is absent. */
    requestId: string
    /** The client IP the rate limiter keyed on. */
    rateLimitIp: string
    /** How the rate limiter resolved: the route class, or a deny/outage marker. */
    rateLimitResult?: string
  }
}
