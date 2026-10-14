import './style.css'
import { loadArt, type Art } from './assets'
import { CONNECTION_LABEL } from './feed'
import {
  activeFlights,
  bubbleFor,
  feedSnapshot,
  getFeedUrl,
  installHostHook,
  presentMessage,
  reloadFeed,
  startFeed,
  startReplay,
} from './events'
import { ENVELOPE_RGB, renderOffice, resizeBoard, fitZoom, type Anchor } from './render'
import {
  advanceDemo,
  botName,
  getView,
  isDemoOn,
  loadStatus,
  orderedBots,
  setDemo,
  setMessageHook,
  subscribe,
} from './status'
import { STATUS_LABEL, type BotRecord, type WorkbenchStatus } from './types'
import {
  readReportToken,
  sendCommand,
  writeReportToken,
} from './command'

const stage = must<HTMLElement>('#stage')
const board = must<HTMLElement>('#board')
const canvas = must<HTMLCanvasElement>('#office')
const floaters = must<HTMLElement>('#floaters')
const loading = must<HTMLElement>('#loading')
const banner = must<HTMLElement>('#banner')
const botList = must<HTMLUListElement>('#bot-list')
const msgList = must<HTMLOListElement>('#msg-list')
const fileMeta = must<HTMLElement>('#file-meta')
const demoButton = must<HTMLButtonElement>('#demo-toggle')
const reloadButton = must<HTMLButtonElement>('#reload')
const replayButton = must<HTMLButtonElement>('#replay')
const feedForm = must<HTMLFormElement>('#feed-form')
const feedInput = must<HTMLInputElement>('#feed-url')
const connectionEl = must<HTMLElement>('#connection')
const commandForm = must<HTMLFormElement>('#command-form')
const commandTo = must<HTMLSelectElement>('#command-to')
const commandText = must<HTMLTextAreaElement>('#command-text')
const reportToken = must<HTMLInputElement>('#report-token')
const commandSend = must<HTMLButtonElement>('#command-send')
const commandStatus = must<HTMLElement>('#command-status')

const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('无法创建画布')

let art: Art | null = null
let zoom = 2
let highlightId: string | null = null
let demoTimer = 0
let loadNote = ''
const chips = new Map<string, HTMLDivElement>()

demoButton.addEventListener('click', () => {
  const next = !isDemoOn()
  setDemo(next)
  syncDemoTimer()
  renderChrome(getView())
})

reloadButton.addEventListener('click', () => {
  void reload()
})

replayButton.addEventListener('click', () => {
  setDemo(false)
  syncDemoTimer()
  void startReplay()
})

feedForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const next = feedInput.value.trim()
  if (!next) return
  startFeed(next)
})

reportToken.value = readReportToken()
reportToken.addEventListener('change', () => {
  writeReportToken(reportToken.value)
})

commandForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitCommand()
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    highlightId = null
    renderChrome(getView())
  }
})

subscribe(() => {
  renderChrome(getView())
})

new ResizeObserver(() => {
  zoom = fitZoom(stage.clientWidth, stage.clientHeight)
  resizeBoard(canvas, board, zoom)
}).observe(stage)

void boot()

async function boot(): Promise<void> {
  try {
    const [loaded, result] = await Promise.all([loadArt(), loadStatus()])
    art = loaded
    loading.hidden = true
    board.hidden = false
    board.dataset.envelope = `${ENVELOPE_RGB.r},${ENVELOPE_RGB.g},${ENVELOPE_RGB.b}`
    zoom = fitZoom(stage.clientWidth, stage.clientHeight)
    resizeBoard(canvas, board, zoom)
    if (new URLSearchParams(location.search).get('demo') === '0') setDemo(false)
    setMessageHook((message) => {
      // The demo cycle already wrote the log line. This adds the bubble, the envelope, and the receiver.
      presentMessage(message)
    })
    showLoadNote(result)
    installHostHook()
    if (!window.__WORKBENCH_SOURCE__) await startFeed()
    feedInput.value = getFeedUrl()
    syncDemoTimer()
    renderChrome(getView())
    requestAnimationFrame(frame)
  } catch (err) {
    loading.textContent = err instanceof Error ? err.message : '办公室没有打开'
  }
}

