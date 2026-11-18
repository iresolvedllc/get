/**
 * Upload a staged release directory and publish it through QStash.
 *
 * Usage:
 *   bun --env-file=.env.get run scripts/publish.ts \
 *     <product> <channel> <version> <platform> <directory> [notes]
 *
 * Files in the directory must use the product's public filenames. Optional
 * kinds are skipped when the file is absent; required kinds fail the upload.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Env } from '../src/env'
import { putObject } from '../src/lib/s3'
import { publishRelease, type PublishArtifact } from '../src/lib/releases'
import { productFor } from '../src/products'
import { isChannel, isPlatform } from '../src/products/types'

const [slug, channel, version, platform, directory, ...notesParts] = process.argv.slice(2)
if (!slug || !channel || !version || !platform || !directory) {
  console.error(
    'usage: bun run scripts/publish.ts <product> <channel> <version> <platform> <directory> [notes]',
  )
  process.exit(1)
}

const product = productFor(slug)
if (!product) fail(`error: unknown product: ${slug}`)
if (!isChannel(product, channel)) {
  fail(`error: channel must be one of: ${Object.keys(product.channels).join(', ')}`)
}
if (!isPlatform(product, platform)) {
  fail(`error: platform must be one of: ${Object.keys(product.platforms).join(', ')}`)
}
if (!product.isValidVersion(version)) {
  fail(`error: invalid version for ${slug}: ${version}`)
}

const env: Env = {
  DATABASE_URL: process.env.GET_DATABASE_URL ?? '',
  AWS_ACCESS_KEY_ID: required('GET_AWS_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: required('GET_AWS_SECRET_ACCESS_KEY'),
  AWS_REGION: required('GET_AWS_REGION'),
  AWS_ENDPOINT_URL_S3: required('GET_AWS_ENDPOINT_URL_S3'),
  S3_BUCKET: required('GET_S3_BUCKET'),
  QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY ?? '',
  QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY ?? '',
}

const platformNames = platform.split(',').map((value: string) => value.trim()).filter(Boolean)
if (platformNames.length === 0) fail('error: at least one platform is required')
for (const name of platformNames) {
  if (!isPlatform(product, name)) {
    fail(`error: platform must be one of: ${Object.keys(product.platforms).join(', ')}`)
  }
}

const artifacts: PublishArtifact[] = []
for (const platformName of platformNames) {
  const platformArtifacts: PublishArtifact[] = []

  for (const kind of product.artifactKinds) {
    if (kind === 'checksums') continue
    const filename = product.filenameFor({ version, platform: platformName, kind })
    const body = await readFirst([
      join(directory, platformName, filename),
      join(directory, filename),
    ])
    if (!body) {
      if (product.requiredKinds.includes(kind)) {
        fail(`error: required artifact ${kind} is missing for ${platformName}`)
      }
      continue
    }
    platformArtifacts.push(await uploadArtifact(platformName, kind, body))
  }

  if (product.artifactKinds.includes('checksums')) {
    const filename = product.filenameFor({ version, platform: platformName, kind: 'checksums' })
    const candidates = [join(directory, platformName, filename)]
    if (platformNames.length === 1) candidates.push(join(directory, filename))
    const checksumBody =
      (await readFirst(candidates)) ??
      Buffer.from(
        platformArtifacts
          .map((artifact) => {
            const artifactName = product.filenameFor({
              version,
              platform: platformName,
              kind: artifact.kind,
            })
            return `${artifact.sha256}  ${artifactName}\n`
          })
          .join(''),
      )
    platformArtifacts.push(await uploadArtifact(platformName, 'checksums', checksumBody))
  }

  artifacts.push(...platformArtifacts)
}

async function uploadArtifact(
  platformName: string,
  kind: string,
  body: Buffer,
): Promise<PublishArtifact> {
  const sha256 = createHash('sha256').update(body).digest('hex')
  const objectKey = product!.artifactKey({ channel, version, platform: platformName, kind })
  const contentType = contentTypeFor(kind)
  await putObject(env, {
    bucket: env.S3_BUCKET,
    key: objectKey,
    region: env.AWS_REGION,
    body,
    contentType,
    metadata: {
      sha256,
      ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
    },
  })
  console.log(`uploaded s3://${env.S3_BUCKET}/${objectKey}`)
  return {
    platform: platformName,
    kind,
    objectKey,
    sha256,
    size: body.length,
    contentType,
  }
}

async function readFirst(paths: string[]): Promise<Buffer | null> {
  for (const path of paths) {
    const body = await readOptional(path)
    if (body) return body
  }
  return null
}

const notes = notesParts.join(' ').trim() || null
const qstashUrl = process.env.QSTASH_URL
const qstashToken = process.env.QSTASH_TOKEN

if (qstashUrl && qstashToken) {
  const destination = `https://get.iresolved.link/${product.slug}/v1/publish`
  const response = await fetch(`${qstashUrl.replace(/\/$/, '')}/v2/publish/${destination}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Retries': '5',
    },
    body: JSON.stringify({
      channel,
      version,
      notes,
      artifacts: artifacts.map((artifact) => ({
        platform: artifact.platform,
        kind: artifact.kind,
        object_key: artifact.objectKey,
        sha256: artifact.sha256,
        size: artifact.size,
        content_type: artifact.contentType,
      })),
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    fail(`qstash publish failed: ${response.status} ${text}`)
  }
  console.log(`qstash -> ${text}`)
} else {
  if (!env.DATABASE_URL) {
    fail('error: GET_DATABASE_URL is required without QSTASH_URL/QSTASH_TOKEN')
  }
  const result = await publishRelease(env, product, {
    channel,
    version,
    notes,
    metadata: process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {},
    artifacts,
    rollback: false,
    messageId: null,
  })
  console.log(JSON.stringify({ ok: true, ...result }))
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return await readFile(path)
  } catch {
    return null
  }
}

function contentTypeFor(kind: string): string {
  if (kind === 'checksums') return 'text/plain; charset=utf-8'
  if (kind === 'zstd') return 'application/zstd'
  if (kind === 'gzip') return 'application/gzip'
  if (kind === 'zip') return 'application/zip'
  return 'application/octet-stream'
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) fail(`error: ${name} is not set`)
  return value
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
  throw new Error(message)
}
