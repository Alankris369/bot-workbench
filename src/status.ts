import fallbackJson from '../data/status.json'
import { LOG_CAP } from './feed'
import { BOT_ORDER, type BotMessage, type BotRecord, type BotStatus, type WorkbenchStatus } from './types'

const DEFAULT_PALETTE: Record<string, number> = {
  lead: 0,
  frontend: 1,
  integration: 2,
  qa: 3,
}

interface Beat {
  botId: string
  status: BotStatus
  activity: string
  to: string
  text: string
}

/** Demo lines. Each tick changes one bot and appends one message. */
const SCRIPT: Beat[] = [
  {
    botId: 'integration',
    status: 'working',
    activity: '在对状态 JSON',
    to: 'lead',
    text: '我按现在这个 JSON 形状接。',
  },
  {
    botId: 'qa',
    status: 'working',
    activity: '在对四个角色',
    to: 'frontend',
    text: '我开始对四个角色。',
  },
  {
    botId: 'frontend',
    status: 'idle',
    activity: '等下一处修改',
    to: 'qa',
    text: '标签先这样，你看会不会挡脸。',
  },
  {
    botId: 'lead',
    status: 'waiting',
    activity: '等集成回一句',
    to: 'integration',
    text: '等你把消息字段定死。',
  },
  {
    botId: 'integration',
    status: 'idle',
    activity: '字段已经对齐',
    to: 'lead',
    text: 'from、to、text、time，就这四个。',
  },
  {
    botId: 'qa',
    status: 'waiting',
    activity: '等总工程师一句话',
    to: 'lead',
    text: '我这轮看完了，等你一句话。',
  },
  {
    botId: 'lead',
    status: 'working',
    activity: '在看演示',
    to: 'qa',
    text: '继续演示就行，先不接真通道。',
  },
  {
    botId: 'frontend',
    status: 'working',
    activity: '页面仍读本地 JSON',
    to: 'integration',
    text: '页面还是读那一个 JSON。',
  },
]

type Listener = () => void
type MessageHook = (message: BotMessage) => void

let fetched: WorkbenchStatus = parseStatus(fallbackJson, '内置示例')
let view: WorkbenchStatus = clone(fetched)
let demoOn = fetched.demo
let step = 0
let seq = 0
const listeners = new Set<Listener>()
let messageHook: MessageHook | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStatus(raw: unknown, label: string): WorkbenchStatus {
  if (!isRecord(raw)) throw new Error(`${label}不是对象`)
  if (raw.demo !== undefined && typeof raw.demo !== 'boolean') {
    throw new Error(`${label}的 demo 必须是 true 或 false`)
  }
  if (!Array.isArray(raw.bots)) throw new Error(`${label}缺少 bots 数组`)
  if (!Array.isArray(raw.messages)) throw new Error(`${label}缺少 messages 数组`)

  const bots: BotRecord[] = raw.bots.map((item, index) => parseBot(item, index, label))
  const ids = new Set(bots.map((bot) => bot.id))
  for (const id of BOT_ORDER) {
    if (!ids.has(id)) throw new Error(`${label}缺少机器人 ${id}`)
  }

  const messages = raw.messages.map((item, index) => parseMessage(item, index, label))
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString()

  return {
    demo: raw.demo !== false,
    updatedAt,
    bots,
    messages,
  }
}

function parseBot(raw: unknown, index: number, label: string): BotRecord {
  if (!isRecord(raw)) throw new Error(`${label}的 bots[${index}] 不是对象`)
  const id = requiredString(raw.id, `${label}的 bots[${index}].id`)
  const name = requiredString(raw.name, `${label}的 bots[${index}].name`)
  const status = raw.status
  if (status !== 'idle' && status !== 'working' && status !== 'waiting') {
    throw new Error(`${label}的 ${id} 状态必须是 idle、working 或 waiting`)
  }
  const paletteRaw = raw.palette
  const palette =
    typeof paletteRaw === 'number' && paletteRaw >= 0 && paletteRaw <= 5
      ? Math.floor(paletteRaw)
      : (DEFAULT_PALETTE[id] ?? 0)
  return {
    id,
    name,
    role: typeof raw.role === 'string' && raw.role ? raw.role : id,
    status,
    palette,
    activity: typeof raw.activity === 'string' ? raw.activity : '',
  }
}

