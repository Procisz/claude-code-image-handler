import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBase64 } from '../src/base64'
import { resetMissingTools } from '../src/convert'
import {
  JOB_LIMIT,
  OPEN_FAILED,
  REMOVE_FAILED,
  TICK_MS,
  createMemory,
  markDirty,
  notePaste,
  openImage,
  pictures,
  remove,
  setRequestId,
  start,
  stop,
  sync,
  tick,
} from '../src/controller'
import { SPINNER_FRAMES, spinnerCells } from '../src/layout'
import { createEngine, flushAll } from './helpers/engine'
import type { EngineOptions, RunHandler } from './helpers/engine'
import { makePpm } from './helpers/png'

let counter = 0

const defaultRun: RunHandler = (argv) => {
  if (argv[0] === 'uname') return { stdout: 'Linux\n' }
  if (argv[0] === 'id') return { stdout: '501\n' }
  return { exitCode: 1 }
}

function setup(options: EngineOptions = {}) {
  counter++
  const sessionId = options.sessionId ?? `controller-session-${counter}`
  const engine = createEngine({ run: defaultRun, ...options, sessionId })
  const memory = createMemory()
  return { engine, memory, $: engine.$ as never, sessionId }
}

function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function toolGate(engine: ReturnType<typeof createEngine>) {
  const closed = gate()
  const state = { current: 0, max: 0, started: 0 }
  engine.handlers.run = async (argv) => {
    if (argv[0] === 'uname') return { stdout: 'Linux\n' }
    if (argv[0] === 'id') return { stdout: '501\n' }
    state.current++
    state.started++
    state.max = Math.max(state.max, state.current)
    await closed.promise
    state.current--
    return { exitCode: 1 }
  }
  return { ...closed, state }
}

function statusOf(memory: ReturnType<typeof createMemory>, id: string) {
  return memory.items.find((item) => item.id === id)?.status
}

const ppm = (color: [number, number, number] = [10, 20, 30]) => makePpm(2, 2, color)

beforeEach(() => {
  resetMissingTools()
})

describe('constants', () => {
  it('allows three jobs at once and ticks every 200 ms', () => {
    expect(JOB_LIMIT).toBe(3)
    expect(TICK_MS).toBe(200)
    expect(REMOVE_FAILED).toBe('Could not remove the image from the prompt')
  })
})

