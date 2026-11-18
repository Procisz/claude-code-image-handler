import { describe, expect, it } from 'vitest'
import { parseDraft, removeRef } from '../src/draft'

const options = { platform: 'mac', home: '/Users/me' } as const

function refOf(text: string, id: string) {
  const ref = parseDraft(text, options).find((candidate) => candidate.id === id)
  if (ref === undefined) throw new Error(`no ref ${id} in "${text}"`)
  return ref
}

describe('parseDraft', () => {
  it('returns nothing for plain text', () => {
    expect(parseDraft('hello world', options)).toEqual([])
  })

  it('finds an image tag with its span', () => {
    expect(parseDraft('see [Image #3] here', options)).toEqual([
      { id: 'tag:3', kind: 'tag', n: 3, spans: [{ start: 4, end: 14 }] },
    ])
  })

  it('finds a multi digit tag', () => {
    expect(parseDraft('[Image #25]', options)).toEqual([{ id: 'tag:25', kind: 'tag', n: 25, spans: [{ start: 0, end: 11 }] }])
  })

  it('ignores text that only looks like a tag', () => {
    expect(parseDraft('[Image #] [Image 1] [image #1] [Image #x]', options)).toEqual([])
  })

  it('finds a path reference with its span', () => {
    expect(parseDraft('look /tmp/a.png', options)).toEqual([
      { id: 'path:/tmp/a.png', kind: 'path', path: '/tmp/a.png', spans: [{ start: 5, end: 15 }] },
    ])
  })

  it('orders tags and paths by their first span', () => {
    const refs = parseDraft('/tmp/a.png [Image #2] /tmp/b.png [Image #1]', options)
    expect(refs.map((ref) => ref.id)).toEqual(['path:/tmp/a.png', 'tag:2', 'path:/tmp/b.png', 'tag:1'])
  })

  it('merges repeated references into one ref with every span', () => {
    const refs = parseDraft('[Image #1] x /tmp/a.png [Image #1] /tmp/a.png', options)
    expect(refs).toEqual([
      { id: 'tag:1', kind: 'tag', n: 1, spans: [{ start: 0, end: 10 }, { start: 24, end: 34 }] },
      { id: 'path:/tmp/a.png', kind: 'path', path: '/tmp/a.png', spans: [{ start: 13, end: 23 }, { start: 35, end: 45 }] },
    ])
  })

  it('gives 25 distinct references for 25 dropped paths', () => {
    const text = Array.from({ length: 25 }, (_unused, index) => `/tmp/img${index}.png`).join(' ')
    expect(parseDraft(text, options)).toHaveLength(25)
  })

  it('expands home paths using the options', () => {
    expect(parseDraft('~/a.png', options).map((ref) => ref.id)).toEqual(['path:/Users/me/a.png'])
  })
})

describe('removeRef', () => {
  it('removes the tag and the space before it when other text follows', () => {
    const text = 'a [Image #1] b'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'a b', cursor: 3 })
  })

  it('removes the space after the tag when the tag starts the text', () => {
    const text = '[Image #1] b'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'b', cursor: 1 })
  })

  it('removes the space before the tag when it ends the text', () => {
    const text = 'a [Image #1]'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'a', cursor: 1 })
  })

  it('removes a lone tag completely', () => {
    expect(removeRef('[Image #1]', 10, refOf('[Image #1]', 'tag:1'))).toEqual({ text: '', cursor: 0 })
  })

  it('removes only the tag when no space touches it', () => {
    const text = 'a[Image #1]b'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'ab', cursor: 2 })
  })

  it('removes the space after when the tag follows a non-space and precedes a space', () => {
    const text = 'a[Image #1] b'
    expect(removeRef(text, 0, refOf(text, 'tag:1'))).toEqual({ text: 'ab', cursor: 0 })
  })

  it('keeps the neighbouring tag and its spacing', () => {
    const text = '[Image #1] [Image #2]'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: '[Image #2]', cursor: 10 })
  })

  it('removes a path reference', () => {
    const text = 'look /tmp/a.png now'
    expect(removeRef(text, text.length, refOf(text, 'path:/tmp/a.png'))).toEqual({ text: 'look now', cursor: 8 })
  })

  it('removes every occurrence of a repeated reference', () => {
    const text = 'a [Image #1] b [Image #1] c'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'a b c', cursor: 5 })
  })

  it('merges the removal ranges of touching occurrences', () => {
    const text = 'a [Image #1] [Image #1] b'
    expect(removeRef(text, text.length, refOf(text, 'tag:1'))).toEqual({ text: 'a b', cursor: 3 })
  })

  it('leaves a cursor before the tag where it is', () => {
    const text = 'ab [Image #1] c'
    expect(removeRef(text, 1, refOf(text, 'tag:1'))).toEqual({ text: 'ab c', cursor: 1 })
  })

  it('moves a cursor after the tag left by the removed length', () => {
    const text = 'a [Image #1] bcd'
    expect(removeRef(text, 14, refOf(text, 'tag:1'))).toEqual({ text: 'a bcd', cursor: 3 })
  })

  it('moves a cursor right at the end of the removed range left by the removed length', () => {
    const text = 'a [Image #1] b'
    expect(removeRef(text, 12, refOf(text, 'tag:1'))).toEqual({ text: 'a b', cursor: 1 })
  })

  it('lands a cursor inside the tag at the start of the removed range', () => {
    const text = 'a [Image #1] b'
    expect(removeRef(text, 6, refOf(text, 'tag:1'))).toEqual({ text: 'a b', cursor: 1 })
  })

  it('lands a cursor inside a tag at the start of the text at index 0', () => {
    const text = '[Image #1] b'
    expect(removeRef(text, 4, refOf(text, 'tag:1'))).toEqual({ text: 'b', cursor: 0 })
  })

  it('handles a cursor after one occurrence and before another', () => {
    const text = 'a [Image #1] b [Image #1] c'
    expect(removeRef(text, 14, refOf(text, 'tag:1'))).toEqual({ text: 'a b c', cursor: 3 })
  })
})
