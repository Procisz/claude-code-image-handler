import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng, pngSize } from '../../src/decode/png'
import { MAX_PIXELS } from '../../src/decode/types'
import { expectSameImage, fixture, fixtureNames, oracle, pixelAt } from './support/fixtures'
import { assemble, buildPng, chunk, header, scanlines, type PngSpec } from './support/png'

const WIDTH = 7
const HEIGHT = 5

const sampleFor = (depth: number) => (x: number, y: number, channel: number) =>
  (x * 29 + y * 17 + channel * 11 + 3) % (2 ** depth)

const spec = (colorType: number, depth: number, extra: Partial<PngSpec> = {}): PngSpec => ({
  width: WIDTH,
  height: HEIGHT,
  depth,
  colorType,
  sample: sampleFor(depth),
  ...extra,
})

const to8 = (value: number, depth: number): number => (depth === 16 ? value >> 8 : (value * 255) / (2 ** depth - 1))

const PALETTE = Array.from({ length: 256 * 3 }, (_, index) => (index * 13 + 5) % 256)

const expectedPixel = (colorType: number, depth: number, x: number, y: number, palette = PALETTE): number[] => {
  const s = (channel: number) => sampleFor(depth)(x, y, channel)
  if (colorType === 0) {
    return [to8(s(0), depth), to8(s(0), depth), to8(s(0), depth), 255]
  }
  if (colorType === 2) {
    return [to8(s(0), depth), to8(s(1), depth), to8(s(2), depth), 255]
  }
  if (colorType === 3) {
    return [palette[s(0) * 3]!, palette[s(0) * 3 + 1]!, palette[s(0) * 3 + 2]!, 255]
  }
  if (colorType === 4) {
    return [to8(s(0), depth), to8(s(0), depth), to8(s(0), depth), to8(s(1), depth)]
  }
  return [to8(s(0), depth), to8(s(1), depth), to8(s(2), depth), to8(s(3), depth)]
}

const COMBINATIONS: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
]

const decodeBuilt = (colorType: number, depth: number, extra: Partial<PngSpec> = {}) => {
  const image = decodePng(buildPng(spec(colorType, depth, extra), { palette: colorType === 3 ? PALETTE : undefined }))
  expect(image).not.toBeNull()
  return image!
}

