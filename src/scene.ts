/** Tile size matches pixel-agents. */
export const TILE = 16
export const COLS = 18
export const ROWS = 14
export const WORLD_W = COLS * TILE
export const WORLD_H = ROWS * TILE

/** Character sheet: 7 frames × 16px, 3 rows × 32px (down, up, right). Left is flipped right. */
export const FRAME_W = 16
export const FRAME_H = 32
export const SIT_OFFSET = 6

export type Dir = 'down' | 'up' | 'left' | 'right'

export interface Seat {
  col: number
  row: number
}

/** Fixed desks for the four bots. Names come from JSON; seats stay by id. */
export const SEATS: Record<string, Seat> = {
  lead: { col: 3, row: 7 },
  frontend: { col: 12, row: 7 },
  integration: { col: 3, row: 11 },
  qa: { col: 12, row: 11 },
}

export interface Prop {
  sprite: string
  col: number
  row: number
  w: number
  h: number
  /** Footprint height in tiles. Sprite bottom sits on this edge. */
  footH: number
  layer: number
  /** Shift the sprite up, in world pixels. Used so monitors sit on desks. */
  lift?: number
  botId?: string
}

export const PROPS: Prop[] = [
  { sprite: 'bookshelf', col: 2, row: 3, w: 32, h: 16, footH: 1, layer: 0 },
  { sprite: 'bookshelf', col: 12, row: 3, w: 32, h: 16, footH: 1, layer: 0 },
  { sprite: 'clock', col: 6, row: 2, w: 16, h: 32, footH: 1, layer: 2 },
  { sprite: 'whiteboard', col: 8, row: 3, w: 32, h: 32, footH: 2, layer: 0 },

  { sprite: 'desk', col: 2, row: 5, w: 48, h: 32, footH: 2, layer: 0 },
  { sprite: 'pc', col: 3, row: 5, w: 16, h: 32, footH: 2, layer: 1, lift: 8, botId: 'lead' },
  { sprite: 'chair', col: 3, row: 7, w: 16, h: 16, footH: 1, layer: 0 },

  { sprite: 'desk', col: 11, row: 5, w: 48, h: 32, footH: 2, layer: 0 },
  { sprite: 'pc', col: 12, row: 5, w: 16, h: 32, footH: 2, layer: 1, lift: 8, botId: 'frontend' },
  { sprite: 'chair', col: 12, row: 7, w: 16, h: 16, footH: 1, layer: 0 },

  { sprite: 'desk', col: 2, row: 9, w: 48, h: 32, footH: 2, layer: 0 },
  { sprite: 'pc', col: 3, row: 9, w: 16, h: 32, footH: 2, layer: 1, lift: 8, botId: 'integration' },
  { sprite: 'chair', col: 3, row: 11, w: 16, h: 16, footH: 1, layer: 0 },

  { sprite: 'desk', col: 11, row: 9, w: 48, h: 32, footH: 2, layer: 0 },
  { sprite: 'pc', col: 12, row: 9, w: 16, h: 32, footH: 2, layer: 1, lift: 8, botId: 'qa' },
  { sprite: 'chair', col: 12, row: 11, w: 16, h: 16, footH: 1, layer: 0 },

  { sprite: 'plant', col: 15, row: 4, w: 16, h: 32, footH: 2, layer: 0 },
  { sprite: 'cactus', col: 15, row: 10, w: 16, h: 32, footH: 2, layer: 0 },
  { sprite: 'bin', col: 5, row: 12, w: 16, h: 16, footH: 1, layer: 0 },
]

export function isWall(col: number, row: number): boolean {
  if (row === 2 && col >= 1 && col <= 16) return true
  if ((col === 1 || col === 16) && row >= 2 && row <= 13) return true
  return false
}

export function isFloor(col: number, row: number): boolean {
  return col >= 2 && col <= 15 && row >= 3 && row <= 13
}

export function isCarpet(col: number, row: number): boolean {
  return col >= 6 && col <= 10 && row >= 7 && row <= 8
}

/** N=1 E=2 S=4 W=8, same bitmask as pixel-agents wall auto-tile. */
export function wallMask(col: number, row: number): number {
  let mask = 0
  if (isWall(col, row - 1)) mask |= 1
  if (isWall(col + 1, row)) mask |= 2
  if (isWall(col, row + 1)) mask |= 4
  if (isWall(col - 1, row)) mask |= 8
  return mask
}

export function seatFeet(seat: Seat): { x: number; y: number } {
  return {
    x: seat.col * TILE + TILE / 2,
    y: (seat.row + 1) * TILE,
  }
}
