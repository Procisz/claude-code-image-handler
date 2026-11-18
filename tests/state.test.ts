import { describe, expect, it } from 'vitest'
import { readItems, readOffer, writeItems, writeOffer } from '../src/state'
import { createEngine } from './helpers/engine'

const KEY = 'image-handler/items'

const valid = {
  id: 'tag:1',
  kind: 'tag',
  label: 'Image #1',
  status: 'ready',
  width: 10,
  height: 20,
}

describe('readItems', () => {
  it('returns an empty list when nothing is stored', async () => {
    expect(await readItems(createEngine().$ as never)).toEqual([])
  })

  it('returns valid stored items', async () => {
    const engine = createEngine()
    engine.state.set(KEY, [valid, { ...valid, id: 'path:/a.png', kind: 'path', status: 'loading', width: 0, height: 0 }])
    expect(await readItems(engine.$ as never)).toHaveLength(2)
  })

  it('returns an empty list for a stored empty array', async () => {
    const engine = createEngine()
    engine.state.set(KEY, [])
    expect(await readItems(engine.$ as never)).toEqual([])
  })

  it.for([
    ['a string', 'items'],
    ['an object', { items: [] }],
    ['null', null],
    ['a number', 3],
  ] as const)('returns an empty list when the stored value is %s', async ([, value]) => {
    const engine = createEngine()
    engine.state.set(KEY, value)
    expect(await readItems(engine.$ as never)).toEqual([])
  })

  it.for([
    ['a null entry', null],
    ['a non-object entry', 'tag:1'],
    ['a numeric id', { ...valid, id: 1 }],
    ['an unknown kind', { ...valid, kind: 'url' }],
    ['a numeric label', { ...valid, label: 5 }],
    ['an unknown status', { ...valid, status: 'done' }],
    ['a missing status', { ...valid, status: undefined }],
    ['a string width', { ...valid, width: '10' }],
    ['a negative width', { ...valid, width: -1 }],
    ['a fractional width', { ...valid, width: 1.5 }],
    ['a string height', { ...valid, height: '10' }],
    ['a negative height', { ...valid, height: -3 }],
  ] as const)('returns an empty list when one entry is %s', async ([, entry]) => {
    const engine = createEngine()
    engine.state.set(KEY, [valid, entry])
    expect(await readItems(engine.$ as never)).toEqual([])
  })
})

describe('writeItems', () => {
  it('stores new items under the plugin key', async () => {
    const engine = createEngine()
    await writeItems(engine.$ as never, [valid] as never)
    expect(engine.$.state.set).toHaveBeenCalledWith({ plugin: 'image-handler', key: 'items' }, [valid])
    expect(engine.state.get(KEY)).toEqual([valid])
  })

  it('skips the write when the stored items are identical', async () => {
    const engine = createEngine()
    engine.state.set(KEY, [valid])
    await writeItems(engine.$ as never, [{ ...valid }] as never)
    expect(engine.$.state.set).not.toHaveBeenCalled()
  })

  it('writes when one field differs', async () => {
    const engine = createEngine()
    engine.state.set(KEY, [valid])
    await writeItems(engine.$ as never, [{ ...valid, status: 'failed' }] as never)
    expect(engine.$.state.set).toHaveBeenCalledTimes(1)
    expect(engine.state.get(KEY)).toEqual([{ ...valid, status: 'failed' }])
  })

  it('writes an empty list over stored items', async () => {
    const engine = createEngine()
    engine.state.set(KEY, [valid])
    await writeItems(engine.$ as never, [])
    expect(engine.state.get(KEY)).toEqual([])
  })

  it('replaces an invalid stored value', async () => {
    const engine = createEngine()
    engine.state.set(KEY, 'garbage')
    await writeItems(engine.$ as never, [valid] as never)
    expect(engine.state.get(KEY)).toEqual([valid])
  })

  it('skips writing an empty list over an invalid stored value that reads as empty', async () => {
    const engine = createEngine()
    engine.state.set(KEY, 'garbage')
    await writeItems(engine.$ as never, [])
    expect(engine.$.state.set).not.toHaveBeenCalled()
  })
})

const OFFER_KEY = 'image-handler/clipboard'

describe('readOffer', () => {
  it('returns null when nothing is stored', async () => {
    expect(await readOffer(createEngine().$ as never)).toBeNull()
  })

  it.for(['loading', 'ready', 'failed'] as const)('returns a stored %s offer', async (status) => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, { status, width: 4, height: 2 })
    expect(await readOffer(engine.$ as never)).toEqual({ status, width: 4, height: 2 })
  })

  it('drops fields other than status and size', async () => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, { status: 'ready', width: 4, height: 2, path: '/x' })
    expect(await readOffer(engine.$ as never)).toEqual({ status: 'ready', width: 4, height: 2 })
  })

  it.for([
    ['a string', 'ready'],
    ['null', null],
    ['an unknown status', { status: 'done', width: 1, height: 1 }],
    ['a missing status', { width: 1, height: 1 }],
    ['a string width', { status: 'ready', width: '1', height: 1 }],
    ['a negative width', { status: 'ready', width: -1, height: 1 }],
    ['a fractional height', { status: 'ready', width: 1, height: 1.5 }],
    ['a missing height', { status: 'ready', width: 1 }],
  ] as const)('returns null when the stored value is %s', async ([, value]) => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, value)
    expect(await readOffer(engine.$ as never)).toBeNull()
  })
})

describe('writeOffer', () => {
  const offer = { status: 'ready', width: 4, height: 2 } as const

  it('stores a new offer under the clipboard key', async () => {
    const engine = createEngine()
    await writeOffer(engine.$ as never, offer)
    expect(engine.$.state.set).toHaveBeenCalledWith({ plugin: 'image-handler', key: 'clipboard' }, offer)
    expect(engine.state.get(OFFER_KEY)).toEqual(offer)
  })

  it('skips the write when the stored offer is identical', async () => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, { ...offer })
    await writeOffer(engine.$ as never, { ...offer })
    expect(engine.$.state.set).not.toHaveBeenCalled()
  })

  it('skips writing null when nothing valid is stored', async () => {
    const engine = createEngine()
    await writeOffer(engine.$ as never, null)
    expect(engine.$.state.set).not.toHaveBeenCalled()
  })

  it('writes null over a stored offer', async () => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, offer)
    await writeOffer(engine.$ as never, null)
    expect(engine.state.get(OFFER_KEY)).toBeNull()
  })

  it('writes when the status differs', async () => {
    const engine = createEngine()
    engine.state.set(OFFER_KEY, { ...offer, status: 'loading' })
    await writeOffer(engine.$ as never, offer)
    expect(engine.state.get(OFFER_KEY)).toEqual(offer)
  })
})
