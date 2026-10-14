import assert from 'node:assert/strict'
import {
  applyPollResult,
  CONNECTION_LABEL,
  emptyFeedState,
  FEED_WINDOW,
  LOG_CAP,
  parseEventFeed,
  resolveFeedUrl,
  type FeedBot,
  type FeedState,
} from '../src/feed.ts'
import {
  buildCommandPayload,
  RELAY_COMMAND_URL,
  RELAY_EVENTS_URL,
  RELAY_STREAM_URL,
} from '../src/command.ts'
import {
  httpFeedSource,
  liveFeedSource,
  openAdaptiveFeed,
  openFeed,
  pageUrl,
  pollIntervalMs,
  POLL_HIDDEN_MS,
  POLL_SSE_BACKUP_MS,
  POLL_VISIBLE_MS,
  streamUrlFromEvents,
  type FeedSource,
} from '../src/source.ts'

const results: { name: string; ok: boolean; detail: string }[] = []
const pending: Promise<void>[] = []

function record(name: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  results.push({ name, ok: false, detail })
  console.log(`FAIL  ${name} — ${detail}`)
}

function check(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      pending.push(
        result.then(
          () => {
            results.push({ name, ok: true, detail: '' })
            console.log(`PASS  ${name}`)
          },
          (err: unknown) => record(name, err),
        ),
      )
      return
    }
    results.push({ name, ok: true, detail: '' })
    console.log(`PASS  ${name}`)
  } catch (err) {
    record(name, err)
  }
}

function bots(): FeedBot[] {
  return [
    { id: 'lead', name: '总工程师', status: 'idle', activity: '' },
    { id: 'frontend', name: '前端开发', status: 'idle', activity: '' },
    { id: 'integration', name: '集成开发', status: 'idle', activity: '' },
    { id: 'qa', name: '测试员', status: 'waiting', activity: '等着' },
  ]
}

function message(id: string, text = id, from = 'frontend', to = 'qa'): string {
  return JSON.stringify({ id, type: 'message', from, to, text, time: '2026-10-13T00:00:00.000Z' })
}

function qa(state: FeedState): FeedBot {
  const bot = state.bots.find((item) => item.id === 'qa')
  assert.ok(bot)
  return bot
}

check('query param beats saved address and config', () => {
  const url = resolveFeedUrl({
    query: 'https://example.com/live.jsonl',
    saved: 'data/saved.jsonl',
    config: 'data/config.jsonl',
    fallback: 'data/events.jsonl',
  })
  assert.equal(url, 'https://example.com/live.jsonl')
})

check('blank config falls through to the local file', () => {
  const url = resolveFeedUrl({ query: '  ', saved: '', config: '', fallback: 'data/events.jsonl' })
  assert.equal(url, 'data/events.jsonl')
})

check('config is used when nothing else is set', () => {
  const url = resolveFeedUrl({ query: null, saved: null, config: 'https://example.com/a.jsonl', fallback: 'data/events.jsonl' })
  assert.equal(url, 'https://example.com/a.jsonl')
})

check('malformed lines are skipped and the rest are kept', () => {
  const parsed = parseEventFeed(
    `${message('a', '甲')}\n{bad\n${message('b', '乙', '测试员', '总工程师')}\n`,
    bots(),
  )
  assert.equal(parsed.fatal, false)
  assert.equal(parsed.events.length, 2)
  assert.equal(parsed.events[0]?.type === 'message' && parsed.events[0].text, '甲')
  assert.equal(parsed.events[1]?.type === 'message' && parsed.events[1].from, 'qa')
  assert.equal(parsed.events[1]?.type === 'message' && parsed.events[1].to, 'lead')
  assert.ok(parsed.errors.some((error) => error.includes('不是 JSON')))
})

check('a JSON array parses, and an HTML body is fatal', () => {
  const list = parseEventFeed('[{"type":"status","bot":"qa","status":"idle","activity":"","time":"2026-10-13T00:00:00.000Z","id":"s"}]')
  assert.equal(list.events.length, 1)
  assert.equal(list.events[0]?.type === 'status' && list.events[0].status, 'idle')
  const html = parseEventFeed('<!doctype html><html></html>')
  assert.equal(html.fatal, true)
  assert.equal(html.events.length, 0)
})

