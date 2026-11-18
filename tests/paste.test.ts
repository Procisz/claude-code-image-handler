import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMissingClipboardTools } from '../src/clipboard'
import { createMemory } from '../src/controller'
import type { Memory } from '../src/controller'
import { ADDED, NOT_ADDED, NO_PICTURE, NO_TOOL, PASTE_SPEC, USAGE, runPaste } from '../src/paste'
import { createEngine, flushAll } from './helpers/engine'
import type { RunHandler } from './helpers/engine'

const UUID = '11111111-2222-3333-4444-555555555555'
const TARGET = `/tmp/claude-image-handler/clipboard-${UUID}.png`

function setup(osascript: RunHandler, options: { draft?: string } = {}) {
  const engine = createEngine({
    env: { TMPDIR: '/tmp/' },
    draft: options.draft,
    run: (argv, runOptions) => {
      if (argv[0] === 'uname') return { stdout: 'Darwin\n' }
      if (argv[0] === 'osascript') return osascript(argv, runOptions)
      return {}
    },
  })
  const memory = createMemory()
  return { engine, memory, $: engine.$ as never }
}

function clip(token: string, path: string): RunHandler {
  return () => ({ stdout: JSON.stringify({ token, path }) })
}

beforeEach(() => {
  resetMissingClipboardTools()
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(UUID as `${string}-${string}-${string}-${string}-${string}`)
})

afterEach(async () => {
  await flushAll()
  vi.restoreAllMocks()
})

function stopTimer(memory: Memory) {
  memory.timer?.cancel()
}

describe('PASTE_SPEC', () => {
  it('describes the command', () => {
    expect(PASTE_SPEC).toEqual({
      name: 'paste',
      description: 'Adds the clipboard picture to the prompt.',
      argumentHint: '[auto on|off]',
    })
  })
})

describe('runPaste without arguments', () => {
  it('reads the clipboard in always mode, inserts the path and records the token', async () => {
    const { engine, memory, $ } = setup(clip('12', TARGET), { draft: 'look' })
    const result = await runPaste($, memory, '')
    stopTimer(memory)
    expect(result).toEqual({ text: ADDED })
    expect(ADDED).toBe('Added the clipboard picture to the prompt.')
    expect(memory.clipboardSeen).toBe('12')
    expect(memory.clipboardFiles.has(TARGET)).toBe(true)
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: ` ${TARGET} `, mode: 'insert' })
    const call = engine.calls.find((entry) => entry.argv[0] === 'osascript')
    expect(call?.argv.slice(5)).toEqual(['always', '', TARGET])
  })

  it('passes the previously seen token', async () => {
    const { engine, memory, $ } = setup(clip('13', TARGET))
    memory.clipboardSeen = '12'
    await runPaste($, memory, '   ')
    stopTimer(memory)
    const call = engine.calls.find((entry) => entry.argv[0] === 'osascript')
    expect(call?.argv.slice(5)).toEqual(['always', '12', TARGET])
  })

  it('replies that no tool could read the clipboard', async () => {
    const { memory, $ } = setup(() => ({ exitCode: 1 }))
    const result = await runPaste($, memory, '')
    stopTimer(memory)
    expect(result).toEqual({
      text: 'Could not read the clipboard. It needs osascript (macOS), PowerShell (Windows), or wl-paste or xclip (Linux).',
    })
    expect(NO_TOOL).toBe(result.text)
    expect(memory.clipboardSeen).toBeUndefined()
  })

  it('replies that there is no picture and still records the token', async () => {
    const { engine, memory, $ } = setup(clip('5', ''))
    const result = await runPaste($, memory, '')
    stopTimer(memory)
    expect(result).toEqual({ text: 'No picture on the clipboard.' })
    expect(NO_PICTURE).toBe(result.text)
    expect(memory.clipboardSeen).toBe('5')
    expect(engine.prompt.text).toBe('')
  })

  it('replies that the prompt refused the text', async () => {
    const { engine, memory, $ } = setup(clip('6', TARGET))
    engine.prompt.accepts = false
    const result = await runPaste($, memory, '')
    stopTimer(memory)
    expect(result).toEqual({ text: 'Could not add the picture to the prompt.' })
    expect(NOT_ADDED).toBe(result.text)
    expect(memory.clipboardFiles.size).toBe(0)
  })

  it('discards a pending offer before inserting', async () => {
    const { engine, memory, $ } = setup(clip('8', TARGET))
    memory.offer = { status: 'ready', width: 4, height: 4, path: '/tmp/claude-image-handler/old.png', token: {} }
    memory.thumbs.set('clipboard', {} as never)
    await runPaste($, memory, '')
    stopTimer(memory)
    expect(memory.offer).toBeUndefined()
    expect(memory.thumbs.has('clipboard')).toBe(false)
    expect(engine.calls.some((c) => c.argv.join(' ') === 'rm -f /tmp/claude-image-handler/old.png')).toBe(true)
  })
})

describe('runPaste auto', () => {
  it.for([
    { args: 'auto on', text: 'Clipboard watching is on.' },
    { args: '  AUTO   On  ', text: 'Clipboard watching is on.' },
  ])('switches the watcher on for "$args"', async ({ args, text }) => {
    const { memory, $ } = setup(clip('1', ''))
    memory.watch = false
    memory.clipboardSeen = '9'
    memory.polledAt = 123
    expect(await runPaste($, memory, args)).toEqual({ text })
    expect(memory.watch).toBe(true)
    expect(memory.clipboardSeen).toBeUndefined()
    expect(memory.polledAt).toBeUndefined()
  })

  it.for(['auto off', ' Auto OFF\n'])('switches the watcher off and dismisses the offer for "%s"', async (args) => {
    const { engine, memory, $ } = setup(clip('1', ''))
    memory.offer = { status: 'ready', width: 4, height: 4, path: '/tmp/claude-image-handler/o.png', token: {} }
    expect(await runPaste($, memory, args)).toEqual({ text: 'Clipboard watching is off.' })
    expect(memory.watch).toBe(false)
    expect(memory.offer).toBeUndefined()
    expect(engine.calls.some((c) => c.argv.join(' ') === 'rm -f /tmp/claude-image-handler/o.png')).toBe(true)
  })

  it('reports the current state when auto has no value', async () => {
    const { memory, $ } = setup(clip('1', ''))
    expect(await runPaste($, memory, 'auto')).toEqual({
      text: 'Clipboard watching is on. Use /paste auto on or /paste auto off.',
    })
    memory.watch = false
    expect(await runPaste($, memory, 'AUTO')).toEqual({
      text: 'Clipboard watching is off. Use /paste auto on or /paste auto off.',
    })
  })

  it.for(['auto maybe', 'auto on now', 'auto on off', 'watch', 'on', 'now auto on'])('replies the usage for "%s"', async (args) => {
    const { engine, memory, $ } = setup(clip('1', ''))
    expect(await runPaste($, memory, args)).toEqual({ text: 'Usage: /paste, /paste auto on, /paste auto off' })
    expect(USAGE).toBe('Usage: /paste, /paste auto on, /paste auto off')
    expect(engine.calls).toEqual([])
    expect(memory.watch).toBe(true)
  })
})
