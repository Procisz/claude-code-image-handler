import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMissingClipboardTools } from '../src/clipboard'
import { resetMissingTools } from '../src/convert'
import { PASTE_SPEC } from '../src/paste'
import { HINT } from '../src/view'
import { register } from '../hooks/register'
import { createEngine, flushAll } from './helpers/engine'
import type { EngineOptions } from './helpers/engine'
import { makePpm } from './helpers/png'

type Node = { type: unknown; props: Record<string, any>; children: any[] }
type Handler = (...args: any[]) => any

let counter = 0

function walk(node: unknown, visit: (node: Node) => void): void {
  if (typeof node !== 'object' || node === null) return
  visit(node as Node)
  for (const child of (node as Node).children) walk(child, visit)
}

function all(node: unknown, type: string): Node[] {
  const found: Node[] = []
  walk(node, (candidate) => {
    if (candidate.type === type) found.push(candidate)
  })
  return found
}

function setup(options: EngineOptions = {}, pluginOptions: Record<string, unknown> = {}) {
  counter++
  const engine = createEngine({
    sessionId: `register-session-${counter}`,
    run: (argv) => {
      if (argv[0] === 'uname') return { stdout: 'Linux\n' }
      return { exitCode: 1 }
    },
    ...options,
  })
  const handlers = new Map<string, Handler>()
  register(((name: string, second: unknown, third?: Handler) => {
    const handler = (third ?? second) as Handler
    const matcher = second as { component?: string; command?: string }
    const key = third === undefined ? name : `${name}:${matcher.component ?? matcher.command}`
    handlers.set(key, handler)
  }) as never, pluginOptions as never)
  const $ = engine.$ as never
  const next = vi.fn(async (_event: unknown) => 'below-content')
  return {
    engine,
    handlers,
    next,
    fire: (name: string, event: Record<string, unknown>) => (handlers.get(name) as Handler)($, event, next),
  }
}

function renderEvent(overrides: Record<string, unknown> = {}) {
  return {
    surface: 'terminal',
    requestId: 'req-1',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80 },
    viewport: { isFullscreen: false },
    ...overrides,
  }
}

async function withReadyImage(options: EngineOptions = {}) {
  const context = setup({ files: { '/p/cat.ppm': makePpm(2, 2, [10, 20, 30]) }, draft: '/p/cat.ppm', ...options })
  await context.fire('session.start', {})
  context.engine.fireTimers()
  await flushAll()
  context.engine.fireTimers()
  await flushAll()
  return context
}

function clipboardRun(clip: { token: string }) {
  return (argv: string[]) => {
    if (argv[0] === 'uname') return { stdout: 'Linux\n' }
    if (argv[0] === 'xclip') return { stdout: 'TARGETS\nimage/png\n' }
    if (argv[0] === 'sh' && argv[2]?.includes('cksum')) return { stdout: `${clip.token} 1\n` }
    return { exitCode: 1 }
  }
}

async function withClipboardOffer() {
  const clip = { token: 'v1' }
  const context = setup({ env: { TMPDIR: '/t' } })
  const { engine } = context
  engine.handlers.run = (argv, runOptions) => {
    if (argv[0] === 'sh' && argv[2]?.includes('mkdir')) {
      engine.setFile(argv[5] as string, makePpm(2, 2, [5, 6, 7]))
      return {}
    }
    if (argv[0] === 'rm') {
      engine.removeFile(argv[2] as string)
      return {}
    }
    return clipboardRun(clip)(argv)
  }
  await context.fire('session.start', {})
  engine.fireTimers()
  await flushAll()
  clip.token = 'v2'
  engine.clock.now += 1500
  engine.fireTimers()
  await flushAll()
  engine.fireTimers()
  await flushAll()
  return context
}

beforeEach(() => {
  resetMissingTools()
  resetMissingClipboardTools()
})

describe('register', () => {
  it('registers the session, prompt and render hooks', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([
      'command.run:paste',
      'prompt.change',
      'prompt.edit',
      'session.end',
      'session.start',
      'ui.render:AbovePrompt',
    ])
  })
})