check('relay {events:[...]} wrapper parses', () => {
  const body = JSON.stringify({
    events: [
      {
        id: 'r1',
        type: 'status',
        bot: '测试员',
        status: 'working',
        activity: '链路',
        time: '2026-10-14T00:00:00.000Z',
      },
      {
        id: 'r2',
        type: 'message',
        from: 'frontend',
        to: 'qa',
        text: '中转站来的',
        time: '2026-10-14T00:00:01.000Z',
      },
    ],
  })
  const parsed = parseEventFeed(body, bots())
  assert.equal(parsed.fatal, false)
  assert.equal(parsed.events.length, 2)
  assert.equal(parsed.events[0]?.type === 'status' && parsed.events[0].bot, 'qa')
  assert.equal(parsed.events[1]?.type === 'message' && parsed.events[1].text, '中转站来的')
})

check('duplicate ids are applied once', () => {
  const text = `${message('same', '第一句')}\n${message('same', '第二句')}`
  const result = applyPollResult(emptyFeedState(bots()), { ok: true, text, first: true })
  assert.equal(result.state.messages.length, 1)
  assert.equal(result.state.messages[0]?.text, '第一句')
  assert.deepEqual(result.state.seen, ['same'])
  assert.equal(result.animate.length, 0)
})

check('history fills the log without flipping the receiver', () => {
  const result = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('m1', '旧消息'), first: true })
  assert.equal(result.connection, 'live')
  assert.equal(result.ready, true)
  assert.equal(result.animate.length, 0)
  assert.equal(result.state.messages.length, 1)
  assert.equal(qa(result.state).status, 'waiting')
})

check('a new message sets the receiver to working', () => {
  const first = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('m1', '旧消息'), first: true })
  const second = applyPollResult(first.state, {
    ok: true,
    text: `${message('m1', '旧消息')}\n${message('m2', '新消息')}`,
    first: false,
  })
  assert.equal(second.animate.length, 1)
  assert.equal(second.animate[0]?.id, 'm2')
  assert.equal(qa(second.state).status, 'working')
  assert.equal(qa(second.state).activity, '在看前端开发的消息')
  assert.equal(second.state.messages.length, 2)
})

check('the same id is not applied on the next poll', () => {
  const first = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('m1'), first: true })
  const second = applyPollResult(first.state, { ok: true, text: message('m1'), first: false })
  assert.equal(second.animate.length, 0)
  assert.equal(second.state.messages.length, 1)
  assert.equal(qa(second.state).status, 'waiting')
})

check('a status event updates that bot', () => {
  const text = JSON.stringify({
    id: 'st',
    type: 'status',
    bot: '集成开发',
    status: 'working',
    activity: '在对接口',
    time: '2026-10-13T00:00:01.000Z',
  })
  const result = applyPollResult(emptyFeedState(bots()), { ok: true, text, first: true })
  const integration = result.state.bots.find((bot) => bot.id === 'integration')
  assert.equal(integration?.status, 'working')
  assert.equal(integration?.activity, '在对接口')
  assert.equal(result.animate.length, 0)
})

check('unknown bots and bad statuses are reported and skipped', () => {
  const text = [
    JSON.stringify({ id: 'bad', type: 'status', bot: '外人', status: 'working', activity: '', time: '2026-10-13T00:00:00.000Z' }),
    JSON.stringify({ id: 'bad2', type: 'status', bot: 'qa', status: 'asleep', activity: '', time: '2026-10-13T00:00:00.000Z' }),
    message('ok', '还在'),
  ].join('\n')
  const result = applyPollResult(emptyFeedState(bots()), { ok: true, text, first: true })
  assert.equal(result.connection, 'degraded')
  assert.equal(result.state.messages.length, 1)
  assert.equal(qa(result.state).status, 'waiting')
  assert.match(result.error ?? '', /不认识|必须是/)
})

check('the log keeps only the newest lines', () => {
  const lines = Array.from({ length: LOG_CAP + 15 }, (_, index) => message(`m${index}`, `t${index}`))
  const result = applyPollResult(emptyFeedState(bots()), { ok: true, text: lines.join('\n'), first: true })
  assert.equal(result.state.messages.length, LOG_CAP)
  assert.equal(result.state.messages[0]?.id, 'm15')
  assert.equal(result.state.messages.at(-1)?.id, `m${LOG_CAP + 14}`)
  assert.equal(result.state.seen.length, LOG_CAP + 15)
})

