import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { convertToPng, resetMissingTools } from '../src/convert'
import { createEngine } from './helpers/engine'

const UUID = '11111111-2222-3333-4444-555555555555'
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3)
const PNG_BASE64 = Buffer.from(PNG).toString('base64')
const OUT = `/tmp/claude-image-handler-${UUID}.png`
const WIN_OUT = `C:\\Temp\\claude-image-handler-${UUID}.png`

function outOf(argv: string[]): string {
  return argv.at(-1)?.replace(/^PNG32:/, '') ?? ''
}

beforeEach(() => {
  resetMissingTools()
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(UUID as `${string}-${string}-${string}-${string}-${string}`)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('convertToPng on mac', () => {
  it('runs sips first with the exact arguments and returns the png bytes', async () => {
    const engine = createEngine({
      env: { TMPDIR: '/tmp/' },
      run: (argv) => {
        if (argv[0] === 'sips') engine.setFile(OUT, PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    expect(engine.calls[0]?.argv).toEqual(['sips', '-s', 'format', 'png', '-Z', '320', '/pics/a.heic', '--out', OUT])
    expect(engine.calls[0]?.options).toEqual({ env: undefined, timeoutMs: 20000 })
  })

  it('deletes the temporary png after reading it', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'sips') engine.setFile(OUT, PNG)
        return {}
      },
    })
    await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(engine.calls.at(-1)).toEqual({ argv: ['rm', '-f', OUT], options: { env: undefined, timeoutMs: 20000 } })
  })

  it('falls back to ImageMagick when sips exits non-zero, and still deletes the sips output', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'sips') return { exitCode: 13 }
        if (argv[0] === 'magick') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'mac', '/pics/a.svg')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    expect(engine.calls.map((call) => call.argv[0])).toEqual(['sips', 'rm', 'magick', 'rm'])
    expect(engine.calls[2]?.argv).toEqual([
      'magick',
      '/pics/a.svg[0]',
      '-auto-orient',
      '-thumbnail',
      '320x320>',
      '-strip',
      `PNG32:${OUT}`,
    ])
  })

  it('falls back to ImageMagick when sips exits zero but writes no file', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'magick') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
  })

  it('treats an empty output file as a failure', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'sips') engine.setFile(OUT, new Uint8Array(0))
        if (argv[0] === 'magick') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    expect(engine.calls.some((call) => call.argv[0] === 'magick')).toBe(true)
  })

  it('tries the chain sips, magick, convert in order and returns null when all fail', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    expect(await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')).toBeNull()
    expect(engine.calls.map((call) => call.argv[0]).filter((name) => name !== 'rm')).toEqual(['sips', 'magick', 'convert'])
  })

  it('skips a tool that could not start for the rest of the session', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'sips') throw new Error('spawn sips ENOENT')
        if (argv[0] === 'magick') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    engine.calls.length = 0
    await convertToPng(engine.$ as never, 'mac', '/pics/b.heic')
    expect(engine.calls.map((call) => call.argv[0])).toEqual(['magick', 'rm'])
  })

  it('does not run rm for a tool that could not start', async () => {
    const engine = createEngine({
      run: () => {
        throw new Error('spawn ENOENT')
      },
    })
    expect(await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')).toBeNull()
    expect(engine.calls.map((call) => call.argv[0])).toEqual(['sips', 'magick', 'convert'])
  })

  it('keeps a skipped tool skipped until the missing list is reset', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'sips') throw new Error('spawn sips ENOENT')
        return {}
      },
    })
    await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    resetMissingTools()
    engine.calls.length = 0
    await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(engine.calls[0]?.argv[0]).toBe('sips')
  })

  it('keeps a source starting with a dash from being read as an option', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    await convertToPng(engine.$ as never, 'mac', '-evil.png')
    expect(engine.calls[0]?.argv[6]).toBe('./-evil.png')
    expect(engine.calls[2]?.argv[1]).toBe('./-evil.png[0]')
  })

  it('ignores a failing cleanup', async () => {
    const engine = createEngine({
      run: (argv) => {
        if (argv[0] === 'rm') throw new Error('spawn rm ENOENT')
        engine.setFile(OUT, PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'mac', '/pics/a.heic')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
  })
})

describe('convertToPng on linux', () => {
  it('tries magick then convert with the same arguments', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    expect(await convertToPng(engine.$ as never, 'linux', '/pics/a.tiff')).toBeNull()
    const tools = engine.calls.filter((call) => call.argv[0] !== 'rm').map((call) => call.argv)
    expect(tools).toEqual([
      ['magick', '/pics/a.tiff[0]', '-auto-orient', '-thumbnail', '320x320>', '-strip', `PNG32:${OUT}`],
      ['convert', '/pics/a.tiff[0]', '-auto-orient', '-thumbnail', '320x320>', '-strip', `PNG32:${OUT}`],
    ])
  })

  it('uses convert when magick is not installed', async () => {
    const engine = createEngine({
      env: { TMPDIR: '/var/tmp' },
      run: (argv) => {
        if (argv[0] === 'magick') throw new Error('spawn magick ENOENT')
        if (argv[0] === 'convert') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'linux', '/pics/a.tiff')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    expect(engine.calls[1]?.argv.at(-1)).toBe(`PNG32:/var/tmp/claude-image-handler-${UUID}.png`)
  })

  it('never runs sips', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    await convertToPng(engine.$ as never, 'linux', '/pics/a.tiff')
    expect(engine.calls.some((call) => call.argv[0] === 'sips')).toBe(false)
  })
})

describe('convertToPng on windows', () => {
  const windowsEnv = { TEMP: 'C:\\Temp\\' }

  it('runs powershell with the source only in the environment and reads base64 stdout', async () => {
    const source = 'C:\\Pictures\\my "odd" $name.heic'
    const engine = createEngine({ env: windowsEnv, run: () => ({ stdout: `${PNG_BASE64}\n` }) })
    const bytes = await convertToPng(engine.$ as never, 'windows', source)
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    const call = engine.calls[0]
    expect(call?.argv.slice(0, 6)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ])
    expect(call?.argv).toHaveLength(7)
    expect(call?.argv.some((part) => part.includes(source))).toBe(false)
    expect(call?.argv[6]).toContain('$env:CLAUDE_IMAGE_HANDLER_SOURCE')
    expect(call?.options).toEqual({ env: { CLAUDE_IMAGE_HANDLER_SOURCE: source }, timeoutMs: 20000 })
  })

  it('does not run a cleanup after a powershell success', async () => {
    const engine = createEngine({ env: windowsEnv, run: () => ({ stdout: PNG_BASE64 }) })
    await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')
    expect(engine.calls).toHaveLength(1)
  })

  it('falls back to magick.exe when powershell exits with 1', async () => {
    const engine = createEngine({
      env: windowsEnv,
      run: (argv) => {
        if (argv[0] === 'powershell.exe' && argv.length === 7 && argv[6]?.includes('SOURCE')) return { exitCode: 1 }
        if (argv[0] === 'magick.exe') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    const bytes = await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')
    expect(Array.from(bytes ?? [])).toEqual(Array.from(PNG))
    expect(engine.calls[1]?.argv).toEqual([
      'magick.exe',
      'C:\\a.heic[0]',
      '-auto-orient',
      '-thumbnail',
      '320x320>',
      '-strip',
      `PNG32:${WIN_OUT}`,
    ])
  })

  it('removes the magick output through powershell with the target only in the environment', async () => {
    const engine = createEngine({
      env: windowsEnv,
      run: (argv) => {
        if (argv[0] === 'powershell.exe' && argv[6]?.includes('SOURCE')) return { exitCode: 1 }
        if (argv[0] === 'magick.exe') engine.setFile(outOf(argv), PNG)
        return {}
      },
    })
    await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')
    const cleanup = engine.calls.at(-1)
    expect(cleanup?.argv.slice(0, 6)).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ])
    expect(cleanup?.argv[6]).toBe('Remove-Item -LiteralPath $env:CLAUDE_IMAGE_HANDLER_TARGET -Force')
    expect(cleanup?.argv.some((part) => part.includes(WIN_OUT))).toBe(false)
    expect(cleanup?.options).toEqual({ env: { CLAUDE_IMAGE_HANDLER_TARGET: WIN_OUT }, timeoutMs: 20000 })
  })

  it('treats empty powershell output as a failure', async () => {
    const engine = createEngine({ env: windowsEnv, run: () => ({ stdout: '  \n' }) })
    expect(await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')).toBeNull()
    expect(engine.calls.some((call) => call.argv[0] === 'magick.exe')).toBe(true)
  })

  it('treats malformed powershell output as a failure', async () => {
    const engine = createEngine({
      env: windowsEnv,
      run: (argv) => (argv[0] === 'powershell.exe' && argv[6]?.includes('SOURCE') ? { stdout: '***' } : { exitCode: 1 }),
    })
    expect(await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')).toBeNull()
  })

  it('skips powershell for the rest of the session once it could not start', async () => {
    const engine = createEngine({
      env: windowsEnv,
      run: (argv) => {
        if (argv[0] === 'powershell.exe') throw new Error('spawn powershell.exe ENOENT')
        return { exitCode: 1 }
      },
    })
    await convertToPng(engine.$ as never, 'windows', 'C:\\a.heic')
    engine.calls.length = 0
    await convertToPng(engine.$ as never, 'windows', 'C:\\b.heic')
    expect(engine.calls.map((call) => call.argv[0])).toEqual(['magick.exe', 'powershell.exe'])
  })
})
