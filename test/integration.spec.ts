import { createHash } from 'node:crypto'

import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { env, SELF } from 'cloudflare:test'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Env } from '../src/env'
import { buildProduct } from '../src/products/build'

const bindings = env as unknown as Env
const ORIGIN = 'https://get.example.com'
const CHANNEL = 'beta'
const VERSION = '0.0.0-test.get'
const PLATFORM = 'linux-x86_64'
const MESSAGE_ID = 'msg_getintegration0001'
const OBJECT_KEY = buildProduct.artifactKey({
  channel: CHANNEL,
  version: VERSION,
  platform: PLATFORM,
  kind: 'raw',
})
const BODY = Buffer.from(
  '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "build test"; exit 0; fi\n',
)
const SHA256 = createHash('sha256').update(BODY).digest('hex')

function haveBindings(): boolean {
  return Boolean(
    bindings.DATABASE_URL &&
      bindings.QSTASH_CURRENT_SIGNING_KEY &&
      bindings.AWS_ACCESS_KEY_ID &&
      bindings.AWS_SECRET_ACCESS_KEY &&
      bindings.AWS_ENDPOINT_URL_S3 &&
      bindings.AWS_REGION &&
      bindings.S3_BUCKET,
  )
}

function s3(): S3Client {
  return new S3Client({
    region: bindings.AWS_REGION,
    endpoint: bindings.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: {
      accessKeyId: bindings.AWS_ACCESS_KEY_ID,
      secretAccessKey: bindings.AWS_SECRET_ACCESS_KEY,
    },
  })
}

async function signMessage(body: string, destination: string): Promise<string> {
  return new SignJWT({
    sub: destination,
    body: createHash('sha256').update(body).digest('base64url'),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('Upstash')
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 10)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(new TextEncoder().encode(bindings.QSTASH_CURRENT_SIGNING_KEY))
}

function manifest(): string {
  return JSON.stringify({
    channel: CHANNEL,
    version: VERSION,
    platform: PLATFORM,
    notes: 'integration test',
    rollback: true,
    artifacts: [
      {
        platform: PLATFORM,
        kind: 'raw',
        object_key: OBJECT_KEY,
        sha256: SHA256,
        size: BODY.length,
        content_type: 'application/octet-stream',
      },
    ],
  })
}

async function publish(): Promise<Response> {
  const body = manifest()
  return SELF.fetch(`${ORIGIN}/build/v1/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Upstash-Signature': await signMessage(body, `${ORIGIN}/build/v1/publish`),
      'Upstash-Message-Id': MESSAGE_ID,
    },
    body,
  })
}

describe('publish and update round trip', () => {
  let previousHead: string | null = null
  let published = false

  beforeAll(async () => {
    if (!haveBindings()) return

    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(bindings.DATABASE_URL)
    const rows = (await sql`
      SELECT release_id::text AS release_id
        FROM channel_heads
       WHERE product = 'build' AND channel = ${CHANNEL}
    `) as unknown as { release_id: string }[]
    previousHead = rows[0]?.release_id ?? null

    await s3().send(
      new PutObjectCommand({
        Bucket: bindings.S3_BUCKET,
        Key: OBJECT_KEY,
        Body: BODY,
        ContentType: 'application/octet-stream',
        Metadata: { sha256: SHA256 },
      }),
    )

    const response = await publish()
    if (response.status !== 200) {
      throw new Error(`publish failed: ${response.status} ${await response.text()}`)
    }
    published = true
  })

  afterAll(async () => {
    if (!haveBindings() || !published) return

    const { neon } = await import('@neondatabase/serverless')
    const sql = neon(bindings.DATABASE_URL)
    await sql`DELETE FROM releases WHERE product = 'build' AND channel = ${CHANNEL} AND version = ${VERSION}`
    if (previousHead) {
      await sql`UPDATE channel_heads SET release_id = ${previousHead} WHERE product = 'build' AND channel = ${CHANNEL}`
    } else {
      await sql`DELETE FROM channel_heads WHERE product = 'build' AND channel = ${CHANNEL}`
    }
    await sql`DELETE FROM publish_messages WHERE message_id = ${MESSAGE_ID}`
    await s3().send(new DeleteObjectCommand({ Bucket: bindings.S3_BUCKET, Key: OBJECT_KEY }))
  })

  it('reports the published release', async () => {
    if (!haveBindings() || !published) return

    const response = await SELF.fetch(
      `${ORIGIN}/build/v1/update?channel=${CHANNEL}&platform=${PLATFORM}`,
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.product).toBe('build')
    expect(payload.update).toBe(true)
    expect(payload.latest).toBe(VERSION)
    expect(payload.channel).toBe(CHANNEL)
    expect(payload.sha256).toBe(SHA256)
    expect(payload.size).toBe(BODY.length)
    expect(String(payload.url)).toContain(OBJECT_KEY)
  })

  it('hands back a URL that serves the bytes', async () => {
    if (!haveBindings() || !published) return

    const response = await SELF.fetch(
      `${ORIGIN}/build/v1/update?channel=${CHANNEL}&platform=${PLATFORM}`,
    )
    const payload = (await response.json()) as { url: string }
    const download = await fetch(payload.url)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer()).equals(BODY)).toBe(true)
  })

  it('reports no update when the caller is current', async () => {
    if (!haveBindings() || !published) return

    const response = await SELF.fetch(
      `${ORIGIN}/build/v1/update?channel=${CHANNEL}&platform=${PLATFORM}&version=${VERSION}`,
    )
    const payload = (await response.json()) as { update: boolean }
    expect(payload.update).toBe(false)
  })

  it('serves a pinned target and the plain format', async () => {
    if (!haveBindings() || !published) return

    const target = await SELF.fetch(
      `${ORIGIN}/build/v1/update?channel=${CHANNEL}&platform=${PLATFORM}&target=${VERSION}`,
    )
    expect(((await target.json()) as { latest: string }).latest).toBe(VERSION)

    const plain = await SELF.fetch(
      `${ORIGIN}/build/v1/update?channel=${CHANNEL}&platform=${PLATFORM}&format=plain`,
    )
    expect((await plain.text()).trim()).toBe(VERSION)
  })

  it('treats a repeated QStash delivery as a duplicate', async () => {
    if (!haveBindings() || !published) return

    const response = await publish()
    expect(response.status).toBe(200)
    expect((await response.json()) as { duplicate?: boolean }).toMatchObject({ duplicate: true })
  })
})