describe('start and stop', () => {
  it('detects the platform, reads home and the renderer env, and arms a 200 ms timer', async () => {
    const { engine, memory, $ } = setup({
      env: { HOME: '/Users/me', CLAUDE_IMAGE_HANDLER_RENDERER: 'image' },
      run: (argv) => (argv[0] === 'uname' ? { stdout: 'Darwin\n' } : {}),
    })
    await start($, memory)
    expect(memory.platform).toBe('mac')
    expect(memory.home).toBe('/Users/me')
    expect(memory.rendererEnv.CLAUDE_IMAGE_HANDLER_RENDERER).toBe('image')
    expect(engine.$.clock.every).toHaveBeenCalledTimes(1)
    expect(engine.$.clock.every.mock.calls[0]?.[0]).toBe(200)
  })

  it('detects windows from the environment and reads USERPROFILE', async () => {
    const { memory, $ } = setup({ env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\me' } })
    await start($, memory)
    expect(memory.platform).toBe('windows')
    expect(memory.home).toBe('C:\\Users\\me')
  })

  it('starts only once however often it is called', async () => {
    const { engine, memory, $ } = setup()
    await Promise.all([start($, memory), start($, memory)])
    await start($, memory)
    expect(engine.$.clock.every).toHaveBeenCalledTimes(1)
  })

  it('ticks the draft when the timer fires', async () => {
    const { engine, memory, $ } = setup({ draft: '' })
    await start($, memory)
    engine.fireTimers()
    await flushAll()
    expect(engine.$.prompt.read).toHaveBeenCalledTimes(1)
  })

  it('cancels the timer on stop and can start again afterwards', async () => {
    const { engine, memory, $ } = setup()
    await start($, memory)
    stop(memory)
    expect(engine.activeTimers()).toHaveLength(0)
    expect(memory.timer).toBeUndefined()
    await start($, memory)
    expect(engine.activeTimers()).toHaveLength(1)
  })

  it('stops safely when never started', () => {
    expect(() => stop(createMemory())).not.toThrow()
  })

  it('can start again after a failed start', async () => {
    const { engine, memory, $ } = setup()
    engine.$.env.get.mockRejectedValueOnce(new Error('env unavailable'))
    await start($, memory)
    expect(engine.$.clock.every).not.toHaveBeenCalled()
    await start($, memory)
    expect(engine.$.clock.every).toHaveBeenCalledTimes(1)
  })
})

describe('pictures, markDirty and setRequestId', () => {
  it('decides from the renderer env read at start', async () => {
    const { memory, $ } = setup({ env: { KITTY_WINDOW_ID: '1' } })
    expect(pictures(memory, true)).toBe(false)
    await start($, memory)
    expect(pictures(memory, false)).toBe(true)
  })

  it('remembers the request id and the dirty flag', () => {
    const memory = createMemory()
    setRequestId(memory, 'req-9')
    markDirty(memory)
    expect(memory.requestId).toBe('req-9')
    expect(memory.isDirty).toBe(true)
  })
})

describe('sync with path references', () => {
  it('adds a loading item for an existing image file and ready after the job ran', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/cat.ppm': ppm() } })
    await sync($, memory, 'look /pics/cat.ppm')
    expect(memory.items).toEqual([
      { id: 'path:/pics/cat.ppm', kind: 'path', label: 'cat.ppm', status: 'loading', width: 0, height: 0 },
    ])
    await flushAll()
    expect(memory.items).toEqual([
      { id: 'path:/pics/cat.ppm', kind: 'path', label: 'cat.ppm', status: 'ready', width: 2, height: 2 },
    ])
    expect(memory.thumbs.get('path:/pics/cat.ppm')?.image.width).toBe(2)
    expect(engine.calls.length).toBeGreaterThan(0)
  })

  it('marks an unreadable image failed with zero size', async () => {
    const { memory, $ } = setup({ files: { '/pics/bad.png': Uint8Array.of(1, 2, 3) } })
    await sync($, memory, '/pics/bad.png')
    await flushAll()
    expect(memory.items).toEqual([
      { id: 'path:/pics/bad.png', kind: 'path', label: 'bad.png', status: 'failed', width: 0, height: 0 },
    ])
    expect(memory.thumbs.size).toBe(0)
  })

  it('ignores a path that does not exist', async () => {
    const { memory, $ } = setup()
    await sync($, memory, '/pics/nothing.png')
    expect(memory.items).toEqual([])
  })

  it('ignores a path that is a folder', async () => {
    const { memory, $ } = setup({ dirs: ['/pics/folder.png'] })
    await sync($, memory, '/pics/folder.png')
    expect(memory.items).toEqual([])
  })

  it('ignores text that is not an image reference', async () => {
    const { engine, memory, $ } = setup()
    await sync($, memory, 'just words /pics/notes.txt')
    expect(memory.items).toEqual([])
    expect(engine.$.fs.stat).not.toHaveBeenCalled()
  })

  it('checks a path on disk once while it stays in the draft', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/a.ppm': ppm() } })
    await sync($, memory, '/pics/a.ppm')
    await sync($, memory, '/pics/a.ppm hello')
    const checks = engine.$.fs.stat.mock.calls.filter((call) => call[0] === '/pics/a.ppm').length
    await flushAll()
    const checksAfterJob = engine.$.fs.stat.mock.calls.filter((call) => call[0] === '/pics/a.ppm').length
    expect(checks).toBe(1)
    expect(checksAfterJob).toBeGreaterThanOrEqual(1)
  })

  it('forgets the file check once the path leaves the draft', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/a.ppm': ppm() } })
    await sync($, memory, '/pics/a.ppm')
    await flushAll()
    await sync($, memory, 'nothing')
    expect(memory.files.size).toBe(0)
    engine.$.fs.stat.mockClear()
    await sync($, memory, '/pics/a.ppm')
    expect(engine.$.fs.stat.mock.calls.filter((call) => call[0] === '/pics/a.ppm')).toHaveLength(1)
  })

  it('keeps one item for the same path typed twice', async () => {
    const { memory, $ } = setup({ files: { '/pics/a.ppm': ppm() } })
    await sync($, memory, '/pics/a.ppm and again /pics/a.ppm')
    expect(memory.items).toHaveLength(1)
  })

  it('does not start a second job for an item it already has', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/a.ppm': ppm() } })
    await sync($, memory, '/pics/a.ppm')
    await flushAll()
    const runs = engine.calls.length
    await sync($, memory, '/pics/a.ppm more words')
    await flushAll()
    expect(engine.calls.length).toBe(runs)
    expect(statusOf(memory, 'path:/pics/a.ppm')).toBe('ready')
  })

  it('keeps the order of the draft', async () => {
    const files = { '/p/a.ppm': ppm(), '/p/b.ppm': ppm(), '/p/c.ppm': ppm() }
    const { memory, $ } = setup({ files })
    await sync($, memory, '/p/c.ppm /p/a.ppm /p/b.ppm')
    expect(memory.items.map((item) => item.label)).toEqual(['c.ppm', 'a.ppm', 'b.ppm'])
  })

  it('drops an item when its path leaves the draft', async () => {
    const { memory, $ } = setup({ files: { '/p/a.ppm': ppm(), '/p/b.ppm': ppm() } })
    await sync($, memory, '/p/a.ppm /p/b.ppm')
    await flushAll()
    await sync($, memory, '/p/b.ppm')
    expect(memory.items.map((item) => item.label)).toEqual(['b.ppm'])
    expect([...memory.thumbs.keys()]).toEqual(['path:/p/b.ppm'])
    expect([...memory.tokens.keys()]).toEqual(['path:/p/b.ppm'])
  })

  it('marks the state dirty after a sync and after a job', async () => {
    const { memory, $ } = setup({ files: { '/p/a.ppm': ppm() } })
    expect(memory.isStateDirty).toBe(false)
    await sync($, memory, '/p/a.ppm')
    expect(memory.isStateDirty).toBe(true)
    memory.isStateDirty = false
    await flushAll()
    expect(memory.isStateDirty).toBe(true)
  })

  it('remembers the last synced text', async () => {
    const { memory, $ } = setup()
    await sync($, memory, 'hello')
    expect(memory.lastText).toBe('hello')
  })

  it('serializes overlapping syncs', async () => {
    const { memory, $ } = setup({ files: { '/p/a.ppm': ppm(), '/p/b.ppm': ppm() } })
    await Promise.all([sync($, memory, '/p/a.ppm'), sync($, memory, '/p/a.ppm /p/b.ppm'), sync($, memory, '/p/b.ppm')])
    await flushAll()
    expect(memory.items.map((item) => item.label)).toEqual(['b.ppm'])
    expect(memory.lastText).toBe('/p/b.ppm')
  })

  it('keeps working after a sync failed', async () => {
    const { engine, memory, $ } = setup({ files: { '/p/a.ppm': ppm() } })
    engine.$.clock.now.mockRejectedValueOnce(new Error('clock down'))
    await expect(sync($, memory, '/p/a.ppm')).rejects.toThrow('clock down')
    await sync($, memory, '/p/a.ppm')
    expect(memory.items).toHaveLength(1)
  })
})

