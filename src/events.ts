import relayFallback from '../data/relay.jsonl?raw'
import {
  applyPollResult,
  parseEventFeed,
  previewText,
  resolveFeedUrl,
  type Connection,
  type FeedState,
  type PollResult,
} from './feed'
import {
  browserTextFetch,
  httpFeedSource,
  openFeed,
  pageUrl,
  type FeedPull,
  type FeedSource,
} from './source'
import { botName, getView, patchBot, pushMessage, replaceMessages, setDemo, touchView } from './status'
import type { BotMessage, BotStatus, WorkEvent } from './types'

export type { FeedSource } from './source'

export { parseEventFeed, previewText, resolveBotId, resolveFeedUrl } from './feed'
export type { Connection } from './feed'

const POLL_MS = 2500
const FLIGHT_MS = 1800
const SPEECH_MS = 4200
const MESSAGE_GAP_MS = 2200
const STATUS_GAP_MS = 280

interface Speech {
  botId: string
  text: string
  until: number
}

export interface LiveFlight {
  fromId: string
  toId: string
  startMs: number
  durationMs: number
}

let feedUrl = ''
let seen: string[] = []
let ready = false
let error: string | null = null
let connection: Connection = 'connecting'
let generation = 0
let replaying = false
let replayTimer = 0
let flights: LiveFlight[] = []
let speeches: Speech[] = []
let configFeed: string | null = null
let configLoaded = false
let stopFeed: () => void = () => {}
let settleReady: (() => void) | null = null

export function pollIntervalMs(): number {
  return POLL_MS
}

export function flightDurationMs(): number {
  return FLIGHT_MS
}

export function defaultFeedUrl(): string {
  const query = new URLSearchParams(location.search).get('feed')
  let saved: string | null = null
  try {
    saved = localStorage.getItem('workbench.feed')
  } catch {
    // Private mode can block localStorage. The default file still works.
  }
  return resolveFeedUrl({
    query,
    saved,
    config: configFeed,
    fallback: pageUrl('data/events.jsonl', import.meta.env.BASE_URL),
  })
}

export function getFeedUrl(): string {
  return feedUrl || defaultFeedUrl()
}

export function feedSnapshot(): {
  ready: boolean
  url: string
  applied: number
  ids: string[]
  flights: number
  replaying: boolean
  error: string | null
  connection: Connection
} {
  return {
    ready,
    url: getFeedUrl(),
    applied: seen.length,
    ids: [...seen],
    flights: activeFlights(performance.now()).length,
    replaying,
    error,
    connection,
  }
}

export function activeFlights(nowMs: number): LiveFlight[] {
  flights = flights.filter((flight) => nowMs >= flight.startMs && nowMs - flight.startMs < flight.durationMs)
  return flights
}

export function bubbleFor(botId: string, status: BotStatus, now = Date.now()): string | null {
  speeches = speeches.filter((speech) => speech.until > now)
  for (let i = speeches.length - 1; i >= 0; i -= 1) {
    const speech = speeches[i]
    if (speech.botId === botId) return speech.text
  }
  if (status === 'waiting') return '等一下…'
  return null
}

/** Bubble plus envelope. Does not change the receiver; the feed state already did. */
export function showFlight(message: BotMessage): void {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  speeches.push({
    botId: message.from,
    text: previewText(message.text),
    until: Date.now() + (reduce ? 1600 : SPEECH_MS),
  })
  flights.push({
    fromId: message.from,
    toId: message.to,
    startMs: performance.now(),
    durationMs: reduce ? 220 : FLIGHT_MS,
  })
  if (speeches.length > 8) speeches.splice(0, speeches.length - 8)
  if (flights.length > 12) flights.splice(0, flights.length - 12)
}

/** Show the sender's bubble and fly an envelope. Also used by the demo cycle. */
export function presentMessage(message: BotMessage): void {
  const bots = getView().bots
  const fromName = botName(message.from, bots)
  patchBot(message.to, { status: 'working', activity: `在看${fromName}的消息` })
  showFlight(message)
}

export async function startFeed(url?: string): Promise<void> {
  await loadConfig()
  if (url) {
    feedUrl = url.trim()
    try {
      localStorage.setItem('workbench.feed', feedUrl)
    } catch {
      // Ignore storage failures. The in-memory URL still polls.
    }
  } else if (!feedUrl) {
    feedUrl = defaultFeedUrl()
  }
  resetCursor()
  arm(httpFeedSource(feedUrl))
}

/** Swap the HTTP poll for a push source. A native shell can call this later. */
export function useFeedSource(source: FeedSource): void {
  feedUrl = source.label
  resetCursor()
  arm(source)
}

declare global {
  interface Window {
    /** Present after boot so a webview shell can replace the HTTP poll. */
    workbench?: { useFeedSource: (source: FeedSource) => void }
    /** Set by a shell before the page module runs. Applied on boot if present. */
    __WORKBENCH_SOURCE__?: FeedSource
  }
}

export function installHostHook(): void {
  const preset = window.__WORKBENCH_SOURCE__
  window.workbench = { useFeedSource }
  if (preset) useFeedSource(preset)
}

