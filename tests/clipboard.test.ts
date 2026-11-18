import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClipboard, resetMissingClipboardTools } from '../src/clipboard'
import type { ClipboardRequest } from '../src/clipboard'
import { createEngine } from './helpers/engine'
import type { RunHandler } from './helpers/engine'

const MAC_TARGET = '/tmp/claude-image-handler/clip-1.png'
const WIN_TARGET = 'C:\\Temp\\claude-image-handler\\clip-1.png'

function request(overrides: Partial<ClipboardRequest> = {}): ClipboardRequest {
  return { mode: 'always', seen: undefined, directory: '/tmp/claude-image-handler', stem: 'clip-1', ...overrides }
}

function json(token: string, path: string): string {
  return JSON.stringify({ token, path })
}

beforeEach(() => {
  resetMissingClipboardTools()
})

afterEach(() => {
  resetMissingClipboardTools()
})

describe('readClipboard on mac', () => {
  it('runs osascript with the mode, seen token and target and parses the saved path', async () => {
    const engine = createEngine({ run: () => ({ stdout: json('7', MAC_TARGET) }) })
    const result = await readClipboard(engine.$ as never, 'mac', request({ mode: 'changed', seen: '6' }))
    expect(result).toEqual({ token: '7', path: MAC_TARGET })
    expect(engine.calls).toHaveLength(1)
    const [call] = engine.calls
    expect(call.argv.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
    expect(call.argv[4]).toContain("ObjC.import('AppKit')")
    expect(call.argv[4]).toContain('function run(argv)')
    expect(call.argv.slice(5)).toEqual(['changed', '6', MAC_TARGET])
    expect(call.options).toEqual({ env: undefined, timeoutMs: 20_000 })
  })

  it('passes an empty seen token when none is known and maps an empty path to undefined', async () => {
    const engine = createEngine({ run: () => ({ stdout: json('3', '') }) })
    const result = await readClipboard(engine.$ as never, 'mac', request({ mode: 'baseline' }))
    expect(result).toEqual({ token: '3', path: undefined })
    expect(engine.calls[0].argv.slice(5)).toEqual(['baseline', '', MAC_TARGET])
  })

  it('returns null when osascript exits non-zero', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1, stdout: json('1', '') }) })
    expect(await readClipboard(engine.$ as never, 'mac', request())).toBeNull()
  })

  it('returns null for output that is not JSON', async () => {
    const engine = createEngine({ run: () => ({ stdout: 'not json' }) })
    expect(await readClipboard(engine.$ as never, 'mac', request())).toBeNull()
  })

  it.for([
    { name: 'null', stdout: 'null' },
    { name: 'a number', stdout: '5' },
    { name: 'a missing token', stdout: '{"path":"a"}' },
    { name: 'a numeric token', stdout: '{"token":1,"path":"a"}' },
    { name: 'a missing path', stdout: '{"token":"1"}' },
    { name: 'a numeric path', stdout: '{"token":"1","path":2}' },
  ])('returns null for $name', async ({ stdout }) => {
    const engine = createEngine({ run: () => ({ stdout }) })
    expect(await readClipboard(engine.$ as never, 'mac', request())).toBeNull()
  })

  it('marks osascript missing after a rejected run and does not run it again until reset', async () => {
    const engine = createEngine({
      run: () => {
        throw new Error('spawn osascript ENOENT')
      },
    })
    expect(await readClipboard(engine.$ as never, 'mac', request())).toBeNull()
    expect(await readClipboard(engine.$ as never, 'mac', request())).toBeNull()
    expect(engine.calls).toHaveLength(1)

    resetMissingClipboardTools()
    engine.handlers.run = () => ({ stdout: json('9', '') })
    expect(await readClipboard(engine.$ as never, 'mac', request())).toEqual({ token: '9', path: undefined })
    expect(engine.calls).toHaveLength(2)
  })
})