describe('decodePng', () => {
  describe('fixtures written by PIL', () => {
    const names = fixtureNames().filter((name) => name.endsWith('.png'))

    it('has a fixture for every kind', () => {
      expect(names.length).toBeGreaterThanOrEqual(12)
    })

    it.for(names)('decodes %s to the pixels PIL reads', (name) => {
      expectSameImage(decodePng(fixture(name)), oracle(name))
    })
  })

  describe('color types and bit depths', () => {
    it.for(COMBINATIONS)('decodes color type %i at %i bits per sample', ([colorType, depth]) => {
      const image = decodeBuilt(colorType, depth)
      expect({ width: image.width, height: image.height }).toEqual({ width: WIDTH, height: HEIGHT })
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          expect(pixelAt(image, x, y), `pixel ${x},${y}`).toEqual(expectedPixel(colorType, depth, x, y))
        }
      }
    })

    it('keeps the high byte of 16-bit samples', () => {
      const image = decodePng(
        buildPng({ width: 1, height: 1, depth: 16, colorType: 0, sample: () => 0xabcd }),
      )
      expect(pixelAt(image!, 0, 0)).toEqual([0xab, 0xab, 0xab, 255])
    })
  })

  describe('filters', () => {
    it.for([0, 1, 2, 3, 4])('reverses filter type %i on every row', (filter) => {
      const image = decodeBuilt(2, 8, { filter: () => filter })
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          expect(pixelAt(image, x, y), `pixel ${x},${y}`).toEqual(expectedPixel(2, 8, x, y))
        }
      }
    })

    it('reverses a different filter on each row', () => {
      const image = decodeBuilt(6, 8, { filter: (_pass, row) => row % 5 })
      for (let y = 0; y < HEIGHT; y++) {
        expect(pixelAt(image, 3, y)).toEqual(expectedPixel(6, 8, 3, y))
      }
    })

    it('reverses the Paeth filter when the left neighbour is closest, the upper one is closest and the corner is closest', () => {
      const values = [
        [10, 200, 90, 40, 250, 3, 77],
        [12, 190, 95, 35, 10, 255, 70],
        [100, 100, 100, 101, 99, 100, 100],
      ]
      const image = decodePng(
        buildPng({
          width: 7,
          height: 3,
          depth: 8,
          colorType: 0,
          sample: (x, y) => values[y]![x]!,
          filter: () => 4,
        }),
      )
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 7; x++) {
          expect(pixelAt(image!, x, y)[0]).toBe(values[y]![x])
        }
      }
    })

    it('uses the byte a whole pixel back for the filters on 16-bit RGBA', () => {
      const image = decodeBuilt(6, 16, { filter: () => 3 })
      expect(pixelAt(image, 4, 2)).toEqual(expectedPixel(6, 16, 4, 2))
    })

    it('uses the previous byte for filters on 1-bit samples', () => {
      const image = decodeBuilt(0, 1, { filter: () => 1 })
      expect(pixelAt(image, 6, 4)).toEqual(expectedPixel(0, 1, 6, 4))
    })
  })

  describe('interlacing', () => {
    it.for(COMBINATIONS)('decodes Adam7 color type %i at %i bits per sample', ([colorType, depth]) => {
      const image = decodeBuilt(colorType, depth, { width: 11, height: 9, interlace: 1 })
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 11; x++) {
          expect(pixelAt(image, x, y), `pixel ${x},${y}`).toEqual(expectedPixel(colorType, depth, x, y))
        }
      }
    })

    it('decodes an interlaced image whose small size leaves most passes empty', () => {
      const image = decodeBuilt(2, 8, { width: 1, height: 1, interlace: 1 })
      expect(pixelAt(image, 0, 0)).toEqual(expectedPixel(2, 8, 0, 0))
    })

    it('decodes a 3 by 2 interlaced image where some passes have no rows', () => {
      const image = decodeBuilt(2, 8, { width: 3, height: 2, interlace: 1 })
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
          expect(pixelAt(image, x, y)).toEqual(expectedPixel(2, 8, x, y))
        }
      }
    })

    it('applies filters inside each interlace pass', () => {
      const image = decodeBuilt(0, 8, { width: 9, height: 9, interlace: 1, filter: (pass, row) => (pass + row) % 5 })
      for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 9; x++) {
          expect(pixelAt(image, x, y)).toEqual(expectedPixel(0, 8, x, y))
        }
      }
    })
  })

  describe('transparency', () => {
    it('makes the gray value named by tRNS transparent', () => {
      const keyed = sampleFor(8)(2, 1, 0)
      const image = decodePng(buildPng(spec(0, 8), { trns: [0, keyed] }))
      expect(pixelAt(image!, 2, 1)[3]).toBe(0)
      expect(pixelAt(image!, 3, 1)[3]).toBe(255)
    })

    it('compares 16-bit gray against the full 16-bit key', () => {
      const sample = (x: number) => (x === 0 ? 0x1234 : 0x1200)
      const image = decodePng(
        buildPng({ width: 2, height: 1, depth: 16, colorType: 0, sample }, { trns: [0x12, 0x34] }),
      )
      expect(pixelAt(image!, 0, 0)).toEqual([0x12, 0x12, 0x12, 0])
      expect(pixelAt(image!, 1, 0)).toEqual([0x12, 0x12, 0x12, 255])
    })

    it('makes a pixel transparent only when all three RGB channels match tRNS', () => {
      const pixels = [
        [10, 20, 30],
        [11, 20, 30],
        [10, 21, 30],
        [10, 20, 31],
      ]
      const image = decodePng(
        buildPng(
          { width: 4, height: 1, depth: 8, colorType: 2, sample: (x, _y, channel) => pixels[x]![channel]! },
          { trns: [0, 10, 0, 20, 0, 30] },
        ),
      )
      expect([0, 1, 2, 3].map((x) => pixelAt(image!, x, 0)[3])).toEqual([0, 255, 255, 255])
    })

    it('reads per-entry alpha for a palette and leaves later entries opaque', () => {
      const image = decodePng(buildPng(spec(3, 4), { palette: PALETTE, trns: [0, 100] }))
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const index = sampleFor(4)(x, y, 0)
          const alpha = index === 0 ? 0 : index === 1 ? 100 : 255
          expect(pixelAt(image!, x, y)[3], `pixel ${x},${y}`).toBe(alpha)
        }
      }
    })
  })

  describe('chunk handling', () => {
    it('joins the data of several IDAT chunks', () => {
      const image = decodePng(buildPng(spec(2, 8), { idatSplit: 7 }))
      expect(pixelAt(image!, 6, 4)).toEqual(expectedPixel(2, 8, 6, 4))
    })

    it('skips unknown chunks', () => {
      const image = decodePng(buildPng(spec(2, 8), { extraChunks: [chunk('tEXt', [65, 0, 66]), chunk('zzzz', [])] }))
      expect(pixelAt(image!, 0, 0)).toEqual(expectedPixel(2, 8, 0, 0))
    })

    it('stops at IEND and ignores what follows', () => {
      const keyed = sampleFor(8)(1, 1, 0)
      const data = deflateSync(scanlines(spec(0, 8)))
      const png = assemble(
        header(WIDTH, HEIGHT, 8, 0),
        chunk('IDAT', data),
        chunk('IEND', []),
        chunk('tRNS', [0, keyed]),
      )
      expect(pixelAt(decodePng(png)!, 1, 1)).toEqual(expectedPixel(0, 8, 1, 1))
    })

    it('ignores image data whose declared length runs past the end of the file', () => {
      const whole = Uint8Array.from(buildPng(spec(2, 8), { omitIend: true }))
      const declared = (whole[33]! << 24) | (whole[34]! << 16) | (whole[35]! << 8) | whole[36]!
      whole.set([0, 0, (declared + 100) >> 8, (declared + 100) & 255], 33)
      expect(decodePng(whole)).toBeNull()
    })

    it('decodes when IEND is missing', () => {
      const image = decodePng(buildPng(spec(2, 8), { omitIend: true }))
      expect(pixelAt(image!, 2, 2)).toEqual(expectedPixel(2, 8, 2, 2))
    })

    it('ignores a trailing chunk cut off before its end', () => {
      const whole = buildPng(spec(2, 8), { omitIend: true })
      const withCutChunk = Uint8Array.from([...whole, 0, 0, 0, 50, 116, 69, 88, 116, 1, 2])
      expect(pixelAt(decodePng(withCutChunk)!, 0, 0)).toEqual(expectedPixel(2, 8, 0, 0))
    })

    it('decodes with up to seven stray trailing bytes', () => {
      const whole = buildPng(spec(2, 8))
      expect(decodePng(Uint8Array.from([...whole, 1, 2, 3]))).not.toBeNull()
    })
  })

  describe('invalid input', () => {
    const good = (): number[] => Array.from(buildPng(spec(2, 8)))

    it('returns null for an empty array', () => {
      expect(decodePng(new Uint8Array(0))).toBeNull()
    })

    it('returns null for input shorter than signature plus header', () => {
      expect(decodePng(Uint8Array.from(good().slice(0, 32)))).toBeNull()
    })

    it('returns null when the signature is wrong', () => {
      const bytes = good()
      bytes[1] = 0x51
      expect(decodePng(Uint8Array.from(bytes))).toBeNull()
    })

    it('returns null when the first chunk is not 13 bytes long', () => {
      const bytes = good()
      bytes[11] = 12
      expect(decodePng(Uint8Array.from(bytes))).toBeNull()
    })

    it('returns null when the first chunk is not IHDR', () => {
      const bytes = good()
      bytes[12] = 0x58
      expect(decodePng(Uint8Array.from(bytes))).toBeNull()
    })

    it('returns null for zero width', () => {
      const png = assemble(header(0, 5, 8, 2), chunk('IDAT', deflateSync(Buffer.alloc(0))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for zero height', () => {
      const png = assemble(header(5, 0, 8, 2), chunk('IDAT', deflateSync(Buffer.alloc(0))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it('returns null when the pixel count is above the limit', () => {
      const png = assemble(header(4097, 4096, 8, 0), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', []))
      expect(4097 * 4096).toBeGreaterThan(MAX_PIXELS)
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for a pixel count exactly at the limit when the image data is too short', () => {
      const png = assemble(header(4096, 4096, 8, 0), chunk('IDAT', deflateSync(Buffer.alloc(8))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for a non-zero compression method', () => {
      const png = assemble(header(1, 1, 8, 0, 0, 1), chunk('IDAT', deflateSync(Buffer.alloc(2))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for a non-zero filter method', () => {
      const png = assemble(header(1, 1, 8, 0, 0, 0, 1), chunk('IDAT', deflateSync(Buffer.alloc(2))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for an unknown interlace method', () => {
      const png = assemble(header(1, 1, 8, 0, 2), chunk('IDAT', deflateSync(Buffer.alloc(2))), chunk('IEND', []))
      expect(decodePng(png)).toBeNull()
    })

    it.for([
      [1, 8],
      [5, 8],
      [7, 8],
      [0, 3],
      [0, 0],
      [2, 4],
      [2, 1],
      [3, 16],
      [4, 4],
      [6, 1],
    ])('returns null for color type %i with %i bits per sample', ([colorType, depth]) => {
      const png = assemble(
        header(1, 1, depth!, colorType!),
        chunk('PLTE', [0, 0, 0]),
        chunk('IDAT', deflateSync(Buffer.alloc(8))),
        chunk('IEND', []),
      )
      expect(decodePng(png)).toBeNull()
    })

    it('returns null for a palette image without a PLTE chunk', () => {
      expect(decodePng(buildPng(spec(3, 8)))).toBeNull()
    })

    it('returns null when there is no image data', () => {
      expect(decodePng(assemble(header(1, 1, 8, 0), chunk('IEND', [])))).toBeNull()
    })

    it('returns null when the image data is not zlib', () => {
      expect(decodePng(buildPng(spec(2, 8), { idat: Uint8Array.of(1, 2, 3, 4, 5) }))).toBeNull()
    })

    it('returns null when the image data holds fewer rows than the header declares', () => {
      const short = deflateSync(scanlines(spec(2, 8)).subarray(0, 40))
      expect(decodePng(buildPng(spec(2, 8), { idat: new Uint8Array(short) }))).toBeNull()
    })

    it('returns null when a row has an unknown filter type', () => {
      const lines = Uint8Array.from(scanlines(spec(2, 8)))
      lines[(WIDTH * 3 + 1) * 2] = 5
      expect(decodePng(buildPng(spec(2, 8), { idat: new Uint8Array(deflateSync(lines)) }))).toBeNull()
    })

    it('returns null for a truncated file', () => {
      const bytes = buildPng(spec(2, 8))
      expect(decodePng(bytes.subarray(0, bytes.length - 30))).toBeNull()
    })
  })
})

describe('pngSize', () => {
  it('reads width and height from the header', () => {
    expect(pngSize(fixture('png-rgb8.png'))).toEqual({ width: 13, height: 9 })
  })

  it('reads the size of an image too large to decode', () => {
    const png = assemble(header(70000, 80000, 8, 2))
    expect(pngSize(Uint8Array.from([...png, ...new Array(10).fill(0)]))).toEqual({ width: 70000, height: 80000 })
  })

  it('returns null for bytes that are not a PNG', () => {
    expect(pngSize(fixture('bmp-rgb24.bmp'))).toBeNull()
    expect(pngSize(new Uint8Array(0))).toBeNull()
  })

  it('returns null for a zero dimension', () => {
    const png = assemble(header(0, 9, 8, 2))
    expect(pngSize(Uint8Array.from([...png, ...new Array(10).fill(0)]))).toBeNull()
  })
})
