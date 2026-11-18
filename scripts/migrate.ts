/**
 * Applies the SQL files in `migrations/` to Neon, in filename order.
 *
 * Each file runs once and is recorded in `_migrations`, so re-running the
 * script is a no-op. Files are applied in a transaction, so a file that
 * fails leaves neither the schema change nor the record behind.
 *
 * Usage:
 *   bun run scripts/migrate.ts
 *   bun run scripts/migrate.ts --status
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { neon } from '@neondatabase/serverless'
const __ORIGINAL_URL = new URL(import.meta.url);

const here = dirname(fileURLToPath(__ORIGINAL_URL.href))
const migrationsDir = join(here, '..', 'migrations')

const connectionString = process.env.GET_DATABASE_URL ?? process.env.DATABASE_URL
if (!connectionString) {
  console.error('error: GET_DATABASE_URL is not set')
  process.exit(1)
}

const sql = neon(connectionString)

await sql`
  CREATE TABLE IF NOT EXISTS _migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`

const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()
const applied = new Set(
  (await sql`SELECT name FROM _migrations`).map((row) => (row as { name: string }).name),
)

if (process.argv.includes('--status')) {
  for (const file of files) {
    console.log(`${applied.has(file) ? 'applied' : 'pending'}  ${file}`)
  }
  process.exit(0)
}

for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip    ${file}`)
    continue
  }

  const statements = await readFile(join(migrationsDir, file), 'utf8')
  try {
    const batch = splitStatements(statements).map((statement) => sql.query(statement))
    batch.push(sql`INSERT INTO _migrations (name) VALUES (${file})`)
    await sql.transaction(batch)
  } catch (error) {
    console.error(`error: ${file} failed`)
    console.error(error)
    process.exit(1)
  }
  console.log(`applied ${file}`)
}

console.log('done')

/**
 * Split a SQL file into individual statements.
 *
 * The Neon HTTP driver sends each query as a prepared statement, and a
 * prepared statement may only hold one command, so a file with several
 * `CREATE TABLE` statements has to be split before it is sent.
 */
export function splitStatements(source: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0
  let inLineComment = false
  let inBlockComment = false
  let inSingleQuote = false
  let inDoubleQuote = false
  let dollarTag: string | null = null

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (inLineComment) {
      if (char === '\n') inLineComment = false
      index += 1
      continue
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length
        dollarTag = null
        continue
      }
      current += char
      index += 1
      continue
    }
    if (inSingleQuote) {
      current += char
      if (char === "'") {
        if (next === "'") {
          current += next
          index += 2
          continue
        }
        inSingleQuote = false
      }
      index += 1
      continue
    }
    if (inDoubleQuote) {
      current += char
      if (char === '"') inDoubleQuote = false
      index += 1
      continue
    }

    if (char === '-' && next === '-') {
      inLineComment = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 2
      continue
    }
    if (char === "'") {
      inSingleQuote = true
      current += char
      index += 1
      continue
    }
    if (char === '"') {
      inDoubleQuote = true
      current += char
      index += 1
      continue
    }
    if (char === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index))
      if (tag) {
        dollarTag = tag[0]
        index += tag[0].length
        continue
      }
    }
    if (char === ';') {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      index += 1
      continue
    }

    current += char
    index += 1
  }

  const trimmed = current.trim()
  if (trimmed) statements.push(trimmed)
  return statements
}
