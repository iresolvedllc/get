import { Hono } from 'hono'

import type { Env } from './env'
import { handleHealth, handleIndex } from './routes/index'
import { handleDownload } from './routes/download'
import { handlePowerShellInstall, handleShellInstall } from './routes/install'
import { handlePublish } from './routes/publish'
import { handleUpdate } from './routes/update'

const app = new Hono<{ Bindings: Env }>()

app.get('/', handleIndex)
app.get('/healthz', handleHealth)

app.get('/:product/install.ps1', handlePowerShellInstall)
app.get('/:product/install', handleShellInstall)

app.get('/:product/:apiVersion/update', handleUpdate)
app.get('/:product/:apiVersion/download', handleDownload)
app.post('/:product/:apiVersion/publish', handlePublish)

app.notFound((c) => c.json({ error: 'not found' }, 404, { 'Cache-Control': 'no-store' }))

app.onError((error, c) => {
  console.error('unhandled error', error)
  return c.json({ error: 'internal server error' }, 500, { 'Cache-Control': 'no-store' })
})

export default app
