import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

import type { AppEnv, Env } from './env'
import { methodNotAllowed } from './lib/http'
import { UpstreamTimeoutError, sql, withTimeout } from './lib/neon'
import { rateLimitMiddleware } from './lib/ratelimit'
import { fingerprint } from './lib/util'
import { handleHealth, handleDeepHealth, handleIndex } from './routes/index'
import { handleDownload } from './routes/download'
import { handlePowerShellInstall, handleShellInstall } from './routes/install'
import { handlePublish } from './routes/publish'
import { handleUpdate } from './routes/update'

const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID())
  await next()
})

// Security headers on every response, including errors.
app.use('*', secureHeaders())

app.use('*', async (c, next) => {
  const started = performance.now()
  await next()
  const response = c.res
  const ip = c.get('rateLimitIp') ?? c.req.header('cf-connecting-ip') ?? ''
  // IPs are fingerprinted in logs: enough to correlate a burst, not an address.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: 'request',
      rid: c.get('requestId'),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: response.status,
      ms: Math.round(performance.now() - started),
      ip: ip ? fingerprint(ip) : 'none',
      rl: c.get('rateLimitResult') ?? 'none',
    }),
  )
})

app.use('*', rateLimitMiddleware())

app.get('/', handleIndex)
app.get('/healthz', handleHealth)
app.get('/healthz/deep', handleDeepHealth)

app.get('/:product/install.ps1', handlePowerShellInstall)
app.get('/:product/install', handleShellInstall)

app.get('/:product/:apiVersion/update', handleUpdate)
app.get('/:product/:apiVersion/download', handleDownload)
app.post('/:product/:apiVersion/publish', handlePublish)

// Wrong method on a known shape answers 405 with Allow; everything else 404.
app.all('*', methodNotAllowed)

app.notFound((c) => c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' }))

app.onError((error, c) => {
  if (error instanceof UpstreamTimeoutError) {
    console.error('upstream timeout', error.operation)
    return c.json({ error: 'upstream timed out' }, 503, { 'Cache-Control': 'no-store' })
  }
  console.error('unhandled error', error)
  return c.json({ error: 'internal server error' }, 500, { 'Cache-Control': 'no-store' })
})

/** Nightly pruning of the publish idempotency table. */
const RETAIN_MESSAGES_DAYS = 90

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) => {
    try {
      await withTimeout(
        'database prune',
        sql(env)`DELETE FROM publish_messages
         WHERE received_at < now() - (${RETAIN_MESSAGES_DAYS} * interval '1 day')`,
      )
    } catch (error) {
      console.error('prune failed', error instanceof Error ? error.message : 'error')
    }
  },
}
