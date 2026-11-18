import { describe, expect, it } from 'vitest'
import { decodeJpeg } from '../../src/decode/jpeg'
import { expectSameImage, fixture, fixtureNames, oracle, pixelAt } from './support/fixtures'
import {
  AC_COUNTS,
  AC_SYMBOLS,
  DC_COUNTS,
  DC_SYMBOLS,
  EOI,
  Entropy,
  SOI,
  acTable,
  dcTable,
  dht,
  dqt,
  dri,
  grayJpeg,
  ones,
  segment,
  sof,
  sos,
} from './support/jpeg'

const GRAY = [{ id: 1, h: 1, v: 1, tq: 0 }]
const COLOR = [
  { id: 1, h: 1, v: 1, tq: 0 },
  { id: 2, h: 1, v: 1, tq: 0 },
  { id: 3, h: 1, v: 1, tq: 0 },
]
const GRAY_SCAN = sos([{ id: 1, dc: 0, ac: 0 }])
const COLOR_SCAN = sos([
  { id: 1, dc: 0, ac: 0 },
  { id: 2, dc: 0, ac: 0 },
  { id: 3, dc: 0, ac: 0 },
])

const stream = (...parts: number[][]): Uint8Array => Uint8Array.from([...SOI, ...parts.flat(), ...EOI])
const onePixelData = (): number[] => new Entropy().block(8).done()

const grayHead = (): number[][] => [dqt(0, ones()), sof(0xc0, 8, 8, 8, GRAY), dcTable(), acTable()]

const grayWith = (replace: Partial<Record<'dqt' | 'sof' | 'dc' | 'ac' | 'sos', number[]>>): Uint8Array =>
  stream(
    replace.dqt ?? dqt(0, ones()),
    replace.sof ?? sof(0xc0, 8, 8, 8, GRAY),
    replace.dc ?? dcTable(),
    replace.ac ?? acTable(),
    replace.sos ?? GRAY_SCAN,
    onePixelData(),
  )

const expectGray = (image: ReturnType<typeof decodeJpeg>, value: number, tolerance = 0): void => {
  expect(image).not.toBeNull()
  for (let at = 0; at < image!.width * image!.height; at++) {
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(image!.rgba[at * 4 + channel]! - value), `pixel ${at}`).toBeLessThanOrEqual(tolerance)
    }
    expect(image!.rgba[at * 4 + 3]).toBe(255)
  }
}

const cosine = (u: number, x: number): number => (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)

const idealPixel = (terms: Array<[number, number, number]>, x: number, y: number): number => {
  let sum = 0
  for (const [u, v, value] of terms) {
    sum += (value * cosine(u, x) * cosine(v, y)) / 4
  }
  return Math.min(255, Math.max(0, sum + 128))
}

