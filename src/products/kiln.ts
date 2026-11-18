import { renderKilnInstaller, renderKilnPowerShellInstaller } from '../installers/kiln'
import { isSemverVersion } from '../lib/versions'
import type { ArtifactKeyInput, FilenameInput, ProductDefinition } from './types'

const SLUG = 'kiln'
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/

function filenameFor(input: FilenameInput): string {
  switch (input.kind) {
    case 'zip':
      return `kiln-${input.platform}.zip`
    case 'checksums':
      return 'SHA256SUMS'
    default:
      throw new Error(`unknown artifact kind: ${input.kind}`)
  }
}

function artifactKey(input: ArtifactKeyInput): string {
  return `${SLUG}/${input.channel}/${input.version}/${input.platform}/${input.kind}/${filenameFor(input)}`
}

export const kilnProduct: ProductDefinition = {
  slug: SLUG,
  displayName: 'Kiln',
  apiVersions: ['v1'],
  defaultChannel: 'stable',
  channels: {
    stable: {},
    beta: {},
    rc: {},
    lts: {},
    alpha: {},
    canary: {},
  },
  defaultPlatform: 'x86_64-unknown-linux-gnu',
  platforms: {
    'x86_64-unknown-linux-gnu': { label: 'Linux x86_64 (glibc)' },
    'aarch64-unknown-linux-gnu': { label: 'Linux arm64 (glibc)' },
    'x86_64-apple-darwin': { label: 'macOS x86_64' },
    'aarch64-apple-darwin': { label: 'macOS arm64' },
    'x86_64-pc-windows-msvc': { label: 'Windows x86_64' },
    'aarch64-pc-windows-msvc': { label: 'Windows arm64' },
  },
  artifactKinds: ['zip', 'checksums'],
  requiredKinds: ['zip'],
  primaryKind: 'zip',
  versionScheme: 'semver',
  updatePolicy: 'semver',
  unorderedChannels: ['canary'],
  installers: {
    sh: renderKilnInstaller,
    ps1: renderKilnPowerShellInstaller,
  },
  artifactKey,
  filenameFor,
  isValidVersion: (value) => isSemverVersion(value) || COMMIT_PATTERN.test(value),
}
