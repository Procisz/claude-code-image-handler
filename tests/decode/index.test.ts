import { describe, expect, it } from 'vitest'
import { decodeImage, sniffFormat } from '../../src/decode/index'
import { expectSameImage, fixture, oracle } from './support/fixtures'

const ascii = (text: string): Uint8Array => Uint8Array.from(Array.from(text, (character) => character.charCodeAt(0)))

describe('sniffFormat', () => {
  it.for([
    ['png-rgb8.png', 'png'],
    ['jpeg-444.jpg', 'jpeg'],
    ['gif-plain.gif', 'gif'],
    ['bmp-rgb24.bmp', 'bmp'],
    ['pnm-p6.ppm', 'pnm'],
    ['pnm-p5.pgm', 'pnm'],
    ['pnm-p4.pbm', 'pnm'],
  ])('names %s as %s', ([name, format]) => {
    expect(sniffFormat(fixture(name!))).toBe(format)
  })

  it('recognises only the leading bytes of each signature', () => {
    expect(sniffFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png')
    expect(sniffFormat(Uint8Array.of(0xff, 0xd8, 0xff))).toBe('jpeg')
    expect(sniffFormat(ascii('GIF8'))).toBe('gif')
    expect(sniffFormat(ascii('BM'))).toBe('bmp')
  })

  it('does not call a truncated PNG signature a PNG', () => {
    expect(sniffFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull()
  })

  it('does not call a two-byte JPEG start a JPEG', () => {
    expect(sniffFormat(Uint8Array.of(0xff, 0xd8))).toBeNull()
  })

  it.for(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'])('names %s followed by a space as PNM', (magic) => {
    expect(sniffFormat(ascii(`${magic} 1 1`))).toBe('pnm')
  })

  it.for([[0x0a], [0x09], [0x0d], [0x23]])('accepts separator byte %i after the PNM magic', ([separator]) => {
    expect(sniffFormat(Uint8Array.of(0x50, 0x36, separator!))).toBe('pnm')
  })

  it('rejects the PNM magic without a separator', () => {
    expect(sniffFormat(ascii('P6x'))).toBeNull()
    expect(sniffFormat(ascii('P6'))).toBeNull()
    expect(sniffFormat(ascii('P'))).toBeNull()
  })

  it.for(['P0 ', 'P7 ', 'P8 ', 'Pa '])('rejects %j as PNM', (head) => {
    expect(sniffFormat(ascii(head))).toBeNull()
  })

  it('rejects a first byte other than P', () => {
    expect(sniffFormat(ascii('Q6 '))).toBeNull()
  })

  it('returns null for empty input and text', () => {
    expect(sniffFormat(new Uint8Array(0))).toBeNull()
    expect(sniffFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it('returns null for formats it cannot decode', () => {
    expect(sniffFormat(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBeNull()
    expect(sniffFormat(Uint8Array.of(0x49, 0x49, 0x2a, 0x00))).toBeNull()
  })
})

describe('decodeImage', () => {
  it.for(['png-rgba8.png', 'gif-plain.gif', 'bmp-rgb24.bmp', 'pnm-p6.ppm', 'pnm-p5.pgm', 'pnm-p4.pbm'])(
    'dispatches %s to its decoder',
    (name) => {
      expectSameImage(decodeImage(fixture(name)), oracle(name))
    },
  )

  it('dispatches a JPEG to the JPEG decoder', () => {
    expectSameImage(decodeImage(fixture('jpeg-444.jpg')), oracle('jpeg-444.jpg'), 3)
  })

  it('returns null for an unknown format', () => {
    expect(decodeImage(ascii('RIFF\0\0\0\0WEBP'))).toBeNull()
    expect(decodeImage(new Uint8Array(0))).toBeNull()
  })

  it('returns null when the detected decoder rejects the data', () => {
    expect(decodeImage(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBeNull()
    expect(decodeImage(ascii('GIF89a'))).toBeNull()
    expect(decodeImage(ascii('BM12345'))).toBeNull()
    expect(decodeImage(ascii('P6 '))).toBeNull()
    expect(decodeImage(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull()
  })
})
