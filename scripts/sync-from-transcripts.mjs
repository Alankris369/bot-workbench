#!/usr/bin/env node
// Usage: node scripts/sync-from-transcripts.mjs extracted.json
// extracted.json: [{ "sourceId": "<transcript msg id>", "from": "总工程师|前端开发|集成开发|测试员", "to": "...", "text": "...", "time": "2026-10-14T09:00:00+08:00" }]
// Appends new message events (and working/idle status hints) to data/events.jsonl, deduped by stable id.
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
const FEED = new URL('../data/events.jsonl', import.meta.url)
const MAP = { 总工程师: 'lead', 前端开发: 'frontend', 集成开发: 'integration', 测试员: 'qa' }
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const seen = new Set(existsSync(FEED) ? readFileSync(FEED, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).id } catch { return null } }) : [])
const id = (m) => 'tx-' + createHash('sha1').update(m.sourceId ?? `${m.time}|${m.from}|${m.to}|${m.text}`).digest('hex').slice(0, 12)
const out = []
for (const m of input.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
  const from = MAP[m.from] ?? m.from, to = MAP[m.to] ?? m.to
  const mid = id(m)
  if (seen.has(mid)) continue
  const text = Array.from(m.text.trim()).slice(0, 120).join('')
  const time = new Date(m.time).toISOString()
  out.push({ id: mid, type: 'message', from, to, text, time })
  out.push({ id: mid + '-s', type: 'status', bot: to, status: 'working', activity: `处理 ${m.from} 的消息`, time })
  out.push({ id: mid + '-f', type: 'status', bot: from, status: 'idle', activity: '', time })
  seen.add(mid)
}
if (out.length) appendFileSync(FEED, out.map((e) => JSON.stringify(e)).join('\n') + '\n')
console.log(`appended ${out.length} events`)
