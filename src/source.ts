/**
 * Where the event text comes from.
 *
 * The page polls an HTTP source today, and may also subscribe() to Server-Sent
 * Events when the feed URL is a relay `/events` endpoint. A later WebSocket, or
 * a Tauri / Electron / Capacitor bridge, implements the same FeedSource
 * interface and can push via subscribe() without waiting for the next poll.
 * Nothing here knows about the canvas or a host name.
 *
 * Desktop / mobile shells (leave hooks for later hosts):
 * - Set window.__WORKBENCH_SOURCE__ before the page module runs, or
 * - Call window.workbench.useFeedSource(source) after boot.
 * Prefer subscribe() for native push / WebSocket; pull() remains the snapshot
 * fallback. Paths stay relative so a webview can open dist/ offline.
 */

export type FeedPull =
  | { ok: true; text: string }
  | { ok: false; error: string }

export interface FeedSource {
  /** Shown in the address field. Not necessarily a URL. */
  label: string
  pull(): Promise<FeedPull>
  /** Push a full snapshot whenever the feed changes. Polling sources omit this. */
  subscribe?(onData: (pull: FeedPull) => void): () => void
  close?(): void
}

export type TextRead =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string }

export type TextFetch = (url: string) => Promise<TextRead>

export type ScheduleFn = (fn: () => void, ms: number) => () => void

/** Visible-tab poll interval (ms). Hidden tabs back off. */
export const POLL_VISIBLE_MS = 1200
export const POLL_HIDDEN_MS = 8000
/** When SSE is healthy, poll less often as a safety net. */
export const POLL_SSE_BACKUP_MS = 5000

/** Join a path onto Vite's relative base. Never prefixes a scheme or host. */
export function pageUrl(path: string, base = './'): string {
  const cleanBase = base.endsWith('/') ? base : `${base}/`
  const cleanPath = path.replace(/^\.\//, '').replace(/^\//, '')
  return `${cleanBase}${cleanPath}`
}

export function browserTextFetch(): TextFetch {
  return async (url) => {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      return { ok: true, status: response.status, text: await response.text() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '未知错误' }
    }
  }
}

export function httpFeedSource(url: string, fetchText: TextFetch = browserTextFetch()): FeedSource {
  return {
    label: url,
    async pull() {
      const result = await fetchText(url)
      if (!result.ok) return { ok: false, error: `事件流读取失败：${result.error}` }
      if (result.status < 200 || result.status >= 300) {
        return { ok: false, error: `事件流读取失败：HTTP ${result.status}` }
      }
      return { ok: true, text: result.text }
    },
  }
}

/**
 * If the events URL ends with `/events`, return the SSE sibling `/events/stream`.
 * Relative paths without a usable base still resolve when `location` exists.
 */
export function streamUrlFromEvents(eventsUrl: string): string | null {
  const trimmed = eventsUrl.trim()
  if (!trimmed) return null
  try {
    const base =
      typeof location !== 'undefined' && location.href ? location.href : 'https://example.invalid/'
    const u = new URL(trimmed, base)
    if (!u.pathname.endsWith('/events')) return null
    u.pathname = `${u.pathname}/stream`
    u.search = ''
    u.hash = ''
    // Drop the placeholder origin when the input was absolute already.
    return u.toString()
  } catch {
    return null
  }
}

export function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

export function pollIntervalMs(opts: { visible: boolean; pushHealthy: boolean }): number {
  if (!opts.visible) return POLL_HIDDEN_MS
  if (opts.pushHealthy) return POLL_SSE_BACKUP_MS
  return POLL_VISIBLE_MS
}

export interface EventSourceLike {
  readyState: number
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  close(): void
}

function defaultEventSource(url: string): EventSourceLike | null {
  if (typeof EventSource === 'undefined') return null
  try {
    return new EventSource(url)
  } catch {
    return null
  }
}

/**
 * HTTP pull plus optional SSE push for relay-style `/events` URLs.
 * Arbitrary JSONL feeds stay poll-only via httpFeedSource.
 */
