import { describe, expect, it } from 'vitest'
import { decodeBase64, encodeBase64 } from '../src/base64'

describe('base64', () => {
  it('encodes known bytes to the standard alphabet with padding', () => {
    expect(encodeBase64(Uint8Array.of(0x4d, 0x61, 0x6e, 0x21))).toBe('TWFuIQ==')
  })

  it('decodes known text to the original bytes', () => {
    expect(Array.from(decodeBase64('TWFuIQ=='))).toEqual([0x4d, 0x61, 0x6e, 0x21])
  })

  it('encodes an empty array to an empty string and back', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('')
    expect(decodeBase64('').length).toBe(0)
  })

  it('round-trips every byte value', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index)
    expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('round-trips input larger than one 32K chunk', () => {
    const bytes = Uint8Array.from({ length: 70_001 }, (_unused, index) => (index * 7) % 256)
    const text = encodeBase64(bytes)
    expect(text).toBe(Buffer.from(bytes).toString('base64'))
    expect(Array.from(decodeBase64(text))).toEqual(Array.from(bytes))
  })

  it('throws for text outside the base64 alphabet', () => {
    expect(() => decodeBase64('***')).toThrow()
  })
})
