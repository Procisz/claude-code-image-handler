import { describe, expect, it, vi } from 'vitest'
import { spinnerCells } from '../src/layout'
import { HINT, buildBand } from '../src/view'
import type { BandOptions, Thumb } from '../src/view'

type Node = { type: unknown; props: Record<string, any>; children: any[] }

const elements = { Box: 'Box', Text: 'Text', Button: 'Button', Raster: 'Raster', Image: 'Image' } as never

function walk(node: unknown, visit: (node: Node) => void): void {
  if (typeof node !== 'object' || node === null) return
  const current = node as Node
  visit(current)
  for (const child of current.children) walk(child, visit)
}

function all(node: unknown, type: string): Node[] {
  const found: Node[] = []
  walk(node, (candidate) => {
    if (candidate.type === type) found.push(candidate)
  })
  return found
}

function tileOf(band: unknown, id: string): Node {
  const tile = all(band, 'Box').find((box) => box.props.key === `tile:${id}`)
  if (tile === undefined) throw new Error(`no tile ${id}`)
  return tile
}

function textsOf(node: unknown): string[] {
  return all(node, 'Text').map((text) => text.children.join(''))
}

function item(id: string, status: 'loading' | 'ready' | 'failed', label = 'photo.png', width = 100, height = 100) {
  return { id, kind: 'path' as const, label, status, width, height }
}

function thumb(width = 4, height = 4): Thumb {
  return {
    image: { width, height, rgba: new Uint8Array(width * height * 4) },
    rgba: 'RGBA-BASE64',
  }
}

