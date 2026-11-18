import { describe, expect, it } from 'vitest'

import { buildProduct } from '../src/products/build'
import { buildToolProduct } from '../src/products/build-tool'
import { kilnProduct } from '../src/products/kiln'

describe('artifact keys', () => {
  it('builds the Build layout', () => {
    expect(
      buildProduct.artifactKey({
        channel: 'stable',
        version: '1.0.38',
        platform: 'linux-x86_64',
        kind: 'raw',
      }),
    ).toBe('build/stable/1.0.38/linux-x86_64/raw/build-1.0.38-linux-x86_64')

    expect(
      buildProduct.artifactKey({
        channel: 'stable',
        version: '1.0.38',
        platform: 'linux-x86_64',
        kind: 'checksums',
      }),
    ).toBe('build/stable/1.0.38/linux-x86_64/checksums/SHA256SUMS')
  })

  it('builds the build-tool layout', () => {
    expect(
      buildToolProduct.artifactKey({
        channel: 'stable',
        version: 'abc1234',
        platform: 'linux-x86_64',
        kind: 'binary',
      }),
    ).toBe('build-tool/stable/abc1234/linux-x86_64/binary/build-tool-abc1234-linux-x86_64')
  })

  it('builds the Kiln layout', () => {
    expect(
      kilnProduct.artifactKey({
        channel: 'stable',
        version: '1.0.0',
        platform: 'aarch64-apple-darwin',
        kind: 'zip',
      }),
    ).toBe('kiln/stable/1.0.0/aarch64-apple-darwin/zip/kiln-aarch64-apple-darwin.zip')
  })
})

describe('product validation', () => {
  it('accepts only declared channels and platforms', () => {
    expect(Object.keys(buildProduct.channels)).toEqual(['stable', 'beta', 'nightly'])
    expect(Object.keys(buildToolProduct.channels)).toEqual(['stable'])
    expect(Object.keys(kilnProduct.channels)).toEqual(['stable', 'beta', 'rc', 'lts', 'alpha', 'canary'])
    expect(Object.keys(kilnProduct.platforms)).toHaveLength(6)
  })

  it('validates opaque build-tool versions', () => {
    expect(buildToolProduct.isValidVersion('abc1234')).toBe(true)
    expect(buildToolProduct.isValidVersion('0.0.0-rc.1')).toBe(true)
    expect(buildToolProduct.isValidVersion('not-a-version')).toBe(false)
  })
})
