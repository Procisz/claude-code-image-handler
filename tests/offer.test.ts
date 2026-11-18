import { beforeEach, describe, expect, it } from 'vitest'
import { resetMissingClipboardTools } from '../src/clipboard'
import { resetMissingTools } from '../src/convert'
import { createMemory } from '../src/controller'
import {
  ADD_FAILED,
  CLIPBOARD_POLL_MS,
  addOffer,
  cleanupClipboard,
  dismissOffer,
  insertPicture,
  pollClipboard,
  showOffer,
} from '../src/offer'
import { createEngine, settle } from './helpers/engine'
import type { EngineOptions } from './helpers/engine'
import { makePpm } from './helpers/png'

type Clip = { token: string; bytes: Uint8Array | undefined; exitCode: number }

function setup(options: EngineOptions = {}) {
  const clip: Clip = { token: 'v1', bytes: makePpm(2, 2, [10, 20, 30]), exitCode: 0 }
  const removed: string[] = []
  const reads: string[][] = []
  const engine = createEngine({
    env: { TMPDIR: '/t' },
    ...options,
    run: (argv) => {
      if (argv[0] === 'osascript') {
        reads.push(argv)
        if (clip.exitCode !== 0) return { exitCode: clip.exitCode }
        const [mode, seen, target] = [argv[5], argv[6], argv[7]] as string[]
        const isSkipped = mode === 'baseline' || (mode === 'changed' && seen === clip.token) || clip.bytes === undefined
        if (!isSkipped && clip.bytes !== undefined) engine.setFile(target as string, clip.bytes)
        return { stdout: JSON.stringify({ token: clip.token, path: isSkipped ? '' : target }) }
      }
      if (argv[0] === 'rm') {
        if (!/claude-image-handler-/.test(argv[2] as string)) removed.push(argv[2] as string)
        engine.removeFile(argv[2] as string)
        return {}
      }
      return { exitCode: 1 }
    },
  })
  const memory = createMemory()
  memory.platform = 'mac'
  return { engine, memory, clip, removed, reads, $: engine.$ as never }
}

beforeEach(() => {
  resetMissingTools()
  resetMissingClipboardTools()
})

describe('constants', () => {
  it('polls about every 1.5 seconds and names the add failure', () => {
    expect(CLIPBOARD_POLL_MS).toBe(1500)
    expect(ADD_FAILED).toBe('Could not add the picture to the prompt')
  })
})

describe('pollClipboard guards', () => {
  it('does nothing while watching is off', async () => {
    const { engine, memory, reads, $ } = setup()
    memory.watch = false
    await pollClipboard($, memory)
    expect(reads).toEqual([])
    expect(engine.$.clock.now).not.toHaveBeenCalled()
    expect(memory.polledAt).toBeUndefined()
  })

  it('does nothing while another poll runs', async () => {
    const { memory, reads, $ } = setup()
    memory.isPolling = true
    await pollClipboard($, memory)
    expect(reads).toEqual([])
    expect(memory.isPolling).toBe(true)
  })

  it('skips a poll less than 1500 ms after the last one and runs at exactly 1500 ms', async () => {
    const { engine, memory, reads, $ } = setup()
    await pollClipboard($, memory)
    expect(reads).toHaveLength(1)
    engine.clock.now += CLIPBOARD_POLL_MS - 1
    await pollClipboard($, memory)
    expect(reads).toHaveLength(1)
    engine.clock.now += 1
    await pollClipboard($, memory)
    expect(reads).toHaveLength(2)
    expect(memory.polledAt).toBe(engine.clock.now)
  })
})