describe('readClipboard on windows', () => {
  it('runs powershell with the mode, seen and target in the environment', async () => {
    const engine = createEngine({ run: () => ({ stdout: json('42', WIN_TARGET) }) })
    const result = await readClipboard(
      engine.$ as never,
      'windows',
      request({ mode: 'changed', seen: '41', directory: 'C:\\Temp\\claude-image-handler' }),
    )
    expect(result).toEqual({ token: '42', path: WIN_TARGET })
    const [call] = engine.calls
    expect(call.argv.slice(0, 7)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Sta',
      '-Command',
    ])
    expect(call.argv).toHaveLength(8)
    expect(call.argv[7]).toContain('GetClipboardSequenceNumber')
    expect(call.argv[7]).toContain('ConvertTo-Json -Compress')
    expect(call.options).toEqual({
      env: {
        CLAUDE_IMAGE_HANDLER_CLIP_MODE: 'changed',
        CLAUDE_IMAGE_HANDLER_CLIP_SEEN: '41',
        CLAUDE_IMAGE_HANDLER_CLIP_TARGET: WIN_TARGET,
      },
      timeoutMs: 20_000,
    })
  })

  it('sends an empty seen value when none is known', async () => {
    const engine = createEngine({ run: () => ({ stdout: json('1', '') }) })
    const result = await readClipboard(engine.$ as never, 'windows', request({ mode: 'baseline', directory: 'C:\\Temp\\claude-image-handler' }))
    expect(result).toEqual({ token: '1', path: undefined })
    expect(engine.calls[0].options?.env?.CLAUDE_IMAGE_HANDLER_CLIP_SEEN).toBe('')
  })

  it('returns null when powershell is missing and skips it afterwards', async () => {
    const engine = createEngine({
      run: () => {
        throw new Error('ENOENT')
      },
    })
    expect(await readClipboard(engine.$ as never, 'windows', request())).toBeNull()
    expect(await readClipboard(engine.$ as never, 'windows', request())).toBeNull()
    expect(engine.calls).toHaveLength(1)
  })
})

