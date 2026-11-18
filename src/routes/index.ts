import type { Context } from 'hono'

import type { Env } from '../env'
import { allProducts } from '../products'

type IndexContext = Context<{ Bindings: Env }>

export function handleIndex(c: IndexContext): Response {
  return c.json(
    {
      service: 'get',
      description: 'Unified release, update and install API',
      products: allProducts().map((product) => ({
        product: product.slug,
        name: product.displayName,
        apiVersions: product.apiVersions,
        channels: Object.keys(product.channels),
        platforms: Object.keys(product.platforms),
        install: `/${product.slug}/install`,
        update: `/${product.slug}/${product.apiVersions[0]}/update`,
        download: `/${product.slug}/${product.apiVersions[0]}/download`,
      })),
    },
    200,
    { 'Cache-Control': 'no-store' },
  )
}

export function handleHealth(c: IndexContext): Response {
  return c.json({ ok: true }, 200, { 'Cache-Control': 'no-store' })
}