check('a long feed does not keep every id forever', () => {
  let state = emptyFeedState(bots())
  const lines: string[] = []
  for (let index = 0; index < FEED_WINDOW + 80; index += 1) {
    lines.push(message(`m${index}`))
    const result = applyPollResult(state, { ok: true, text: lines.join('\n'), first: index === 0 })
    state = result.state
  }
  assert.ok(state.seen.length <= FEED_WINDOW)
  assert.equal(state.seen.length, FEED_WINDOW)
  assert.ok(state.messages.length <= LOG_CAP)
  assert.equal(state.seen[0], `m${80}`)
  assert.equal(state.seen.at(-1), `m${FEED_WINDOW + 79}`)
})

check('a network error keeps the previous log', () => {
  const first = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('m1', '留下'), first: true })
  const failed = applyPollResult(first.state, { ok: false, error: '事件流读取失败：HTTP 500' })
  assert.equal(failed.connection, 'offline')
  assert.equal(failed.ready, true)
  assert.equal(failed.state.messages.length, 1)
  assert.equal(failed.state.messages[0]?.text, '留下')
  assert.equal(qa(failed.state).status, 'waiting')
  assert.equal(CONNECTION_LABEL.offline, '已断开')
})

check('HTML instead of a feed does not wipe the log', () => {
  const first = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('m1', '留下'), first: true })
  const failed = applyPollResult(first.state, { ok: true, text: '<html>nope</html>', first: false })
  assert.equal(failed.connection, 'offline')
  assert.equal(failed.state.messages.length, 1)
  assert.equal(failed.animate.length, 0)
})

check('relative page urls do not grow a host', () => {
  assert.equal(pageUrl('data/events.jsonl', './'), './data/events.jsonl')
  assert.equal(pageUrl('/assets/characters/char_0.png', './').includes('://'), false)
})

check('http source polls the given relative url', async () => {
  let seen = ''
  const source = httpFeedSource('./data/events.jsonl', async (url) => {
    seen = url
    return { ok: true, status: 200, text: message('m1', '来了') }
  })
  assert.equal(source.subscribe, undefined)
  const pull = await source.pull()
  assert.equal(seen, './data/events.jsonl')
  assert.equal(pull.ok, true)
  if (pull.ok) assert.equal(pull.text.includes('来了'), true)
})

check('a push source delivers without a poll timer', () => {
  let scheduled = 0
  let pulls = 0
  const source: FeedSource = {
    label: 'native-bridge',
    async pull() {
      pulls += 1
      return { ok: true, text: '' }
    },
    subscribe(onData) {
      onData({ ok: true, text: message('live', '桥') })
      return () => {}
    },
  }
  const texts: string[] = []
  const stop = openFeed(
    source,
    (pull) => {
      if (pull.ok) texts.push(pull.text)
    },
    2500,
    () => {
      scheduled += 1
      return () => {}
    },
  )
  assert.equal(scheduled, 0)
  assert.equal(texts.some((text) => text.includes('桥')), true)
  assert.equal(pulls, 1)
  stop()
})


check('offline recovery restores live without wiping messages', () => {
  const first = applyPollResult(emptyFeedState(bots()), { ok: true, text: message('keep', '还在'), first: true })
  const down = applyPollResult(first.state, { ok: false, error: '事件流读取失败：HTTP 502' })
  assert.equal(down.connection, 'offline')
  assert.equal(down.state.messages[0]?.text, '还在')
  const up = applyPollResult(down.state, {
    ok: true,
    text: `${message('keep', '还在')}\n${message('new', '回来了')}`,
    first: false,
  })
  assert.equal(up.connection, 'live')
  assert.equal(up.state.messages.length, 2)
  assert.equal(up.animate.length, 1)
  assert.equal(up.animate[0]?.id, 'new')
  assert.equal(CONNECTION_LABEL.offline, '已断开')
})

check('relay wrapper with empty events is live and non-fatal', () => {
  const result = applyPollResult(emptyFeedState(bots()), {
    ok: true,
    text: JSON.stringify({ events: [] }),
    first: true,
  })
  assert.equal(result.connection, 'live')
  assert.equal(result.ready, true)
  assert.equal(result.state.messages.length, 0)
})

