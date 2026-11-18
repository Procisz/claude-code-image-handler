import { describe, expect, it } from 'vitest'
import { openInViewer } from '../src/viewer'
import { createEngine } from './helpers/engine'
import type { EngineOptions } from './helpers/engine'

function setup(files: Record<string, string>, options: EngineOptions = {}) {
  return createEngine({ files, ...options })
}

describe('openInViewer', () => {
  it('runs open with the path as one argument on mac', async () => {
    const engine = setup({ '/tmp/my pic.png': 'x' })
    expect(await openInViewer(engine.$ as never, 'mac', '/tmp/my pic.png')).toBe(true)
    expect(engine.calls).toEqual([{ argv: ['open', '/tmp/my pic.png'], options: { env: undefined, timeoutMs: 10_000 } }])
  })

  it('runs xdg-open on linux', async () => {
    const engine = setup({ '/tmp/a.png': 'x' })
    expect(await openInViewer(engine.$ as never, 'linux', '/tmp/a.png')).toBe(true)
    expect(engine.calls).toEqual([{ argv: ['xdg-open', '/tmp/a.png'], options: { env: undefined, timeoutMs: 10_000 } }])
  })

  it('runs Start-Process through powershell with the path in the environment on windows', async () => {
    const path = 'C:\\Users\\me\\a b.png'
    const engine = setup({ [path]: 'x' })
    expect(await openInViewer(engine.$ as never, 'windows', path)).toBe(true)
    expect(engine.calls).toEqual([
      {
        argv: [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'Start-Process -FilePath $env:CLAUDE_IMAGE_HANDLER_OPEN',
        ],
        options: { env: { CLAUDE_IMAGE_HANDLER_OPEN: path }, timeoutMs: 10_000 },
      },
    ])
  })

  it.for(['https://example.com/a.png', 'file:///tmp/a.png', 'HTTP://x/a.png'])('refuses the URL %s without running anything', async (url) => {
    const engine = setup({ [url]: 'x' })
    expect(await openInViewer(engine.$ as never, 'mac', url)).toBe(false)
    expect(engine.calls).toEqual([])
  })

  it('refuses a UNC path', async () => {
    const path = '\\\\server\\share\\a.png'
    const engine = setup({ [path]: 'x' })
    expect(await openInViewer(engine.$ as never, 'windows', path)).toBe(false)
    expect(engine.calls).toEqual([])
  })

  it('refuses a folder', async () => {
    const engine = setup({}, { dirs: ['/tmp/folder'] })
    expect(await openInViewer(engine.$ as never, 'mac', '/tmp/folder')).toBe(false)
    expect(engine.calls).toEqual([])
  })

  it('refuses a path that cannot be inspected', async () => {
    const engine = setup({})
    expect(await openInViewer(engine.$ as never, 'linux', '/tmp/missing.png')).toBe(false)
    expect(engine.calls).toEqual([])
  })

  it('prefixes a leading dash with ./ on mac and linux', async () => {
    const engine = setup({ '-a.png': 'x' })
    expect(await openInViewer(engine.$ as never, 'linux', '-a.png')).toBe(true)
    expect(await openInViewer(engine.$ as never, 'mac', '-a.png')).toBe(true)
    expect(engine.calls.map((call) => call.argv)).toEqual([
      ['xdg-open', './-a.png'],
      ['open', './-a.png'],
    ])
  })

  it('prefixes a leading dash with ./ in the windows environment variable', async () => {
    const engine = setup({ '-a.png': 'x' })
    expect(await openInViewer(engine.$ as never, 'windows', '-a.png')).toBe(true)
    expect(engine.calls[0].options?.env).toEqual({ CLAUDE_IMAGE_HANDLER_OPEN: './-a.png' })
  })

  it('returns false when the viewer exits non-zero', async () => {
    const engine = setup({ '/tmp/a.png': 'x' }, { run: () => ({ exitCode: 3 }) })
    expect(await openInViewer(engine.$ as never, 'mac', '/tmp/a.png')).toBe(false)
  })

  it('returns false when the viewer cannot be started', async () => {
    const engine = setup(
      { '/tmp/a.png': 'x' },
      {
        run: () => {
          throw new Error('ENOENT')
        },
      },
    )
    expect(await openInViewer(engine.$ as never, 'linux', '/tmp/a.png')).toBe(false)
  })
})
