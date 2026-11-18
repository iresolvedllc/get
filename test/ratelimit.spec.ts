import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import type { AppEnv } from '../src/env'
import { SLIDING_LIMITS, rateLimitMiddleware, type LimiterSet } from '../src/lib/ratelimit'

const FUTURE_RESET = Date.now() + 10_000
const OK = { success: true, limit: SLIDING_LIMITS.public, remaining: 29, reset: FUTURE_RESET }
const DENY = { success: false, limit: SLIDING_LIMITS.public, remaining: 0, reset: FUTURE_RESET }

function fakeLimiters(success: boolean): LimiterSet {
  const limiter = {
    limit: async () => (success ? { ...OK } : { ...DENY }),
  }
  return { public: limiter, install: limiter, publish: limiter }
}

const failingLimiters: LimiterSet = {
  public: { limit: async () => { throw new Error('redis down') } },
  install: { limit: async () => { throw new Error('redis down') } },
  publish: { limit: async () => { throw new Error('redis down') } },
}

const redisEnv: Partial<AppEnv['Bindings']> = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
  UPSTASH_REDIS_REST_TOKEN: 'token',
}

function appWith(deps: Parameters<typeof rateLimitMiddleware>[number]) {
  const app = new Hono<AppEnv>()
  app.use('*', rateLimitMiddleware(deps))
  app.get('/:product/:apiVersion/update', (c) => c.json({ ok: true }))
  app.get('/:product/install', (c) => c.text('#!/bin/sh\n'))
  app.post('/:product/:apiVersion/publish', (c) => c.json({ ok: true }))
  return app
}

describe('rate limit middleware', () => {
  it('passes through when the Redis bindings are absent', async () => {
    const app = appWith({})
    const response = await app.request('https://x/build/v1/update')
    expect(response.status).toBe(200)
  })

  it('passes through when the limiter set is explicitly disabled', async () => {
    const app = appWith({ limiters: null })
    const response = await app.request('https://x/build/v1/update', {}, redisEnv)
    expect(response.status).toBe(200)
  })

  it('answers 429 with rate limit headers when the window is exhausted', async () => {
    const app = appWith({ limiters: fakeLimiters(false) })
    const response = await app.request('https://x/build/v1/update', {}, redisEnv)
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(await response.json()).toEqual({ error: 'rate limit exceeded' })
  })

  it('answers 503 when the limiter is unreachable (fail closed)', async () => {
    const app = appWith({ limiters: failingLimiters })
    const response = await app.request('https://x/build/v1/update', {}, redisEnv)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'rate limiter unavailable' })
  })

  it('renders a text body for install routes', async () => {
    const app = appWith({ limiters: fakeLimiters(false) })
    const response = await app.request('https://x/build/install', {}, redisEnv)
    expect(response.status).toBe(429)
    expect(await response.text()).toBe('rate limit exceeded\n')
  })

  it('exposes the remaining quota on allowed requests', async () => {
    const app = appWith({ limiters: fakeLimiters(true) })
    const response = await app.request('https://x/build/v1/update', {}, redisEnv)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-ratelimit-remaining')).toBe('29')
  })

  it('applies the publish window to publish requests', async () => {
    let called = ''
    const publish = {
      limit: async (identifier: string) => {
        called = `publish:${identifier}`
        return OK
      },
    }
    const app = appWith({
      limiters: { public: fakeLimiters(true).public, install: publish, publish },
    })
    const response = await app.request('https://x/build/v1/publish', { method: 'POST' }, redisEnv)
    expect(response.status).toBe(200)
    expect(called.startsWith('publish:')).toBe(true)
  })

  it('keys the limiter on the cf-connecting-ip header', async () => {
    let key = ''
    const limiter = {
      limit: async (identifier: string) => {
        key = identifier
        return OK
      },
    }
    const app = appWith({ limiters: { public: limiter, install: limiter, publish: limiter } })
    const response = await app.request('https://x/build/v1/update', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }, redisEnv)
    expect(response.status).toBe(200)
    expect(key).toBe('203.0.113.7')
  })

  it('denies with the native Cloudflare binding before the sliding windows', async () => {
    const native = {
      limit: async () => ({ success: false }),
    }
    const app = appWith({ limiters: fakeLimiters(true) })
    const response = await app.request(
      'https://x/build/v1/update',
      {},
      { ...redisEnv, IP_RATE_LIMIT: native },
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('x-ratelimit-limit')).toBe('60')
  })

  it('ignores native binding failures and keeps the sliding windows', async () => {
    const native = {
      limit: async () => { throw new Error('binding hiccup') },
    }
    const app = appWith({ limiters: fakeLimiters(true) })
    const response = await app.request(
      'https://x/build/v1/update',
      {},
      { ...redisEnv, IP_RATE_LIMIT: native },
    )
    expect(response.status).toBe(200)
  })
})