async function reload(): Promise<void> {
  const result = await loadStatus()
  showLoadNote(result)
  await reloadFeed()
  feedInput.value = getFeedUrl()
  syncDemoTimer()
  renderChrome(getView())
}

function showLoadNote(result: { usedFallback: boolean; error?: string }): void {
  loadNote = result.usedFallback
    ? `读不到 data/status.json（${result.error ?? '未知错误'}），先用包里的示例。`
    : ''
}

function syncDemoTimer(): void {
  window.clearInterval(demoTimer)
  demoTimer = 0
  if (!isDemoOn()) return
  demoTimer = window.setInterval(() => advanceDemo(), 2800)
}

function frame(now: number): void {
  if (art) {
    const flights = activeFlights(now)
    board.dataset.flights = String(flights.length)
    const anchors = renderOffice(ctx!, art, zoom, now / 1000, getView().bots, highlightId, flights)
    placeChips(getView(), anchors)
  }
  requestAnimationFrame(frame)
}

function renderChrome(view: WorkbenchStatus): void {
  const feed = feedSnapshot()
  demoButton.setAttribute('aria-pressed', isDemoOn() ? 'true' : 'false')
  demoButton.textContent = isDemoOn() ? '演示模式：开' : '演示模式：关'
  replayButton.disabled = !feed.ready || feed.replaying
  replayButton.textContent = feed.replaying ? '正在重放…' : '重放接力'
  connectionEl.dataset.state = feed.connection
  connectionEl.title = feed.url
  const connectionText = connectionEl.querySelector('span')
  if (connectionText) connectionText.textContent = CONNECTION_LABEL[feed.connection]
  if (feed.error) {
    banner.hidden = false
    banner.dataset.kind = feed.connection === 'offline' ? 'offline' : 'warn'
    const keep = feed.connection === 'offline' ? ' 画面先留着上次的数据，正在自动重试。' : ''
    banner.textContent = `${feed.error}${keep}`
  } else if (loadNote) {
    banner.hidden = false
    banner.dataset.kind = 'warn'
    banner.textContent = loadNote
  } else {
    banner.hidden = true
    banner.dataset.kind = ''
    banner.textContent = ''
  }
  renderBots(view)
  renderMessages(view)
  const demo = isDemoOn() ? '演示开着。' : '演示关着。'
  const how =
    feed.mode === 'sse'
      ? '优先实时推送，标签页可见时约 1.2 秒补拉一次。'
      : '标签页可见时约 1.2 秒拉一次，切到后台会放慢。'
  fileMeta.textContent = `${demo}已收 ${feed.applied} 条。${how}时间是上海时间。`
}

const DUTY: Record<string, string> = {
  lead: '统筹',
  frontend: '页面',
  integration: '接入',
  qa: '验收',
}

function dutyLabel(bot: BotRecord): string {
  if (bot.role && bot.role !== bot.id) return bot.role
  return DUTY[bot.id] ?? bot.role
}

function renderBots(view: WorkbenchStatus): void {
  const bots = orderedBots(view.bots)
  const sig = `${highlightId}|${bots.map((bot) => `${bot.id}:${bot.name}:${bot.status}:${bot.activity}:${dutyLabel(bot)}`).join('|')}`
  if (botList.dataset.sig === sig) return
  botList.dataset.sig = sig
  botList.replaceChildren()
  for (const bot of bots) {
    const li = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'bot-card'
    if (bot.id === highlightId) button.classList.add('selected')
    button.dataset.id = bot.id
    button.dataset.status = bot.status
    button.addEventListener('click', () => {
      highlightId = highlightId === bot.id ? null : bot.id
      renderChrome(getView())
    })

    const mark = document.createElement('i')
    mark.className = 'mark'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = bot.name
    const pill = document.createElement('span')
    pill.className = `pill st-${bot.status}`
    pill.textContent = STATUS_LABEL[bot.status]

    const sub = document.createElement('span')
    sub.className = 'sub'
    sub.textContent = dutyLabel(bot)

    button.append(mark, who, pill, sub)
    if (bot.activity) {
      const activity = document.createElement('span')
      activity.className = 'activity'
      activity.textContent = bot.activity
      button.append(activity)
    }
    li.append(button)
    botList.append(li)
  }
}

