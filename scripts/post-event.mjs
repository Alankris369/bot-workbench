#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent, createEvent } from './event-file.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return undefined
  return value
}

const help = `用法:
  npm run post -- --from 前端开发 --to 测试员 --text "写好了"
  npm run post -- --type status --bot 测试员 --status working --activity "在看消息"

名字可以用中文，也可以用 lead、frontend、integration、qa。
默认追加到 data/events.jsonl。--file 可以换一个文件。`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(help)
  process.exit(0)
}

try {
  const event = createEvent({
    type: arg('--type'),
    from: arg('--from'),
    to: arg('--to'),
    text: arg('--text'),
    bot: arg('--bot'),
    status: arg('--status'),
    activity: arg('--activity'),
    time: arg('--time'),
    id: arg('--id'),
  })
  const file = path.resolve(arg('--file') || path.join(root, 'data', 'events.jsonl'))
  appendEvent(file, event)
  console.log(JSON.stringify(event))
} catch (err) {
  console.error(err instanceof Error ? err.message : '写入失败')
  console.error(help)
  process.exit(1)
}
