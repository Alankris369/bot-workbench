import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { appendEvent, createEvent } from './scripts/event-file.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(root, 'data')
const statusFile = path.join(dataDir, 'status.json')
const eventsFile = path.join(dataDir, 'events.jsonl')
const relayFile = path.join(dataDir, 'relay.jsonl')
const configFile = path.join(dataDir, 'config.json')

type NodeReq = {
  url?: string
  method?: string
  on: (name: string, cb: (chunk?: Buffer) => void) => void
}
type NodeRes = {
  statusCode: number
  setHeader: (name: string, value: string) => void
  end: (body?: string | Buffer) => void
}

/** Serve the data files from disk, and accept POST /events while developing. */
function dataPlugin(): Plugin {
  const serve = (req: NodeReq, res: NodeRes, next: () => void) => {
    const rawUrl = req.url ?? ''
    const pathOnly = rawUrl.split('?')[0]
    if (rawUrl.includes('import') || rawUrl.includes('raw')) {
      next()
      return
    }

    if ((req.method ?? 'GET') === 'GET' && pathOnly === '/data/status.json') {
      sendFile(res, statusFile, 'application/json; charset=utf-8')
      return
    }
    if ((req.method ?? 'GET') === 'GET' && pathOnly === '/data/events.jsonl') {
      sendFile(res, eventsFile, 'text/plain; charset=utf-8')
      return
    }
    if ((req.method ?? 'GET') === 'GET' && pathOnly === '/data/relay.jsonl') {
      sendFile(res, relayFile, 'text/plain; charset=utf-8')
      return
    }
    if ((req.method ?? 'GET') === 'GET' && pathOnly === '/data/config.json') {
      sendFile(res, configFile, 'application/json; charset=utf-8')
      return
    }
    if (pathOnly === '/events' && (req.method === 'POST' || req.method === 'OPTIONS')) {
      void handlePost(req, res)
      return
    }
    next()
  }

  return {
    name: 'workbench-data',
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
    closeBundle() {
      const dir = path.join(root, 'dist', 'data')
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(statusFile, path.join(dir, 'status.json'))
      fs.copyFileSync(eventsFile, path.join(dir, 'events.jsonl'))
      fs.copyFileSync(relayFile, path.join(dir, 'relay.jsonl'))
      fs.copyFileSync(configFile, path.join(dir, 'config.json'))
    },
  }
}

function sendFile(res: NodeRes, file: string, type: string): void {
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(fs.readFileSync(file))
}

function readBody(req: NodeReq): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk) => {
      if (!chunk) return
      size += chunk.length
      if (size > 16_384) {
        reject(new Error('请求太大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => reject(new Error('请求中断')))
  })
}

async function handlePost(req: NodeReq, res: NodeRes): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  try {
    const raw = await readBody(req)
    const body: unknown = raw ? JSON.parse(raw) : {}
    const event = createEvent(body)
    appendEvent(eventsFile, event)
    res.statusCode = 201
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, event }))
  } catch (err) {
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : '写入失败' }))
  }
}

export default defineConfig({
  base: './',
  plugins: [dataPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 43123,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 43123,
    strictPort: true,
  },
})
