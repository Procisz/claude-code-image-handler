import { describe, expect, it } from 'vitest'
import { baseName, wrapName } from '../src/names'

describe('baseName', () => {
  it('returns the last segment of a posix path', () => {
    expect(baseName('/home/me/photo.png')).toBe('photo.png')
  })

  it('returns the last segment of a windows path', () => {
    expect(baseName('C:\\Users\\me\\photo.png')).toBe('photo.png')
  })

  it('handles mixed separators', () => {
    expect(baseName('C:\\Users/me\\pics/photo.png')).toBe('photo.png')
  })

  it('returns a bare name unchanged', () => {
    expect(baseName('photo.png')).toBe('photo.png')
  })

  it('returns an empty string for a trailing separator', () => {
    expect(baseName('/home/me/')).toBe('')
  })
})

describe('wrapName', () => {
  it('keeps a name that fits on one line', () => {
    expect(wrapName('photo.png', 20)).toEqual(['photo.png'])
  })

  it('keeps a name exactly as wide as the limit on one line', () => {
    expect(wrapName('12345678901234567890', 20)).toEqual(['12345678901234567890'])
  })

  it('wraps a 23 character name at width 20 onto two lines', () => {
    expect(wrapName('abcdefghijklmnopqrstuvw', 20)).toEqual(['abcdefghijklmnopqrst', 'uvw'])
  })

  it('wraps a 45 character name at width 20 onto lines of 20, 20 and 5 characters', () => {
    const lines = wrapName('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS', 20)
    expect(lines).toEqual(['abcdefghijklmnopqrst', 'uvwxyzABCDEFGHIJKLMN', 'OPQRS'])
    expect(lines.map((line) => line.length)).toEqual([20, 20, 5])
  })

  it('joins the lines back to the exact name with no ellipsis, brackets or cut extension', () => {
    const name = 'my-very-long-screenshot-name-from-yesterday.final.jpeg'
    const lines = wrapName(name, 16)
    expect(lines.join('')).toBe(name)
    expect(lines.some((line) => /[[\]\u2026]|\.\.\./.test(line))).toBe(false)
  })

  it('never splits an emoji, counting code points', () => {
    expect(wrapName('😀'.repeat(25), 20)).toEqual(['😀'.repeat(20), '😀'.repeat(5)])
  })

  it('returns one empty line for an empty name', () => {
    expect(wrapName('', 20)).toEqual([''])
  })

  it('keeps a name of exactly two lines without an empty third line', () => {
    expect(wrapName('abcdefghijklmnopqrstabcdefghijklmnopqrst', 20)).toEqual([
      'abcdefghijklmnopqrst',
      'abcdefghijklmnopqrst',
    ])
  })
})
