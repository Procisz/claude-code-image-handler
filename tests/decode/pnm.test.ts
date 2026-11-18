import { describe, expect, it } from 'vitest'
import { decodePnm } from '../../src/decode/pnm'
import { MAX_PIXELS } from '../../src/decode/types'
import { expectSameImage, fixture, fixtureNames, oracle, pixelAt } from './support/fixtures'

const ascii = (text: string): Uint8Array => Uint8Array.from(Array.from(text, (character) => character.charCodeAt(0)))
const binary = (head: string, ...data: number[]): Uint8Array => Uint8Array.from([...ascii(head), ...data])

describe('decodePnm', () => {
  describe('fixtures written by PIL', () => {
    const names = fixtureNames().filter((name) => name.startsWith('pnm-'))

    it('has a fixture for P4, P5 and P6', () => {
      expect(names).toEqual(['pnm-p4.pbm', 'pnm-p5.pgm', 'pnm-p6.ppm'])
    })

    it.for(names)('decodes %s to the pixels PIL reads', (name) => {
      expectSameImage(decodePnm(fixture(name)), oracle(name))
    })
  })

  describe('ASCII formats', () => {
    it('decodes P1 bitmaps with spaces, treating 1 as black', () => {
      const image = decodePnm(ascii('P1\n3 2\n1 0 1\n0 1 0\n'))!
      expect({ width: image.width, height: image.height }).toEqual({ width: 3, height: 2 })
      expect(pixelAt(image, 0, 0)).toEqual([0, 0, 0, 255])
      expect(pixelAt(image, 1, 0)).toEqual([255, 255, 255, 255])
      expect(pixelAt(image, 1, 1)).toEqual([0, 0, 0, 255])
    })

    it('decodes P1 bitmaps whose digits are not separated', () => {
      const image = decodePnm(ascii('P1 4 1 1001'))!
      expect([0, 1, 2, 3].map((x) => pixelAt(image, x, 0)[0])).toEqual([0, 255, 255, 0])
    })

    it('decodes P2 graymaps and scales by the maximum value', () => {
      const image = decodePnm(ascii('P2\n3 1\n15\n0 5 15\n'))!
      expect([0, 1, 2].map((x) => pixelAt(image, x, 0))).toEqual([
        [0, 0, 0, 255],
        [85, 85, 85, 255],
        [255, 255, 255, 255],
      ])
    })

    it('decodes P3 pixmaps with a 16-bit maximum value', () => {
      const image = decodePnm(ascii('P3 1 1 65535 65535 32768 0'))!
      expect(pixelAt(image, 0, 0)).toEqual([255, 128, 0, 255])
    })

    it('caps samples above the maximum value at 255', () => {
      const image = decodePnm(ascii('P2 1 1 100 300'))!
      expect(pixelAt(image, 0, 0)).toEqual([255, 255, 255, 255])
    })

    it('skips comments in the header and between samples', () => {
      const text = 'P3 # created by hand\n2 # width\n1\n#full line\n255\n10 20 30 # first\n40 50 60\n'
      const image = decodePnm(ascii(text))!
      expect(pixelAt(image, 0, 0)).toEqual([10, 20, 30, 255])
      expect(pixelAt(image, 1, 0)).toEqual([40, 50, 60, 255])
    })

    it('ends a comment at a carriage return', () => {
      const image = decodePnm(ascii('P2\r# note\r2 1\r255\r7 9'))!
      expect(pixelAt(image, 1, 0)).toEqual([9, 9, 9, 255])
    })

    it('accepts tabs and form feeds between tokens', () => {
      const image = decodePnm(ascii('P2\t2\f1\v255\t1\t2'))!
      expect(pixelAt(image, 0, 0)[0]).toBe(1)
    })

    it('accepts a comment that runs to the end of the file when no samples are needed', () => {
      expect(decodePnm(ascii('P2 1 1 255 5 # trailing'))).not.toBeNull()
    })
  })

  describe('binary formats', () => {
    it('decodes P4 with rows padded to whole bytes', () => {
      const image = decodePnm(binary('P4\n10 2\n', 0b10101010, 0b11000000, 0b01010101, 0b00000000))!
      expect([0, 1, 8, 9].map((x) => pixelAt(image, x, 0)[0])).toEqual([0, 255, 0, 0])
      expect([0, 1, 8, 9].map((x) => pixelAt(image, x, 1)[0])).toEqual([255, 0, 255, 255])
    })

    it('decodes P5 with 8-bit samples', () => {
      const image = decodePnm(binary('P5\n3 1\n255\n', 0, 128, 255))!
      expect([0, 1, 2].map((x) => pixelAt(image, x, 0)[0])).toEqual([0, 128, 255])
    })

    it('decodes P5 with a maximum value below 255 by scaling', () => {
      const image = decodePnm(binary('P5 2 1 100\n', 50, 100))!
      expect(pixelAt(image, 0, 0)[0]).toBe(128)
      expect(pixelAt(image, 1, 0)[0]).toBe(255)
    })

    it('decodes P5 with 16-bit big-endian samples', () => {
      const image = decodePnm(binary('P5 2 1 65535\n', 0x80, 0x00, 0xff, 0xff))!
      expect(pixelAt(image, 0, 0)[0]).toBe(128)
      expect(pixelAt(image, 1, 0)[0]).toBe(255)
    })

    it('decodes P6 with 8-bit samples', () => {
      const image = decodePnm(binary('P6\n2 1\n255\n', 1, 2, 3, 4, 5, 6))!
      expect(pixelAt(image, 0, 0)).toEqual([1, 2, 3, 255])
      expect(pixelAt(image, 1, 0)).toEqual([4, 5, 6, 255])
    })

    it('decodes P6 with 16-bit samples', () => {
      const image = decodePnm(binary('P6 1 1 1000\n', 0x03, 0xe8, 0x01, 0xf4, 0x00, 0x00))!
      expect(pixelAt(image, 0, 0)).toEqual([255, 128, 0, 255])
    })

    it('reads exactly one whitespace byte after the header, even when data starts with a space', () => {
      const image = decodePnm(binary('P5 1 1 255\n', 32))!
      expect(pixelAt(image, 0, 0)[0]).toBe(32)
    })
  })

  describe('invalid input', () => {
    it('returns null for input shorter than three bytes', () => {
      expect(decodePnm(new Uint8Array(0))).toBeNull()
      expect(decodePnm(ascii('P6'))).toBeNull()
    })

    it('returns null when the first byte is not P', () => {
      expect(decodePnm(ascii('Q6 1 1 255 abc'))).toBeNull()
    })

    it.for(['P0', 'P7', 'P9', 'PX'])('returns null for the magic number %s', (magic) => {
      expect(decodePnm(ascii(`${magic} 1 1 255 abc`))).toBeNull()
    })

    it('returns null when the width is missing', () => {
      expect(decodePnm(ascii('P2 '))).toBeNull()
    })

    it('returns null when the height is missing', () => {
      expect(decodePnm(ascii('P2 4'))).toBeNull()
    })

    it('returns null for a non-numeric width', () => {
      expect(decodePnm(ascii('P2 ab 1 255 0'))).toBeNull()
    })

    it('returns null for a number longer than nine digits', () => {
      expect(decodePnm(ascii('P2 1234567890 1 255 0'))).toBeNull()
      expect(decodePnm(ascii('P2 12345678901234 1 255 0'))).toBeNull()
    })

    it('returns null for a negative width', () => {
      expect(decodePnm(ascii('P2 -1 1 255 0'))).toBeNull()
    })

    it('returns null for zero width', () => {
      expect(decodePnm(ascii('P2 0 1 255'))).toBeNull()
    })

    it('returns null for zero height', () => {
      expect(decodePnm(ascii('P2 1 0 255'))).toBeNull()
    })

    it('returns null when the pixel count is above the limit', () => {
      expect(4097 * 4096).toBeGreaterThan(MAX_PIXELS)
      expect(decodePnm(ascii('P2 4097 4096 255'))).toBeNull()
      expect(decodePnm(ascii('P2 999999999 999999999 255'))).toBeNull()
    })

    it('returns null when the maximum value is missing', () => {
      expect(decodePnm(ascii('P2 1 1'))).toBeNull()
    })

    it('returns null for a maximum value of zero', () => {
      expect(decodePnm(ascii('P2 1 1 0 0'))).toBeNull()
    })

    it('returns null for a maximum value above 65535', () => {
      expect(decodePnm(ascii('P2 1 1 65536 0'))).toBeNull()
    })

    it('returns null when P4 data is shorter than the bitmap', () => {
      expect(decodePnm(binary('P4 9 2\n', 0, 0, 0))).toBeNull()
    })

    it('returns null when P5 data is shorter than the image', () => {
      expect(decodePnm(binary('P5 3 1 255\n', 1, 2))).toBeNull()
    })

    it('returns null when P6 16-bit data is shorter than the image', () => {
      expect(decodePnm(binary('P6 1 1 65535\n', 1, 2, 3, 4, 5))).toBeNull()
    })

    it('returns null when P1 has a character other than 0 or 1', () => {
      expect(decodePnm(ascii('P1 2 1 1 2'))).toBeNull()
    })

    it('returns null when P1 runs out of digits', () => {
      expect(decodePnm(ascii('P1 3 1 1 0'))).toBeNull()
    })

    it('returns null when P2 runs out of samples', () => {
      expect(decodePnm(ascii('P2 3 1 255 1 2'))).toBeNull()
    })

    it('returns null when P2 has a non-numeric sample', () => {
      expect(decodePnm(ascii('P2 2 1 255 1 x'))).toBeNull()
    })

    it('returns null when P3 runs out of samples in the middle of a pixel', () => {
      expect(decodePnm(ascii('P3 1 1 255 1 2'))).toBeNull()
    })

    it('returns null when P3 has a non-numeric first, second or third sample', () => {
      expect(decodePnm(ascii('P3 1 1 255 x 2 3'))).toBeNull()
      expect(decodePnm(ascii('P3 1 1 255 1 x 3'))).toBeNull()
      expect(decodePnm(ascii('P3 1 1 255 1 2 x'))).toBeNull()
    })
  })
})