check('buildCommandPayload trims and rejects blanks', () => {
  assert.deepEqual(buildCommandPayload(' qa ', ' 测一下 '), { to: 'qa', instruction: '测一下' })
  assert.equal(buildCommandPayload('', 'x'), null)
  assert.equal(buildCommandPayload('qa', '  '), null)
  assert.ok(RELAY_COMMAND_URL.endsWith('/command'))
  assert.ok(RELAY_EVENTS_URL.endsWith('/events'))
  assert.ok(RELAY_STREAM_URL.endsWith('/events/stream'))
})

check('streamUrlFromEvents maps /events to /events/stream', () => {
  assert.equal(
    streamUrlFromEvents('https://bot-workbench-relay.alankris369.workers.dev/events'),
    'https://bot-workbench-relay.alankris369.workers.dev/events/stream',
  )
  assert.equal(streamUrlFromEvents('https://example.com/data/events.jsonl'), null)
  assert.equal(streamUrlFromEvents(''), null)
})

check('pollIntervalMs backs off when hidden and when SSE is healthy', () => {
  assert.equal(pollIntervalMs({ visible: true, pushHealthy: false }), POLL_VISIBLE_MS)
  assert.equal(pollIntervalMs({ visible: false, pushHealthy: false }), POLL_HIDDEN_MS)
  assert.equal(pollIntervalMs({ visible: true, pushHealthy: true }), POLL_SSE_BACKUP_MS)
  assert.ok(POLL_VISIBLE_MS <= 1500 && POLL_VISIBLE_MS >= 1000)
})

check('liveFeedSource still pulls when EventSource factory returns null', async () => {
  const pulls: string[] = []
  const source = liveFeedSource(
    'https://bot-workbench-relay.alankris369.workers.dev/events',
    async (url) => {
      pulls.push(url)
      return { ok: true, status: 200, text: JSON.stringify({ events: [] }) }
    },
    () => null,
  )
  // subscribe exists for relay URLs but is a no-op when the factory cannot open a stream
  assert.equal(typeof source.subscribe, 'function')
  const stop = source.subscribe?.(() => {})
  stop?.()
  const pull = await source.pull()
  assert.equal(pull.ok, true)
  assert.equal(pulls[0], 'https://bot-workbench-relay.alankris369.workers.dev/events')
})

check('openAdaptiveFeed slows down when not visible', async () => {
  const delays: number[] = []
  let visible = true
  let pullCount = 0
  const source: FeedSource = {
    label: 'test',
    async pull() {
      pullCount += 1
      return { ok: true, text: JSON.stringify({ events: [] }) }
    },
  }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const stop = openAdaptiveFeed(
    source,
    () => {},
    (fn, ms) => {
      delays.push(ms)
      timers.push({ fn, ms })
      return () => {}
    },
    {
      visibleMs: 1200,
      hiddenMs: 8000,
      backupMs: 5000,
      isVisible: () => visible,
      onVisibilityChange: () => () => {},
    },
  )
  // Allow the initial pull promise to settle.
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(pullCount >= 1)
  assert.equal(delays[0], 1200)
  visible = false
  // Fire the scheduled tick to re-arm with hidden delay.
  timers[0]?.fn()
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(delays.some((ms) => ms === 8000))
  stop()
})

check('openAdaptiveFeed uses SSE subscribe when present', async () => {
  const texts: string[] = []
  let unsub = 0
  const source: FeedSource = {
    label: 'relay',
    async pull() {
      return { ok: true, text: JSON.stringify({ events: [] }) }
    },
    subscribe(onData) {
      onData({ ok: true, text: JSON.stringify({ events: [{ id: 's', type: 'status', bot: 'qa', status: 'idle', activity: '', time: '2026-10-14T00:00:00.000Z' }] }) })
      return () => {
        unsub += 1
      }
    },
  }
  const stop = openAdaptiveFeed(
    source,
    (pull) => {
      if (pull.ok) texts.push(pull.text)
    },
    (fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    },
    {
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    },
  )
  await Promise.resolve()
  assert.ok(texts.some((text) => text.includes('"id":"s"')))
  stop()
  assert.equal(unsub, 1)
})

await Promise.all(pending)
const failed = results.filter((item) => !item.ok)
console.log(failed.length ? `FEED FAIL (${failed.length})` : 'FEED PASS')
process.exit(failed.length ? 1 : 0)