describe('readClipboard on linux', () => {
  const LIST_X11 = ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o']
  const LIST_WAYLAND = ['wl-paste', '--list-types']

  function linuxRun(types: string, extra: RunHandler = () => ({})): RunHandler {
    return (argv, options) => {
      if (argv[0] === 'xclip' || argv[0] === 'wl-paste') return { stdout: types }
      if (argv[0] === 'sh' && argv[2]?.includes('cksum')) return { stdout: '123 45\n' }
      return extra(argv, options)
    }
  }

  it('uses xclip first when WAYLAND_DISPLAY is unset and saves the png with a positional-argument shell', async () => {
    const engine = createEngine({ run: linuxRun('TARGETS\nimage/png\ntext/plain\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result).toEqual({ token: 'image/png 123 45', path: '/tmp/claude-image-handler/clip-1.png' })
    expect(engine.calls.map((call) => call.argv)).toEqual([
      LIST_X11,
      ['sh', '-c', 'xclip -selection clipboard -t "$1" -o | cksum', 'image-handler', 'image/png'],
      [
        'sh',
        '-c',
        'mkdir -p "$(dirname "$2")" && xclip -selection clipboard -t "$1" -o > "$2"',
        'image-handler',
        'image/png',
        '/tmp/claude-image-handler/clip-1.png',
      ],
    ])
    expect(engine.calls.every((call) => call.options?.timeoutMs === 20_000)).toBe(true)
  })

  it('uses wl-paste first when WAYLAND_DISPLAY is set', async () => {
    const engine = createEngine({ env: { WAYLAND_DISPLAY: 'wayland-0' }, run: linuxRun('image/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result?.token).toBe('image/png 123 45')
    expect(engine.calls[0].argv).toEqual(LIST_WAYLAND)
    expect(engine.calls[1].argv[2]).toBe('wl-paste --no-newline --type "$1" | cksum')
    expect(engine.calls[2].argv[2]).toBe('mkdir -p "$(dirname "$2")" && wl-paste --no-newline --type "$1" > "$2"')
  })

  it('falls back to wl-paste when xclip is missing', async () => {
    const engine = createEngine({
      run: (argv, options) => {
        if (argv[0] === 'xclip') throw new Error('ENOENT')
        return linuxRun('image/png\n')(argv, options)
      },
    })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result?.path).toBe('/tmp/claude-image-handler/clip-1.png')
    expect(engine.calls[0].argv).toEqual(LIST_X11)
    expect(engine.calls[1].argv).toEqual(LIST_WAYLAND)
  })

  it('falls back to xclip when wl-paste is missing under Wayland', async () => {
    const engine = createEngine({
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run: (argv, options) => {
        if (argv[0] === 'wl-paste' && argv[1] === '--list-types') throw new Error('ENOENT')
        return linuxRun('image/png\n')(argv, options)
      },
    })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result?.path).toBe('/tmp/claude-image-handler/clip-1.png')
    expect(engine.calls[1].argv).toEqual(LIST_X11)
  })

  it('skips tools already known missing and returns null when none is left', async () => {
    const engine = createEngine({
      run: () => {
        throw new Error('ENOENT')
      },
    })
    expect(await readClipboard(engine.$ as never, 'linux', request())).toBeNull()
    expect(engine.calls).toHaveLength(2)
    expect(await readClipboard(engine.$ as never, 'linux', request())).toBeNull()
    expect(engine.calls).toHaveLength(2)

    resetMissingClipboardTools()
    expect(await readClipboard(engine.$ as never, 'linux', request())).toBeNull()
    expect(engine.calls).toHaveLength(4)
  })

  it('returns null when a later process run rejects', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'xclip') return { stdout: 'image/png\n' }
        throw new Error('sh failed')
      },
    })
    expect(await readClipboard(engine.$ as never, 'linux', request())).toBeNull()
    expect(engine.calls).toHaveLength(2)
  })

  it('treats a non-zero list exit as an empty clipboard', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1, stdout: 'image/png\n' }) })
    expect(await readClipboard(engine.$ as never, 'linux', request())).toEqual({ token: 'none', path: undefined })
    expect(engine.calls).toHaveLength(1)
  })

  it('treats a clipboard without image types as empty', async () => {
    const engine = createEngine({ run: linuxRun('text/plain\r\nUTF8_STRING\r\n') })
    expect(await readClipboard(engine.$ as never, 'linux', request())).toEqual({ token: 'none', path: undefined })
  })

  it.for([
    { type: 'image/png', ext: 'png' },
    { type: 'image/jpeg', ext: 'jpg' },
    { type: 'image/gif', ext: 'gif' },
    { type: 'image/bmp', ext: 'bmp' },
    { type: 'image/tiff', ext: 'tiff' },
    { type: 'image/webp', ext: 'webp' },
  ])('saves $type with the extension $ext', async ({ type, ext }) => {
    const engine = createEngine({ run: linuxRun(`${type}\n`) })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result).toEqual({ token: `${type} 123 45`, path: `/tmp/claude-image-handler/clip-1.${ext}` })
    expect(engine.calls[1].argv.at(-1)).toBe(type)
  })

  it('prefers png over jpeg when both are listed', async () => {
    const engine = createEngine({ run: linuxRun('image/webp\nimage/jpeg\nimage/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result?.token).toBe('image/png 123 45')
  })

  it('never saves in baseline mode', async () => {
    const engine = createEngine({ run: linuxRun('image/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request({ mode: 'baseline' }))
    expect(result).toEqual({ token: 'image/png 123 45', path: undefined })
    expect(engine.calls).toHaveLength(2)
  })

  it('does not save in changed mode when the token equals the seen one', async () => {
    const engine = createEngine({ run: linuxRun('image/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request({ mode: 'changed', seen: 'image/png 123 45' }))
    expect(result).toEqual({ token: 'image/png 123 45', path: undefined })
    expect(engine.calls).toHaveLength(2)
  })

  it('saves in changed mode when the token differs from the seen one', async () => {
    const engine = createEngine({ run: linuxRun('image/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request({ mode: 'changed', seen: 'image/png 1 1' }))
    expect(result?.path).toBe('/tmp/claude-image-handler/clip-1.png')
    expect(engine.calls).toHaveLength(3)
  })

  it('saves in always mode even when the token equals the seen one', async () => {
    const engine = createEngine({ run: linuxRun('image/png\n') })
    const result = await readClipboard(engine.$ as never, 'linux', request({ mode: 'always', seen: 'image/png 123 45' }))
    expect(result?.path).toBe('/tmp/claude-image-handler/clip-1.png')
  })

  it('returns the token without a path when the save command fails', async () => {
    const engine = createEngine({
      run: linuxRun('image/png\n', (argv) => (argv[2]?.includes('mkdir') ? { exitCode: 1 } : {})),
    })
    const result = await readClipboard(engine.$ as never, 'linux', request())
    expect(result).toEqual({ token: 'image/png 123 45', path: undefined })
  })
})
