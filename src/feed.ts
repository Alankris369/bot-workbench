import type { BotMessage, BotStatus, WorkEvent } from './types'

/** Keep these names in sync with scripts/event-file.mjs. */
const ALIASES: Record<string, string> = {
  lead: 'lead',
  frontend: 'frontend',
  integration: 'integration',
  qa: 'qa',
  总工程师: 'lead',
  前端开发: 'frontend',
  集成开发: 'integration',
  测试员: 'qa',
}

/** Messages kept on screen. Older lines drop off so the list cannot grow without limit. */
export const LOG_CAP = 40

/** Lines read from the tail of a feed. Older lines are left on disk and not reparsed. */
export const FEED_WINDOW = 200

export type Connection = 'connecting' | 'live' | 'degraded' | 'offline'

export const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: '正在连接',
  live: '已连接',
  degraded: '有行读不了',
  offline: '连接失败',
}

export interface NamedBot {
  id: string
  name: string
}

export interface FeedBot extends NamedBot {
  status: BotStatus
  activity: string
}

export interface FeedState {
  bots: FeedBot[]
  messages: BotMessage[]
  seen: string[]
  ready: boolean
}

export interface PollResult {
  state: FeedState
  connection: Connection
  error: string | null
  animate: BotMessage[]
  ready: boolean
}

interface ParsedFeed {
  events: WorkEvent[]
  errors: string[]
  /** The body is not a feed at all, so callers should keep the previous state. */
  fatal: boolean
}

export function resolveBotId(token: string, bots: NamedBot[] = []): string | null {
  const trimmed = token.trim()
  if (!trimmed) return null
  if (ALIASES[trimmed]) return ALIASES[trimmed]
  const match = bots.find((bot) => bot.id === trimmed || bot.name === trimmed)
  return match?.id ?? null
}

export function previewText(text: string): string {
  const chars = Array.from(text)
  if (chars.length <= 18) return text
  return `${chars.slice(0, 18).join('')}…`
}

/**
 * Query wins, then the address saved from the form, then data/config.json, then the local file.
 * Blank values are skipped.
 */
export function resolveFeedUrl(input: {
  query: string | null
  saved: string | null
  config: string | null
  fallback: string
}): string {
  for (const candidate of [input.query, input.saved, input.config]) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return input.fallback
}

export function parseEventFeed(text: string, bots: NamedBot[] = [], maxLines = FEED_WINDOW): ParsedFeed {
  const trimmed = text.trim()
  if (!trimmed) return { events: [], errors: [], fatal: false }
  if (trimmed.startsWith('<')) return { events: [], errors: ['事件流不是 JSON'], fatal: true }
  if (trimmed.startsWith('[')) {
    try {
      const raw: unknown = JSON.parse(trimmed)
      if (!Array.isArray(raw)) return { events: [], errors: ['事件必须是数组或 JSONL'], fatal: true }
      const tail = raw.length > maxLines ? raw.slice(raw.length - maxLines) : raw
      const parsed = collect(tail, bots)
      return { ...parsed, fatal: false }
    } catch {
      return { events: [], errors: ['JSON 数组解析失败'], fatal: true }
    }
  }
  // Relay returns {"events":[...]} as one JSON object.
  if (trimmed.startsWith('{')) {
    try {
      const raw: unknown = JSON.parse(trimmed)
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'events' in raw) {
        const list = (raw as { events: unknown }).events
        if (!Array.isArray(list)) {
          return { events: [], errors: ['events 必须是数组'], fatal: true }
        }
        const tail = list.length > maxLines ? list.slice(list.length - maxLines) : list
        const parsed = collect(tail, bots)
        return { ...parsed, fatal: false }
      }
      // A single event object — treat as one JSONL line below.
    } catch {
      // Fall through to line-by-line JSONL parsing.
    }
  }

  const kept: { line: string; number: number }[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim()) kept.push({ line, number: index + 1 })
  })
  const tail = kept.length > maxLines ? kept.slice(kept.length - maxLines) : kept
  const errors: string[] = []
  const items: unknown[] = []
  for (const entry of tail) {
    try {
      items.push(JSON.parse(entry.line))
    } catch {
      errors.push(`第 ${entry.number} 行不是 JSON`)
    }
  }
  const parsed = collect(items, bots)
  return { events: parsed.events, errors: [...errors, ...parsed.errors], fatal: false }
}

function collect(items: unknown[], bots: NamedBot[]): { events: WorkEvent[]; errors: string[] } {
  const events: WorkEvent[] = []
  const errors: string[] = []
  items.forEach((item, index) => {
    const parsed = parseOne(item, bots, index)
    if (typeof parsed === 'string') errors.push(parsed)
    else events.push(parsed)
  })
  return { events, errors }
}

