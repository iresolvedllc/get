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