describe('sync with many references', () => {
  const names = Array.from({ length: 25 }, (_unused, index) => `/drop/img${index}.ppm`)
  const files = Object.fromEntries(names.map((name, index) => [name, ppm([index, 0, 0])]))

  it('gives all 25 dropped images an item at once, all loading', async () => {
    const { engine, memory, $ } = setup({ files })
    const tools = toolGate(engine)
    await sync($, memory, names.join(' '))
    expect(memory.items).toHaveLength(25)
    expect(memory.items.every((item) => item.status === 'loading')).toBe(true)
    tools.open()
    await flushAll()
  })

  it('never runs more than three jobs at once and finishes all 25', async () => {
    const { engine, memory, $ } = setup({ files })
    const tools = toolGate(engine)
    await sync($, memory, names.join(' '))
    await flushAll()
    expect(memory.running).toBe(3)
    expect(tools.state.current).toBe(3)
    tools.open()
    await flushAll()
    expect(tools.state.max).toBe(3)
    expect(memory.running).toBe(0)
    expect(memory.items).toHaveLength(25)
    expect(memory.items.every((item) => item.status === 'ready')).toBe(true)
    expect(memory.thumbs.size).toBe(25)
  })

  it('does not start jobs for items removed before they got a slot', async () => {
    const { engine, memory, $ } = setup({ files })
    const tools = toolGate(engine)
    await sync($, memory, names.slice(0, 6).join(' '))
    await flushAll()
    await sync($, memory, names[0] as string)
    tools.open()
    await flushAll()
    expect(memory.items.map((item) => item.status)).toEqual(['ready'])
    expect(memory.thumbs.size).toBe(1)
    expect(memory.pending).toEqual([])
  })
})