export async function reloadFeed(): Promise<void> {
  configLoaded = false
  await loadConfig()
  const query = new URLSearchParams(location.search).get('feed')?.trim()
  if (query) feedUrl = query
  else if (!readSavedFeed()) feedUrl = defaultFeedUrl()
  resetCursor()
  arm(httpFeedSource(feedUrl))
  await whenReady()
}

export function isReplaying(): boolean {
  return replaying
}

export async function startReplay(): Promise<void> {
  if (replaying) return
  setDemo(false)
  replaying = true
  touchView()
  try {
    const text = await loadRelayText()
    const { events, errors } = parseEventFeed(text, getView().bots)
    if (!events.length) {
      error = errors[0] ?? '接力文件是空的'
      replaying = false
      touchView()
      return
    }
    const messageIds = new Set(events.filter((event) => event.type === 'message').map((event) => event.id))
    replaceMessages(getView().messages.filter((message) => !messageIds.has(message.id)))
    await play(events)
  } catch (err) {
    error = `接力没有放出来：${err instanceof Error ? err.message : '未知错误'}`
    replaying = false
    touchView()
  }
}

async function loadConfig(): Promise<void> {
  if (configLoaded) return
  configLoaded = true
  const read = await browserTextFetch()(pageUrl('data/config.json', import.meta.env.BASE_URL))
  if (!read.ok || read.status < 200 || read.status >= 300) {
    configFeed = null
    return
  }
  try {
    const raw: unknown = JSON.parse(read.text)
    if (typeof raw === 'object' && raw !== null && 'feed' in raw && typeof raw.feed === 'string') {
      configFeed = raw.feed
      return
    }
  } catch {
    // A broken config file just means "use the default feed".
  }
  configFeed = null
}

function readSavedFeed(): string | null {
  try {
    return localStorage.getItem('workbench.feed')
  } catch {
    return null
  }
}

function resetCursor(): void {
  generation += 1
  seen = []
  ready = false
  connection = 'connecting'
  error = null
}

function arm(source: FeedSource): void {
  stopFeed()
  const gen = generation
  stopFeed = openFeed(
    source,
    (pull) => accept(gen, pull),
    POLL_MS,
    (fn, ms) => {
      const id = window.setInterval(fn, ms)
      return () => window.clearInterval(id)
    },
  )
}

function whenReady(): Promise<void> {
  if (ready || error) return Promise.resolve()
  return new Promise((resolve) => {
    const previous = settleReady
    settleReady = () => {
      previous?.()
      resolve()
    }
    window.setTimeout(() => {
      if (settleReady === null) return
      const finish = settleReady
      settleReady = null
      finish()
    }, 4000)
  })
}

function accept(gen: number, pull: FeedPull): void {
  if (gen !== generation) return
  if (replaying) {
    if (!pull.ok) {
      connection = 'offline'
      error = pull.error
      touchView()
    }
    settleReady?.()
    settleReady = null
    return
  }
  if (!pull.ok) writeResult(applyPollResult(readState(), pull))
  else writeResult(applyPollResult(readState(), { ok: true, text: pull.text, first: !ready }))
  settleReady?.()
  settleReady = null
}

async function loadRelayText(): Promise<string> {
  const read = await browserTextFetch()(pageUrl('data/relay.jsonl', import.meta.env.BASE_URL))
  if (!read.ok || read.status < 200 || read.status >= 300) return relayFallback
  return read.text
}

function play(events: WorkEvent[]): Promise<void> {
  return new Promise((resolve) => {
    let index = 0
    const step = () => {
      if (index >= events.length) {
        replaying = false
        touchView()
        resolve()
        return
      }
      const source = events[index]
      index += 1
      const event = restamp(source)
      applyReplayEvent(event)
      const wait = event.type === 'message' ? MESSAGE_GAP_MS : STATUS_GAP_MS
      window.clearTimeout(replayTimer)
      replayTimer = window.setTimeout(step, wait)
    }
    step()
  })
}

function restamp(event: WorkEvent): WorkEvent {
  const time = new Date().toISOString()
  if (event.type === 'status') return { ...event, time }
  return { ...event, time }
}

function applyReplayEvent(event: WorkEvent): void {
  if (event.type === 'status') {
    patchBot(event.bot, { status: event.status, activity: event.activity })
    return
  }
  const message: BotMessage = {
    id: event.id,
    from: event.from,
    to: event.to,
    text: event.text,
    time: event.time,
  }
  pushMessage(message)
  presentMessage(message)
}

function readState(): FeedState {
  const view = getView()
  return {
    bots: view.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      status: bot.status,
      activity: bot.activity,
    })),
    messages: view.messages.map((message) => ({ ...message })),
    seen: [...seen],
    ready,
  }
}

function writeResult(result: PollResult): void {
  const view = getView()
  for (const bot of result.state.bots) {
    const current = view.bots.find((item) => item.id === bot.id)
    if (!current) continue
    current.status = bot.status
    current.activity = bot.activity
  }
  view.messages = result.state.messages
  view.updatedAt = new Date().toISOString()
  seen = result.state.seen
  ready = result.ready
  error = result.error
  connection = result.connection
  for (const message of result.animate) showFlight(message)
  touchView()
}
