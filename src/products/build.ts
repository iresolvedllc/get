import { renderBuildInstaller } from '../installers/build'
import { isSemverVersion } from '../lib/versions'
import type { ArtifactKeyInput, FilenameInput, ProductDefinition } from './types'

const SLUG = 'build'

function filenameFor(input: FilenameInput): string {
  const base = `build-${input.version}-${input.platform}`
  switch (input.kind) {
    case 'raw':
      return base
    case 'zstd':
      return `${base}.zst`
    case 'gzip':
      return `${base}.gz`
    case 'debug':
      return `${base}.debug`
    case 'checksums':
      return 'SHA256SUMS'
    default:
      throw new Error(`unknown artifact kind: ${input.kind}`)
  }
}

function artifactKey(input: ArtifactKeyInput): string {
  return `${SLUG}/${input.channel}/${input.version}/${input.platform}/${input.kind}/${filenameFor(input)}`
}

export const buildProduct: ProductDefinition = {
  slug: SLUG,
  displayName: 'Build',
  apiVersions: ['v1'],
  defaultChannel: 'stable',
  channels: {
    stable: {},
    beta: { fallback: 'stable' },
    nightly: { fallback: 'stable' },
  },
  defaultPlatform: 'linux-x86_64',
  platforms: {
    'linux-x86_64': { label: 'Linux x86_64' },
  },
  artifactKinds: ['raw', 'zstd', 'gzip', 'debug', 'checksums'],
  requiredKinds: ['raw'],
  primaryKind: 'raw',
  versionScheme: 'semver',
  updatePolicy: 'semver',
  unorderedChannels: ['nightly'],
  installers: {
    sh: renderBuildInstaller,
  },
  artifactKey,
  filenameFor,
  isValidVersion: isSemverVersion,
}
