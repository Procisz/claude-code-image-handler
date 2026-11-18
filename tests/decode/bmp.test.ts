import { describe, expect, it } from 'vitest'
import { decodeBmp } from '../../src/decode/bmp'
import { MAX_PIXELS } from '../../src/decode/types'
import { expectSameImage, fixture, fixtureNames, oracle, pixelAt } from './support/fixtures'
import { buildBmp, le32, type BmpSpec } from './support/bmp'

const patch = (bytes: Uint8Array, at: number, value: number[]): Uint8Array => {
  const copy = Uint8Array.from(bytes)
  copy.set(value, at)
  return copy
}

const rgb24 = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

const palette4 = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [10, 20, 30],
  [40, 50, 60],
]

describe('decodeBmp', () => {
  describe('fixtures written by PIL and sips', () => {
    const names = fixtureNames().filter((name) => name.endsWith('.bmp'))

    it('has a fixture for every kind', () => {
      expect(names).toEqual(
        expect.arrayContaining(['bmp-rgb24.bmp', 'bmp-rgb8.bmp', 'bmp-gray8.bmp', 'bmp-bilevel.bmp', 'bmp-rgba32.bmp', 'bmp-sips.bmp']),
      )
    })

    it.for(names)('decodes %s to the pixels PIL reads', (name) => {
      expectSameImage(decodeBmp(fixture(name)), oracle(name))
    })
  })

  describe('palette images', () => {
    it('decodes 1 bit per pixel with a two-color palette', () => {
      const bytes = buildBmp({
        width: 10,
        height: 2,
        bpp: 1,
        palette: [
          [1, 2, 3],
          [250, 251, 252],
        ],
        pixel: (x, y) => (x + y) % 2,
      })
      const image = decodeBmp(bytes)!
      expect({ width: image.width, height: image.height }).toEqual({ width: 10, height: 2 })
      expect(pixelAt(image, 0, 0)).toEqual([1, 2, 3, 255])
      expect(pixelAt(image, 1, 0)).toEqual([250, 251, 252, 255])
      expect(pixelAt(image, 9, 1)).toEqual([1, 2, 3, 255])
      expect(pixelAt(image, 8, 1)).toEqual([250, 251, 252, 255])
    })

    it('decodes 4 bits per pixel and uses the declared number of colors', () => {
      const bytes = buildBmp({
        width: 5,
        height: 2,
        bpp: 4,
        palette: palette4,
        colorsUsed: 5,
        pixel: (x, y) => (x + y * 2) % 5,
      })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 3, 0)).toEqual([10, 20, 30, 255])
      expect(pixelAt(image, 4, 0)).toEqual([40, 50, 60, 255])
      expect(pixelAt(image, 4, 1)).toEqual([0, 255, 0, 255])
    })

    it('reads a full 256-color palette when no color count is given', () => {
      const palette = Array.from({ length: 256 }, (_, index) => [index, 255 - index, (index * 3) & 255])
      const bytes = buildBmp({ width: 4, height: 1, bpp: 8, palette, pixel: (x) => 250 + x })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([250, 5, 238, 255])
      expect(pixelAt(image, 3, 0)).toEqual([253, 2, 247, 255])
    })

    it('caps the declared color count at what the bit depth allows', () => {
      const bytes = buildBmp({
        width: 2,
        height: 1,
        bpp: 1,
        palette: [
          [9, 9, 9],
          [200, 100, 50],
        ],
        colorsUsed: 1000,
        pixel: (x) => x,
      })
      expect(pixelAt(decodeBmp(bytes)!, 1, 0)).toEqual([200, 100, 50, 255])
    })

    it('leaves palette entries that are not stored black', () => {
      const bytes = buildBmp({ width: 2, height: 1, bpp: 4, palette: [[7, 8, 9]], colorsUsed: 1, pixel: (x) => x * 3 })
      expect(pixelAt(decodeBmp(bytes)!, 1, 0)).toEqual([0, 0, 0, 255])
    })
  })

  describe('true color images', () => {
    it('decodes 24 bits per pixel with padded rows', () => {
      const bytes = buildBmp({ width: 3, height: 2, bpp: 24, pixel: (x, y) => rgb24(x * 50, y * 100, 200 - x) })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([0, 0, 200, 255])
      expect(pixelAt(image, 2, 1)).toEqual([100, 100, 198, 255])
    })

    it('decodes 32 bits per pixel without bit fields as opaque', () => {
      const bytes = buildBmp({ width: 2, height: 1, bpp: 32, pixel: (x) => 0x7f000000 + rgb24(x * 100, 20, 30) })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 1, 0)).toEqual([100, 20, 30, 255])
    })

    it('decodes 16 bits per pixel as 5-5-5 by default and scales to 8 bits', () => {
      const white = 0x7fff
      const red = 0x7c00
      const bytes = buildBmp({ width: 3, height: 1, bpp: 16, pixel: (x) => [white, red, 0x0010][x]! })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([255, 255, 255, 255])
      expect(pixelAt(image, 1, 0)).toEqual([255, 0, 0, 255])
      expect(pixelAt(image, 2, 0)).toEqual([0, 0, 132, 255])
    })

    it('decodes 16 bits per pixel as 5-6-5 from BI_BITFIELDS masks', () => {
      const bytes = buildBmp({
        width: 2,
        height: 1,
        bpp: 16,
        compression: 3,
        masks: [0xf800, 0x07e0, 0x001f],
        dataOffset: 66,
        pixel: (x) => [0x07e0, 0xf81f][x]!,
      })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([0, 255, 0, 255])
      expect(pixelAt(image, 1, 0)).toEqual([255, 0, 255, 255])
    })

    it('decodes 32 bits per pixel with an alpha mask from a V4 header', () => {
      const bytes = buildBmp({
        width: 2,
        height: 1,
        bpp: 32,
        headerSize: 108,
        compression: 3,
        masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
        pixel: (x) => [0x80102030, 0x00ffffff][x]!,
      })
      const image = decodeBmp(bytes)!
      expect(pixelAt(image, 0, 0)).toEqual([0x10, 0x20, 0x30, 0x80])
      expect(pixelAt(image, 1, 0)).toEqual([255, 255, 255, 0])
    })

    it('decodes a V5 header the same way', () => {
      const bytes = buildBmp({
        width: 1,
        height: 1,
        bpp: 32,
        headerSize: 124,
        compression: 3,
        masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
        pixel: () => 0xff0a0b0c,
      })
      expect(pixelAt(decodeBmp(bytes)!, 0, 0)).toEqual([0x0a, 0x0b, 0x0c, 255])
    })

    it('ignores the alpha mask of a 40-byte header and stays opaque', () => {
      const bytes = buildBmp({
        width: 1,
        height: 1,
        bpp: 32,
        compression: 3,
        masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
        dataOffset: 70,
        pixel: () => 0x10010203,
      })
      expect(pixelAt(decodeBmp(bytes)!, 0, 0)).toEqual([1, 2, 3, 255])
    })

    it('treats a zero color mask as an absent channel', () => {
      const bytes = buildBmp({
        width: 1,
        height: 1,
        bpp: 32,
        compression: 3,
        masks: [0x00ff0000, 0, 0x000000ff],
        dataOffset: 66,
        pixel: () => 0x00112233,
      })
      expect(pixelAt(decodeBmp(bytes)!, 0, 0)).toEqual([0x11, 0, 0x33, 255])
    })
  })

  describe('row order and offsets', () => {
    const pixel = (x: number, y: number): number => rgb24(y * 60, x * 60, 7)

    it('reads rows bottom-up by default', () => {
      const image = decodeBmp(buildBmp({ width: 3, height: 3, bpp: 24, pixel }))!
      expect(pixelAt(image, 1, 0)).toEqual([0, 60, 7, 255])
      expect(pixelAt(image, 1, 2)).toEqual([120, 60, 7, 255])
    })

    it('reads rows top-down when the height is negative', () => {
      const image = decodeBmp(buildBmp({ width: 3, height: 3, bpp: 24, topDown: true, pixel }))!
      expect(image.height).toBe(3)
      expect(pixelAt(image, 1, 0)).toEqual([0, 60, 7, 255])
      expect(pixelAt(image, 1, 2)).toEqual([120, 60, 7, 255])
    })

    it('honours a pixel data offset past the end of the headers', () => {
      const image = decodeBmp(buildBmp({ width: 2, height: 1, bpp: 24, dataOffset: 80, pixel }))!
      expect(pixelAt(image, 1, 0)).toEqual([0, 60, 7, 255])
    })
  })

  describe('invalid input', () => {
    const good = buildBmp({ width: 4, height: 4, bpp: 24, pixel: () => 0x102030 })

    it('returns null for an empty array', () => {
      expect(decodeBmp(new Uint8Array(0))).toBeNull()
    })

    it('returns null when shorter than the two headers', () => {
      expect(decodeBmp(good.subarray(0, 53))).toBeNull()
    })

    it('returns null when the first byte is not B', () => {
      expect(decodeBmp(patch(good, 0, [0x43]))).toBeNull()
    })

    it('returns null when the second byte is not M', () => {
      expect(decodeBmp(patch(good, 1, [0x4e]))).toBeNull()
    })

    it('returns null for the 12-byte OS/2 header', () => {
      expect(decodeBmp(patch(good, 14, le32(12)))).toBeNull()
    })

    it('returns null for a header larger than V5', () => {
      expect(decodeBmp(patch(good, 14, le32(125)))).toBeNull()
    })

    it('returns null for zero width', () => {
      expect(decodeBmp(patch(good, 18, le32(0)))).toBeNull()
    })

    it('returns null for negative width', () => {
      expect(decodeBmp(patch(good, 18, le32(-4)))).toBeNull()
    })

    it('returns null for zero height', () => {
      expect(decodeBmp(patch(good, 22, le32(0)))).toBeNull()
    })

    it('returns null when the pixel count is above the limit', () => {
      const wide = patch(patch(good, 18, le32(4097)), 22, le32(4096))
      expect(4097 * 4096).toBeGreaterThan(MAX_PIXELS)
      expect(decodeBmp(wide)).toBeNull()
    })

    it('returns null for a bit depth BMP does not define', () => {
      expect(decodeBmp(patch(good, 28, [15, 0]))).toBeNull()
      expect(decodeBmp(patch(good, 28, [0, 0]))).toBeNull()
      expect(decodeBmp(patch(good, 28, [48, 0]))).toBeNull()
    })

    it('returns null for run-length compression', () => {
      const eight = buildBmp({ width: 2, height: 2, bpp: 8, palette: [[0, 0, 0]], pixel: () => 0 })
      expect(decodeBmp(patch(eight, 30, le32(1)))).toBeNull()
      expect(decodeBmp(patch(eight, 30, le32(2)))).toBeNull()
    })

    it('returns null for bit fields on a bit depth that cannot use them', () => {
      expect(decodeBmp(patch(good, 30, le32(3)))).toBeNull()
      const eight = buildBmp({ width: 2, height: 2, bpp: 8, palette: [[0, 0, 0]], pixel: () => 0 })
      expect(decodeBmp(patch(eight, 30, le32(3)))).toBeNull()
    })

    it('returns null for an unknown compression value', () => {
      expect(decodeBmp(patch(good, 30, le32(7)))).toBeNull()
    })

    it('returns null when the pixel data is cut short', () => {
      expect(decodeBmp(good.subarray(0, good.length - 1))).toBeNull()
    })

    it('returns null when the pixel data offset points past the file', () => {
      expect(decodeBmp(patch(good, 10, le32(good.length)))).toBeNull()
    })
  })
})
