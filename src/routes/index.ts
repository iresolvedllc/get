import type { Context } from 'hono'

import type { AppEnv } from '../env'
import { sql, withTimeout } from '../lib/neon'
import { allProducts } from '../products'

type IndexContext = Context<AppEnv>

export function handleIndex(c: IndexContext): Response {
  return c.json(
    {
      service: 'get',
      description: 'Unified release, update and install API',
      products: allProducts().map((product) => ({
        product: product.slug,
        name: product.displayName,
        apiVersions: product.apiVersions,
        channels: Object.keys(product.channels),
        platforms: Object.keys(product.platforms),
        install: `/${product.slug}/install`,
        update: `/${product.slug}/${product.apiVersions[0]}/update`,
        download: `/${product.slug}/${product.apiVersions[0]}/download`,
      })),
    },
    200,
    { 'Cache-Control': 'public, max-age=0, s-maxage=300' },
  )
}

export function handleHealth(c: IndexContext): Response {
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' })
}

/**
 * `GET /healthz/deep` - liveness plus a database round trip.
 *
 * The result is cached in isolate memory for 10s so external monitors and
 * crawls cannot hammer Neon through this route.
 */
let deepOkAt = 0

export async function handleDeepHealth(c: IndexContext): Promise<Response> {
  const cached = Date.now() - deepOkAt < 10_000
  if (cached) {
    return c.json({ ok: true, database: 'cached-ok' }, 200, { 'Cache-Control': 'no-store' })
  }

  try {
    await withTimeout('database health', sql(c.env)`SELECT 1`, 5_000)
    deepOkAt = Date.now()
    return c.json({ ok: true, database: 'ok' }, 200, { 'Cache-Control': 'no-store' })
  } catch (error) {
    console.error('deep health failed', error instanceof Error ? error.message : 'error')
    return c.json({ ok: false, database: 'unreachable' }, 503, { 'Cache-Control': 'no-store' })
  }
}
