import { describe, expect, it } from 'vitest'
import { createPasteMemory } from '../src/paste-memory'

describe('createPasteMemory', () => {
  it('claims nothing when nothing was recorded', () => {
    expect(createPasteMemory().claim([1], 0)).toEqual(new Map())
  })

  it('claims recorded paths in order for new tags', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png', '/b.png'], 1000)
    expect(memory.claim([4, 5], 1100)).toEqual(
      new Map([
        [4, '/a.png'],
        [5, '/b.png'],
      ]),
    )
  })

  it('claims across several records in order', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png'], 1000)
    memory.record(['/b.png', '/c.png'], 1500)
    expect(memory.claim([1, 2, 3], 1600)).toEqual(
      new Map([
        [1, '/a.png'],
        [2, '/b.png'],
        [3, '/c.png'],
      ]),
    )
  })

  it('forgets a path once it is claimed', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png'], 1000)
    memory.claim([1], 1000)
    expect(memory.claim([2], 1000)).toEqual(new Map())
  })

  it('keeps the paths a partial claim left over', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png', '/b.png'], 1000)
    memory.record(['/c.png'], 1000)
    expect(memory.claim([1], 1000)).toEqual(new Map([[1, '/a.png']]))
    expect(memory.claim([2, 3], 1000)).toEqual(
      new Map([
        [2, '/b.png'],
        [3, '/c.png'],
      ]),
    )
  })

  it('claims fewer paths than tags without failing', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png'], 1000)
    expect(memory.claim([1, 2, 3], 1000)).toEqual(new Map([[1, '/a.png']]))
  })

  it('claims at the exact end of the two second window', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png'], 1000)
    expect(memory.claim([1], 3000)).toEqual(new Map([[1, '/a.png']]))
  })

  it('ignores a record older than two seconds', () => {
    const memory = createPasteMemory()
    memory.record(['/a.png'], 1000)
    expect(memory.claim([1], 3001)).toEqual(new Map())
  })

  it('drops an old record when a newer one is recorded', () => {
    const memory = createPasteMemory()
    memory.record(['/old.png'], 1000)
    memory.record(['/new.png'], 5000)
    expect(memory.claim([1, 2], 5000)).toEqual(new Map([[1, '/new.png']]))
  })

  it('copies the recorded path list', () => {
    const memory = createPasteMemory()
    const paths = ['/a.png']
    memory.record(paths, 1000)
    paths.push('/late.png')
    expect(memory.claim([1, 2], 1000)).toEqual(new Map([[1, '/a.png']]))
  })

  it('records an empty paste without claiming anything', () => {
    const memory = createPasteMemory()
    memory.record([], 1000)
    expect(memory.claim([1], 1000)).toEqual(new Map())
  })
})