function parseMessage(raw: unknown, index: number, label: string): BotMessage {
  if (!isRecord(raw)) throw new Error(`${label}的 messages[${index}] 不是对象`)
  const from = requiredString(raw.from, `${label}的 messages[${index}].from`)
  const to = requiredString(raw.to, `${label}的 messages[${index}].to`)
  const text = requiredString(raw.text, `${label}的 messages[${index}].text`)
  const time = requiredString(raw.time, `${label}的 messages[${index}].time`)
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `msg-${index}`
  return { id, from, to, text, time }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} 必须是非空字符串`)
  return value
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function getView(): WorkbenchStatus {
  return view
}

export function isDemoOn(): boolean {
  return demoOn
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Demo messages call this so the office can show the same flight as a real event. */
export function setMessageHook(fn: MessageHook): void {
  messageHook = fn
}

export function pushMessage(message: BotMessage): void {
  view.messages.push(message)
  if (view.messages.length > LOG_CAP) view.messages.splice(0, view.messages.length - LOG_CAP)
  view.updatedAt = new Date().toISOString()
  emit()
}

export function replaceMessages(messages: BotMessage[]): void {
  view.messages = messages.length > LOG_CAP ? messages.slice(messages.length - LOG_CAP) : messages
  emit()
}

export function patchBot(id: string, patch: { status?: BotStatus; activity?: string }): void {
  const bot = view.bots.find((item) => item.id === id)
  if (!bot) return
  if (patch.status) bot.status = patch.status
  if (patch.activity !== undefined) bot.activity = patch.activity
  view.updatedAt = new Date().toISOString()
  emit()
}

/** Ask the page to redraw after a change that did not touch a bot. */
export function touchView(): void {
  emit()
}

export async function loadStatus(): Promise<{ usedFallback: boolean; error?: string }> {
  const statusUrl = `${import.meta.env.BASE_URL}data/status.json`
  try {
    const response = await fetch(statusUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw: unknown = await response.json()
    fetched = parseStatus(raw, 'status.json')
    view = clone(fetched)
    demoOn = fetched.demo
    step = 0
    emit()
    return { usedFallback: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : '读取失败'
    fetched = parseStatus(fallbackJson, '内置示例')
    view = clone(fetched)
    demoOn = fetched.demo
    step = 0
    emit()
    return { usedFallback: true, error: message }
  }
}

/** Turn the built-in cycle on or off. Stopping it leaves events already applied. */
export function setDemo(on: boolean): void {
  demoOn = on
  emit()
}

export function advanceDemo(): void {
  if (!demoOn) return
  const beat = SCRIPT[step % SCRIPT.length]
  step += 1
  const bot = view.bots.find((item) => item.id === beat.botId)
  if (!bot) return
  bot.status = beat.status
  bot.activity = beat.activity
  seq += 1
  view.messages.push({
    id: `demo-${seq}`,
    from: beat.botId,
    to: beat.to,
    text: beat.text,
    time: new Date().toISOString(),
  })
  if (view.messages.length > 12) view.messages.splice(0, view.messages.length - 12)
  view.updatedAt = new Date().toISOString()
  emit()
  const message = view.messages[view.messages.length - 1]
  if (message) messageHook?.(message)
}

export function botName(id: string, bots: BotRecord[]): string {
  return bots.find((bot) => bot.id === id)?.name ?? id
}

export function orderedBots(bots: BotRecord[]): BotRecord[] {
  const rank = new Map<string, number>(BOT_ORDER.map((id, index) => [id, index]))
  return [...bots].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99))
}