function options(overrides: Partial<BandOptions> = {}): BandOptions {
  return {
    elements,
    items: [],
    thumbs: new Map(),
    frame: 0,
    bodyColumns: 80,
    pictures: false,
    offer: null,
    onRemove: vi.fn(),
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

describe('buildBand layout', () => {
  it('shows only the hint when there are no items', () => {
    const band = buildBand(options()) as unknown as Node
    expect(all(band, 'Button')).toEqual([])
    expect(textsOf(band)).toEqual([HINT])
  })

  it('puts the keyboard hint under the tiles', () => {
    const band = buildBand(options({ items: [item('a', 'failed')] })) as unknown as Node
    const last = band.children.at(-1)
    expect(last.type).toBe('Text')
    expect(last.props.dimColor).toBe(true)
    expect(last.children).toEqual([HINT])
    expect(HINT).toBe('ctrl+x tab: focus previews, Tab: next, Enter: press, Esc: back')
  })

  it('gives 25 references 25 tiles and 25 remove buttons, three per row at 80 columns', () => {
    const items = Array.from({ length: 25 }, (_unused, index) => item(`path:/tmp/img${index}.png`, 'loading', `img${index}.png`))
    const band = buildBand(options({ items })) as unknown as Node
    const rows = band.children.filter((child) => child.type === 'Box')
    expect(rows).toHaveLength(9)
    expect(rows.map((row) => row.children.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 1])
    expect(rows.map((row) => row.props.key)).toEqual(Array.from({ length: 9 }, (_unused, index) => `row:${index}`))
    const buttons = all(band, 'Button')
    expect(buttons).toHaveLength(50)
    expect(new Set(buttons.map((button) => button.props.key)).size).toBe(50)
    expect(new Set(all(band, 'Box').map((box) => box.props.key).filter((key) => String(key).startsWith('tile:'))).size).toBe(25)
  })

  it('puts one tile per row on a narrow body', () => {
    const items = [item('a', 'failed'), item('b', 'failed')]
    const band = buildBand(options({ items, bodyColumns: 30 })) as unknown as Node
    expect(band.children.filter((child) => child.type === 'Box').map((row) => row.children.length)).toEqual([1, 1])
  })

  it('spaces tiles in a row by one column', () => {
    const band = buildBand(options({ items: [item('a', 'failed')] })) as unknown as Node
    expect(band.children[0].props).toMatchObject({ flexDirection: 'row', columnGap: 1 })
  })

  it('draws every tile as a 22 column column box with a round border', () => {
    const band = buildBand(options({ items: [item('a', 'failed')] }))
    expect(tileOf(band, 'a').props).toMatchObject({ key: 'tile:a', flexDirection: 'column', width: 22, borderStyle: 'round' })
  })
})

describe('buildBand remove button', () => {
  it('has a unique key, a label naming the file and an x, in a right aligned row first in the tile', () => {
    const band = buildBand(options({ items: [item('a', 'failed', 'cat.png')] }))
    const tile = tileOf(band, 'a')
    const top = tile.children[0]
    expect(top.props.justifyContent).toBe('space-between')
    const button = top.children[1]
    expect(button.type).toBe('Button')
    expect(button.props.key).toBe('remove:a')
    expect(button.props.label).toBe('Remove cat.png')
    expect(button.children).toEqual(['x'])
  })

  it('calls onRemove with the item id when pressed', () => {
    const onRemove = vi.fn()
    const band = buildBand(options({ items: [item('a', 'failed'), item('b', 'failed')], onRemove }))
    const buttons = all(band, 'Button').filter((button) => String(button.props.key).startsWith('remove:'))
    buttons[1]?.props.onPress()
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith('b')
  })

  it('appears on loading, ready and failed tiles alike', () => {
    const items = [item('l', 'loading'), item('r', 'ready'), item('f', 'failed')]
    const band = buildBand(options({ items, thumbs: new Map([['r', thumb()]]) }))
    expect(all(band, 'Button').map((button) => button.props.key)).toEqual(['open:l', 'remove:l', 'open:r', 'remove:r', 'open:f', 'remove:f'])
  })
})

describe('buildBand open button', () => {
  it('sits left of the remove button with a label naming the file and calls onOpen with the id', () => {
    const onOpen = vi.fn()
    const band = buildBand(options({ items: [item('a', 'failed', 'cat.png')], onOpen }))
    const button = tileOf(band, 'a').children[0].children[0]
    expect(button.props.key).toBe('open:a')
    expect(button.props.label).toBe('Open cat.png')
    expect(button.children).toEqual(['open'])
    button.props.onPress()
    expect(onOpen).toHaveBeenCalledWith('a')
  })
})

describe('buildBand clipboard tile', () => {
  it('is absent without an offer', () => {
    const band = buildBand(options({ items: [item('a', 'failed')] }))
    expect(all(band, 'Box').some((box) => box.props.key === 'tile:clipboard')).toBe(false)
  })

  it('comes after the file tiles with Add and dismiss buttons wired to the callbacks', () => {
    const onAdd = vi.fn()
    const onDismiss = vi.fn()
    const band = buildBand(
      options({ items: [item('a', 'failed')], offer: { status: 'loading', width: 0, height: 0 }, bodyColumns: 200, onAdd, onDismiss }),
    )
    const keys = all(band, 'Box').map((box) => box.props.key).filter((key) => String(key).startsWith('tile:'))
    expect(keys).toEqual(['tile:a', 'tile:clipboard'])
    const tile = tileOf(band, 'clipboard')
    const [add, dismiss] = tile.children[0].children
    expect(add.props).toMatchObject({ key: 'add:clipboard', label: 'Add clipboard picture', variant: 'primary' })
    expect(add.children).toEqual(['Add'])
    expect(dismiss.props.key).toBe('dismiss:clipboard')
    expect(dismiss.props.label).toBe('Dismiss clipboard picture')
    expect(dismiss.children).toEqual(['x'])
    add.props.onPress()
    dismiss.props.onPress()
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(textsOf(tile).at(-1)).toBe('Clipboard picture')
  })

  it('draws the picture from the clipboard thumbnail when ready and pictures are on', () => {
    const band = buildBand(
      options({
        offer: { status: 'ready', width: 100, height: 100 },
        thumbs: new Map([['clipboard', thumb()]]),
        pictures: true,
      }),
    )
    expect(all(tileOf(band, 'clipboard'), 'Image')[0]?.props.key).toBe('picture:clipboard')
  })

  it('shows the clipboard tile as a name line only when pictures are off', () => {
    const band = buildBand(options({ offer: { status: 'loading', width: 0, height: 0 } }))
    const tile = tileOf(band, 'clipboard')
    expect(tile.children.map((child) => child.type)).toEqual(['Box', 'Text'])
    expect(tile.children[1].children).toEqual(['Clipboard picture'])
  })

  it('packs into the same rows as file tiles', () => {
    const band = buildBand(
      options({ items: [item('a', 'failed')], offer: { status: 'failed', width: 0, height: 0 }, bodyColumns: 200, pictures: true }),
    )
    expect(band.children.filter((child) => child.type === 'Box')[0].children).toHaveLength(2)
    expect(textsOf(tileOf(band, 'clipboard'))).toContain('No preview')
  })
})

describe('buildBand tile bodies with pictures on', () => {
  it('shows a spinner raster and Loading while the preview is made', () => {
    const band = buildBand(options({ items: [item('a', 'loading')], frame: 4, pictures: true }))
    const [spinner] = all(tileOf(band, 'a'), 'Raster')
    expect(spinner?.props).toMatchObject({ key: 'spinner:a', columns: 1, rows: 1, cells: spinnerCells(4) })
    const loading = all(tileOf(band, 'a'), 'Text').find((text) => text.children.join('') === 'Loading')
    expect(loading?.props.dimColor).toBe(true)
  })

  it('changes the spinner cells with the frame', () => {
    const first = buildBand(options({ items: [item('a', 'loading')], frame: 0, pictures: true }))
    const second = buildBand(options({ items: [item('a', 'loading')], frame: 1, pictures: true }))
    expect(all(first, 'Raster')[0]?.props.cells).not.toBe(all(second, 'Raster')[0]?.props.cells)
  })

  it('shows the spinner for a ready item whose thumbnail is not in memory', () => {
    const band = buildBand(options({ items: [item('a', 'ready')], pictures: true }))
    expect(all(band, 'Raster')[0]?.props.key).toBe('spinner:a')
  })

  it('shows a No preview tile for a failed item', () => {
    const band = buildBand(options({ items: [item('a', 'failed')], pictures: true }))
    const tile = tileOf(band, 'a')
    expect(textsOf(tile)).toContain('No preview')
    expect(all(tile, 'Raster')).toEqual([])
    expect(all(tile, 'Image')).toEqual([])
    expect(all(tile, 'Text').find((text) => text.children[0] === 'No preview')?.props.dimColor).toBe(true)
  })

  it('draws an Image with the thumbnail pixels, an aspect box and alt text', () => {
    const entry = thumb(8, 4)
    const band = buildBand(
      options({ items: [item('a', 'ready', 'wide.png', 200, 100)], thumbs: new Map([['a', entry]]), pictures: true }),
    )
    const [image] = all(tileOf(band, 'a'), 'Image')
    expect(image?.props).toEqual({
      key: 'picture:a',
      source: { rgba: 'RGBA-BASE64', width: 8, height: 4 },
      columns: 20,
      rows: 5,
      alt: 'Preview of wide.png',
    })
    expect(all(tileOf(band, 'a'), 'Raster')).toEqual([])
  })

  it('centers the body in a box 20 wide and 5 rows tall', () => {
    const band = buildBand(options({ items: [item('a', 'failed')], pictures: true }))
    expect(tileOf(band, 'a').children[1].props).toMatchObject({ width: 20, height: 5, alignItems: 'center', justifyContent: 'center' })
  })
})

describe('buildBand name-only tile with pictures off', () => {
  it('has no body box, Raster, Image, Loading or No preview for any status', () => {
    const thumbs = new Map([['r', thumb()]])
    const items = [item('l', 'loading'), item('r', 'ready'), item('f', 'failed')]
    const band = buildBand(options({ items, thumbs }))
    for (const id of ['l', 'r', 'f']) {
      const tile = tileOf(band, id)
      expect(all(tile, 'Raster')).toEqual([])
      expect(all(tile, 'Image')).toEqual([])
      expect(textsOf(tile)).not.toContain('Loading')
      expect(textsOf(tile)).not.toContain('No preview')
      expect(tile.children.map((child) => child.type)).toEqual(['Box', 'Text'])
    }
  })

  it('shows the header first and then the name line', () => {
    const band = buildBand(options({ items: [item('a', 'ready', 'cat.png')], thumbs: new Map([['a', thumb()]]) }))
    const tile = tileOf(band, 'a')
    expect(tile.children[0].props.justifyContent).toBe('space-between')
    expect(tile.children[1].children).toEqual(['cat.png'])
  })

  it('shows a short name in one line without truncation', () => {
    const band = buildBand(options({ items: [item('a', 'failed', 'cat.png')] }))
    const name = tileOf(band, 'a').children.at(-1)
    expect(name.type).toBe('Text')
    expect(name.props.wrap).toBeUndefined()
    expect(name.children).toEqual(['cat.png'])
  })

  it('wraps a long name over several lines whose joined text is the full name', () => {
    const label = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS'
    const band = buildBand(options({ items: [item('a', 'failed', label)] }))
    const names = tileOf(band, 'a').children.slice(1)
    expect(names.map((text) => text.children)).toEqual([
      ['abcdefghijklmnopqrst'],
      ['uvwxyzABCDEFGHIJKLMN'],
      ['OPQRS'],
    ])
    expect(names.map((text) => text.children.join('')).join('')).toBe(label)
    expect(names.every((text) => text.props.wrap === undefined)).toBe(true)
  })

  it('keys each name line by tile and line index', () => {
    const band = buildBand(options({ items: [item('a', 'failed', 'abcdefghijklmnopqrstuvw')] }))
    const names = tileOf(band, 'a').children.slice(1)
    expect(names.map((text) => text.props.key)).toEqual(['name:a:0', 'name:a:1'])
  })

  it('wraps the name in picture tiles too, below the picture box', () => {
    const label = 'abcdefghijklmnopqrstuvw'
    const band = buildBand(options({ items: [item('a', 'ready', label)], thumbs: new Map([['a', thumb()]]), pictures: true }))
    const names = tileOf(band, 'a').children.slice(2)
    expect(names.map((text) => text.children.join(''))).toEqual(['abcdefghijklmnopqrst', 'uvw'])
  })
})