describe('session hooks', () => {
  it('starts the 200 ms timer on session.start and passes the event on', async () => {
    const { engine, fire, next } = setup()
    const event = { id: 'e1' }
    expect(await fire('session.start', event)).toBe('below-content')
    expect(next).toHaveBeenCalledWith(event)
    expect(engine.activeTimers().map((timer) => timer.ms)).toEqual([200])
  })

  it('starts the timer once even when several hooks ask', async () => {
    const { engine, fire } = setup()
    await fire('session.start', {})
    await fire('prompt.change', {})
    await fire('prompt.edit', { inputText: 'x', key: 'a' })
    expect(engine.timers).toHaveLength(1)
  })

  it('cancels the timer on session.end and passes the event on', async () => {
    const { engine, fire, next } = setup()
    await fire('session.start', {})
    const event = { id: 'end' }
    expect(await fire('session.end', event)).toBe('below-content')
    expect(next).toHaveBeenLastCalledWith(event)
    expect(engine.activeTimers()).toHaveLength(0)
  })

  it('arms the timer again after a hot reload style restart', async () => {
    const { engine, fire } = setup()
    await fire('session.start', {})
    await fire('session.end', {})
    await fire('prompt.change', {})
    expect(engine.activeTimers()).toHaveLength(1)
  })
})

describe('prompt hooks', () => {
  it('lets prompt.change through unchanged and starts the timer', async () => {
    const { engine, fire, next } = setup()
    const event = { text: 'x' }
    expect(await fire('prompt.change', event)).toBe('below-content')
    expect(next).toHaveBeenCalledWith(event)
    expect(engine.activeTimers()).toHaveLength(1)
  })

  it('returns the prompt.edit result of the next handler untouched', async () => {
    const { fire, next } = setup()
    next.mockResolvedValueOnce({ inputText: 'changed' } as never)
    const event = { inputText: 'typed', key: 'a' }
    expect(await fire('prompt.edit', event)).toEqual({ inputText: 'changed' })
    expect(next).toHaveBeenCalledWith(event)
  })

  it('learns the file name of a pasted image path so the tile shows it', async () => {
    const { engine, fire } = setup({ files: { '/Users/me/shot one.ppm': makePpm(1, 1, [1, 2, 3]) } })
    await fire('prompt.edit', { inputText: "'/Users/me/shot one.ppm'", key: undefined })
    engine.setDraft('[Image #1]')
    engine.fireTimers()
    await flushAll()
    const items = engine.state.get('image-handler/items') as { label: string }[]
    expect(items.map((item) => item.label)).toEqual(['shot one.ppm'])
  })

  it('does not treat typed keys as pastes', async () => {
    const { engine, fire } = setup()
    await fire('prompt.edit', { inputText: '/Users/me/typed.png', key: 'g' })
    engine.setDraft('[Image #1]')
    engine.fireTimers()
    await flushAll()
    const items = engine.state.get('image-handler/items') as { label: string }[]
    expect(items.map((item) => item.label)).toEqual(['Image #1'])
  })

  it('marks the draft dirty so the next tick syncs', async () => {
    const { engine, fire } = setup({ draft: '/p/a.ppm', files: { '/p/a.ppm': makePpm(1, 1, [0, 0, 0]) } })
    await fire('prompt.change', {})
    engine.fireTimers()
    await flushAll()
    expect((engine.state.get('image-handler/items') as unknown[]).length).toBe(1)
  })
})

