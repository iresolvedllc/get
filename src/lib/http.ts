import type { Context } from 'hono'

const DEFAULT_CANONICAL_ORIGIN = 'https://get.iresolved.link'

/**
 * Loopback keeps the request origin so `wrangler dev` installs from itself.
 * Every other host is pinned: a workers.dev URL or a spoofed Host must not
 * become the API the script trusts.
 */
export function installerOrigin(requestUrl: string, configured: string | undefined): string {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return pinnedOrigin(configured)
  }
  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return url.origin
  return pinnedOrigin(configured)
}

function pinnedOrigin(configured: string | undefined): string {
  const trimmed = configured?.trim().replace(/\/$/, '')
  return trimmed || DEFAULT_CANONICAL_ORIGIN
}

/**
 * Serve GET responses through the Cloudflare edge cache.
 *
 * Release manifests change rarely and presigned URLs stay valid for
 * `PRESIGN_TTL_SECONDS` (>= 60s clamped), so a short `s-maxage` keeps most
 * client requests from running the origin at all. The cache key is the full
 * request URL, so distinct channel/platform/format queries stay separate.
 */
export async function withEdgeCache(
  c: Context,
  maxAgeSeconds: number,
  staleSeconds: number,
  produce: () => Promise<Response> | Response,
  cacheStatuses: readonly number[] = [200],
): Promise<Response> {
  const request = c.req.raw
  if (request.method !== 'GET') return produce()

  try {
    const hit = await caches.default.match(request)
    if (hit) {
      // Cached responses have immutable headers; the middleware below (security
      // headers, rate-limit counters) mutates the response, so rewrap it first.
      return new Response(hit.body, hit)
    }
  } catch {
    // No cache available (some runtimes); serve from the origin.
    return produce()
  }

  const response = await produce()
  if (cacheStatuses.includes(response.status)) {
    const cached = response.clone()
    cached.headers.set(
      'Cache-Control',
      `public, max-age=0, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleSeconds}`,
    )
    c.executionCtx.waitUntil(caches.default.put(request, cached))
  }
  return response
}

/**
 * Known path shapes and the only method each accepts. Used to answer wrong
 * methods with 405 instead of 404.
 */
const METHOD_SHAPES: { pattern: RegExp; allow: string }[] = [
  { pattern: /^\/[^/]+\/install(\.ps1)?$/, allow: 'GET' },
  { pattern: /^\/[^/]+\/v\d+\/(update|download)$/, allow: 'GET' },
  { pattern: /^\/[^/]+\/v\d+\/publish$/, allow: 'POST' },
]

export function methodNotAllowed(c: Context): Response {
  const path = new URL(c.req.url).pathname
  for (const shape of METHOD_SHAPES) {
    if (shape.pattern.test(path)) {
      return c.json(
        { error: `method not allowed: ${c.req.method}` },
        405,
        { Allow: shape.allow, 'Cache-Control': 'no-store' },
      )
    }
  }
  return c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' })
}