describe('late job results', () => {
  it('ignores the result of an item deleted while its job ran', async () => {
    const { engine, memory, $ } = setup({ files: { '/p/a.ppm': ppm() } })
    const tools = toolGate(engine)
    await sync($, memory, '/p/a.ppm')
    await flushAll()
    await sync($, memory, '')
    tools.open()
    await flushAll()
    expect(memory.items).toEqual([])
    expect(memory.thumbs.size).toBe(0)
    expect(memory.running).toBe(0)
  })

  it('ignores a stale result when the same path was added again', async () => {
    const { engine, memory, $ } = setup({ files: { '/p/a.ppm': ppm([1, 2, 3]) } })
    const tools = toolGate(engine)
    await sync($, memory, '/p/a.ppm')
    await flushAll()
    await sync($, memory, '')
    await sync($, memory, '/p/a.ppm')
    tools.open()
    await flushAll()
    expect(memory.items).toHaveLength(1)
    expect(memory.items[0]?.status).toBe('ready')
    expect(memory.thumbs.size).toBe(1)
  })
})

describe('sources of late tag jobs', () => {
  it('does not remember the source of a tag removed while its job ran', async () => {
    const sessionId = 'late-source-session'
    const file = `/tmp/claude-501/proj/${sessionId}/images/1.ppm`
    const { engine, memory, $ } = setup({ sessionId, files: { [file]: ppm() } })
    const tools = toolGate(engine)
    await sync($, memory, '[Image #1]')
    await flushAll()
    await sync($, memory, '')
    tools.open()
    await flushAll()
    expect(memory.sources.size).toBe(0)
    expect(memory.items).toEqual([])
  })
})

describe('sync with image tags', () => {
  const images = (sessionId: string) => `/tmp/claude-501/proj/${sessionId}/images`

  it('labels a pasted image Image #n and loads it from the Claude Code cache', async () => {
    const sessionId = 'tag-session-ready'
    const { memory, $ } = setup({ sessionId, files: { [`${images(sessionId)}/1.ppm`]: ppm([9, 9, 9]) } })
    await sync($, memory, 'see [Image #1]')
    expect(memory.items[0]).toMatchObject({ id: 'tag:1', kind: 'tag', label: 'Image #1', status: 'loading' })
    await flushAll()
    expect(memory.items[0]).toMatchObject({ status: 'ready', width: 2, height: 2 })
  })

  it('shows a failed tile when the cached file never appears', async () => {
    const { memory, $ } = setup({ dirs: ['/tmp/claude-501/proj/other/images'] })
    await sync($, memory, '[Image #2]')
    await flushAll()
    expect(memory.items[0]).toMatchObject({ id: 'tag:2', label: 'Image #2', status: 'failed' })
  })

  it('loads a tag whose cache file is written after the tag was synced', async () => {
    const sessionId = 'tag-session-late'
    const { engine, memory, $ } = setup({ sessionId })
    engine.$.clock.sleep.mockImplementation(async () => {
      if (engine.$.clock.sleep.mock.calls.length === 2) engine.setFile(`${images(sessionId)}/1.ppm`, ppm([9, 9, 9]))
    })
    await sync($, memory, '[Image #1]')
    await flushAll()
    expect(memory.items[0]).toMatchObject({ id: 'tag:1', status: 'ready', width: 2, height: 2 })
  })

  it('labels a pasted image with the file name from the paste and falls back to that file', async () => {
    const { memory, $ } = setup({ files: { '/Users/me/shots/screen one.ppm': ppm([7, 7, 7]) } })
    notePaste(memory, '/Users/me/shots/screen\\ one.ppm', 1_000_000)
    await sync($, memory, '[Image #1]')
    expect(memory.items[0]?.label).toBe('screen one.ppm')
    await flushAll()
    expect(memory.items[0]?.status).toBe('ready')
  })

  it('assigns recorded paste paths to new tags in order', async () => {
    const { memory, $ } = setup()
    notePaste(memory, '/a/one.png /a/two.png', 1_000_000)
    await sync($, memory, '[Image #1] [Image #2]')
    expect(memory.items.map((item) => item.label)).toEqual(['one.png', 'two.png'])
  })

  it('does not give a recorded path to a tag seen after the window', async () => {
    const { engine, memory, $ } = setup()
    notePaste(memory, '/a/one.png', 1_000_000)
    engine.clock.now += 5000
    await sync($, memory, '[Image #1]')
    expect(memory.items[0]?.label).toBe('Image #1')
  })

  it('does not reassign paste paths to a tag that already has an item', async () => {
    const { memory, $ } = setup()
    await sync($, memory, '[Image #1]')
    notePaste(memory, '/a/late.png', 1_000_000)
    await sync($, memory, '[Image #1] [Image #2]')
    expect(memory.items.map((item) => item.label)).toEqual(['Image #1', 'late.png'])
  })

  it('keeps one item for a tag that appears twice', async () => {
    const { memory, $ } = setup()
    await sync($, memory, '[Image #1] and [Image #1]')
    expect(memory.items).toHaveLength(1)
  })

  it('fails the tile instead of throwing when the loader throws', async () => {
    const { engine, memory, $ } = setup()
    engine.$.session.id.mockRejectedValue(new Error('no session'))
    await sync($, memory, '[Image #1]')
    await flushAll()
    expect(statusOf(memory, 'tag:1')).toBe('failed')
  })

  it('shows tags and paths together', async () => {
    const { memory, $ } = setup({ files: { '/p/a.ppm': ppm() } })
    await sync($, memory, '[Image #1] /p/a.ppm [Image #2]')
    expect(memory.items.map((item) => item.id)).toEqual(['tag:1', 'path:/p/a.ppm', 'tag:2'])
  })
})

