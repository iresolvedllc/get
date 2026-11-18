import { renderBuildToolInstaller } from '../installers/build-tool'
import { isSemverVersion } from '../lib/versions'
import type { ArtifactKeyInput, FilenameInput, ProductDefinition } from './types'

const SLUG = 'build-tool'
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/

function filenameFor(input: FilenameInput): string {
  switch (input.kind) {
    case 'binary':
      return `build-tool-${input.version}-${input.platform}`
    case 'checksums':
      return 'SHA256SUMS'
    default:
      throw new Error(`unknown artifact kind: ${input.kind}`)
  }
}

function artifactKey(input: ArtifactKeyInput): string {
  return `${SLUG}/${input.channel}/${input.version}/${input.platform}/${input.kind}/${filenameFor(input)}`
}

export const buildToolProduct: ProductDefinition = {
  slug: SLUG,
  displayName: 'build-tool',
  apiVersions: ['v1'],
  defaultChannel: 'stable',
  channels: {
    stable: {},
  },
  defaultPlatform: 'linux-x86_64',
  platforms: {
    'linux-x86_64': { label: 'Linux x86_64' },
  },
  artifactKinds: ['binary', 'checksums'],
  requiredKinds: ['binary'],
  primaryKind: 'binary',
  versionScheme: 'opaque',
  updatePolicy: 'equality',
  unorderedChannels: ['stable'],
  installers: {
    sh: renderBuildToolInstaller,
  },
  artifactKey,
  filenameFor,
  isValidVersion: (value) => COMMIT_PATTERN.test(value) || isSemverVersion(value),
}
