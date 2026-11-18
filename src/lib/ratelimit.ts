import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

import type { Context, Next } from 'hono'
import type { AppEnv, Env } from '../env'
import { fingerprint } from './util'

/**
 * Two independent layers of rate limiting:
 *
 * 1. `IP_RATE_LIMIT`, a Cloudflare rate-limit binding configured in
 *    wrangler.jsonc: a coarse fixed-window per-IP cap enforced at the edge.
 *    It runs with no external dependency, so it keeps protecting the service
 *    when Upstash Redis is unreachable.
 * 2. Sliding windows in Upstash Redis, keyed by client IP and route class.
 *    When Redis is unreachable these routes fail *closed* (503): the service
 *    would rather appear unavailable than run without abuse protection.
 *    When the Redis bindings are absent — `wrangler dev` without `.dev.vars`,
 *    unit tests — this layer is disabled entirely.
 */

export const NATIVE_LIMIT_PER_MINUTE = 60

/** Sliding-window limits per minute, keyed by client IP. */
export const SLIDING_LIMITS = {
  public: 30,
  install: 20,
  publish: 30,
} as const

export type RouteClass = keyof typeof SLIDING_LIMITS

export interface LimiterOutcome {
  success: boolean
  limit: number
  remaining: number
  /** Epoch milliseconds at which the window resets. */
  reset: number
}

/** Duck type of the Upstash limiter, so tests can substitute a fake. */
export interface Limiter {
  limit(identifier: string): Promise<{
    success: boolean
    limit: number
    remaining: number
    reset: number
  }>
}

const redisClients = new Map<string, Redis>()

function redisFor(env: Env): Redis {
  const url = env.UPSTASH_REDIS_REST_URL!
  let redis = redisClients.get(url)
  if (!redis) {
    redis = new Redis({ url, token: env.UPSTASH_REDIS_REST_TOKEN! })
    redisClients.set(url, redis)
  }
  return redis
}

function buildLimiter(
  redis: Redis,
  prefix: string,
  limit: number,
): Limiter {
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(limit, '1 m'),
    prefix,
    analytics: false,
  })
}

export interface LimiterSet {
  public: Limiter
  install: Limiter
  publish: Limiter
}

/** Build the three sliding-window limiters for one Redis instance. */
export function buildLimiters(env: Env): LimiterSet {
  const redis = redisFor(env)
  return {
    public: buildLimiter(redis, 'get:public', SLIDING_LIMITS.public),
    install: buildLimiter(redis, 'get:install', SLIDING_LIMITS.install),
    publish: buildLimiter(redis, 'get:publish', SLIDING_LIMITS.publish),
  }
}

const limitersByInstance = new Map<string, LimiterSet>()

function limitersFor(env: Env): LimiterSet | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null
  const cacheKey = `${env.UPSTASH_REDIS_REST_URL}|${fingerprint(env.UPSTASH_REDIS_REST_TOKEN)}`
  let limiters = limitersByInstance.get(cacheKey)
  if (!limiters) {
    limiters = buildLimiters(env)
    limitersByInstance.set(cacheKey, limiters)
  }
  return limiters
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

/** Which sliding window applies to a path, or null when none does. */
export function classifyRoute(path: string): RouteClass | null {
  if (path.endsWith('/publish')) return 'publish'
  if (path.endsWith('/install') || path.endsWith('/install.ps1')) return 'install'
  if (path.endsWith('/update') || path.endsWith('/download')) return 'public'
  return null
}

function limitedResponse(
  c: Context,
  outcome: LimiterOutcome,
): Response {
  const retryAfter = Math.max(1, Math.ceil((outcome.reset - Date.now()) / 1000))
  const headers = new Headers({
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(outcome.limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.ceil(outcome.reset / 1000)),
    'Cache-Control': 'no-store',
  })
  const plain = classifyRoute(c.req.path) === 'install'
  const body = plain
    ? 'rate limit exceeded\n'
    : JSON.stringify({ error: 'rate limit exceeded' })
  headers.set('Content-Type', plain ? 'text/plain; charset=utf-8' : 'application/json')
  return new Response(body, { status: 429, headers })
}

const REDIS_OUTAGE_SECONDS = 5

function redisOutageResponse(c: Context): Response {
  const plain = classifyRoute(c.req.path) === 'install'
  const body = plain
    ? 'rate limiter unavailable\n'
    : JSON.stringify({ error: 'rate limiter unavailable' })
  return new Response(body, {
    status: 503,
    headers: {
      'Content-Type': plain ? 'text/plain; charset=utf-8' : 'application/json',
      'Retry-After': String(REDIS_OUTAGE_SECONDS),
      'Cache-Control': 'no-store',
    },
  })
}

export interface RateLimitDeps {
  /** Overridable for tests. Null disables the sliding-window layer. */
  limiters?: LimiterSet | null
}

/**
 * The rate-limit middleware.
 *
 * - Native Cloudflare binding: applies to every request; failures are logged
 *   and ignored because it is only the coarse backstop.
 * - Upstash sliding windows: applies to update/download/install/publish;
 *   failures fail closed with a 503.
 */
export function rateLimitMiddleware(deps: RateLimitDeps = {}) {
  return async (c: Context<AppEnv>, next: Next): Promise<Response | void> => {
    const env = (c.env ?? {}) as Env
    const ip = clientIp(c)
    c.set('rateLimitIp', ip)

    // Layer 1: Cloudflare edge binding (always-on backstop).
    if (env.IP_RATE_LIMIT) {
      try {
        const outcome = await env.IP_RATE_LIMIT.limit({ key: ip })
        if (!outcome.success) {
          c.set('rateLimitResult', 'native-deny')
          const now = Math.floor(Date.now() / 1000)
          return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '1',
              'X-RateLimit-Limit': String(NATIVE_LIMIT_PER_MINUTE),
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(now + 60),
              'Cache-Control': 'no-store',
            },
          })
        }
      } catch (error) {
        console.error('native rate limit failed', error instanceof Error ? error.message : 'error')
      }
    }

    // Layer 2: Upstash sliding windows (fail-closed).
    const routeClass = classifyRoute(c.req.path)
    const limiters = deps.limiters !== undefined ? deps.limiters : limitersFor(env)
    if (routeClass && limiters) {
      let outcome: LimiterOutcome
      try {
        outcome = (await limiters[routeClass].limit(ip)) as LimiterOutcome
      } catch (error) {
        console.error('rate limiter unreachable', error instanceof Error ? error.message : 'error')
        c.set('rateLimitResult', 'redis-outage')
        return redisOutageResponse(c)
      }
      c.set('rateLimitResult', outcome.success ? routeClass : 'sliding-deny')
      if (!outcome.success) return limitedResponse(c, outcome)
      await next()
      // Counters go on after the handler so a cached response (immutable at
      // rest) is rewrapped by Hono before we touch its headers.
      c.res.headers.set('X-RateLimit-Limit', String(outcome.limit))
      c.res.headers.set('X-RateLimit-Remaining', String(outcome.remaining))
      c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(outcome.reset / 1000)))
      return
    }

    await next()
  }
}