describe('AbovePrompt render', () => {
  it('passes the event on for the desktop surface', async () => {
    const { engine, fire, next } = setup()
    engine.state.set('image-handler/items', [
      { id: 'tag:1', kind: 'tag', label: 'Image #1', status: 'failed', width: 0, height: 0 },
    ])
    const event = renderEvent({ surface: 'desktop' })
    expect(await fire('ui.render:AbovePrompt', event)).toBe('below-content')
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(event)
    expect(engine.$.ui.resolve).not.toHaveBeenCalled()
  })

  it('passes the event on while a survey is shown', async () => {
    const { engine, fire } = setup()
    engine.state.set('image-handler/items', [
      { id: 'tag:1', kind: 'tag', label: 'Image #1', status: 'failed', width: 0, height: 0 },
    ])
    const event = renderEvent({ props: { hasSurvey: true, isWorking: false, maxRows: 20, bodyColumns: 80 } })
    expect(await fire('ui.render:AbovePrompt', event)).toBe('below-content')
    expect(engine.$.ui.resolve).not.toHaveBeenCalled()
  })

  it('passes the event on when there are no items', async () => {
    const { engine, fire, next } = setup()
    expect(await fire('ui.render:AbovePrompt', renderEvent())).toBe('below-content')
    expect(next).toHaveBeenCalledTimes(1)
    expect(engine.$.ui.resolve).not.toHaveBeenCalled()
  })

  it('puts the tiles above whatever the next handler draws', async () => {
    const { engine, fire, next } = setup()
    engine.state.set('image-handler/items', [
      { id: 'tag:1', kind: 'tag', label: 'Image #1', status: 'failed', width: 0, height: 0 },
    ])
    const result = (await fire('ui.render:AbovePrompt', renderEvent())) as Node
    expect(next).toHaveBeenCalledTimes(1)
    expect(result.type).toBe('Box')
    expect(result.props.flexDirection).toBe('column')
    expect(result.children).toHaveLength(2)
    expect(result.children[1]).toBe('below-content')
    const band = result.children[0] as Node
    expect(all(band, 'Text').map((text) => text.children.join(''))).toEqual(['Image #1', HINT])
  })

  it('draws one tile with an open and a remove button per stored item', async () => {
    const { engine, fire } = setup()
    engine.state.set(
      'image-handler/items',
      Array.from({ length: 25 }, (_unused, index) => ({
        id: `tag:${index + 1}`,
        kind: 'tag',
        label: `Image #${index + 1}`,
        status: 'loading',
        width: 0,
        height: 0,
      })),
    )
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    const keys = all(result, 'Button').map((button) => button.props.key)
    expect(keys).toHaveLength(50)
    expect(new Set(keys).size).toBe(50)
  })

  it('spaces the tiles by the body columns', async () => {
    const { engine, fire } = setup()
    const items = [1, 2, 3, 4].map((n) => ({ id: `tag:${n}`, kind: 'tag', label: `Image #${n}`, status: 'failed', width: 0, height: 0 }))
    engine.state.set('image-handler/items', items)
    const narrow = await fire('ui.render:AbovePrompt', renderEvent({ props: { hasSurvey: false, bodyColumns: 30 } }))
    expect(all(narrow, 'Box').filter((box) => String(box.props.key).startsWith('row:'))).toHaveLength(4)
  })

  it('shows only the file name on a plain terminal for a loaded image', async () => {
    const { fire } = await withReadyImage()
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    expect(all(result, 'Image')).toEqual([])
    expect(all(result, 'Raster')).toEqual([])
    const tile = all(result, 'Box').find((box) => box.props.key === 'tile:path:/p/cat.ppm')
    expect(tile?.children.map((child: Node) => child.type)).toEqual(['Box', 'Text'])
    expect(all(tile, 'Text').map((text) => text.children.join(''))).toEqual(['cat.ppm'])
  })

  it('draws a real picture when the terminal supports them', async () => {
    const { fire } = await withReadyImage({ env: { KITTY_WINDOW_ID: '1' } })
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    const image = all(result, 'Image')[0]
    expect(image?.props.key).toBe('picture:path:/p/cat.ppm')
    expect(image?.props.alt).toBe('Preview of cat.ppm')
    expect(image?.props.source).toMatchObject({ width: 2, height: 2 })
  })

  it('draws pictures in iTerm2 only when the layout is fullscreen', async () => {
    const { fire } = await withReadyImage({ env: { TERM_PROGRAM: 'iTerm.app' } })
    expect(all(await fire('ui.render:AbovePrompt', renderEvent({ viewport: { isFullscreen: true } })), 'Image')).toHaveLength(1)
    expect(all(await fire('ui.render:AbovePrompt', renderEvent({ viewport: { isFullscreen: false } })), 'Image')).toHaveLength(0)
    expect(all(await fire('ui.render:AbovePrompt', renderEvent({ viewport: undefined })), 'Image')).toHaveLength(0)
  })

  it('blits the spinner to the request id of the last render', async () => {
    const { engine, fire } = setup({ draft: '/p/a.ppm', files: { '/p/a.ppm': makePpm(1, 1, [0, 0, 0]) } })
    let release: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      release = resolve
    })
    engine.handlers.run = async (argv) => {
      if (argv[0] === 'uname') return { stdout: 'Linux' }
      await closed
      return { exitCode: 1 }
    }
    await fire('session.start', {})
    engine.fireTimers()
    await flushAll()
    await fire('ui.render:AbovePrompt', renderEvent({ requestId: 'req-77' }))
    engine.fireTimers()
    await flushAll()
    expect(engine.$.ui.blit.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: 'req-77', key: 'spinner:path:/p/a.ppm' })
    release()
    await flushAll()
  })
})

describe('keyboard and mouse removal through the button', () => {
  it('removes the image reference from the draft and the tile when the button is pressed', async () => {
    const { engine, fire } = await withReadyImage()
    engine.setDraft('hello /p/cat.ppm there')
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    const button = all(result, 'Button').find((candidate) => candidate.props.label === 'Remove cat.ppm')
    expect(button?.props.label).toBe('Remove cat.ppm')
    button?.props.onPress()
    await flushAll()
    expect(engine.prompt.text).toBe('hello there')
    engine.fireTimers()
    await flushAll()
    expect(engine.state.get('image-handler/items')).toEqual([])
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })

  it('shows a toast and keeps the tile when the prompt cannot be changed', async () => {
    const { engine, fire } = await withReadyImage()
    engine.prompt.accepts = false
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    all(result, 'Button').find((candidate) => candidate.props.label === 'Remove cat.ppm')?.props.onPress()
    await flushAll()
    expect(engine.$.ui.toast).toHaveBeenCalledWith('Could not remove the image from the prompt')
    expect(engine.prompt.text).toBe('/p/cat.ppm')
  })
})