describe('notePaste', () => {
  it('records the image paths of a paste using the detected platform and home', async () => {
    const { memory, $ } = setup({ env: { HOME: '/Users/me' } })
    await start($, memory)
    notePaste(memory, '~/shot.png', 1_000_000)
    expect(memory.paste.claim([1], 1_000_000)).toEqual(new Map([[1, '/Users/me/shot.png']]))
  })

  it('records nothing for text without image paths', () => {
    const memory = createMemory()
    notePaste(memory, 'hello there', 1_000_000)
    expect(memory.paste.claim([1], 1_000_000)).toEqual(new Map())
  })
})

describe('thumbnails', () => {
  it('keeps the decoded image and its base64 pixels only', async () => {
    const { memory, $ } = setup({ files: { '/p/a.ppm': ppm([50, 60, 70]) } })
    await sync($, memory, '/p/a.ppm')
    await flushAll()
    const entry = memory.thumbs.get('path:/p/a.ppm')
    expect(Object.keys(entry ?? {}).sort()).toEqual(['image', 'rgba'])
    expect(entry?.rgba).toBe(encodeBase64(entry?.image.rgba as Uint8Array))
  })
})

describe('remove', () => {
  it('takes the reference out of the draft with the cursor and drops the tile', async () => {
    const { engine, memory, $ } = setup({ draft: 'a /p/a.ppm b', files: { '/p/a.ppm': ppm() } })
    await sync($, memory, 'a /p/a.ppm b')
    await flushAll()
    await remove($, memory, 'path:/p/a.ppm')
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: 'a b', mode: 'replace', cursor: 3 })
    expect(engine.prompt.text).toBe('a b')
    expect(memory.items).toEqual([])
    expect(memory.thumbs.size).toBe(0)
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })

  it('removes a pasted image tag from the draft', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1] hello' })
    await sync($, memory, '[Image #1] hello')
    await remove($, memory, 'tag:1')
    expect(engine.prompt.text).toBe('hello')
    expect(memory.items).toEqual([])
  })

  it('removes every occurrence of a repeated reference', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1] x [Image #1]' })
    await sync($, memory, '[Image #1] x [Image #1]')
    await remove($, memory, 'tag:1')
    expect(engine.prompt.text).toBe('x')
  })

  it('shows a toast and keeps the tile when the prompt refuses the fill', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1]' })
    await sync($, memory, '[Image #1]')
    engine.prompt.accepts = false
    await remove($, memory, 'tag:1')
    expect(engine.$.ui.toast).toHaveBeenCalledWith('Could not remove the image from the prompt')
    expect(memory.items).toHaveLength(1)
    expect(engine.prompt.text).toBe('[Image #1]')
  })

  it('shows a toast when reading the prompt fails', async () => {
    const { engine, memory, $ } = setup()
    engine.$.prompt.read.mockRejectedValueOnce(new Error('prompt gone'))
    await remove($, memory, 'tag:1')
    expect(engine.$.ui.toast).toHaveBeenCalledWith(REMOVE_FAILED)
  })

  it('syncs without filling when the reference is already gone from the draft', async () => {
    const { engine, memory, $ } = setup({ draft: '' })
    await sync($, memory, '[Image #1]')
    expect(memory.items).toHaveLength(1)
    await remove($, memory, 'tag:1')
    expect(engine.$.prompt.fill).not.toHaveBeenCalled()
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
    expect(memory.items).toEqual([])
  })
})

