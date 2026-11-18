/**
 * Upload the checkout's `tools/build-tool` binary to the release bucket and
 * record it as the current `build-tool/stable` release.
 *
 * Usage:
 *   bun --env-file=.env.get run scripts/seed-build-tool.ts
 *   bun --env-file=.env.get run scripts/seed-build-tool.ts <version>
 *
 * The binary stays in the working tree. It is no longer tracked by git; this
 * script is how a local build gets into the release store.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Env } from '../src/env'
import { putObject } from '../src/lib/s3'
import { publishRelease } from '../src/lib/releases'
import { buildToolProduct } from '../src/products/build-tool'
const __ORIGINAL_URL = new URL(import.meta.url);

const here = dirname(fileURLToPath(__ORIGINAL_URL.href))
const binaryPath = process.env.BUILD_TOOL_BINARY ?? join(here, '..', 'tools', 'build-tool')
const platform = 'linux-x86_64'
const channel = 'stable'

const env: Env = {
  DATABASE_URL: required('GET_DATABASE_URL'),
  AWS_ACCESS_KEY_ID: required('GET_AWS_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: required('GET_AWS_SECRET_ACCESS_KEY'),
  AWS_REGION: required('GET_AWS_REGION'),
  AWS_ENDPOINT_URL_S3: required('GET_AWS_ENDPOINT_URL_S3'),
  S3_BUCKET: required('GET_S3_BUCKET'),
  QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY ?? '',
  QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY ?? '',
}

const body = await readFile(binaryPath)
const sha256 = createHash('sha256').update(body).digest('hex')
const commit = process.env.GITHUB_SHA || execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const binaryVersion = execFileSync(binaryPath, ['--version'], {
  encoding: 'utf8',
}).trim().replace(/^build-tool\s+/, '')
const version = process.argv[2] || commit.slice(0, 12)

const metadata = {
  commit,
  binary_version: binaryVersion,
  source: 'tools/build-tool',
}
const binaryKey = buildToolProduct.artifactKey({ channel, version, platform, kind: 'binary' })
const checksumKey = buildToolProduct.artifactKey({ channel, version, platform, kind: 'checksums' })
const checksumBody = `${sha256}  ${buildToolProduct.filenameFor({ version, platform, kind: 'binary' })}\n`

await putObject(env, {
  bucket: env.S3_BUCKET,
  key: binaryKey,
  region: env.AWS_REGION,
  body,
  contentType: 'application/octet-stream',
  metadata: { sha256, commit, version, binary_version: binaryVersion },
})

await putObject(env, {
  bucket: env.S3_BUCKET,
  key: checksumKey,
  region: env.AWS_REGION,
  body: checksumBody,
  contentType: 'text/plain; charset=utf-8',
  metadata: { sha256: createHash('sha256').update(checksumBody).digest('hex') },
})

const result = await publishRelease(env, buildToolProduct, {
  channel,
  version,
  notes: `Seeded from tools/build-tool at ${commit}`,
  metadata,
  rollback: false,
  messageId: null,
  artifacts: [
    {
      platform,
      kind: 'binary',
      objectKey: binaryKey,
      sha256,
      size: body.length,
      contentType: 'application/octet-stream',
    },
    {
      platform,
      kind: 'checksums',
      objectKey: checksumKey,
      sha256: createHash('sha256').update(checksumBody).digest('hex'),
      size: Buffer.byteLength(checksumBody),
      contentType: 'text/plain; charset=utf-8',
    },
  ],
})

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      commit,
      binaryVersion,
      sha256,
      size: body.length,
      bucket: env.S3_BUCKET,
      binaryKey,
      checksumKey,
      releaseId: result.releaseId,
    },
    null,
    2,
  ),
)

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`error: ${name} is not set`)
    process.exit(1)
  }
  return value
}
