import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://get.example.com'

describe('GET /', () => {
  it('lists the three products', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      service: string
      products: { product: string; update: string; install: string }[]
    }
    expect(payload.service).toBe('get')
    expect(payload.products.map((product) => product.product)).toEqual([
      'build',
      'build-tool',
      'kiln',
    ])
    expect(payload.products[0]?.update).toBe('/build/v1/update')
    expect(payload.products[0]?.install).toBe('/build/install')
  })

  it('answers health checks', async () => {
    const response = await SELF.fetch(`${ORIGIN}/healthz`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})

describe('install routes', () => {
  it('renders the Build installer with the canonical origin', async () => {
    const response = await SELF.fetch(`${ORIGIN}/build/install`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/x-shellscript')
    const script = await response.text()
    expect(script).toContain('API_BASE="https://get.iresolved.link"')
    expect(script).toContain('/build/v1/update')
    expect(script).not.toContain('__ORIGIN__')
    expect(script).not.toContain('__CHANNEL__')
  })

  it('keeps loopback installs on the request origin', async () => {
    const response = await SELF.fetch('http://127.0.0.1:8787/build/install')
    const script = await response.text()
    expect(script).toContain('API_BASE="http://127.0.0.1:8787"')
    expect(script).toContain('/build/v1/update')
  })

  it('renders the build-tool and Kiln installers', async () => {
    const buildTool = await (await SELF.fetch(`${ORIGIN}/build-tool/install`)).text()
    expect(buildTool).toContain('/build-tool/v1/update')
    expect(buildTool).toContain('BUILD_TOOL_BIN_DIR')

    const kiln = await (await SELF.fetch(`${ORIGIN}/kiln/install`)).text()
    expect(kiln).toContain('/kiln/v1/update')
    expect(kiln).toContain('KILN_INSTALL_ROOT')

    const powershell = await (await SELF.fetch(`${ORIGIN}/kiln/install.ps1`)).text()
    expect(powershell).toContain('/kiln/v1/update')
    expect(powershell).toContain('kiln.exe')
  })

  it('rejects an unknown product and an unsupported installer', async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope/install`)).status).toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/build/install.ps1`)).status).toBe(404)
  })

  it('rejects an unknown channel and a malformed version', async () => {
    expect((await SELF.fetch(`${ORIGIN}/build/install?channel=alpha`)).status).toBe(400)
    expect((await SELF.fetch(`${ORIGIN}/build/install?version=nope`)).status).toBe(400)
  })
})

describe('update route validation', () => {
  it('rejects an unknown product and API version', async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope/v1/update`)).status).toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/build/v2/update`)).status).toBe(404)
  })

  it('rejects unknown channels, platforms, versions and formats', async () => {
    expect((await SELF.fetch(`${ORIGIN}/build/v1/update?channel=alpha`)).status).toBe(400)
    expect(
      (await SELF.fetch(`${ORIGIN}/build/v1/update?channel=stable&platform=darwin-arm64`)).status,
    ).toBe(400)
    expect((await SELF.fetch(`${ORIGIN}/build/v1/update?channel=stable&version=nope`)).status).toBe(
      400,
    )
    expect((await SELF.fetch(`${ORIGIN}/build/v1/update?channel=stable&format=yaml`)).status).toBe(
      400,
    )
  })
})

describe('download route validation', () => {
  it('rejects an unknown product and API version', async () => {
    expect((await SELF.fetch(`${ORIGIN}/nope/v1/download`)).status).toBe(404)
    expect((await SELF.fetch(`${ORIGIN}/build/v2/download`)).status).toBe(404)
  })

  it('rejects unknown channels, platforms and versions', async () => {
    expect((await SELF.fetch(`${ORIGIN}/build/v1/download?channel=alpha`)).status).toBe(400)
    expect(
      (await SELF.fetch(`${ORIGIN}/build/v1/download?channel=stable&platform=darwin-arm64`)).status,
    ).toBe(400)
    expect((await SELF.fetch(`${ORIGIN}/build/v1/download?channel=stable&version=nope`)).status).toBe(
      400,
    )
  })
})

describe('publish route validation', () => {
  it('rejects a request without a QStash signature', async () => {
    const response = await SELF.fetch(`${ORIGIN}/build/v1/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'stable' }),
    })
    expect(response.status).toBe(401)
  })

  it('rejects a malformed signature', async () => {
    const response = await SELF.fetch(`${ORIGIN}/build/v1/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Upstash-Signature': 'not.a.jwt',
        'Upstash-Message-Id': 'msg_12345678',
      },
      body: JSON.stringify({ channel: 'stable' }),
    })
    expect(response.status).toBe(401)
  })

  it('answers a wrong method with 405 and Allow', async () => {
    const post = await SELF.fetch(`${ORIGIN}/build/v1/update`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')

    const get = await SELF.fetch(`${ORIGIN}/build/v1/publish`)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
  })
})

describe('response pipeline', () => {
  it('sets security headers on every response', async () => {
    const response = await SELF.fetch(`${ORIGIN}/`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })

  it('rejects an oversized publish body before reading it', async () => {
    const response = await SELF.fetch(`${ORIGIN}/build/v1/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(2 * 1024 * 1024) },
      body: 'x',
    })
    expect(response.status).toBe(489)
    expect(response.headers.get('upstash-nonretryable-error')).toBe('true')
  })

  it('answers version params over the length cap with 400', async () => {
    const long = '1.0.0-' + 'a'.repeat(64)
    const response = await SELF.fetch(`${ORIGIN}/build/v1/update?version=${long}`)
    expect(response.status).toBe(400)
  })
})