describe('pollClipboard reads', () => {
  it('starts with a baseline read that offers nothing and remembers the version', async () => {
    const { memory, reads, $ } = setup()
    await pollClipboard($, memory)
    expect(reads[0]?.slice(0, 7)).toEqual(['osascript', '-l', 'JavaScript', '-e', reads[0]?.[4], 'baseline', ''])
    expect(reads[0]?.[7]).toMatch(/^\/t\/claude-image-handler\/clipboard-[0-9a-f-]{36}\.png$/)
    expect(memory.clipboardSeen).toBe('v1')
    expect(memory.offer).toBeUndefined()
    expect(memory.isPolling).toBe(false)
  })

  it('reads in changed mode after the baseline and offers nothing for the same version', async () => {
    const { engine, memory, reads, $ } = setup()
    await pollClipboard($, memory)
    engine.clock.now += CLIPBOARD_POLL_MS
    await pollClipboard($, memory)
    expect(reads[1]?.slice(5, 7)).toEqual(['changed', 'v1'])
    expect(memory.offer).toBeUndefined()
  })

  it('offers a ready tile with the thumbnail size when a new picture appears', async () => {
    const { engine, memory, clip, reads, $ } = setup()
    await pollClipboard($, memory)
    clip.token = 'v2'
    engine.clock.now += CLIPBOARD_POLL_MS
    await pollClipboard($, memory)
    expect(memory.clipboardSeen).toBe('v2')
    expect(memory.offer).toMatchObject({ status: 'ready', width: 2, height: 2, path: reads[1]?.[7] })
    expect(memory.thumbs.get('clipboard')?.image.width).toBe(2)
    expect(memory.isStateDirty).toBe(true)
    expect(memory.isPolling).toBe(false)
  })

  it('records the version without an offer when the new clipboard holds no picture', async () => {
    const { engine, memory, clip, $ } = setup()
    await pollClipboard($, memory)
    clip.token = 'v2'
    clip.bytes = undefined
    engine.clock.now += CLIPBOARD_POLL_MS
    await pollClipboard($, memory)
    expect(memory.clipboardSeen).toBe('v2')
    expect(memory.offer).toBeUndefined()
  })

  it('changes nothing and clears the polling flag when the tool fails', async () => {
    const { memory, clip, $ } = setup()
    clip.exitCode = 1
    await pollClipboard($, memory)
    expect(memory.clipboardSeen).toBeUndefined()
    expect(memory.offer).toBeUndefined()
    expect(memory.isPolling).toBe(false)
    expect(memory.polledAt).toBe(1_000_000)
  })

  it('swallows an unexpected error and clears the polling flag', async () => {
    const { engine, memory, $ } = setup()
    engine.$.env.get.mockRejectedValue(new Error('boom'))
    await expect(pollClipboard($, memory)).resolves.toBeUndefined()
    expect(memory.isPolling).toBe(false)
    expect(memory.clipboardSeen).toBeUndefined()
  })

  it('uses the Windows temp folder and separators on Windows', async () => {
    const { engine, memory, $ } = setup({ env: { TEMP: 'C:\\Temp\\' } })
    memory.platform = 'windows'
    engine.handlers.run = (argv, options) => {
      expect(argv[0]).toBe('powershell.exe')
      expect(options?.env?.CLAUDE_IMAGE_HANDLER_CLIP_TARGET).toMatch(
        /^C:\\Temp\\claude-image-handler\\clipboard-[0-9a-f-]{36}\.png$/,
      )
      return { stdout: JSON.stringify({ token: 'w1', path: '' }) }
    }
    await pollClipboard($, memory)
    expect(memory.clipboardSeen).toBe('w1')
  })
})

