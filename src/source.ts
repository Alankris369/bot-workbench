/**
 * Where the event text comes from.
 *
 * The page polls an HTTP source today. A later WebSocket, or a Tauri / Electron /
 * Capacitor bridge, implements the same interface and can subscribe() instead of
 * waiting for the next poll. Nothing here knows about the canvas or a host name.
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

/** Join a path onto Vite's relative base. Never prefixes a scheme or host. */
export function pageUrl(path: string, base = './'): string {
  const cleanBase = base.endsWith('/') ? base : `${base}/`
  const cleanPath = path.replace(/^\//, '')
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
 * Start either a poll loop or a push subscription.
 * `schedule` is injected so this file does not touch window timers.
 * The returned function stops further deliveries.
 */
export function openFeed(
  source: FeedSource,
  onPull: (pull: FeedPull) => void,
  everyMs: number,
  schedule: (fn: () => void, ms: number) => () => void,
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
