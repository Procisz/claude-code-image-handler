import { describe, expect, it } from 'vitest'
import { decodeGif } from '../../src/decode/gif'
import { MAX_PIXELS } from '../../src/decode/types'
import { expectSameImage, fixture, fixtureNames, oracle, pixelAt } from './support/fixtures'
import { buildGif, lzwEncode, type GifSpec } from './support/gif'

const COLORS = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [9, 8, 7],
]

const gif = (width: number, height: number, indices: number[], extra: Partial<GifSpec> = {}): Uint8Array =>
  buildGif({
    width,
    height,
    global: { bits: 2, colors: COLORS },
    frame: { width, height, indices },
    ...extra,
  })

const patch = (bytes: Uint8Array, at: number, value: number[]): Uint8Array => {
  const copy = Uint8Array.from(bytes)
  copy.set(value, at)
  return copy
}

const noise = (count: number, colors: number): number[] => {
  let state = 12345
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state >> 8) % colors
  })
}

describe('decodeGif', () => {
  describe('fixtures written by PIL', () => {
    const names = fixtureNames().filter((name) => name.endsWith('.gif'))

    it('has a fixture for every kind', () => {
      expect(names).toEqual(
        expect.arrayContaining(['gif-interlaced.gif', 'gif-plain.gif', 'gif-transparent.gif', 'gif-animated.gif']),
      )
    })

    it.for(names)('decodes %s to the pixels PIL reads', (name) => {
      expectSameImage(decodeGif(fixture(name)), oracle(name))
    })

    it('leaves transparent pixels fully transparent in gif-transparent.gif', () => {
      const image = decodeGif(fixture('gif-transparent.gif'))!
      const want = oracle('gif-transparent.gif')
      const transparent = Array.from({ length: want.width * want.height }, (_, index) => want.rgba[index * 4 + 3]).filter(
        (alpha) => alpha === 0,
      )
      expect(transparent.length).toBeGreaterThan(0)
      expect(Array.from(image.rgba).filter((_, index) => index % 4 === 3 && image.rgba[index] === 0).length).toBe(
        transparent.length,
      )
    })
  })

  describe('frames', () => {
    it('decodes a plain frame with a global color table', () => {
      const image = decodeGif(gif(3, 2, [0, 1, 2, 3, 2, 1]))!
      expect({ width: image.width, height: image.height }).toEqual({ width: 3, height: 2 })
      expect(pixelAt(image, 0, 0)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 1, 0)).toEqual([0, 255, 0, 255])
      expect(pixelAt(image, 2, 0)).toEqual([0, 0, 255, 255])
      expect(pixelAt(image, 0, 1)).toEqual([9, 8, 7, 255])
      expect(pixelAt(image, 2, 1)).toEqual([0, 255, 0, 255])
    })

    it('accepts the GIF87a signature', () => {
      const image = decodeGif(gif(2, 1, [1, 2], { version: '87a' }))!
      expect(pixelAt(image, 1, 0)).toEqual([0, 0, 255, 255])
    })

    it('prefers a local color table over the global one', () => {
      const bytes = buildGif({
        width: 2,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 2, height: 1, indices: [0, 1], local: { bits: 2, colors: [[1, 2, 3], [4, 5, 6]] } },
      })
      const image = decodeGif(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([1, 2, 3, 255])
      expect(pixelAt(image, 1, 0)).toEqual([4, 5, 6, 255])
    })

    it('decodes with only a local color table', () => {
      const bytes = buildGif({
        width: 2,
        height: 1,
        frame: { width: 2, height: 1, indices: [1, 0], local: { bits: 1, colors: [[1, 2, 3], [4, 5, 6]] } },
      })
      expect(pixelAt(decodeGif(bytes)!, 0, 0)).toEqual([4, 5, 6, 255])
    })

    it('decodes a stream without a trailer', () => {
      expect(decodeGif(gif(2, 1, [1, 0], { trailer: false }))).not.toBeNull()
    })

    it('places the frame at its offset on a transparent canvas', () => {
      const bytes = buildGif({
        width: 4,
        height: 3,
        global: { bits: 2, colors: COLORS },
        frame: { left: 1, top: 2, width: 2, height: 1, indices: [2, 3] },
      })
      const image = decodeGif(bytes)!
      expect(pixelAt(image, 0, 2)).toEqual([0, 0, 0, 0])
      expect(pixelAt(image, 1, 2)).toEqual([0, 0, 255, 255])
      expect(pixelAt(image, 2, 2)).toEqual([9, 8, 7, 255])
      expect(pixelAt(image, 3, 2)).toEqual([0, 0, 0, 0])
      expect(pixelAt(image, 1, 0)).toEqual([0, 0, 0, 0])
    })

    it('clips frame pixels that fall outside the canvas', () => {
      const bytes = buildGif({
        width: 2,
        height: 2,
        global: { bits: 2, colors: COLORS },
        frame: { left: 1, top: 1, width: 3, height: 3, indices: [0, 1, 2, 3, 0, 1, 2, 3, 0] },
      })
      const image = decodeGif(bytes)!
      expect(pixelAt(image, 1, 1)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 0])
      expect(image.rgba.length).toBe(2 * 2 * 4)
    })

    it('makes the graphic control transparent index fully transparent', () => {
      const image = decodeGif(gif(3, 1, [0, 1, 2], { transparent: 1 }))!
      expect(pixelAt(image, 0, 0)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 1, 0)).toEqual([0, 0, 0, 0])
      expect(pixelAt(image, 2, 0)).toEqual([0, 0, 255, 255])
    })

    it('ignores the transparent index when the graphic control flag is off', () => {
      const bytes = gif(2, 1, [0, 1], { extensions: [[0x21, 0xf9, 4, 0, 0, 0, 1, 0]] })
      expect(pixelAt(decodeGif(bytes)!, 1, 0)).toEqual([0, 255, 0, 255])
    })

    it('skips comment and application extensions', () => {
      const comment = [0x21, 0xfe, 3, 65, 66, 67, 0]
      const application = [0x21, 0xff, 11, ...Array(11).fill(78), 3, 1, 0, 0, 0]
      const image = decodeGif(gif(2, 1, [3, 0], { extensions: [comment, application] }))!
      expect(pixelAt(image, 0, 0)).toEqual([9, 8, 7, 255])
    })

    it('keeps the transparent index when another extension follows the graphic control block', () => {
      const comment = [0x21, 0xfe, 1, 65, 0]
      const bytes = gif(2, 1, [0, 1], { extensions: [[0x21, 0xf9, 4, 1, 0, 0, 0, 0], comment] })
      expect(pixelAt(decodeGif(bytes)!, 0, 0)).toEqual([0, 0, 0, 0])
    })

    it('decodes only the first frame of an animation', () => {
      const first = gif(2, 1, [0, 1], { trailer: false })
      const second = [0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b]
      const image = decodeGif(Uint8Array.from([...first, ...second]))!
      expect(pixelAt(image, 0, 0)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 1, 0)).toEqual([0, 255, 0, 255])
    })
  })

  describe('interlacing', () => {
    it('stores rows in four passes and puts them back in order', () => {
      const height = 11
      const stored = [0, 8, 4, 2, 6, 10, 1, 3, 5, 7, 9]
      const indices = stored.flatMap((row) => [row % 4, (row + 1) % 4])
      const bytes = buildGif({
        width: 2,
        height,
        global: { bits: 2, colors: COLORS },
        frame: { width: 2, height, indices, interlace: true },
      })
      const image = decodeGif(bytes)!
      for (let row = 0; row < height; row++) {
        expect(pixelAt(image, 0, row), `row ${row}`).toEqual([...COLORS[row % 4]!, 255])
        expect(pixelAt(image, 1, row), `row ${row}`).toEqual([...COLORS[(row + 1) % 4]!, 255])
      }
    })

    it('handles an interlaced frame with a single row', () => {
      const bytes = buildGif({
        width: 2,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 2, height: 1, indices: [2, 1], interlace: true },
      })
      expect(pixelAt(decodeGif(bytes)!, 0, 0)).toEqual([0, 0, 255, 255])
    })
  })

  describe('LZW', () => {
    it('decodes runs of one color that need the code just being defined', () => {
      const image = decodeGif(gif(6, 1, [1, 1, 1, 1, 1, 1]))!
      for (let x = 0; x < 6; x++) {
        expect(pixelAt(image, x, 0)).toEqual([0, 255, 0, 255])
      }
    })

    it('decodes a stream that clears the table in the middle', () => {
      const indices = noise(60, 4)
      const bytes = buildGif({
        width: 60,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 60, height: 1, lzw: lzwEncode(indices, 2, { clearAfter: 9 }) },
      })
      const image = decodeGif(bytes)!
      indices.forEach((index, x) => expect(pixelAt(image, x, 0), `pixel ${x}`).toEqual([...(COLORS[index] ?? []), 255]))
    })

    it.for([2, 3, 4, 5, 6, 7, 8])('decodes a minimum code size of %i', (minCodeSize) => {
      const colors = 2 ** minCodeSize
      const table = Array.from({ length: colors }, (_, index) => [index, 255 - index, (index * 7) & 255])
      const indices = noise(200, colors)
      const bytes = buildGif({
        width: 20,
        height: 10,
        global: { bits: minCodeSize, colors: table },
        frame: { width: 20, height: 10, indices, minCodeSize },
      })
      const image = decodeGif(bytes)!
      indices.forEach((index, at) =>
        expect(pixelAt(image, at % 20, Math.floor(at / 20)), `pixel ${at}`).toEqual([...table[index]!, 255]),
      )
    })

    it('grows codes to 12 bits and restarts when the table is full', () => {
      const indices = noise(9000, 256)
      const table = Array.from({ length: 256 }, (_, index) => [index, (index * 5) & 255, 255 - index])
      const bytes = buildGif({
        width: 90,
        height: 100,
        global: { bits: 8, colors: table },
        frame: { width: 90, height: 100, indices, minCodeSize: 8 },
      })
      const image = decodeGif(bytes)!
      for (const at of [0, 1, 4000, 4500, 8999]) {
        expect(pixelAt(image, at % 90, Math.floor(at / 90)), `pixel ${at}`).toEqual([...table[indices[at]!]!, 255])
      }
    })

    it('keeps decoding with a full table when the encoder never clears', () => {
      const indices = noise(9000, 256)
      const table = Array.from({ length: 256 }, (_, index) => [index, (index * 5) & 255, 255 - index])
      const bytes = buildGif({
        width: 90,
        height: 100,
        global: { bits: 8, colors: table },
        frame: { width: 90, height: 100, minCodeSize: 8, lzw: lzwEncode(indices, 8, { onFull: 'freeze' }) },
      })
      const image = decodeGif(bytes)!
      for (const at of [0, 5000, 8999]) {
        expect(pixelAt(image, at % 90, Math.floor(at / 90)), `pixel ${at}`).toEqual([...table[indices[at]!]!, 255])
      }
    })

    it('stops writing when a code expands past the frame size', () => {
      const bytes = buildGif({
        width: 3,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 3, height: 1, lzw: lzwEncode([1, 1, 1, 1, 1, 1], 2) },
      })
      const image = decodeGif(bytes)!
      expect(pixelAt(image, 2, 0)).toEqual([0, 255, 0, 255])
    })

    it('splits image data into small sub-blocks', () => {
      const indices = noise(120, 4)
      const bytes = buildGif({
        width: 120,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 120, height: 1, indices, blockSize: 5 },
      })
      const image = decodeGif(bytes)!
      indices.forEach((index, x) => expect(pixelAt(image, x, 0)).toEqual([...COLORS[index]!, 255]))
    })

    it('returns null when the data ends before the frame is full', () => {
      const bytes = buildGif({
        width: 8,
        height: 8,
        global: { bits: 2, colors: COLORS },
        frame: { width: 8, height: 8, indices: noise(10, 4) },
      })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when the data runs out without an end code', () => {
      const bytes = buildGif({
        width: 8,
        height: 8,
        global: { bits: 2, colors: COLORS },
        frame: { width: 8, height: 8, lzw: [0x04] },
      })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when the end code arrives early', () => {
      const bytes = buildGif({
        width: 4,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 4, height: 1, lzw: [0x2c] },
      })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when the first code after a clear is not a literal', () => {
      const bytes = buildGif({
        width: 4,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 4, height: 1, lzw: [0x34] },
      })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when a code is further ahead than the table', () => {
      const bytes = buildGif({
        width: 4,
        height: 1,
        global: { bits: 2, colors: COLORS },
        frame: { width: 4, height: 1, lzw: [0xcc, 0x01] },
      })
      expect(decodeGif(bytes)).toBeNull()
    })
  })

  describe('invalid input', () => {
    const good = gif(2, 1, [0, 1])

    it('returns null for an empty array', () => {
      expect(decodeGif(new Uint8Array(0))).toBeNull()
    })

    it('returns null for input shorter than the screen descriptor', () => {
      expect(decodeGif(good.subarray(0, 12))).toBeNull()
    })

    it.for([0, 1, 2, 3, 4, 5])('returns null when signature byte %i is wrong', (at) => {
      expect(decodeGif(patch(good, at, [0x20]))).toBeNull()
    })

    it('returns null for zero screen width', () => {
      expect(decodeGif(patch(good, 6, [0, 0]))).toBeNull()
    })

    it('returns null for zero screen height', () => {
      expect(decodeGif(patch(good, 8, [0, 0]))).toBeNull()
    })

    it('returns null when the screen pixel count is above the limit', () => {
      const big = patch(patch(good, 6, [0x01, 0x10]), 8, [0x01, 0x10])
      expect(4097 * 4097).toBeGreaterThan(MAX_PIXELS)
      expect(decodeGif(big)).toBeNull()
    })

    it('returns null when the stream ends before any image', () => {
      expect(decodeGif(Uint8Array.from([...good.subarray(0, 13 + 12)]))).toBeNull()
    })

    it('returns null when a trailer comes before any image', () => {
      const bytes = Uint8Array.from([...good.subarray(0, 13 + 12), 0x3b])
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when an extension is cut off', () => {
      const bytes = Uint8Array.from([...good.subarray(0, 13 + 12), 0x21, 0xfe, 5, 1, 2])
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when an extension has no terminator', () => {
      const bytes = Uint8Array.from([...good.subarray(0, 13 + 12), 0x21, 0xfe, 1, 65])
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null for a frame with zero width', () => {
      expect(decodeGif(patch(good, 13 + 12 + 5, [0, 0]))).toBeNull()
    })

    it('returns null for a frame with zero height', () => {
      expect(decodeGif(patch(good, 13 + 12 + 7, [0, 0]))).toBeNull()
    })

    it('returns null when the frame pixel count is above the limit', () => {
      const bytes = buildGif({
        width: 4096,
        height: 4096,
        global: { bits: 2, colors: COLORS },
        frame: { width: 4097, height: 4096, indices: [0] },
      })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null when no color table exists', () => {
      const bytes = buildGif({ width: 2, height: 1, frame: { width: 2, height: 1, indices: [0, 1] } })
      expect(decodeGif(bytes)).toBeNull()
    })

    it('returns null for a minimum code size below 2', () => {
      expect(decodeGif(patch(good, 13 + 12 + 10, [1]))).toBeNull()
    })

    it('returns null for a minimum code size above 8', () => {
      expect(decodeGif(patch(good, 13 + 12 + 10, [9]))).toBeNull()
    })

    it('returns null when the image data blocks are cut off', () => {
      expect(decodeGif(good.subarray(0, good.length - 4))).toBeNull()
    })

    it('returns null when the image data has no block terminator', () => {
      expect(decodeGif(good.subarray(0, 13 + 12 + 11 + 1))).toBeNull()
    })
  })
})
