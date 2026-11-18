export interface ChannelDefinition {
  /** Channel consulted when this one has no release of its own. */
  fallback?: string
}

export interface PlatformDefinition {
  /** Human-readable platform name used in error messages and the index. */
  label: string
}

export interface ArtifactKeyInput {
  channel: string
  version: string
  platform: string
  kind: string
}

export interface FilenameInput {
  version: string
  platform: string
  kind: string
}

export interface InstallContext {
  /** Canonical API origin, for example https://get.iresolved.link. */
  origin: string
  /** Channel the installer uses when the caller does not pick one. */
  channel: string
  /** Optional pinned version. */
  version: string | null
}

export interface ProductDefinition {
  slug: string
  displayName: string
  apiVersions: readonly string[]
  defaultChannel: string
  channels: Readonly<Record<string, ChannelDefinition>>
  defaultPlatform: string
  platforms: Readonly<Record<string, PlatformDefinition>>
  artifactKinds: readonly string[]
  requiredKinds: readonly string[]
  primaryKind: string
  versionScheme: 'semver' | 'opaque'
  updatePolicy: 'semver' | 'equality'
  /** Channels whose versions are not ordered by semver. */
  unorderedChannels: readonly string[]
  installers: {
    sh?: (context: InstallContext) => string
    ps1?: (context: InstallContext) => string
  }
  /** The only object key a publish may name for this artifact. */
  artifactKey(input: ArtifactKeyInput): string
  /** The filename inside the object key. */
  filenameFor(input: FilenameInput): string
  /** Whether the product accepts this release version at all. */
  isValidVersion(value: string): boolean
}

export function isChannel(product: ProductDefinition, value: string): boolean {
  return Object.hasOwn(product.channels, value)
}

export function isPlatform(product: ProductDefinition, value: string): boolean {
  return Object.hasOwn(product.platforms, value)
}

export function isArtifactKind(product: ProductDefinition, value: string): boolean {
  return product.artifactKinds.includes(value)
}

export function objectKey(product: ProductDefinition, input: ArtifactKeyInput): string {
  return `${product.slug}/${input.channel}/${input.version}/${input.platform}/${input.kind}/${product.filenameFor(input)}`
}