function parseOne(raw: unknown, bots: NamedBot[], index: number): WorkEvent | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `第 ${index + 1} 条不是对象`
  const record = raw as Record<string, unknown>
  const id = stableId(record, index)
  const time = typeof record.time === 'string' && record.time.trim() ? record.time : '1970-01-01T00:00:00.000Z'
  if (record.type === 'status') {
    const botToken = typeof record.bot === 'string' ? record.bot : ''
    const bot = resolveBotId(botToken, bots)
    if (!bot) return `第 ${index + 1} 条的 bot 不认识`
    const status = record.status
    if (status !== 'idle' && status !== 'working' && status !== 'waiting') {
      return `第 ${index + 1} 条的 status 必须是 idle、working 或 waiting`
    }
    const activity = typeof record.activity === 'string' ? record.activity : ''
    return { id, type: 'status', bot, status, activity, time }
  }
  if (record.type !== 'message' && record.type !== undefined) return `第 ${index + 1} 条的 type 不认识`
  const fromToken = typeof record.from === 'string' ? record.from : ''
  const toToken = typeof record.to === 'string' ? record.to : ''
  const from = resolveBotId(fromToken, bots)
  const to = resolveBotId(toToken, bots)
  if (!from || !to) return `第 ${index + 1} 条的 from 或 to 不认识`
  if (typeof record.text !== 'string' || !record.text.trim()) return `第 ${index + 1} 条缺少 text`
  return { id, type: 'message', from, to, text: record.text.trim(), time }
}

function stableId(record: Record<string, unknown>, index: number): string {
  if (typeof record.id === 'string' && record.id.trim()) return record.id.trim()
  const type = record.type === 'status' ? 'status' : 'message'
  const time = typeof record.time === 'string' ? record.time : ''
  const who = typeof record.from === 'string' ? record.from : typeof record.bot === 'string' ? record.bot : ''
  const extra = typeof record.to === 'string' ? record.to : typeof record.status === 'string' ? record.status : ''
  const text = typeof record.text === 'string' ? record.text : ''
  return `${type}:${time}:${who}:${extra}:${text}:${index}`
}

export function emptyFeedState(bots: FeedBot[]): FeedState {
  return {
    bots: bots.map((bot) => ({ ...bot })),
    messages: [],
    seen: [],
    ready: false,
  }
}

/**
 * Fold one fetch into the office state.
 * The first successful read only fills the log. Later reads animate messages that are actually new.
 * A failed fetch, or a body that is not a feed, leaves bots and messages as they were.
 */
export function applyPollResult(
  state: FeedState,
  outcome: { ok: true; text: string; first: boolean } | { ok: false; error: string },
): PollResult {
  if (!outcome.ok) {
    return {
      state: cloneState(state),
      connection: 'offline',
      error: outcome.error,
      animate: [],
      ready: state.ready,
    }
  }

  const parsed = parseEventFeed(outcome.text, state.bots)
  if (parsed.fatal) {
    return {
      state: cloneState(state),
      connection: 'offline',
      error: parsed.errors[0] ?? '事件流不是 JSON',
      animate: [],
      ready: state.ready,
    }
  }

  const live = !outcome.first
  const seen = new Set(state.seen)
  const batch = new Set<string>()
  const bots = state.bots.map((bot) => ({ ...bot }))
  let messages = live ? state.messages.map((message) => ({ ...message })) : []
  const animate: BotMessage[] = []

  for (const event of parsed.events) {
    if (batch.has(event.id)) continue
    batch.add(event.id)
    if (live && seen.has(event.id)) continue
    if (event.type === 'status') {
      const bot = bots.find((item) => item.id === event.bot)
      if (!bot) continue
      bot.status = event.status
      bot.activity = event.activity
      continue
    }
    if (messages.some((message) => message.id === event.id)) continue
    const message: BotMessage = {
      id: event.id,
      from: event.from,
      to: event.to,
      text: event.text,
      time: event.time,
    }
    messages.push(message)
    if (!live) continue
    const receiver = bots.find((item) => item.id === event.to)
    if (receiver) {
      const fromName = bots.find((item) => item.id === event.from)?.name ?? event.from
      receiver.status = 'working'
      receiver.activity = `在看${fromName}的消息`
    }
    animate.push(message)
  }

  if (messages.length > LOG_CAP) messages = messages.slice(messages.length - LOG_CAP)

  return {
    state: {
      bots,
      messages,
      seen: batch.size > 0 ? [...batch] : state.seen,
      ready: true,
    },
    connection: parsed.errors.length ? 'degraded' : 'live',
    error: parsed.errors[0] ?? null,
    animate,
    ready: true,
  }
}

function cloneState(state: FeedState): FeedState {
  return {
    bots: state.bots.map((bot) => ({ ...bot })),
    messages: state.messages.map((message) => ({ ...message })),
    seen: [...state.seen],
    ready: state.ready,
  }
}