describe('tick', () => {
  it('advances the spinner frame and wraps after the last one', async () => {
    const { memory, $ } = setup()
    for (let i = 0; i < SPINNER_FRAMES.length; i++) await tick($, memory)
    expect(memory.frame).toBe(0)
    await tick($, memory)
    expect(memory.frame).toBe(1)
  })

  it('syncs the first time and then only when the draft changed or is dirty', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1]' })
    await tick($, memory)
    expect(memory.items).toHaveLength(1)
    expect(memory.lastText).toBe('[Image #1]')
    engine.$.clock.now.mockClear()
    await tick($, memory)
    expect(engine.$.clock.now).not.toHaveBeenCalled()
    engine.setDraft('[Image #1] [Image #2]')
    await tick($, memory)
    expect(memory.items).toHaveLength(2)
    engine.$.clock.now.mockClear()
    markDirty(memory)
    await tick($, memory)
    expect(engine.$.clock.now).toHaveBeenCalled()
    expect(memory.isDirty).toBe(false)
  })

  it('writes the items to the plugin state once per change', async () => {
    const { engine, memory, $ } = setup({ draft: '/p/a.ppm', files: { '/p/a.ppm': ppm() } })
    const tools = toolGate(engine)
    await tick($, memory)
    expect(engine.$.state.set).toHaveBeenCalledTimes(1)
    expect(engine.state.get('image-handler/items')).toEqual([
      { id: 'path:/p/a.ppm', kind: 'path', label: 'a.ppm', status: 'loading', width: 0, height: 0 },
    ])
    await tick($, memory)
    expect(engine.$.state.set).toHaveBeenCalledTimes(1)
    expect(memory.isStateDirty).toBe(false)
    tools.open()
    await flushAll()
  })

  it('publishes ready items once the job finished', async () => {
    const { engine, memory, $ } = setup({ draft: '/p/a.ppm', files: { '/p/a.ppm': ppm() } })
    await tick($, memory)
    await flushAll()
    await tick($, memory)
    expect(engine.state.get('image-handler/items')).toEqual([
      { id: 'path:/p/a.ppm', kind: 'path', label: 'a.ppm', status: 'ready', width: 2, height: 2 },
    ])
  })

  it('blits the spinner of every loading item to the last render request', async () => {
    const { engine, memory, $ } = setup({ draft: '/p/a.ppm /p/b.ppm', files: { '/p/a.ppm': ppm(), '/p/b.ppm': ppm() } })
    toolGate(engine)
    setRequestId(memory, 'req-1')
    await tick($, memory)
    await flushAll()
    await tick($, memory)
    const cells = spinnerCells(2)
    expect(engine.$.ui.blit.mock.calls.slice(-2).map((call) => call[0])).toEqual([
      { requestId: 'req-1', key: 'spinner:path:/p/a.ppm', cells },
      { requestId: 'req-1', key: 'spinner:path:/p/b.ppm', cells },
    ])
  })

  it('blits the spinner of a loading clipboard offer', async () => {
    const { engine, memory, $ } = setup()
    memory.offer = { status: 'loading', width: 0, height: 0, path: '/t/a.png', token: {} }
    setRequestId(memory, 'req-9')
    await tick($, memory)
    expect(engine.$.ui.blit).toHaveBeenCalledTimes(1)
    expect(engine.$.ui.blit.mock.calls[0]?.[0]).toMatchObject({ requestId: 'req-9', key: 'spinner:clipboard' })
  })

  it('does not blit a clipboard offer that is ready', async () => {
    const { engine, memory, $ } = setup()
    memory.offer = { status: 'ready', width: 2, height: 2, path: '/t/a.png', token: {} }
    setRequestId(memory, 'req-9')
    await tick($, memory)
    expect(engine.$.ui.blit).not.toHaveBeenCalled()
  })

  it('does not blit before a render request is known', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1]' })
    await tick($, memory)
    expect(engine.$.ui.blit).not.toHaveBeenCalled()
  })

  it('does not blit items that are ready or failed', async () => {
    const { engine, memory, $ } = setup({ draft: '/p/a.ppm /p/bad.png', files: { '/p/a.ppm': ppm(), '/p/bad.png': Uint8Array.of(1) } })
    setRequestId(memory, 'req-1')
    await tick($, memory)
    await flushAll()
    engine.$.ui.blit.mockClear()
    await tick($, memory)
    expect(engine.$.ui.blit).not.toHaveBeenCalled()
  })

  it('goes on when a blit is denied', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1]' })
    engine.$.ui.blit.mockResolvedValue({ deny: 'not mounted' } as never)
    setRequestId(memory, 'req-1')
    await expect(tick($, memory)).resolves.toBeUndefined()
    expect(engine.$.ui.blit).toHaveBeenCalledTimes(1)
  })

  it('skips a tick while the previous one is still running', async () => {
    const { engine, memory, $ } = setup({ draft: 'x' })
    const slow = gate()
    engine.$.prompt.read.mockImplementationOnce(async () => {
      await slow.promise
      return { text: 'x', cursor: 1 }
    })
    const first = tick($, memory)
    await tick($, memory)
    expect(memory.frame).toBe(1)
    expect(engine.$.prompt.read).toHaveBeenCalledTimes(1)
    slow.open()
    await first
    expect(memory.isBusy).toBe(false)
  })

  it('swallows an error and ticks again afterwards', async () => {
    const { engine, memory, $ } = setup({ draft: '[Image #1]' })
    engine.$.prompt.read.mockRejectedValueOnce(new Error('prompt busy'))
    await expect(tick($, memory)).resolves.toBeUndefined()
    expect(memory.isBusy).toBe(false)
    await tick($, memory)
    expect(memory.items).toHaveLength(1)
  })
})

