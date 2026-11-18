import { deflateSync, constants } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inflate } from '../../src/decode/inflate'
import { BitSink, fixedLiteral, withHeader, ZLIB_HEADER } from './support/bits'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const wrap = (...bytes: number[]): Uint8Array => Uint8Array.from([...ZLIB_HEADER, ...bytes])

type Op = ['len', number] | ['copy', number] | ['zeros3', number] | ['zeros11', number]

const dynamicBlock = (
  sink: BitSink,
  options: { literalCount: number; distanceCount: number; ops: Op[]; body: (sink: BitSink) => void; last?: boolean },
): void => {
  sink.low(options.last === false ? 0 : 1, 1).low(2, 2)
  sink.low(options.literalCount - 257, 5).low(options.distanceCount - 1, 5).low(15, 4)
  for (let i = 0; i < 19; i++) {
    sink.low(5, 3)
  }
  for (const [kind, value] of options.ops) {
    if (kind === 'len') {
      sink.high(value, 5)
    } else if (kind === 'copy') {
      sink.high(16, 5).low(value - 3, 2)
    } else if (kind === 'zeros3') {
      sink.high(17, 5).low(value - 3, 3)
    } else {
      sink.high(18, 5).low(value - 11, 7)
    }
  }
  options.body(sink)
}

const lengthOps = (entries: Record<number, number>, total: number, from = 0): Op[] => {
  const ops: Op[] = []
  let zeros = 0
  const flush = (): void => {
    while (zeros > 0) {
      if (zeros >= 11) {
        const run = Math.min(zeros, 138)
        ops.push(['zeros11', run])
        zeros -= run
      } else if (zeros >= 3) {
        ops.push(['zeros3', zeros])
        zeros = 0
      } else {
        ops.push(['len', 0])
        zeros -= 1
      }
    }
  }
  for (let position = from; position < total; position++) {
    const length = entries[position]
    if (length === undefined) {
      zeros++
    } else {
      flush()
      ops.push(['len', length])
    }
  }
  flush()
  return ops
}

const smallDynamicOps: Op[] = [
  ['zeros11', 97],
  ['len', 3],
  ['copy', 3],
  ['zeros11', 138],
  ['zeros3', 10],
  ['zeros3', 7],
  ['len', 3],
  ['len', 3],
  ['len', 1],
]