function renderMessages(view: WorkbenchStatus): void {
  const feed = feedSnapshot()
  const sig = `${feed.connection}|${view.messages.map((message) => `${message.id}@${message.time}`).join('|')}`
  if (msgList.dataset.sig === sig) return
  msgList.dataset.sig = sig
  msgList.replaceChildren()
  const messages = [...view.messages].reverse()
  if (messages.length === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    const title = document.createElement('p')
    title.textContent = '还没有消息。'
    const detail = document.createElement('p')
    detail.textContent =
      feed.connection === 'offline' || feed.connection === 'connecting'
        ? '事件流连上之后，谁对谁说了什么会记在这里。'
        : '谁对谁说了话，会记在这里。'
    li.append(title, detail)
    msgList.append(li)
    return
  }
  for (const message of messages) {
    const li = document.createElement('li')
    li.className = 'msg'
    const route = document.createElement('div')
    route.className = 'route'
    route.textContent = `${botName(message.from, view.bots)} → ${botName(message.to, view.bots)}`
    const text = document.createElement('p')
    text.className = 'text'
    text.textContent = message.text
    const time = document.createElement('time')
    time.dateTime = message.time
    time.textContent = formatTime(message.time)
    li.append(route, text, time)
    msgList.append(li)
  }
}

function placeChips(view: WorkbenchStatus, anchors: Anchor[]): void {
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const now = Date.now()
  for (const bot of view.bots) {
    const anchor = byId.get(bot.id)
    if (!anchor) continue
    let chip = chips.get(bot.id)
    if (!chip) {
      chip = document.createElement('div')
      chip.className = 'chip'
      floaters.append(chip)
      chips.set(bot.id, chip)
    }
    const bubble = bubbleText(bot, now)
    const sig = `${bot.name}|${bot.status}|${bubble ?? ''}|${bot.id === highlightId}`
    if (chip.dataset.sig !== sig) {
      chip.dataset.sig = sig
      chip.dataset.status = bot.status
      chip.classList.toggle('selected', bot.id === highlightId)
      fillChip(chip, bot, bubble)
    }
    chip.style.left = `${anchor.x}px`
    chip.style.top = `${anchor.y}px`
  }
}

function fillChip(chip: HTMLDivElement, bot: BotRecord, bubble: string | null): void {
  chip.replaceChildren()
  if (bubble) {
    const bubbleEl = document.createElement('div')
    bubbleEl.className = 'bubble'
    bubbleEl.textContent = bubble
    chip.append(bubbleEl)
  }
  const plate = document.createElement('div')
  plate.className = 'plate'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = bot.name
  const status = document.createElement('div')
  status.className = `st st-${bot.status}`
  status.textContent = STATUS_LABEL[bot.status]
  plate.append(name, status)
  chip.append(plate)
}

function bubbleText(bot: BotRecord, now: number): string | null {
  return bubbleFor(bot.id, bot.status, now)
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

async function submitCommand(): Promise<void> {
  const token = reportToken.value.trim()
  writeReportToken(token)
  if (!token) {
    setCommandStatus('err', '请先填写上报令牌（只存在本机浏览器）。')
    reportToken.focus()
    return
  }
  const to = commandTo.value
  const instruction = commandText.value
  commandSend.disabled = true
  setCommandStatus('busy', '正在发送…')
  const result = await sendCommand({ to, instruction, token })
  commandSend.disabled = false
  if (result.ok) {
    setCommandStatus('ok', result.detail)
    commandText.value = ''
    commandText.focus()
    return
  }
  setCommandStatus('err', result.detail)
}

function setCommandStatus(state: 'ok' | 'err' | 'busy' | '', text: string): void {
  if (state) commandStatus.dataset.state = state
  else delete commandStatus.dataset.state
  commandStatus.textContent = text
}

function must<T extends Element>(selector: string): T {
  const node = document.querySelector(selector)
  if (!node) throw new Error(`找不到 ${selector}`)
  return node as T
}