describe('showOffer', () => {
  it('shows a loading offer first and settles ready with the picture size', async () => {
    const { engine, memory, $ } = setup({ files: { '/t/a.png': makePpm(3, 5, [1, 2, 3]) } })
    const done = showOffer($, memory, '/t/a.png')
    await settle()
    expect(memory.offer).toMatchObject({ status: 'loading', width: 0, height: 0, path: '/t/a.png' })
    await done
    expect(memory.offer).toMatchObject({ status: 'ready', width: 3, height: 5, path: '/t/a.png' })
    expect(memory.thumbs.get('clipboard')?.image).toMatchObject({ width: 3, height: 5 })
    expect(engine.files.has('/t/a.png')).toBe(true)
  })

  it('settles failed without a thumbnail when the picture cannot be decoded', async () => {
    const { memory, $ } = setup({ files: { '/t/bad.png': Uint8Array.of(1, 2, 3) } })
    await showOffer($, memory, '/t/bad.png')
    expect(memory.offer).toMatchObject({ status: 'failed', width: 0, height: 0 })
    expect(memory.thumbs.has('clipboard')).toBe(false)
  })

  it('settles failed when loading throws', async () => {
    const { engine, memory, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    engine.$.env.get.mockRejectedValue(new Error('boom'))
    await showOffer($, memory, '/t/a.png')
    expect(memory.offer).toMatchObject({ status: 'failed' })
  })

  it('deletes the file of the previous unadded offer', async () => {
    const { engine, memory, removed, $ } = setup({
      files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]), '/t/b.png': makePpm(4, 4, [1, 2, 3]) },
    })
    await showOffer($, memory, '/t/a.png')
    await showOffer($, memory, '/t/b.png')
    expect(removed).toEqual(['/t/a.png'])
    expect(engine.files.has('/t/a.png')).toBe(false)
    expect(memory.offer).toMatchObject({ path: '/t/b.png', width: 4, height: 4 })
  })

  it('ignores the result of a load that was dismissed meanwhile', async () => {
    const { engine, memory, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    let release: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      release = resolve
    })
    const stat = engine.$.fs.stat.getMockImplementation() as (path: string) => Promise<unknown>
    engine.$.fs.stat.mockImplementationOnce(async (path: string) => {
      await closed
      return stat(path) as never
    })
    const done = showOffer($, memory, '/t/a.png')
    await settle()
    await dismissOffer($, memory)
    release()
    await done
    expect(memory.offer).toBeUndefined()
    expect(memory.thumbs.has('clipboard')).toBe(false)
  })

  it('ignores the result of a load that a newer offer replaced', async () => {
    const { engine, memory, $ } = setup({
      files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]), '/t/b.png': makePpm(4, 4, [1, 2, 3]) },
    })
    let release: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      release = resolve
    })
    const stat = engine.$.fs.stat.getMockImplementation() as (path: string) => Promise<unknown>
    engine.$.fs.stat.mockImplementationOnce(async (path: string) => {
      await closed
      return stat(path) as never
    })
    const first = showOffer($, memory, '/t/a.png')
    await settle()
    const second = showOffer($, memory, '/t/b.png')
    await second
    release()
    await first
    expect(memory.offer).toMatchObject({ path: '/t/b.png', status: 'ready', width: 4, height: 4 })
    expect(memory.thumbs.get('clipboard')?.image.width).toBe(4)
  })
})

describe('insertPicture', () => {
  it('inserts the path with a trailing space into an empty prompt and syncs', async () => {
    const { engine, memory, $ } = setup()
    expect(await insertPicture($, memory, '/t/a.png')).toBe(true)
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: '/t/a.png ', mode: 'insert' })
    expect(engine.prompt.text).toBe('/t/a.png ')
    expect(memory.lastText).toBe('/t/a.png ')
    expect(memory.clipboardFiles.has('/t/a.png')).toBe(true)
  })

  it('adds a leading space when the text before the cursor ends in a non-space', async () => {
    const { engine, memory, $ } = setup({ draft: 'look' })
    await insertPicture($, memory, '/t/a.png')
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: ' /t/a.png ', mode: 'insert' })
  })

  it('adds no leading space after a space or a newline', async () => {
    const { engine, memory, $ } = setup({ draft: 'look ' })
    await insertPicture($, memory, '/t/a.png')
    expect(engine.$.prompt.fill).toHaveBeenLastCalledWith({ text: '/t/a.png ', mode: 'insert' })
    engine.setDraft('look\n')
    await insertPicture($, memory, '/t/a.png')
    expect(engine.$.prompt.fill).toHaveBeenLastCalledWith({ text: '/t/a.png ', mode: 'insert' })
  })

  it('looks only at the text before the cursor', async () => {
    const { engine, memory, $ } = setup({ draft: 'a b', cursor: 2 })
    await insertPicture($, memory, '/t/a.png')
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: '/t/a.png ', mode: 'insert' })
  })

  it('wraps a path with whitespace in double quotes', async () => {
    const { engine, memory, $ } = setup({ draft: 'x' })
    await insertPicture($, memory, '/t/my pics/a.png')
    expect(engine.$.prompt.fill).toHaveBeenCalledWith({ text: ' "/t/my pics/a.png" ', mode: 'insert' })
  })

  it('returns false and remembers nothing when the prompt refuses the text', async () => {
    const { engine, memory, $ } = setup()
    engine.prompt.accepts = false
    expect(await insertPicture($, memory, '/t/a.png')).toBe(false)
    expect(memory.clipboardFiles.size).toBe(0)
    expect(memory.lastText).toBeUndefined()
  })

  it('returns false when the prompt throws', async () => {
    const { engine, memory, $ } = setup()
    engine.$.prompt.read.mockRejectedValueOnce(new Error('boom'))
    expect(await insertPicture($, memory, '/t/a.png')).toBe(false)
    expect(memory.clipboardFiles.size).toBe(0)
  })
})

