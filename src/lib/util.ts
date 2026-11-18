/** Shared small helpers used by the S3 signer and the request pipeline. */

/** Short non-cryptographic fingerprint, for cache keys and log redaction. */
export function fingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/** Percent-encode each path segment of an object key, keeping the slashes. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** Strip trailing slashes from a configured endpoint or origin. */
export function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