describe('paste command', () => {
  it('registers the paste command on session.start', async () => {
    const { engine, fire } = setup()
    await fire('session.start', {})
    expect(engine.$.command.register).toHaveBeenCalledWith(PASTE_SPEC)
  })

  it('still starts the timer and passes the event on when registration fails', async () => {
    const { engine, fire, next } = setup()
    engine.$.command.register.mockRejectedValueOnce(new Error('no commands'))
    const event = { id: 'e1' }
    expect(await fire('session.start', event)).toBe('below-content')
    expect(next).toHaveBeenCalledWith(event)
    expect(engine.activeTimers()).toHaveLength(1)
  })

  it('answers /paste auto off with the reply text', async () => {
    const { handlers, engine } = setup()
    const reply = await (handlers.get('command.run:paste') as Handler)(engine.$, { args: ' AUTO off ' })
    expect(reply).toEqual({ text: 'Clipboard watching is off.' })
  })

  it('stops polling the clipboard when the clipboard_watch option is false', async () => {
    const { engine, fire } = setup({}, { clipboard_watch: false })
    await fire('session.start', {})
    engine.fireTimers()
    await flushAll()
    expect(engine.calls.filter((call) => call.argv[0] === 'xclip')).toEqual([])
  })

  it('polls the clipboard on the timer by default', async () => {
    const { engine, fire } = setup()
    await fire('session.start', {})
    engine.fireTimers()
    await flushAll()
    expect(engine.calls.filter((call) => call.argv[0] === 'xclip').length).toBeGreaterThan(0)
  })
})

describe('clipboard tile', () => {
  it('draws a tile with Add and dismiss buttons for a stored offer without items', async () => {
    const { engine, fire } = setup()
    engine.state.set('image-handler/clipboard', { status: 'ready', width: 0, height: 0 })
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    expect(all(result, 'Button').map((button) => button.props.key)).toEqual(['add:clipboard', 'dismiss:clipboard'])
  })

  it('offers a copied picture and adds its path to the prompt on Add', async () => {
    const { engine, fire } = await withClipboardOffer()
    const offer = engine.state.get('image-handler/clipboard')
    expect(offer).toEqual({ status: 'ready', width: 2, height: 2 })
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    all(result, 'Button').find((button) => button.props.key === 'add:clipboard')?.props.onPress()
    await flushAll()
    expect(engine.prompt.text).toMatch(/^\/t\/claude-image-handler\/clipboard-[0-9a-f-]{36}\.png $/)
    engine.fireTimers()
    await flushAll()
    expect(engine.state.get('image-handler/clipboard')).toBeNull()
  })

  it('deletes the picture file when the tile is dismissed', async () => {
    const { engine, fire } = await withClipboardOffer()
    const before = [...engine.files.keys()].filter((path) => path.startsWith('/t/claude-image-handler/'))
    expect(before).toHaveLength(1)
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    all(result, 'Button').find((button) => button.props.key === 'dismiss:clipboard')?.props.onPress()
    await flushAll()
    expect([...engine.files.keys()].filter((path) => path.startsWith('/t/claude-image-handler/'))).toEqual([])
    engine.fireTimers()
    await flushAll()
    expect(engine.state.get('image-handler/clipboard')).toBeNull()
  })

  it('removes the offered picture file on session.end', async () => {
    const { engine, fire } = await withClipboardOffer()
    await fire('session.end', {})
    expect([...engine.files.keys()].filter((path) => path.startsWith('/t/claude-image-handler/'))).toEqual([])
  })
})

describe('open button', () => {
  it('opens the source file in the viewer when the open button is pressed', async () => {
    const { engine, fire } = await withReadyImage()
    engine.handlers.run = () => ({})
    engine.calls.length = 0
    const result = await fire('ui.render:AbovePrompt', renderEvent())
    all(result, 'Button').find((button) => button.props.label === 'Open cat.ppm')?.props.onPress()
    await flushAll()
    expect(engine.calls.map((call) => call.argv)).toEqual([['xdg-open', '/p/cat.ppm']])
    expect(engine.$.ui.toast).not.toHaveBeenCalled()
  })
})