describe('addOffer', () => {
  it('does nothing without an offer', async () => {
    const { engine, memory, $ } = setup()
    await addOffer($, memory)
    expect(engine.$.prompt.fill).not.toHaveBeenCalled()
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })

  it('puts the path in the prompt, clears the offer and keeps the file', async () => {
    const { engine, memory, removed, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    await showOffer($, memory, '/t/a.png')
    memory.isStateDirty = false
    await addOffer($, memory)
    expect(engine.prompt.text).toBe('/t/a.png ')
    expect(memory.offer).toBeUndefined()
    expect(memory.thumbs.has('clipboard')).toBe(false)
    expect(memory.isStateDirty).toBe(true)
    expect(removed).toEqual([])
    expect(engine.files.has('/t/a.png')).toBe(true)
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })

  it('toasts and keeps the offer when the prompt refuses', async () => {
    const { engine, memory, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    await showOffer($, memory, '/t/a.png')
    engine.prompt.accepts = false
    await addOffer($, memory)
    expect(engine.$.ui.toast).toHaveBeenCalledWith('Could not add the picture to the prompt')
    expect(memory.offer).toMatchObject({ path: '/t/a.png', status: 'ready' })
    expect(memory.thumbs.has('clipboard')).toBe(true)
  })
})

describe('dismissOffer', () => {
  it('deletes the offer file and clears the offer', async () => {
    const { engine, memory, removed, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    await showOffer($, memory, '/t/a.png')
    memory.isStateDirty = false
    await dismissOffer($, memory)
    expect(removed).toEqual(['/t/a.png'])
    expect(engine.files.has('/t/a.png')).toBe(false)
    expect(memory.offer).toBeUndefined()
    expect(memory.thumbs.has('clipboard')).toBe(false)
    expect(memory.isStateDirty).toBe(true)
  })

  it('does nothing without an offer', async () => {
    const { memory, removed, $ } = setup()
    memory.isStateDirty = false
    await dismissOffer($, memory)
    expect(removed).toEqual([])
    expect(memory.isStateDirty).toBe(false)
  })
})

describe('cleanupClipboard', () => {
  it('removes every added file and the current offer file', async () => {
    const { engine, memory, removed, $ } = setup({
      files: {
        '/t/a.png': makePpm(2, 2, [1, 2, 3]),
        '/t/b.png': makePpm(2, 2, [1, 2, 3]),
        '/t/c.png': makePpm(2, 2, [1, 2, 3]),
      },
    })
    await insertPicture($, memory, '/t/a.png')
    await insertPicture($, memory, '/t/b.png')
    await showOffer($, memory, '/t/c.png')
    await cleanupClipboard($, memory)
    expect([...removed].sort()).toEqual(['/t/a.png', '/t/b.png', '/t/c.png'])
    expect([...engine.files.keys()]).toEqual([])
    expect(memory.clipboardFiles.size).toBe(0)
    expect(memory.offer).toBeUndefined()
    expect(memory.thumbs.has('clipboard')).toBe(false)
  })

  it('removes an added file once even when it is also the offer file', async () => {
    const { memory, removed, $ } = setup({ files: { '/t/a.png': makePpm(2, 2, [1, 2, 3]) } })
    await insertPicture($, memory, '/t/a.png')
    await showOffer($, memory, '/t/a.png')
    await cleanupClipboard($, memory)
    expect(removed).toEqual(['/t/a.png'])
  })

  it('does nothing without files or an offer', async () => {
    const { engine, memory, $ } = setup()
    await cleanupClipboard($, memory)
    expect(engine.calls).toEqual([])
  })
})
