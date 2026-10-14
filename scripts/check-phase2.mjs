#!/usr/bin/env node
/**
 * Phase 2 gate: unit checks, production build, then a headless page check.
 * Prints PASS or FAIL for each step and exits non-zero if any fail.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { appendEvent, createEvent, createMessageEvent, createStatusEvent } from './event-file.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const eventsFile = path.join(root, 'data', 'events.jsonl')
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`
  console.log(line)
  return ok
}

function runUnit() {
  try {
    execFileSync('node', ['--experimental-strip-types', 'scripts/feed.test.ts'], { cwd: root, stdio: 'inherit' })
    check('event parsing and state tests', true)
  } catch {
    check('event parsing and state tests', false, '见上面的 FEED 结果')
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-events-'))
  const file = path.join(dir, 'nested', 'events.jsonl')
  try {
    const message = createMessageEvent({ from: '前端开发', to: '测试员', text: ' 你好 ', id: 'u1', time: '2026-10-13T00:00:00.000Z' })
    check('cli resolves Chinese names', message.from === 'frontend' && message.to === 'qa' && message.text === '你好')
    let rejected = false
    try {
      createStatusEvent({ bot: '测试员', status: 'asleep' })
    } catch {
      rejected = true
    }
    check('cli rejects a bad status', rejected)

    appendEvent(file, message)
    appendEvent(file, createEvent({ type: 'status', bot: 'qa', status: 'working', activity: '在看', id: 'u2', time: '2026-10-13T00:00:01.000Z' }))
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    check('append writes two JSON lines', lines.length === 2 && JSON.parse(lines[0]).id === 'u1' && JSON.parse(lines[1]).type === 'status')

    execFileSync('node', ['scripts/post-event.mjs', '--file', file, '--from', '总工程师', '--to', '集成开发', '--text', 'cli一行'], {
      cwd: root,
      stdio: 'pipe',
    })
    const afterCli = fs.readFileSync(file, 'utf8').trim().split('\n')
    const last = JSON.parse(afterCli[afterCli.length - 1])
    check('npm post appends one message', last.from === 'lead' && last.to === 'integration' && last.text === 'cli一行')

    let cliFailed = false
    try {
      execFileSync('node', ['scripts/post-event.mjs', '--file', file, '--type', 'status', '--bot', 'qa', '--status', 'nope'], {
        cwd: root,
        stdio: 'pipe',
      })
    } catch (err) {
      cliFailed = err.status === 1
    }
    check('npm post exits 1 on a bad status', cliFailed)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runBuild() {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  const relay = fs.readFileSync(path.join(root, 'dist', 'data', 'relay.jsonl'), 'utf8')
  const events = fs.readFileSync(path.join(root, 'dist', 'data', 'events.jsonl'), 'utf8')
  const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8')
  const config = fs.readFileSync(path.join(root, 'dist', 'data', 'config.json'), 'utf8')
  check('build copies the relay', relay.includes('验收通过，请你拍板。'))
  check('build copies the event feed', events.includes('"type":"message"'))
  check('build copies feed config', config.includes('"feed"'))
  check('build keeps the replay button', html.includes('重放接力'))
  check('build uses relative asset paths', html.includes('./assets/') && !html.includes('src="/assets/'))
  const manifest = fs.readFileSync(path.join(root, 'dist', 'manifest.webmanifest'), 'utf8')
  const js = fs.readFileSync(path.join(root, 'dist', 'assets', fs.readdirSync(path.join(root, 'dist', 'assets')).find((name) => name.endsWith('.js'))), 'utf8')
  check('build ships a relative PWA manifest', html.includes('viewport-fit=cover') && html.includes('./manifest.webmanifest') && manifest.includes('"start_url": "./"'))
  check('bundle has no hard-coded origin', !js.includes('127.0.0.1') && !js.includes('location.origin'))
}

function freePort(port) {
  let out = ''
  try {
    out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' })
  } catch {
    return
  }
  for (const pid of out.split(/\s+/).filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

function chromeBin() {
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      execFileSync('which', [name], { stdio: 'ignore' })
      return name
    } catch {
      // Try the next name.
    }
  }
  throw new Error('找不到 Chrome 或 Chromium')
}

async function waitForHttp(url, ms) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Server still booting.
    }
    await sleep(250)
  }
  throw new Error(`等不到 ${url}`)
}

function openSocket(url) {
  const WS = globalThis.WebSocket
  if (!WS) throw new Error('当前 Node 没有 WebSocket')
  const ws = new WS(url)
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', () => reject(new Error(`打不开调试端口 ${url}`)))
  })
}

function cdp(ws) {
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (!msg.id || !pending.has(msg.id)) return
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  })
  return (method, params = {}) => {
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text
    throw new Error(text)
  }
  return result.result.value
}

async function waitUntil(send, expression, ms) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < ms) {
    last = await evaluate(send, expression)
    if (last) return last
    await sleep(150)
  }
  return last
}

async function runBrowser() {
  const saved = fs.readFileSync(eventsFile)
  freePort(43123)
  freePort(9333)
  await sleep(400)
  const server = spawn('npm', ['run', 'dev'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  })
  server.unref()

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-chrome-'))
  const chrome = spawn(chromeBin(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1440,900',
    `--remote-debugging-port=9333`,
    `--user-data-dir=${userData}`,
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    await waitForHttp('http://127.0.0.1:43123/', 20_000)
    let version
    for (let i = 0; i < 40; i += 1) {
      try {
        version = await fetch('http://127.0.0.1:9333/json/version').then((res) => res.json())
        break
      } catch {
        await sleep(200)
      }
    }
    if (!version) throw new Error('Chrome 调试端口没有起来')
    const browser = await openSocket(version.webSocketDebuggerUrl)
    const browserSend = cdp(browser)
    const { targetId } = await browserSend('Target.createTarget', { url: 'about:blank' })
    const targets = await fetch('http://127.0.0.1:9333/json/list').then((res) => res.json())
    const page = targets.find((target) => target.id === targetId)
    if (!page) throw new Error('没有打开页面')
    const pageWs = await openSocket(page.webSocketDebuggerUrl)
    const send = cdp(pageWs)
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await send('Page.navigate', { url: 'http://127.0.0.1:43123/' })

    const booted = await waitUntil(send, `(() => {
      const replay = document.querySelector('#replay')
      const log = document.querySelector('#msg-list')?.innerText || ''
      const board = document.querySelector('#board')
      const canvas = document.querySelector('canvas')
      if (!replay || replay.disabled) return null
      if (!log.includes('四个名字先用这版')) return null
      if (!board || board.dataset.flights !== '0') return null
      if (!canvas || canvas.width < 100) return null
      return {
        integration: document.querySelector('.bot-card[data-id="integration"]')?.dataset.status,
        qa: document.querySelector('.bot-card[data-id="qa"]')?.dataset.status,
        bubbles: [...document.querySelectorAll('.bubble')].map((el) => el.textContent),
      }
    })()`, 12_000)
    check('events load before any replay', Boolean(booted), booted ? '' : '页面没有在 12 秒内准备好')
    if (!booted) return
    check('old events do not fly', booted.integration === 'idle' && booted.qa === 'waiting' && !booted.bubbles.some((text) => text.includes('首页改完了')))

    const labels = await evaluate(send, `({
      connection: document.querySelector('#connection')?.dataset.state,
      connectionText: document.querySelector('#connection span')?.textContent,
      duty: document.querySelector('.bot-card[data-id="lead"] .sub')?.textContent,
      pill: document.querySelector('.bot-card[data-id="lead"] .pill')?.textContent,
    })`)
    check('connection indicator shows live', labels.connection === 'live' && labels.connectionText === '已连接', JSON.stringify(labels))
    const hook = await evaluate(send, `typeof window.workbench?.useFeedSource`)
    check('a later wrapper can replace the feed source', hook === 'function', String(hook))
    check('cards use Chinese labels', labels.duty === '统筹' && labels.pill === '工作中', JSON.stringify(labels))

    async function layoutAt(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 800,
      })
      await sleep(250)
      return evaluate(send, `(() => {
        const stage = document.querySelector('#stage').getBoundingClientRect()
        const panel = document.querySelector('#panel').getBoundingClientRect()
        return {
          sideBySide: stage.width > 0 && panel.width > 0 && stage.right <= panel.left + 2,
          stacked: panel.top >= stage.bottom - 2,
          pageFits: document.documentElement.scrollWidth <= window.innerWidth + 2,
          scrollWidth: document.documentElement.scrollWidth,
          inner: window.innerWidth,
        }
      })()`)
    }
    const laptop = await layoutAt(1280, 800)
    check('laptop keeps the office and the log side by side', laptop.sideBySide && laptop.pageFits, JSON.stringify(laptop))
    const phone = await layoutAt(390, 844)
    check('phone stacks the log under the office', phone.stacked && phone.pageFits, JSON.stringify(phone))
    await layoutAt(1440, 900)
    const wideAgain = await waitUntil(send, `document.querySelector('canvas')?.width > 100`, 4_000)
    check('office canvas is back after resizing', Boolean(wideAgain))

    const parsed = await evaluate(send, `import('/src/events.ts').then((mod) => {
      const feed = mod.parseEventFeed('{"type":"message","from":"前端开发","to":"测试员","text":"你好","time":"2026-10-13T01:00:00.000Z","id":"t1"}\\nnot json\\n{"type":"status","bot":"qa","status":"waiting","activity":"等","time":"2026-10-13T01:00:01.000Z","id":"t2"}')
      const list = mod.parseEventFeed('[{"type":"message","from":"lead","to":"qa","text":"数组","time":"2026-10-13T01:00:02.000Z"}]')
      const again = mod.parseEventFeed('{"type":"message","from":"lead","to":"qa","text":"数组","time":"2026-10-13T01:00:02.000Z"}')
      return {
        from: feed.events[0] && feed.events[0].from,
        to: feed.events[0] && feed.events[0].to,
        status: feed.events[1] && feed.events[1].status,
        error: feed.errors[0] || '',
        arrayId: list.events[0] && list.events[0].id,
        sameId: list.events[0] && again.events[0] && list.events[0].id === again.events[0].id,
      }
    })`)
    check(
      'page parses JSONL and a JSON array',
      parsed.from === 'frontend' && parsed.to === 'qa' && parsed.status === 'waiting' && parsed.error.includes('不是 JSON') && parsed.sameId,
      JSON.stringify(parsed),
    )

    await evaluate(send, `document.querySelector('#replay').click()`)
    const flying = await waitUntil(send, `(() => {
      const bubbles = [...document.querySelectorAll('.bubble')].map((el) => el.textContent || '')
      const hasBubble = bubbles.some((text) => text.includes('首页改完了'))
      const canvas = document.querySelector('canvas')
      const board = document.querySelector('#board')
      if (!canvas || !board?.dataset.envelope) return null
      const [r, g, b] = board.dataset.envelope.split(',').map(Number)
      const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let n = 0
      for (let i = 0; i < img.length; i += 4) {
        if (img[i] === r && img[i + 1] === g && img[i + 2] === b && img[i + 3] === 255) n += 1
      }
      if (!hasBubble || n < 10 || board.dataset.flights === '0') return null
      return { n, flights: board.dataset.flights }
    })()`, 4_000)
    check('replay shows a bubble and the envelope', Boolean(flying), flying ? `${flying.n} magenta pixels, flights=${flying.flights}` : '4 秒内没有同时看到气泡和信封')

    const done = await waitUntil(send, `(() => {
      const log = document.querySelector('#msg-list')?.innerText || ''
      const texts = ['首页改完了，接口按这个对一下。', '接口对齐了，请验收。', '验收通过，请你拍板。']
      if (!texts.every((text) => log.includes(text))) return null
      const routes = [...document.querySelectorAll('#msg-list .route')].map((el) => el.textContent)
      const times = [...document.querySelectorAll('#msg-list time')].map((el) => ({
        dateTime: el.dateTime,
        text: el.textContent,
        expected: new Date(el.dateTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
        utc: new Date(el.dateTime).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false }),
      }))
      return {
        routes,
        integration: document.querySelector('.bot-card[data-id="integration"]')?.dataset.status,
        qa: document.querySelector('.bot-card[data-id="qa"]')?.dataset.status,
        lead: document.querySelector('.bot-card[data-id="lead"]')?.dataset.status,
        times,
      }
    })()`, 15_000)
    if (!done) {
      check('relay log renders', false, '15 秒内没有集齐三句接力')
      return
    }
    const routeOk =
      done.routes[0] === '测试员 → 总工程师' &&
      done.routes[1] === '集成开发 → 测试员' &&
      done.routes[2] === '前端开发 → 集成开发'
    check('relay log lists names in order', routeOk, done.routes.slice(0, 3).join(' | '))
    check(
      'receivers flip to working',
      done.integration === 'working' && done.qa === 'working' && done.lead === 'working',
      `integration=${done.integration} qa=${done.qa} lead=${done.lead}`,
    )
    const seed = done.times.find((item) => item.dateTime.startsWith('2026-10-13T07:33:10'))
    const timesOk = done.times.every((item) => item.text === item.expected)
    check('log times use Asia/Shanghai', Boolean(seed) && timesOk && seed.expected !== seed.utc, seed ? seed.text : '没有种子时间')

    const stamp = Date.now().toString(36)
    const text = `检查${stamp}`
    const posted = await fetch('http://127.0.0.1:43123/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', from: '前端开发', to: '测试员', text }),
    }).then((res) => res.json())
    check('POST /events accepts a message', posted.ok === true && posted.event?.from === 'frontend', JSON.stringify(posted))
    const seen = await waitUntil(send, `(() => {
      const log = document.querySelector('#msg-list')?.innerText || ''
      if (!log.includes(${JSON.stringify(text)})) return null
      return import('/src/events.ts').then((mod) => ({
        count: log.split(${JSON.stringify(text)}).length - 1,
        ids: mod.feedSnapshot().ids,
      }))
    })()`, 8_000)
    check('poll applies only the new event', Boolean(seen) && seen.count === 1 && seen.ids.includes(posted.event?.id), seen ? `count=${seen.count}` : '轮询没有出现新消息')
    if (seen) {
      await sleep(3000)
      const again = await evaluate(send, `(() => {
        const log = document.querySelector('#msg-list')?.innerText || ''
        return log.split(${JSON.stringify(text)}).length - 1
      })()`)
      check('the same event is not applied twice', again === 1, `count=${again}`)
    }

    pageWs.close()
    browser.close()
  } finally {
    fs.writeFileSync(eventsFile, saved)
    try {
      chrome.kill('SIGTERM')
    } catch {
      // Chrome already exited.
    }
    for (let i = 0; i < 5; i += 1) {
      await sleep(200)
      try {
        fs.rmSync(userData, { recursive: true, force: true })
        break
      } catch {
        // Chrome may still be releasing the profile directory.
      }
    }
  }
}

try {
  runUnit()
  runBuild()
  await runBrowser()
} catch (err) {
  check('check script', false, err instanceof Error ? err.stack ?? err.message : String(err))
}

const failed = results.filter((item) => !item.ok)
console.log(failed.length ? `PHASE2 FAIL (${failed.length})` : 'PHASE2 PASS')
process.exit(failed.length ? 1 : 0)
