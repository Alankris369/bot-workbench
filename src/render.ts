import type { Art } from './assets'
import {
  FRAME_H,
  FRAME_W,
  PROPS,
  ROWS,
  COLS,
  SEATS,
  SIT_OFFSET,
  TILE,
  WORLD_H,
  WORLD_W,
  isCarpet,
  isFloor,
  isWall,
  seatFeet,
  wallMask,
  type Dir,
  type Prop,
} from './scene'
import type { BotRecord, BotStatus } from './types'

export interface Anchor {
  id: string
  /** CSS pixels, center of the sprite. */
  x: number
  /** CSS pixels, top of the sprite. */
  y: number
}

/** Magenta used only by the traveling envelope, so a pixel check can see it. */
export const ENVELOPE_RGB = { r: 255, g: 79, b: 216 } as const

export interface FlightDraw {
  fromId: string
  toId: string
  startMs: number
  durationMs: number
}

interface Drawable {
  z: number
  layer: number
  draw: (ctx: CanvasRenderingContext2D, zoom: number) => void
}

export function fitZoom(width: number, height: number): number {
  if (width < 32 || height < 32) return 2
  const z = Math.floor(Math.min(width / WORLD_W, Math.max(height - 8, 1) / WORLD_H))
  if (z >= 2) return Math.min(4, z)
  // A phone is narrower than two pixels per sprite pixel. Draw at 2x and let the stage scroll
  // so the characters stay readable.
  return 2
}

export function resizeBoard(canvas: HTMLCanvasElement, board: HTMLElement, zoom: number): void {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
  canvas.width = WORLD_W * zoom * dpr
  canvas.height = WORLD_H * zoom * dpr
  const cssW = `${WORLD_W * zoom}px`
  const cssH = `${WORLD_H * zoom}px`
  canvas.style.width = cssW
  canvas.style.height = cssH
  board.style.width = cssW
  board.style.height = cssH
}

export function renderOffice(
  ctx: CanvasRenderingContext2D,
  art: Art,
  zoom: number,
  time: number,
  bots: BotRecord[],
  highlightId: string | null,
  flights: FlightDraw[] = [],
): Anchor[] {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#14141f'
  ctx.fillRect(0, 0, WORLD_W * zoom, WORLD_H * zoom)

  drawFloors(ctx, art, zoom)

  const statusById = new Map(bots.map((bot) => [bot.id, bot.status]))
  const drawables: Drawable[] = []

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!isWall(col, row)) continue
      const mask = wallMask(col, row)
      const bottom = (row + 1) * TILE
      drawables.push({
        z: bottom,
        layer: 0,
        draw: (c, z) => drawSheet(c, art.wall, (mask % 4) * 16, Math.floor(mask / 4) * 32, 16, 32, col * TILE, bottom - 32, z),
      })
    }
  }

  for (const prop of PROPS) {
    const bottom = (prop.row + prop.footH) * TILE
    drawables.push({
      z: bottom - (prop.lift ?? 0),
      layer: prop.layer,
      draw: (c, z) => drawProp(c, art, prop, statusById, time, z),
    })
  }

  const anchors: Anchor[] = []
  for (const bot of bots) {
    const seat = SEATS[bot.id]
    if (!seat) continue
    const sheet = art.characters[bot.palette] ?? art.characters[0]
    const feet = seatFeet(seat)
    const pose = poseFor(bot, seat.col, time)
    const sit = pose.sitting ? SIT_OFFSET : 0
    const drawX = feet.x - FRAME_W / 2
    const drawY = feet.y + sit - FRAME_H
    drawables.push({
      z: feet.y + sit + 0.5,
      layer: 3,
      draw: (c, z) => {
        drawCharacter(c, sheet, pose.frame, pose.dir, drawX, drawY, z)
        if (bot.id === highlightId) {
          c.strokeStyle = '#ffffff'
          c.lineWidth = 1
          c.strokeRect(Math.round(drawX * z) - 1, Math.round(drawY * z) - 1, FRAME_W * z + 2, FRAME_H * z + 2)
        }
      },
    })
    anchors.push({
      id: bot.id,
      x: feet.x * zoom,
      y: drawY * zoom - 4,
    })
  }

  drawables.sort((a, b) => a.z - b.z || a.layer - b.layer)
  for (const item of drawables) item.draw(ctx, zoom)
  drawFlights(ctx, anchors, flights, time, zoom)
  return anchors
}

