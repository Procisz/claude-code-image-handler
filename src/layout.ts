import type { CoreEngineInterface } from 'claude-code'
import { encodeBase64 } from './base64'

export type CellBox = { columns: number; rows: number }

export type RendererEnv = Readonly<Record<string, string | undefined>>

export const TILE_INNER_WIDTH = 20
export const MIN_TILE_INNER_WIDTH = 16
export const PICTURE_ROWS = 5
export const TILE_BORDER = 2
export const TILE_GAP = 1

export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const CELL_ASPECT = 2
const SPINNER_COLOR = 0x8ab4f8
const DEFAULT_COLOR = 0x01000000

export function tileInnerWidth(bodyColumns: number): number {
  return Math.min(TILE_INNER_WIDTH, Math.max(MIN_TILE_INNER_WIDTH, bodyColumns - TILE_BORDER))
}

export function pictureBox(width: number, height: number, innerWidth = TILE_INNER_WIDTH): CellBox {
  let rows = PICTURE_ROWS
  let columns = Math.round((rows * CELL_ASPECT * width) / height)
  if (columns > innerWidth) {
    columns = innerWidth
    rows = Math.round((columns * height) / (CELL_ASPECT * width))
  }
  return { columns: Math.max(1, columns), rows: Math.max(1, rows) }
}

export function tilesPerRow(bodyColumns: number): number {
  const tile = tileInnerWidth(bodyColumns) + TILE_BORDER
  return Math.max(1, Math.floor((bodyColumns + TILE_GAP) / (tile + TILE_GAP)))
}

export async function readRendererEnv($: Pick<CoreEngineInterface, 'env'>): Promise<RendererEnv> {
  return {
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TMUX: await $.env.get('TMUX'),
    STY: await $.env.get('STY'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
    CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
    CLAUDE_IMAGE_HANDLER_RENDERER: await $.env.get('CLAUDE_IMAGE_HANDLER_RENDERER'),
  }
}

export function drawsPictures(env: RendererEnv, isFullscreen: boolean): boolean {
  const forced = env.CLAUDE_IMAGE_HANDLER_RENDERER
  if (forced === 'image' || forced === 'blocks') return forced === 'image'
  if (env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES) return true
  if (env.TMUX || env.STY || env.CLAUDE_CODE_SESSION_KIND === 'bg') return false
  if (env.TERM_PROGRAM === 'iTerm.app') return isFullscreen
  return (
    Boolean(env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) ||
    /kitty|ghostty/i.test(env.TERM ?? '') ||
    /^ghostty$/i.test(env.TERM_PROGRAM ?? '')
  )
}

function packCells(words: Uint32Array): string {
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((word, index) => view.setUint32(index * 4, word, true))
  return encodeBase64(bytes)
}

export function spinnerCells(frame: number): string {
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string
  return packCells(Uint32Array.of(glyph.codePointAt(0) as number, SPINNER_COLOR, DEFAULT_COLOR))
}