export function liveFeedSource(
  eventsUrl: string,
  fetchText: TextFetch = browserTextFetch(),
  openEventSource: (url: string) => EventSourceLike | null = defaultEventSource,
): FeedSource {
  const http = httpFeedSource(eventsUrl, fetchText)
  const streamUrl = streamUrlFromEvents(eventsUrl)
  if (!streamUrl) return http
  if (openEventSource === defaultEventSource && typeof EventSource === 'undefined') {
    return http
  }

  return {
    label: eventsUrl,
    pull: () => http.pull(),
    subscribe(onData) {
      const es = openEventSource(streamUrl)
      if (!es) return () => {}

      const onMessage = (event: Event) => {
        const data = (event as MessageEvent).data
        if (typeof data === 'string' && data.trim()) {
          onData({ ok: true, text: data })
        }
      }
      const onError = () => {
        if (es.readyState === 2 /* CLOSED */) {
          onData({ ok: false, error: '实时通道已关闭' })
        }
      }

      es.addEventListener('feed', onMessage)
      es.addEventListener('message', onMessage)
      es.addEventListener('error', onError)

      return () => {
        es.removeEventListener('feed', onMessage)
        es.removeEventListener('message', onMessage)
        es.removeEventListener('error', onError)
        es.close()
      }
    },
  }
}

/**
 * Start either a poll loop or a push subscription (legacy / test path).
 * When the source has subscribe(), only push + one initial pull run — no timer.
 * Production relay feeds use openAdaptiveFeed instead (SSE + visibility poll).
 */
export function openFeed(
  source: FeedSource,
  onPull: (pull: FeedPull) => void,
  everyMs: number,
  schedule: ScheduleFn,
): () => void {
  let stopped = false
  const deliver = (pull: FeedPull) => {
    if (!stopped) onPull(pull)
  }
  if (source.subscribe) {
    const stop = source.subscribe(deliver)
    void source.pull().then(deliver)
    return () => {
      stopped = true
      stop()
      source.close?.()
    }
  }
  const tick = () => {
    void source.pull().then(deliver)
  }
  tick()
  const cancel = schedule(tick, everyMs)
  return () => {
    stopped = true
    cancel()
    source.close?.()
  }
}

/**
 * Hybrid live feed: SSE push when available, plus visibility-aware polling.
 * Keeps last-good data upstream; this only schedules fetches.
 */
export function openAdaptiveFeed(
  source: FeedSource,
  onPull: (pull: FeedPull) => void,
  schedule: ScheduleFn,
  opts: {
    visibleMs?: number
    hiddenMs?: number
    backupMs?: number
    isVisible?: () => boolean
    onVisibilityChange?: (handler: () => void) => () => void
  } = {},
): () => void {
  const visibleMs = opts.visibleMs ?? POLL_VISIBLE_MS
  const hiddenMs = opts.hiddenMs ?? POLL_HIDDEN_MS
  const backupMs = opts.backupMs ?? POLL_SSE_BACKUP_MS
  const isVisible = opts.isVisible ?? isDocumentVisible

  let stopped = false
  let pushHealthy = false
  let cancelPoll: () => void = () => {}

  const deliver = (pull: FeedPull) => {
    if (stopped) return
    onPull(pull)
  }

  const deliverPush = (pull: FeedPull) => {
    if (stopped) return
    if (pull.ok) pushHealthy = true
    else pushHealthy = false
    onPull(pull)
  }

  const stopPush = source.subscribe?.(deliverPush)

  const nextDelay = () => {
    if (!isVisible()) return hiddenMs
    if (pushHealthy) return backupMs
    return visibleMs
  }

  const arm = () => {
    cancelPoll()
    if (stopped) return
    cancelPoll = schedule(() => {
      void source.pull().then(deliver)
      arm()
    }, nextDelay())
  }

  void source.pull().then(deliver)
  arm()

  const onVis = () => {
    if (stopped) return
    void source.pull().then(deliver)
    arm()
  }

  let removeVis = () => {}
  if (opts.onVisibilityChange) {
    removeVis = opts.onVisibilityChange(onVis)
  } else if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVis)
    removeVis = () => document.removeEventListener('visibilitychange', onVis)
  }

  return () => {
    stopped = true
    cancelPoll()
    stopPush?.()
    removeVis()
    source.close?.()
  }
}