function drawFlights(
  ctx: CanvasRenderingContext2D,
  anchors: Anchor[],
  flights: FlightDraw[],
  timeSec: number,
  zoom: number,
): void {
  if (!flights.length) return
  const nowMs = timeSec * 1000
  const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]))
  const scale = Math.max(zoom, 2)
  const color = `rgb(${ENVELOPE_RGB.r}, ${ENVELOPE_RGB.g}, ${ENVELOPE_RGB.b})`
  ctx.save()
  ctx.imageSmoothingEnabled = false
  for (const flight of flights) {
    const from = byId.get(flight.fromId)
    const to = byId.get(flight.toId)
    if (!from || !to) continue
    const t = (nowMs - flight.startMs) / flight.durationMs
    if (t < 0 || t >= 1) continue
    const eased = t * t * (3 - 2 * t)
    const start = { x: from.x, y: from.y + 14 * zoom }
    const end = { x: to.x, y: to.y + 14 * zoom }
    const control = {
      x: (start.x + end.x) / 2,
      y: Math.min(start.y, end.y) - 72,
    }
    for (let i = 0; i <= 8; i += 1) {
      const point = quad(start, control, end, eased * (i / 8))
      const size = Math.max(2, scale)
      ctx.fillStyle = color
      ctx.fillRect(Math.round(point.x - size / 2), Math.round(point.y - size / 2), size, size)
    }
    const head = quad(start, control, end, eased)
    const width = 12 * scale
    const height = 8 * scale
    const left = Math.round(head.x - width / 2)
    const top = Math.round(head.y - height / 2)
    ctx.fillStyle = color
    ctx.fillRect(left, top, width, height)
    ctx.fillStyle = '#2a1024'
    ctx.fillRect(left, top + Math.round(height / 2), width, Math.max(1, scale))
  }
  ctx.restore()
}

function quad(
  start: { x: number; y: number },
  control: { x: number; y: number },
  end: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const inv = 1 - t
  return {
    x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
    y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
  }
}

function poseFor(bot: BotRecord, col: number, time: number): { frame: number; dir: Dir; sitting: boolean } {
  if (bot.status === 'working') {
    return { frame: 3 + (Math.floor(time / 0.3) % 2), dir: 'up', sitting: true }
  }
  if (bot.status === 'waiting') {
    return { frame: 5 + (Math.floor(time / 0.5) % 2), dir: 'down', sitting: false }
  }
  const glance = time % 4 > 3.15
  if (glance) return { frame: 1, dir: col < 8 ? 'right' : 'left', sitting: false }
  const shift = Math.floor(time / 0.55) % 4
  const frame = shift === 1 ? 0 : shift === 3 ? 2 : 1
  return { frame, dir: 'down', sitting: false }
}

function drawFloors(ctx: CanvasRenderingContext2D, art: Art, zoom: number): void {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!isFloor(col, row)) continue
      const tile = isCarpet(col, row) ? art.carpet : art.wood
      ctx.drawImage(tile, col * TILE * zoom, row * TILE * zoom, TILE * zoom, TILE * zoom)
    }
  }
}

function drawProp(
  ctx: CanvasRenderingContext2D,
  art: Art,
  prop: Prop,
  statusById: Map<string, BotStatus>,
  time: number,
  zoom: number,
): void {
  const bottom = (prop.row + prop.footH) * TILE - (prop.lift ?? 0)
  const x = prop.col * TILE
  const y = bottom - prop.h
  if (prop.sprite === 'pc') {
    const working = prop.botId ? statusById.get(prop.botId) === 'working' : false
    const frame = working ? art.pcOn[Math.floor(time / 0.35) % art.pcOn.length] : art.pcOff
    ctx.drawImage(frame, x * zoom, y * zoom, prop.w * zoom, prop.h * zoom)
    return
  }
  const img = art.furniture[prop.sprite]
  if (!img) return
  ctx.drawImage(img, x * zoom, y * zoom, prop.w * zoom, prop.h * zoom)
}

function drawSheet(
  ctx: CanvasRenderingContext2D,
  sheet: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  zoom: number,
): void {
  ctx.drawImage(sheet, sx, sy, sw, sh, Math.round(dx * zoom), Math.round(dy * zoom), sw * zoom, sh * zoom)
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  frame: number,
  dir: Dir,
  dx: number,
  dy: number,
  zoom: number,
): void {
  const sx = frame * FRAME_W
  const sy = dir === 'down' ? 0 : dir === 'up' ? FRAME_H : FRAME_H * 2
  const dw = FRAME_W * zoom
  const dh = FRAME_H * zoom
  const x = Math.round(dx * zoom)
  const y = Math.round(dy * zoom)
  if (dir === 'left') {
    ctx.save()
    ctx.translate(x + dw, y)
    ctx.scale(-1, 1)
    ctx.drawImage(sheet, sx, sy, FRAME_W, FRAME_H, 0, 0, dw, dh)
    ctx.restore()
    return
  }
  ctx.drawImage(sheet, sx, sy, FRAME_W, FRAME_H, x, y, dw, dh)
}