describe('decodeJpeg', () => {
  describe('fixtures written by cjpeg', () => {
    const names = fixtureNames().filter((name) => name.endsWith('.jpg'))

    it('has a fixture for every sampling mode', () => {
      expect(names).toEqual(
        expect.arrayContaining([
          'jpeg-444.jpg',
          'jpeg-420.jpg',
          'jpeg-422.jpg',
          'jpeg-440.jpg',
          'jpeg-gray.jpg',
          'jpeg-restart.jpg',
          'jpeg-optimized.jpg',
          'jpeg-q1-wide.jpg',
          'jpeg-multiscan.jpg',
        ]),
      )
    })

    it.for(names)('decodes %s within rounding of djpeg', (name) => {
      expectSameImage(decodeJpeg(fixture(name)), oracle(name), 1)
    })

    it.for(['jpeg-progressive.jpg', 'jpeg-arithmetic.jpg', 'jpeg-lossless.jpg', 'jpeg-12bit.jpg'])(
      'returns null for the unsupported file %s',
      (name) => {
        expect(decodeJpeg(fixture(name))).toBeNull()
      },
    )

    it('returns null for every truncation of a baseline file', () => {
      const whole = fixture('jpeg-420.jpg')
      for (let length = 0; length < whole.length - 2; length += 7) {
        expect(decodeJpeg(whole.subarray(0, length)), `length ${length}`).toBeNull()
      }
    })
  })

  describe('decoded values', () => {
    it('turns a DC-only block into a flat gray area', () => {
      const image = decodeJpeg(grayJpeg({ blocks: (e) => e.block(8) }))!
      expect({ width: image.width, height: image.height }).toEqual({ width: 8, height: 8 })
      expectGray(image, 129)
    })

    it('handles a negative DC difference', () => {
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(-40) })), 123)
    })

    it('multiplies coefficients by the quantization table', () => {
      const quant = ones()
      quant[0] = 4
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(10), quant })), 133)
    })

    it('reads 16-bit quantization tables', () => {
      const bytes = Uint8Array.from([
        ...SOI,
        ...dqt(0, new Array(64).fill(300), true),
        ...sof(0xc0, 8, 8, 8, GRAY),
        ...dcTable(),
        ...acTable(),
        ...GRAY_SCAN,
        ...new Entropy().block(2).done(),
        ...EOI,
      ])
      expectGray(decodeJpeg(bytes), 203)
    })

    it('carries the DC prediction from block to block', () => {
      const image = decodeJpeg(grayJpeg({ width: 24, height: 8, blocks: (e) => e.block(8).block(8).block(-24) }))!
      expect(pixelAt(image, 0, 0)[0]).toBe(129)
      expect(pixelAt(image, 9, 3)[0]).toBe(130)
      expect(pixelAt(image, 23, 7)[0]).toBe(127)
    })

    it.for([
      { k: 1, u: 1, v: 0, value: 40 },
      { k: 2, u: 0, v: 1, value: -56 },
      { k: 5, u: 2, v: 0, value: 30 },
      { k: 63, u: 7, v: 7, value: 20 },
    ])('applies the inverse DCT for the coefficient at zigzag position $k', ({ k, u, v, value }) => {
      const quant = ones()
      const run = k - 1
      const entropy = (e: Entropy) => {
        const skips = Array.from({ length: Math.floor(run / 16) }, () => 'zrl' as const)
        e.block(0, [...skips, [run % 16, value]], k !== 63)
      }
      const image = decodeJpeg(grayJpeg({ blocks: entropy, quant }))!
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const want = idealPixel([[u, v, value]], x, y)
          expect(Math.abs(image.rgba[(y * 8 + x) * 4]! - want), `pixel ${x},${y}`).toBeLessThanOrEqual(1)
        }
      }
    })

    it('uses the quantization step of the matching zigzag position', () => {
      const quant = Array.from({ length: 64 }, (_, index) => index + 1)
      const image = decodeJpeg(grayJpeg({ blocks: (e) => e.block(0, [[1, 5]]), quant }))!
      for (let x = 0; x < 8; x++) {
        const want = idealPixel([[0, 1, 5 * 3]], x, 2)
        expect(Math.abs(image.rgba[(2 * 8 + x) * 4]! - want)).toBeLessThanOrEqual(1)
      }
    })

    it('skips sixteen coefficients for a zero run', () => {
      const image = decodeJpeg(grayJpeg({ blocks: (e) => e.block(0, ['zrl', [0, 60]]) }))!
      const want = (x: number, y: number) => idealPixel([[3, 2, 60]], x, y)
      expect(Math.abs(image.rgba[(3 * 8 + 4) * 4]! - want(4, 3))).toBeLessThanOrEqual(1)
      expect(Math.abs(image.rgba[(6 * 8 + 1) * 4]! - want(1, 6))).toBeLessThanOrEqual(1)
    })

    it('clamps values that leave the 0 to 255 range', () => {
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(1000) })), 253)
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(1500) })), 255)
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(-1500) })), 0)
    })

    it('crops the padded blocks to the declared size', () => {
      const image = decodeJpeg(grayJpeg({ width: 5, height: 3, blocks: (e) => e.block(8) }))!
      expect({ width: image.width, height: image.height }).toEqual({ width: 5, height: 3 })
      expect(image.rgba.length).toBe(5 * 3 * 4)
    })

    it('ignores sampling factors on a single component', () => {
      const bytes = stream(
        dqt(0, ones()),
        sof(0xc0, 8, 8, 8, [{ id: 1, h: 2, v: 2, tq: 0 }]),
        dcTable(),
        acTable(),
        GRAY_SCAN,
        onePixelData(),
      )
      expectGray(decodeJpeg(bytes), 129)
    })

    it('converts YCbCr to RGB with the JFIF matrix', () => {
      const data = new Entropy().block(400).block(-640).block(320).done()
      const bytes = stream(dqt(0, ones()), sof(0xc0, 8, 8, 8, COLOR), dcTable(), acTable(), COLOR_SCAN, data)
      const image = decodeJpeg(bytes)!
      expect(pixelAt(image, 3, 3)).toEqual([234, 177, 36, 255])
    })

    it('accepts SOF1 extended sequential frames with 8-bit precision', () => {
      const bytes = stream(dqt(0, ones()), sof(0xc1, 8, 8, 8, GRAY), dcTable(), acTable(), GRAY_SCAN, onePixelData())
      expectGray(decodeJpeg(bytes), 129)
    })

    it('uses separate tables for each component', () => {
      const data = new Entropy().block(400).block(-640).block(320).done()
      const bytes = stream(
        dqt(0, ones()),
        dqt(1, ones()),
        sof(0xc0, 8, 8, 8, [
          { id: 1, h: 1, v: 1, tq: 0 },
          { id: 2, h: 1, v: 1, tq: 1 },
          { id: 3, h: 1, v: 1, tq: 1 },
        ]),
        dcTable(0),
        dcTable(1),
        acTable(0),
        acTable(1),
        sos([
          { id: 1, dc: 0, ac: 0 },
          { id: 2, dc: 1, ac: 1 },
          { id: 3, dc: 1, ac: 1 },
        ]),
        data,
      )
      expect(pixelAt(decodeJpeg(bytes)!, 0, 0)).toEqual([234, 177, 36, 255])
    })

    it('reads several tables from one DQT segment and one DHT segment', () => {
      const wideDc = new Array(64).fill(1)
      wideDc[0] = 4
      const bytes = stream(
        segment(0xdb, [0, ...ones(), 1, ...wideDc]),
        sof(0xc0, 8, 8, 8, [{ id: 1, h: 1, v: 1, tq: 1 }]),
        segment(0xc4, [0, ...DC_COUNTS, ...DC_SYMBOLS, 0x10, ...AC_COUNTS, ...AC_SYMBOLS]),
        GRAY_SCAN,
        new Entropy().block(10).done(),
      )
      expectGray(decodeJpeg(bytes), 133)
    })

    it('decodes a stream with no APP or COM segments and with them', () => {
      const withExtras = stream(
        segment(0xe0, [74, 70, 70, 0]),
        segment(0xfe, [104, 105]),
        ...grayHead(),
        GRAY_SCAN,
        onePixelData(),
      )
      expectGray(decodeJpeg(withExtras), 129)
    })

    it('ignores padding bytes and standalone markers between segments', () => {
      const bytes = stream(
        [0xff, 0xff, 0xff],
        [0xff, 0x01],
        [0x00, 0x00],
        [0xff, 0x00],
        dqt(0, ones()),
        [0xff, 0xd0],
        [0xff, 0xd8],
        sof(0xc0, 8, 8, 8, GRAY),
        dcTable(),
        acTable(),
        GRAY_SCAN,
        onePixelData(),
      )
      expectGray(decodeJpeg(bytes), 129)
    })

    it('stops at the end-of-image marker and ignores trailing bytes', () => {
      const bytes = Uint8Array.from([...grayJpeg({ blocks: (e) => e.block(8) }), 1, 2, 3, 0xff, 0xc0])
      expectGray(decodeJpeg(bytes), 129)
    })

    it('decodes a file with no end-of-image marker', () => {
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(8), eoi: false })), 129)
    })
  })

  describe('multiple scans', () => {
    const scanFor = (id: number): number[] => sos([{ id, dc: 0, ac: 0 }])

    it('decodes one scan per component', () => {
      const bytes = stream(
        dqt(0, ones()),
        sof(0xc0, 8, 8, 8, COLOR),
        dcTable(),
        acTable(),
        scanFor(1),
        new Entropy().block(400).done(),
        scanFor(2),
        new Entropy().block(-640).done(),
        scanFor(3),
        new Entropy().block(320).done(),
      )
      expect(pixelAt(decodeJpeg(bytes)!, 5, 5)).toEqual([234, 177, 36, 255])
    })

    it('sizes the blocks of a non-interleaved subsampled component from its own dimensions', () => {
      const bytes = stream(
        dqt(0, ones()),
        sof(0xc0, 8, 20, 8, [
          { id: 1, h: 2, v: 1, tq: 0 },
          { id: 2, h: 1, v: 1, tq: 0 },
          { id: 3, h: 1, v: 1, tq: 0 },
        ]),
        dcTable(),
        acTable(),
        scanFor(1),
        new Entropy().block(8).block(8).block(8).done(),
        scanFor(2),
        new Entropy().block(0).block(0).done(),
        scanFor(3),
        new Entropy().block(0).block(0).done(),
      )
      const image = decodeJpeg(bytes)!
      expect({ width: image.width, height: image.height }).toEqual({ width: 20, height: 8 })
      expect(pixelAt(image, 19, 7)[0]).toBe(131)
    })

    it('returns null when a component never gets a scan', () => {
      const bytes = stream(
        dqt(0, ones()),
        sof(0xc0, 8, 8, 8, COLOR),
        dcTable(),
        acTable(),
        scanFor(1),
        new Entropy().block(400).done(),
        scanFor(2),
        new Entropy().block(-640).done(),
      )
      expect(decodeJpeg(bytes)).toBeNull()
    })
  })

  describe('restart intervals', () => {
    const restarted = (build: (e: Entropy) => void): Uint8Array =>
      grayJpeg({ width: 24, height: 8, restartInterval: 1, blocks: build })

    it('resets the DC prediction after each restart marker', () => {
      const image = decodeJpeg(restarted((e) => e.block(8).marker(0xd0).block(16).marker(0xd1).block(-8)))!
      expect(pixelAt(image, 0, 0)[0]).toBe(129)
      expect(pixelAt(image, 9, 0)[0]).toBe(130)
      expect(pixelAt(image, 20, 0)[0]).toBe(127)
    })

    it('accepts any restart marker number from 0 to 7', () => {
      const image = decodeJpeg(restarted((e) => e.block(8).marker(0xd7).block(8).marker(0xd3).block(8)))
      expect(image).not.toBeNull()
    })

    it('returns null when the restart marker is missing', () => {
      expect(decodeJpeg(restarted((e) => e.block(8).block(8).block(8)))).toBeNull()
    })

    it('returns null when a different marker stands where the restart marker should be', () => {
      expect(decodeJpeg(restarted((e) => e.block(8).marker(0xc0).block(8).block(8)))).toBeNull()
      expect(decodeJpeg(restarted((e) => e.block(8).marker(0xd8).block(8).block(8)))).toBeNull()
      expect(decodeJpeg(restarted((e) => e.block(8).marker(0xcf).block(8).block(8)))).toBeNull()
    })

    it('returns null when the data ends where the restart marker should be', () => {
      expect(decodeJpeg(grayJpeg({ width: 16, height: 8, restartInterval: 1, blocks: (e) => e.block(8).rawByte(0xff), eoi: false }))).toBeNull()
      expect(decodeJpeg(grayJpeg({ width: 16, height: 8, restartInterval: 1, blocks: (e) => e.block(8), eoi: false }))).toBeNull()
    })

    it('returns null when the restart interval segment has the wrong length', () => {
      expect(decodeJpeg(stream(segment(0xdd, [0, 1, 2]), ...grayHead(), GRAY_SCAN, onePixelData()))).toBeNull()
      expect(decodeJpeg(stream(segment(0xdd, [0]), ...grayHead(), GRAY_SCAN, onePixelData()))).toBeNull()
    })

    it('ignores a restart interval of zero', () => {
      expectGray(decodeJpeg(grayJpeg({ blocks: (e) => e.block(8), restartInterval: 0 })), 129)
    })

    it('reads the interval as a 16-bit value', () => {
      expect(dri(0x0102)).toEqual([0xff, 0xdd, 0, 4, 1, 2])
      const image = decodeJpeg(grayJpeg({ width: 24, height: 8, restartInterval: 300, blocks: (e) => e.block(8).block(8).block(8) }))
      expect(image).not.toBeNull()
    })
  })

  describe('corrupt entropy data', () => {
    const markerAc = dht(1, 0, [0, 0, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0], [...AC_SYMBOLS.slice(2, 17), 0x00])

    it('decodes a byte of 0xFF when it is followed by a stuffing zero', () => {
      const bytes = grayJpeg({ blocks: (e) => e.bits(0, 8).rawByte(0xff).rawByte(0x00), ac: markerAc })
      expectGray(decodeJpeg(bytes), 128)
    })

    it('returns null when a marker stands where more bits are needed', () => {
      const bytes = grayJpeg({ blocks: (e) => e.bits(0, 8).rawByte(0xff).rawByte(0xc0), ac: markerAc })
      expect(decodeJpeg(bytes)).toBeNull()
    })

    it('returns null when the data stops in the middle of a block', () => {
      expect(decodeJpeg(grayJpeg({ blocks: (e) => e.bits(0b0011, 4), eoi: false }))).toBeNull()
    })

    it('returns null when the end of image marker comes mid-block', () => {
      expect(decodeJpeg(grayJpeg({ blocks: (e) => e.bits(0b0011, 4) }))).toBeNull()
    })

    it('returns null for a Huffman code that no symbol uses', () => {
      expect(decodeJpeg(grayJpeg({ blocks: (e) => e.bits(0xffff, 16).bits(0xffff, 16) }))).toBeNull()
    })

    it('returns null for a DC size above 15 even when enough bits follow', () => {
      const dc = dht(0, 0, DC_COUNTS, [...DC_SYMBOLS.slice(0, 11), 16])
      const bytes = grayJpeg({ blocks: (e) => e.bits(11, 4).bits(0x8000, 16).bits(0, 8), dc })
      expect(decodeJpeg(bytes)).toBeNull()
    })

    it('returns null when a run takes the coefficient index past 63', () => {
      const bytes = grayJpeg({
        blocks: (e) => e.block(0, ['zrl', 'zrl', 'zrl'], false).bits(AC_SYMBOLS.indexOf(0xf1), 8).bits(1, 1).bits(0, 8),
      })
      expect(decodeJpeg(bytes)).toBeNull()
    })

    it('stops reading coefficients once the index reaches 64', () => {
      const image = decodeJpeg(grayJpeg({ blocks: (e) => e.block(0, ['zrl', 'zrl', 'zrl', 'zrl'], false) }))
      expectGray(image, 128)
    })
  })

  describe('tables', () => {
    const withBefore = (bad: number[], tq = 0): Uint8Array =>
      stream(bad, dqt(0, ones()), sof(0xc0, 8, 8, 8, [{ id: 1, h: 1, v: 1, tq }]), dcTable(), acTable(), GRAY_SCAN, onePixelData())

    it('accepts the same stream when the extra table is valid', () => {
      expectGray(decodeJpeg(withBefore(dht(0, 1, DC_COUNTS, DC_SYMBOLS))), 129)
    })

    it('returns null for a DHT segment cut inside a table header', () => {
      expect(decodeJpeg(withBefore(segment(0xc4, [0, 0, 0, 0, 0])))).toBeNull()
    })

    it('returns null for a Huffman table class above 1', () => {
      expect(decodeJpeg(withBefore(dht(2, 0, DC_COUNTS, DC_SYMBOLS)))).toBeNull()
    })

    it('returns null for a Huffman table id above 3', () => {
      expect(decodeJpeg(withBefore(dht(0, 4, DC_COUNTS, DC_SYMBOLS)))).toBeNull()
      expect(decodeJpeg(withBefore(dht(1, 4, AC_COUNTS, AC_SYMBOLS)))).toBeNull()
    })

    it('returns null for a Huffman table with more than 256 symbols', () => {
      const counts = [255, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      expect(decodeJpeg(withBefore(dht(0, 1, counts, new Array(257).fill(0))))).toBeNull()
    })

    it('returns null for a Huffman table whose symbols are cut off', () => {
      expect(decodeJpeg(withBefore(dht(0, 1, DC_COUNTS, DC_SYMBOLS.slice(0, 5))))).toBeNull()
    })

    it('returns null for a quantization table with a bad precision', () => {
      expect(decodeJpeg(withBefore(segment(0xdb, [0x20, ...ones()])))).toBeNull()
    })

    it('returns null for a quantization table id above 3', () => {
      expect(decodeJpeg(withBefore(segment(0xdb, [0x04, ...ones()])))).toBeNull()
    })

    it('returns null for an 8-bit quantization table that is cut off', () => {
      expect(decodeJpeg(withBefore(segment(0xdb, [0x00, ...ones().slice(0, 63)])))).toBeNull()
    })

    it('returns null for a 16-bit quantization table that is cut off', () => {
      expect(decodeJpeg(withBefore(segment(0xdb, [0x10, ...ones()])))).toBeNull()
    })
  })

  describe('frame header', () => {
    const manyBlocks = (count: number): number[] => {
      const entropy = new Entropy()
      for (let i = 0; i < count; i++) {
        entropy.block(0)
      }
      return entropy.done()
    }

    const withFrame = (frame: number[], scan: number[], blocks: number): Uint8Array =>
      stream(dqt(0, ones()), frame, dcTable(), acTable(), scan, manyBlocks(blocks))

    const colorScan = (count: number): number[] =>
      sos(Array.from({ length: count }, (_, index) => ({ id: index + 1, dc: 0, ac: 0 })))

    it('decodes the same stream when the frame header is valid', () => {
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, COLOR), COLOR_SCAN, 3))).not.toBeNull()
    })

    it('returns null for a second frame header', () => {
      expect(decodeJpeg(stream(...grayHead(), sof(0xc0, 8, 8, 8, GRAY), GRAY_SCAN, onePixelData()))).toBeNull()
    })

    it('returns null for a frame header shorter than six bytes', () => {
      expect(decodeJpeg(grayWith({ sof: segment(0xc0, [8, 0, 8, 0, 8]) }))).toBeNull()
    })

    it('returns null for 12-bit precision', () => {
      expect(decodeJpeg(grayWith({ sof: sof(0xc1, 12, 8, 8, GRAY) }))).toBeNull()
    })

    it('returns null for 2 components', () => {
      const two = [GRAY[0]!, { id: 2, h: 1, v: 1, tq: 0 }]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, two), colorScan(2), 2))).toBeNull()
    })

    it('returns null for 4 components', () => {
      const four = [...COLOR, { id: 4, h: 1, v: 1, tq: 0 }]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, four), colorScan(4), 4))).toBeNull()
    })

    it('returns null when the segment length does not match the component count', () => {
      const bytes = sof(0xc0, 8, 8, 8, GRAY)
      expect(decodeJpeg(grayWith({ sof: segment(0xc0, [...bytes.slice(4), 0]) }))).toBeNull()
    })

    it('returns null for zero width', () => {
      expect(decodeJpeg(grayWith({ sof: sof(0xc0, 8, 0, 8, GRAY) }))).toBeNull()
    })

    it('returns null for zero height', () => {
      expect(decodeJpeg(grayWith({ sof: sof(0xc0, 8, 8, 0, GRAY) }))).toBeNull()
    })

    it('returns null when the pixel count is above the limit', () => {
      expect(decodeJpeg(grayWith({ sof: sof(0xc0, 8, 65535, 65535, GRAY) }))).toBeNull()
    })

    it.for([
      { name: 'zero horizontal sampling', h: 0, v: 1 },
      { name: 'horizontal sampling of 3', h: 3, v: 1 },
      { name: 'zero vertical sampling', h: 1, v: 0 },
      { name: 'vertical sampling of 3', h: 1, v: 3 },
    ])('returns null for $name', ({ h, v }) => {
      const components = [{ id: 1, h, v, tq: 0 }, COLOR[1]!, COLOR[2]!]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, components), COLOR_SCAN, 20))).toBeNull()
    })

    it('decodes sampling factors of 2 by 2 with a full set of blocks', () => {
      const components = [{ id: 1, h: 2, v: 2, tq: 0 }, COLOR[1]!, COLOR[2]!]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, components), COLOR_SCAN, 6))).not.toBeNull()
    })

    it('returns null for a component that names a missing quantization table', () => {
      const components = [{ id: 1, h: 1, v: 1, tq: 2 }, COLOR[1]!, COLOR[2]!]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, components), COLOR_SCAN, 3))).toBeNull()
    })

    it('returns null for a quantization table selector above 3', () => {
      const components = [{ id: 1, h: 1, v: 1, tq: 4 }, COLOR[1]!, COLOR[2]!]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, components), COLOR_SCAN, 3))).toBeNull()
    })

    it('returns null for duplicate component ids', () => {
      const components = [COLOR[0]!, COLOR[0]!, COLOR[2]!]
      expect(decodeJpeg(withFrame(sof(0xc0, 8, 8, 8, components), COLOR_SCAN, 3))).toBeNull()
    })
  })

  describe('scan header', () => {
    it('returns null for a scan before any frame', () => {
      expect(decodeJpeg(stream(dqt(0, ones()), dcTable(), acTable(), GRAY_SCAN, onePixelData()))).toBeNull()
    })

    it('returns null for a scan over two of three components', () => {
      const two = sos([
        { id: 1, dc: 0, ac: 0 },
        { id: 2, dc: 0, ac: 0 },
      ])
      const data = new Entropy().block(0).block(0).block(0).done()
      expect(decodeJpeg(stream(dqt(0, ones()), sof(0xc0, 8, 8, 8, COLOR), dcTable(), acTable(), two, data))).toBeNull()
    })

    it('returns null for a scan with no components', () => {
      expect(decodeJpeg(grayWith({ sos: segment(0xda, [0, 0, 63, 0]) }))).toBeNull()
    })

    it('returns null when the scan header length does not match its component count', () => {
      expect(decodeJpeg(grayWith({ sos: segment(0xda, [1, 1, 0, 0, 63, 0, 0]) }))).toBeNull()
    })

    it('returns null for a spectral selection that is not 0 to 63', () => {
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 1, dc: 0, ac: 0 }], 1, 63, 0) }))).toBeNull()
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 1, dc: 0, ac: 0 }], 0, 5, 0) }))).toBeNull()
    })

    it('returns null for successive approximation bits', () => {
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 1, dc: 0, ac: 0 }], 0, 63, 1) }))).toBeNull()
    })

    it('returns null for a component the frame does not define', () => {
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 9, dc: 0, ac: 0 }]) }))).toBeNull()
    })

    it('returns null when the DC table was never defined', () => {
      expect(decodeJpeg(grayWith({ dc: [] }))).toBeNull()
    })

    it('returns null when the AC table was never defined', () => {
      expect(decodeJpeg(grayWith({ ac: [] }))).toBeNull()
    })

    it('returns null when the quantization table was never defined', () => {
      expect(decodeJpeg(grayWith({ dqt: [] }))).toBeNull()
    })

    it('returns null when the DC table selector points into the AC tables', () => {
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 1, dc: 4, ac: 0 }]) }))).toBeNull()
    })

    it('returns null when the AC table selector is above 3', () => {
      expect(decodeJpeg(grayWith({ sos: sos([{ id: 1, dc: 0, ac: 4 }]) }))).toBeNull()
    })

    it('returns null when a component is listed twice', () => {
      const twice = sos([
        { id: 1, dc: 0, ac: 0 },
        { id: 1, dc: 0, ac: 0 },
        { id: 3, dc: 0, ac: 0 },
      ])
      const data = new Entropy().block(1).block(1).block(1).done()
      expect(decodeJpeg(stream(dqt(0, ones()), sof(0xc0, 8, 8, 8, COLOR), dcTable(), acTable(), twice, data))).toBeNull()
    })
  })

  describe('marker structure', () => {
    const complete = (): number[] => Array.from(grayJpeg({ blocks: (e) => e.block(8), eoi: false }))
    const body = (): number[] => complete().slice(2)

    it('decodes the complete stream used by the structure tests', () => {
      expectGray(decodeJpeg(Uint8Array.from(complete())), 129)
    })

    it('returns null for an empty array', () => {
      expect(decodeJpeg(new Uint8Array(0))).toBeNull()
    })

    it('returns null when the first byte is not 0xFF', () => {
      expect(decodeJpeg(Uint8Array.from([0x00, 0xd8, ...body()]))).toBeNull()
    })

    it('returns null when the second byte is not the SOI marker', () => {
      expect(decodeJpeg(Uint8Array.from([0xff, 0xd9, ...body()]))).toBeNull()
    })

    it('returns null for SOI directly followed by EOI', () => {
      expect(decodeJpeg(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull()
    })

    it('returns null for SOI alone', () => {
      expect(decodeJpeg(Uint8Array.of(0xff, 0xd8))).toBeNull()
    })

    it('returns null for SOI followed by bytes with no marker', () => {
      expect(decodeJpeg(Uint8Array.of(0xff, 0xd8, 1, 2, 3))).toBeNull()
    })

    it('returns null when a marker is the last byte', () => {
      expect(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0]))).toBeNull()
    })

    it('returns null when a segment length is cut off', () => {
      expect(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0, 0x00]))).toBeNull()
    })

    it('returns null for a segment length below 2 even after a complete image', () => {
      expect(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]))).toBeNull()
      expect(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]))).toBeNull()
    })

    it('returns null for a segment that runs past the end of the data even after a complete image', () => {
      expect(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0, 0x00, 0x20, 1, 2, 3]))).toBeNull()
    })

    it('accepts a trailing segment that ends exactly at the end of the data', () => {
      expectGray(decodeJpeg(Uint8Array.from([...complete(), 0xff, 0xe0, 0x00, 0x04, 1, 2])), 129)
    })

    const UNSUPPORTED = [0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]

    it.for(UNSUPPORTED)('returns null for the unsupported frame type %i as the only frame', (marker) => {
      const bytes = stream(dqt(0, ones()), sof(marker, 8, 8, 8, GRAY), dcTable(), acTable(), GRAY_SCAN, onePixelData())
      expect(decodeJpeg(bytes)).toBeNull()
    })

    it.for(UNSUPPORTED)('returns null for an unsupported frame type %i after a complete baseline image', (marker) => {
      const bytes = Uint8Array.from([...complete(), ...sof(marker, 8, 8, 8, GRAY)])
      expect(decodeJpeg(bytes)).toBeNull()
    })

    it('skips a DAC segment and other unknown segments', () => {
      const bytes = stream(segment(0xcc, [0, 1]), segment(0xe5, [1, 2, 3]), ...grayHead(), GRAY_SCAN, onePixelData())
      expectGray(decodeJpeg(bytes), 129)
    })
  })
})
