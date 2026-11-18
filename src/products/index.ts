import { buildProduct } from './build'
import { buildToolProduct } from './build-tool'
import { kilnProduct } from './kiln'
import type { ProductDefinition } from './types'

const REGISTRY = new Map<string, ProductDefinition>(
  [buildProduct, buildToolProduct, kilnProduct].map((product) => [product.slug, product]),
)

export function productFor(slug: string): ProductDefinition | null {
  return REGISTRY.get(slug) ?? null
}

export function allProducts(): ProductDefinition[] {
  return [...REGISTRY.values()]
}

export type { ProductDefinition } from './types'
