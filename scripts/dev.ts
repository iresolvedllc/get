/**
 * Starts `wrangler dev` with the repository-root `.env`.
 *
 * Wrangler reads bindings from `.dev.vars`, which `scripts/dev-vars.ts`
 * generates from `.env`. See that script for the variable mapping.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __ORIGINAL_URL = new URL(import.meta.url);

import { writeDevVars } from './dev-vars'

const here = dirname(fileURLToPath(__ORIGINAL_URL.href))
const serviceDir = join(here, '..')

await writeDevVars()

const child = spawn('bunx', ['wrangler', 'dev'], {
  cwd: serviceDir,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
