import type { Context } from 'hono'

import type { Env } from '../env'
import { installerOrigin } from '../lib/http'
import { productFor } from '../products'
import { isChannel, type ProductDefinition } from '../products/types'

type InstallContext = Context<{ Bindings: Env }>

export function handleShellInstall(c: InstallContext): Response {
  return renderInstall(c, false)
}

export function handlePowerShellInstall(c: InstallContext): Response {
  return renderInstall(c, true)
}

function renderInstall(c: InstallContext, powerShell: boolean): Response {
  const product = productFor(c.req.param('product') ?? '')
  if (!product) return c.json({ error: 'unknown product' }, 404)

  const render = powerShell ? product.installers.ps1 : product.installers.sh
  if (!render) {
    return c.json(
      { error: `${product.displayName} does not provide a ${powerShell ? 'PowerShell' : 'shell'} installer` },
      404,
    )
  }

  const params = new URL(c.req.url).searchParams
  const channel = params.get('channel') ?? product.defaultChannel
  if (!isChannel(product, channel)) {
    return c.json(
      { error: `channel must be one of: ${Object.keys(product.channels).join(', ')}` },
      400,
    )
  }

  const version = params.get('target') ?? params.get('version')
  if (version !== null && !product.isValidVersion(version)) {
    return c.json({ error: `invalid version: ${version}` }, 400)
  }

  const script = render({
    origin: installerOrigin(c.req.url, c.env.CANONICAL_ORIGIN),
    channel,
    version,
  })

  return c.text(script, 200, {
    'Content-Type': powerShell ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
}
