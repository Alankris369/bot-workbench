import { colorizeImage, type Hsbc } from './colorize'

const WOOD: Hsbc = { h: 28, s: 42, b: -8, c: 16 }
const CARPET: Hsbc = { h: 214, s: 34, b: 6, c: 8 }

export interface Art {
  characters: HTMLImageElement[]
  wood: HTMLCanvasElement
  carpet: HTMLCanvasElement
  wall: HTMLImageElement
  furniture: Record<string, HTMLImageElement>
  pcOn: HTMLImageElement[]
  pcOff: HTMLImageElement
}

function url(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`
}

function loadImage(path: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`图片加载失败：${path}`))
    img.src = url(path)
  })
}

/** Default pixel-agents sprites. PNGs are copied unchanged. */
export async function loadArt(): Promise<Art> {
  const characterPaths = [0, 1, 2, 3, 4, 5].map((n) => `assets/characters/char_${n}.png`)
  const furniturePaths: Record<string, string> = {
    desk: 'assets/furniture/DESK/DESK_FRONT.png',
    chair: 'assets/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png',
    plant: 'assets/furniture/PLANT/PLANT.png',
    cactus: 'assets/furniture/CACTUS/CACTUS.png',
    bin: 'assets/furniture/BIN/BIN.png',
    bookshelf: 'assets/furniture/BOOKSHELF/BOOKSHELF.png',
    whiteboard: 'assets/furniture/WHITEBOARD/WHITEBOARD.png',
    clock: 'assets/furniture/CLOCK/CLOCK.png',
  }
  const pcPaths = [1, 2, 3].map((n) => `assets/furniture/PC/PC_FRONT_ON_${n}.png`)

  const [characters, floorWood, floorCarpet, wall, furnitureList, pcOn, pcOff] = await Promise.all([
    Promise.all(characterPaths.map(loadImage)),
    loadImage('assets/floors/floor_1.png'),
    loadImage('assets/floors/floor_5.png'),
    loadImage('assets/walls/wall_0.png'),
    Promise.all(Object.values(furniturePaths).map(loadImage)),
    Promise.all(pcPaths.map(loadImage)),
    loadImage('assets/furniture/PC/PC_FRONT_OFF.png'),
  ])

  const furniture: Record<string, HTMLImageElement> = {}
  Object.keys(furniturePaths).forEach((key, i) => {
    furniture[key] = furnitureList[i]
  })

  return {
    characters,
    wood: colorizeImage(floorWood, WOOD),
    carpet: colorizeImage(floorCarpet, CARPET),
    wall,
    furniture,
    pcOn,
    pcOff,
  }
}
