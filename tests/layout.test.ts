import { describe, expect, it } from 'vitest'
import {
  PICTURE_ROWS,
  SPINNER_FRAMES,
  TILE_INNER_WIDTH,
  drawsPictures,
  pictureBox,
  readRendererEnv,
  spinnerCells,
  tileInnerWidth,
  tilesPerRow,
} from '../src/layout'
import { createEngine } from './helpers/engine'

function words(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.length / 4 }, (_unused, index) => view.getUint32(index * 4, true))
}

describe('constants', () => {
  it('uses a 20 wide tile and a 5 row picture', () => {
    expect(TILE_INNER_WIDTH).toBe(20)
    expect(PICTURE_ROWS).toBe(5)
  })

  it('has ten braille spinner frames', () => {
    expect(SPINNER_FRAMES).toEqual(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
  })
})

describe('pictureBox', () => {
  it('makes a square image 10 columns by 5 rows because a cell is twice as tall as wide', () => {
    expect(pictureBox(100, 100)).toEqual({ columns: 10, rows: 5 })
  })

  it('fills 20 columns and 5 rows when a wide image fits exactly', () => {
    expect(pictureBox(200, 100)).toEqual({ columns: 20, rows: 5 })
  })

  it('limits a very wide image to 20 columns and shortens the rows', () => {
    expect(pictureBox(400, 100)).toEqual({ columns: 20, rows: 3 })
  })

  it('keeps full height for a tall image and narrows the columns', () => {
    expect(pictureBox(80, 200)).toEqual({ columns: 4, rows: 5 })
  })

  it('never goes below one column', () => {
    expect(pictureBox(1, 1000)).toEqual({ columns: 1, rows: 5 })
  })

  it('never goes below one row', () => {
    expect(pictureBox(1000, 1)).toEqual({ columns: 20, rows: 1 })
  })
})

describe('tileInnerWidth', () => {
  it.for([
    [200, 20],
    [33, 20],
    [32, 20],
    [31, 20],
    [21, 19],
    [18, 16],
    [0, 16],
  ])('gives %i body columns an inner width of %i', ([columns, expected]) => {
    expect(tileInnerWidth(columns as number)).toBe(expected)
  })

  it('caps picture columns at a given inner width', () => {
    expect(pictureBox(200, 100, 20)).toEqual({ columns: 20, rows: 5 })
  })
})

describe('tilesPerRow', () => {
  it.for([
    [64, 2],
    [65, 2],
    [80, 3],
    [97, 4],
    [98, 4],
    [127, 5],
    [128, 5],
    [44, 1],
    [18, 1],
    [0, 1],
    [200, 8],
  ])('fits tiles in %i columns: %i per row', ([columns, expected]) => {
    expect(tilesPerRow(columns as number)).toBe(expected)
  })
})

describe('readRendererEnv', () => {
  it('reads every variable the renderer decision uses', async () => {
    const values = {
      TERM: 'xterm-kitty',
      TERM_PROGRAM: 'ghostty',
      TMUX: '/tmp/tmux',
      STY: '123.pts',
      KITTY_WINDOW_ID: '4',
      GHOSTTY_RESOURCES_DIR: '/g',
      CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1',
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_IMAGE_HANDLER_RENDERER: 'blocks',
    }
    const engine = createEngine({ env: values })
    expect(await readRendererEnv(engine.$ as never)).toEqual(values)
  })

  it('leaves missing variables undefined', async () => {
    const env = await readRendererEnv(createEngine().$ as never)
    expect(env.TERM).toBeUndefined()
    expect(env.CLAUDE_IMAGE_HANDLER_RENDERER).toBeUndefined()
  })
})

describe('drawsPictures', () => {
  it('draws no pictures on a plain terminal', () => {
    expect(drawsPictures({}, true)).toBe(false)
    expect(drawsPictures({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }, true)).toBe(false)
  })

  it('draws pictures when the override says image, even inside tmux', () => {
    expect(drawsPictures({ CLAUDE_IMAGE_HANDLER_RENDERER: 'image', TMUX: '1' }, false)).toBe(true)
  })

  it('draws no pictures when the override says blocks, even in kitty', () => {
    expect(
      drawsPictures({ CLAUDE_IMAGE_HANDLER_RENDERER: 'blocks', KITTY_WINDOW_ID: '1', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }, true),
    ).toBe(false)
  })

  it('ignores an unknown override value', () => {
    expect(drawsPictures({ CLAUDE_IMAGE_HANDLER_RENDERER: 'auto' }, true)).toBe(false)
    expect(drawsPictures({ CLAUDE_IMAGE_HANDLER_RENDERER: 'auto', KITTY_WINDOW_ID: '1' }, true)).toBe(true)
  })

  it('draws pictures when Claude Code forces terminal images, even inside tmux', () => {
    expect(drawsPictures({ CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', TMUX: '1' }, false)).toBe(true)
  })

  it('draws no pictures inside tmux', () => {
    expect(drawsPictures({ TMUX: '/tmp/tmux', KITTY_WINDOW_ID: '1' }, true)).toBe(false)
  })

  it('draws no pictures inside screen', () => {
    expect(drawsPictures({ STY: '1.pts', KITTY_WINDOW_ID: '1' }, true)).toBe(false)
  })

  it('draws no pictures in a background session', () => {
    expect(drawsPictures({ CLAUDE_CODE_SESSION_KIND: 'bg', KITTY_WINDOW_ID: '1' }, true)).toBe(false)
  })

  it('draws pictures in iTerm2 only in fullscreen', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'iTerm.app' }, true)).toBe(true)
    expect(drawsPictures({ TERM_PROGRAM: 'iTerm.app' }, false)).toBe(false)
  })

  it('draws pictures in kitty by window id', () => {
    expect(drawsPictures({ KITTY_WINDOW_ID: '3' }, false)).toBe(true)
  })

  it('draws pictures in Ghostty by resources dir', () => {
    expect(drawsPictures({ GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty' }, false)).toBe(true)
  })

  it('draws pictures when TERM names kitty or ghostty', () => {
    expect(drawsPictures({ TERM: 'xterm-kitty' }, false)).toBe(true)
    expect(drawsPictures({ TERM: 'xterm-ghostty' }, false)).toBe(true)
  })

  it('draws pictures when TERM_PROGRAM is ghostty in any case', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'Ghostty' }, false)).toBe(true)
  })

  it('does not take a TERM_PROGRAM that merely contains ghostty', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'notghostty' }, false)).toBe(false)
  })
})

describe('spinnerCells', () => {
  it('encodes the glyph, a blue foreground and the default background for frame 0', () => {
    expect(words(spinnerCells(0))).toEqual([0x280b, 0x8ab4f8, 0x01000000])
  })

  it('moves to the next braille glyph per frame', () => {
    expect(words(spinnerCells(3))[0]).toBe('⠸'.codePointAt(0))
  })

  it('wraps after the last frame', () => {
    expect(spinnerCells(10)).toBe(spinnerCells(0))
    expect(words(spinnerCells(19))[0]).toBe('⠏'.codePointAt(0))
  })
})
