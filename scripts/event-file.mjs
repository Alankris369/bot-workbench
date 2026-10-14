import fs from 'node:fs'
import path from 'node:path'

/** Keep these names in sync with src/events.ts. */
const ALIASES = {
  lead: 'lead',
  frontend: 'frontend',
  integration: 'integration',
  qa: 'qa',
  总工程师: 'lead',
  前端开发: 'frontend',
  集成开发: 'integration',
  测试员: 'qa',
}

export function resolveBot(token) {
  if (typeof token !== 'string') return null
  const trimmed = token.trim()
  return ALIASES[trimmed] ?? null
}

export function createMessageEvent({ from, to, text, id, time } = {}) {
  const sender = resolveBot(from)
  const receiver = resolveBot(to)
  if (!sender || !receiver) {
    throw new Error('from 和 to 要填 总工程师、前端开发、集成开发、测试员，或 lead、frontend、integration、qa')
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('text 不能为空')
  return {
    id: id || newId(),
    type: 'message',
    from: sender,
    to: receiver,
    text: text.trim(),
    time: time || new Date().toISOString(),
  }
}

export function createStatusEvent({ bot, status, activity, id, time } = {}) {
  const who = resolveBot(bot)
  if (!who) throw new Error('bot 要填 总工程师、前端开发、集成开发、测试员，或 lead、frontend、integration、qa')
  if (status !== 'idle' && status !== 'working' && status !== 'waiting') {
    throw new Error('status 必须是 idle、working 或 waiting')
  }
  return {
    id: id || newId(),
    type: 'status',
    bot: who,
    status,
    activity: typeof activity === 'string' ? activity.trim() : '',
    time: time || new Date().toISOString(),
  }
}

export function createEvent(body) {
  if (typeof body !== 'object' || body === null) throw new Error('请求体必须是 JSON 对象')
  if (body.type === 'status') return createStatusEvent(body)
  if (body.type === 'message' || body.type === undefined) return createMessageEvent(body)
  throw new Error('type 必须是 message 或 status')
}

export function appendEvent(file, event) {
  let prefix = ''
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const buf = fs.readFileSync(file)
    if (buf[buf.length - 1] !== 0x0a) prefix = '\n'
  } else if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  fs.appendFileSync(file, `${prefix}${JSON.stringify(event)}\n`)
}

function newId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
