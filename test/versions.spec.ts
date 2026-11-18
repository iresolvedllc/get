import { describe, expect, it } from 'vitest'

import { isSemverVersion, needsUpdate } from '../src/lib/versions'
import { buildProduct } from '../src/products/build'
import { buildToolProduct } from '../src/products/build-tool'
import { kilnProduct } from '../src/products/kiln'

describe('isSemverVersion', () => {
  it('accepts releases and prereleases', () => {
    expect(isSemverVersion('1.0.38')).toBe(true)
    expect(isSemverVersion('1.0.0-rc.1')).toBe(true)
    expect(isSemverVersion('0.0.1-nightly.abc123')).toBe(true)
  })

  it('rejects malformed versions', () => {
    for (const value of ['1.0', 'v1.0.38', '1.0.38.1', 'nightly-abc', '']) {
      expect(isSemverVersion(value)).toBe(false)
    }
  })
})

describe('needsUpdate', () => {
  it('uses semver for Build stable and beta', () => {
    expect(needsUpdate(buildProduct, 'stable', '1.0.37', '1.0.38')).toBe(true)
    expect(needsUpdate(buildProduct, 'stable', '1.0.38', '1.0.38')).toBe(false)
    expect(needsUpdate(buildProduct, 'stable', '2.0.0', '1.0.38')).toBe(false)
    expect(needsUpdate(buildProduct, 'beta', '1.0.37', '1.0.38')).toBe(true)
  })

  it('uses equality for Build nightly', () => {
    expect(needsUpdate(buildProduct, 'nightly', '1.0.38', '1.1.0-nightly.abc')).toBe(true)
    expect(needsUpdate(buildProduct, 'nightly', '1.1.0-nightly.abc', '1.1.0-nightly.abc')).toBe(false)
  })

  it('accepts the nightly prerelease the release pipeline publishes (base with its own prerelease)', () => {
    const version = '0.0.0-rc.1-nightly.e8dff7365b69'
    expect(isSemverVersion(version)).toBe(true)
    // equality across the nightly track, in both directions
    expect(needsUpdate(buildProduct, 'nightly', '0.0.0-rc.1-nightly.e8dff7365b69', version)).toBe(false)
    expect(needsUpdate(buildProduct, 'nightly', '0.0.0-rc.1-nightly.dead00000000', version)).toBe(true)
  })

  it('compares a stable fallback release by semver, not by the unordered nightly rule', () => {
    // The nightly track is empty, so the release was resolved from stable:
    // a caller ahead of the stable head must not be told to move backwards.
    expect(needsUpdate(buildProduct, 'stable', '1.0.40', '1.0.38')).toBe(false)
    expect(needsUpdate(buildProduct, 'stable', '1.0.30', '1.0.38')).toBe(true)
  })

  it('uses equality for the opaque build-tool version', () => {
    expect(needsUpdate(buildToolProduct, 'stable', 'abc1234', 'def5678')).toBe(true)
    expect(needsUpdate(buildToolProduct, 'stable', 'abc1234', 'abc1234')).toBe(false)
  })

  it('uses equality for Kiln canary', () => {
    expect(needsUpdate(kilnProduct, 'canary', '1.0.0', '1.1.0-canary.1')).toBe(true)
    expect(needsUpdate(kilnProduct, 'canary', '1.1.0-canary.1', '1.1.0-canary.1')).toBe(false)
  })
})
