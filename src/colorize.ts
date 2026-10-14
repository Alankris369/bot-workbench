/**
 * Photoshop-style grayscale colorize.
 * Adapted from pixel-agents `webview-ui/src/office/colorize.ts` (MIT).
 * Floor tiles in the default pack are grayscale; hue/saturation/brightness/contrast
 * turn them into wood and carpet without editing the PNGs.
 */
export interface Hsbc {
  /** Hue in degrees, 0–360. */
  h: number
  /** Saturation, 0–100. */
  s: number
  /** Brightness shift, about -100–100. */
  b: number
  /** Contrast around mid gray, about -100–100. */
  c: number
}

export function colorizeImage(img: HTMLImageElement, color: Hsbc): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  const sat = color.s / 100

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 2) continue
    let lightness = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
    if (color.c !== 0) {
      const factor = (100 + color.c) / 100
      lightness = 0.5 + (lightness - 0.5) * factor
    }
    if (color.b !== 0) lightness += color.b / 200
    lightness = Math.max(0, Math.min(1, lightness))
    const [r, g, b] = hslToRgb(color.h, sat, lightness)
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (hp < 1) {
    r1 = c
    g1 = x
  } else if (hp < 2) {
    r1 = x
    g1 = c
  } else if (hp < 3) {
    g1 = c
    b1 = x
  } else if (hp < 4) {
    g1 = x
    b1 = c
  } else if (hp < 5) {
    r1 = x
    b1 = c
  } else {
    r1 = c
    b1 = x
  }
  const m = l - c / 2
  return [clamp((r1 + m) * 255), clamp((g1 + m) * 255), clamp((b1 + m) * 255)]
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}
