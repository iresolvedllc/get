import { gt } from 'semver'

import type { ProductDefinition } from '../products/types'

/**
 * The version grammar shared by the Build installer, the managed download
 * filename and the release API: `X.Y.Z` with an optional prerelease tag.
 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function isSemverVersion(value: string): boolean {
  return SEMVER_PATTERN.test(value)
}

/**
 * Whether `candidate` is a newer release than `current`.
 *
 * Falls back to "not newer" when either side is not parseable semver: an
 * unparseable version must never be the reason a client is told to update.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate === current) return false
  try {
    return gt(candidate, current)
  } catch {
    return false
  }
}

/**
 * The update decision for a product and channel.
 *
 * An unordered channel uses equality. A nightly or canary build is a
 * prerelease, so semver would sort it below the stable release and tell the
 * caller to install the wrong track.
 */
export function needsUpdate(
  product: ProductDefinition,
  channel: string,
  current: string,
  latest: string,
): boolean {
  if (product.updatePolicy === 'equality' || product.unorderedChannels.includes(channel)) {
    return latest !== current
  }
  return isNewer(latest, current)
}
