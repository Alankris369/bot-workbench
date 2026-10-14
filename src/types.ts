/** Status a bot can be in. Later phases should keep these three values. */
export type BotStatus = 'idle' | 'working' | 'waiting'

/** One line in the message log. `from` and `to` are bot ids. */
export interface BotMessage {
  id: string
  from: string
  to: string
  text: string
  time: string
}

/** Append-only feed. One JSON object per line, or a JSON array of the same objects. */
export type WorkEvent = MessageEvent | StatusEvent

export interface MessageEvent {
  id: string
  type: 'message'
  from: string
  to: string
  text: string
  time: string
}

export interface StatusEvent {
  id: string
  type: 'status'
  bot: string
  status: BotStatus
  activity: string
  time: string
}

/** One bot in the office. `palette` picks char_0.png … char_5.png. */
export interface BotRecord {
  id: string
  name: string
  role: string
  status: BotStatus
  palette: number
  activity: string
}

/** Shape of data/status.json. */
export interface WorkbenchStatus {
  demo: boolean
  updatedAt: string
  bots: BotRecord[]
  messages: BotMessage[]
}

export const STATUS_LABEL: Record<BotStatus, string> = {
  idle: '空闲',
  working: '工作中',
  waiting: '等待',
}

export const BOT_ORDER = ['lead', 'frontend', 'integration', 'qa'] as const