describe('openImage', () => {
  it('opens the file of a path reference in the viewer without a toast', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/cat.ppm': ppm() } })
    await sync($, memory, '/pics/cat.ppm')
    await flushAll()
    engine.calls.length = 0
    engine.handlers.run = () => ({})
    await openImage($, memory, 'path:/pics/cat.ppm')
    expect(engine.calls.map((call) => call.argv)).toEqual([['xdg-open', '/pics/cat.ppm']])
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })

  it('opens the cached file of an image tag', async () => {
    const sessionId = 'open-tag-session'
    const file = `/tmp/claude-501/proj/${sessionId}/images/1.ppm`
    const { engine, memory, $ } = setup({ sessionId, files: { [file]: ppm() } })
    await sync($, memory, '[Image #1]')
    await flushAll()
    engine.calls.length = 0
    engine.handlers.run = () => ({})
    await openImage($, memory, 'tag:1')
    expect(engine.calls.map((call) => call.argv)).toEqual([['xdg-open', file]])
  })

  it('toasts when the id has no known source', async () => {
    const { engine, memory, $ } = setup()
    await openImage($, memory, 'tag:9')
    expect(engine.$.ui.toast).toHaveBeenCalledWith(OPEN_FAILED)
    expect(engine.calls).toEqual([])
  })

  it('toasts when the viewer fails', async () => {
    const { engine, memory, $ } = setup({ files: { '/pics/cat.ppm': ppm() } })
    await sync($, memory, '/pics/cat.ppm')
    await flushAll()
    engine.handlers.run = () => ({ exitCode: 1 })
    await openImage($, memory, 'path:/pics/cat.ppm')
    expect(engine.$.ui.toast).toHaveBeenCalledWith('Could not open the image')
  })

  it('forgets the source when the tile is removed', async () => {
    const { engine, memory, $ } = setup({ draft: '/pics/cat.ppm', files: { '/pics/cat.ppm': ppm() } })
    await sync($, memory, '/pics/cat.ppm')
    await flushAll()
    await remove($, memory, 'path:/pics/cat.ppm')
    expect(memory.sources.size).toBe(0)
    await openImage($, memory, 'path:/pics/cat.ppm')
    expect(engine.$.ui.toast).toHaveBeenCalledWith(OPEN_FAILED)
  })
})