describe('inflate', () => {
  describe('valid streams', () => {
    it('inflates a stored block', () => {
      const data = text('stored bytes')
      expect(inflate(new Uint8Array(deflateSync(data, { level: 0 })))).toEqual(data)
    })

    it('inflates a fixed Huffman block', () => {
      const data = text('fixed fixed fixed fixed huffman')
      const packed = new Uint8Array(deflateSync(data, { strategy: constants.Z_FIXED }))
      expect(inflate(packed)).toEqual(data)
    })

    it('inflates a dynamic Huffman block', () => {
      const data = text('dynamic '.repeat(200) + 'tail with other letters xyz')
      expect(inflate(new Uint8Array(deflateSync(data, { level: 9 })))).toEqual(data)
    })

    it('inflates several blocks of different types in one stream', () => {
      const sink = new BitSink()
      sink.low(0, 1).low(1, 2)
      for (const code of text('ab')) {
        fixedLiteral(sink, code)
      }
      fixedLiteral(sink, 256)
      sink.low(0, 1).low(0, 2).raw(2, 0, 0xfd, 0xff, 99, 100)
      sink.low(1, 1).low(1, 2)
      fixedLiteral(sink, 101)
      fixedLiteral(sink, 256)
      expect(inflate(withHeader(sink))).toEqual(text('abcde'))
    })

    it('inflates an empty fixed block to an empty array', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 256)
      expect(inflate(withHeader(sink))).toEqual(new Uint8Array(0))
    })

    it('copies overlapping matches byte by byte', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 97)
      fixedLiteral(sink, 261)
      sink.high(0, 5)
      fixedLiteral(sink, 256)
      expect(inflate(withHeader(sink))).toEqual(text('aaaaaaaa'))
    })

    it('grows the output buffer past its first size for large data', () => {
      const data = new Uint8Array(70000).map((_, index) => (index * 7 + (index >> 8)) & 255)
      expect(inflate(new Uint8Array(deflateSync(data, { level: 0 })))).toEqual(data)
    })

    it('grows the output buffer by doubling for highly compressible data', () => {
      const data = new Uint8Array(100000)
      expect(inflate(new Uint8Array(deflateSync(data)))).toEqual(data)
    })

    it('decodes a hand-built dynamic block that uses every run-length code length symbol', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 258,
        distanceCount: 1,
        ops: smallDynamicOps,
        body: (inner) => {
          inner.high(0, 3)
          inner.high(1, 3)
          inner.high(5, 3)
          inner.high(0, 1)
          inner.high(4, 3)
        },
      })
      expect(inflate(withHeader(sink))).toEqual(text('abbbb'))
    })
  })

  describe('limits', () => {
    it('returns null when the output would exceed maxLength', () => {
      const data = text('0123456789')
      const packed = new Uint8Array(deflateSync(data, { level: 0 }))
      expect(inflate(packed, 9)).toBeNull()
      expect(inflate(packed, 10)).toEqual(data)
    })

    it('returns null when a match would pass maxLength', () => {
      const packed = new Uint8Array(deflateSync(new Uint8Array(500)))
      expect(inflate(packed, 100)).toBeNull()
    })

    it('uses a very large default limit', () => {
      expect(inflate(new Uint8Array(deflateSync(new Uint8Array(5000))))?.length).toBe(5000)
    })
  })

  describe('zlib header', () => {
    it('returns null for input shorter than the header', () => {
      expect(inflate(Uint8Array.of(0x78))).toBeNull()
      expect(inflate(new Uint8Array(0))).toBeNull()
    })

    it('returns null when the compression method is not deflate', () => {
      expect(inflate(Uint8Array.of(0x79, 0x9c, 0x03, 0x00))).toBeNull()
    })

    it('returns null when the header check bits are wrong', () => {
      expect(inflate(Uint8Array.of(0x78, 0x9d, 0x03, 0x00))).toBeNull()
    })

    it('returns null when a preset dictionary is requested', () => {
      expect(inflate(Uint8Array.of(0x78, 0xbb, 0, 0, 0, 0, 0x03, 0x00))).toBeNull()
    })
  })

  describe('stored blocks', () => {
    it('returns null when the length fields are cut off', () => {
      expect(inflate(wrap(0x01, 0x05, 0x00))).toBeNull()
    })

    it('returns null when the length complement does not match', () => {
      expect(inflate(wrap(0x01, 0x01, 0x00, 0xfd, 0xff, 0x41))).toBeNull()
    })

    it('returns null when the data is shorter than the declared length', () => {
      expect(inflate(wrap(0x01, 0x05, 0x00, 0xfa, 0xff, 0x41))).toBeNull()
    })

    it('returns null when no block follows a non-final block', () => {
      expect(inflate(wrap(0x00, 0x00, 0x00, 0xff, 0xff))).toBeNull()
    })
  })

  describe('fixed blocks', () => {
    it('returns null for a reserved block type', () => {
      expect(inflate(wrap(0x07))).toBeNull()
    })

    it('returns null when the stream ends inside a block', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 97)
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null for a length symbol outside the table', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 97)
      fixedLiteral(sink, 286)
      sink.low(0, 8)
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null for a distance code that has no symbol', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 97)
      fixedLiteral(sink, 257)
      sink.high(30, 5)
      sink.low(0, 8)
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null when a match points before the start of the output', () => {
      const sink = new BitSink().low(1, 1).low(1, 2)
      fixedLiteral(sink, 97)
      fixedLiteral(sink, 257)
      sink.high(1, 5)
      fixedLiteral(sink, 256)
      expect(inflate(withHeader(sink))).toBeNull()
    })
  })

  describe('dynamic blocks', () => {
    it('returns null when more than 286 literal codes are declared even if the stream is otherwise valid', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 287,
        distanceCount: 1,
        ops: [...lengthOps({ 97: 1, 256: 1 }, 287), ['len', 0]],
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('accepts exactly 286 literal codes', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 286,
        distanceCount: 1,
        ops: [...lengthOps({ 97: 1, 256: 1 }, 286), ['len', 0]],
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toEqual(text('a'))
    })

    it('returns null when more than 30 distance codes are declared even if the stream is otherwise valid', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 31,
        ops: lengthOps({ 97: 1, 256: 1 }, 288),
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('accepts exactly 30 distance codes', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 30,
        ops: lengthOps({ 97: 1, 256: 1 }, 287),
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toEqual(text('a'))
    })

    it('returns null when a repeat of the previous length comes first even if the rest is valid', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 1,
        ops: [['copy', 3], ...lengthOps({ 97: 1, 256: 1 }, 258, 3)],
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null when a run of lengths passes the declared count even if the rest is valid', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 1,
        ops: [...lengthOps({ 97: 1, 256: 1 }, 257), ['zeros3', 5]],
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('accepts a run of lengths that ends exactly at the declared count', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 1,
        ops: lengthOps({ 97: 1, 256: 1 }, 258),
        body: (inner) => inner.high(0, 1).high(1, 1),
      })
      expect(inflate(withHeader(sink))).toEqual(text('a'))
    })

    it('returns null when the code length code is over-subscribed', () => {
      const sink = new BitSink().low(1, 1).low(2, 2).low(0, 5).low(0, 5).low(15, 4)
      for (let i = 0; i < 19; i++) {
        sink.low(1, 3)
      }
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null when the literal code is over-subscribed even if the stream never needs the extra symbol', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 1,
        ops: [...lengthOps({ 97: 2, 98: 2, 99: 2, 256: 1 }, 257), ['len', 0]],
        body: (inner) => inner.high(2, 2).high(3, 2).high(0, 1),
      })
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('decodes the same stream when the literal code is complete', () => {
      const sink = new BitSink()
      dynamicBlock(sink, {
        literalCount: 257,
        distanceCount: 1,
        ops: [...lengthOps({ 97: 2, 98: 2, 256: 1 }, 257), ['len', 0]],
        body: (inner) => inner.high(2, 2).high(3, 2).high(0, 1),
      })
      expect(inflate(withHeader(sink))).toEqual(text('ab'))
    })

    it('returns null when a code length symbol has no matching code', () => {
      const sink = new BitSink().low(1, 1).low(2, 2).low(0, 5).low(0, 5).low(15, 4)
      for (let i = 0; i < 19; i++) {
        sink.low(5, 3)
      }
      sink.high(0x7fff, 15).high(0x7fff, 15)
      expect(inflate(withHeader(sink))).toBeNull()
    })

    it('returns null when the stream ends inside the code lengths', () => {
      const sink = new BitSink().low(1, 1).low(2, 2).low(0, 5).low(0, 5).low(15, 4)
      expect(inflate(withHeader(sink))).toBeNull()
    })
  })

  describe('garbage', () => {
    it('returns null for random bytes after a valid header', () => {
      expect(inflate(wrap(0xff, 0xff, 0xff, 0xff))).toBeNull()
    })
  })
})
