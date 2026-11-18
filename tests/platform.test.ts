import { describe, expect, it } from 'vitest'
import { claudeImagesDir, detectPlatform, homeDir, joinPath, tempDir } from '../src/platform'
import { createEngine } from './helpers/engine'

describe('joinPath', () => {
  it('joins with a slash on posix platforms', () => {
    expect(joinPath('mac', 'a', 'b')).toBe('a/b')
    expect(joinPath('linux', 'a', 'b', 'c')).toBe('a/b/c')
  })

  it('joins with a backslash on windows', () => {
    expect(joinPath('windows', 'C:\\a', 'b')).toBe('C:\\a\\b')
  })
})

describe('detectPlatform', () => {
  it('reports windows when OS is Windows_NT without running anything', async () => {
    const engine = createEngine({ env: { OS: 'Windows_NT' } })
    expect(await detectPlatform(engine.$ as never)).toBe('windows')
    expect(engine.calls).toEqual([])
  })

  it('reports mac when uname says Darwin', async () => {
    const engine = createEngine({ run: () => ({ stdout: 'Darwin\n' }) })
    expect(await detectPlatform(engine.$ as never)).toBe('mac')
    expect(engine.calls[0]?.argv).toEqual(['uname', '-s'])
  })

  it('reports linux when uname says Linux', async () => {
    const engine = createEngine({ run: () => ({ stdout: 'Linux\n' }) })
    expect(await detectPlatform(engine.$ as never)).toBe('linux')
  })

  it('reports linux when uname cannot start', async () => {
    const engine = createEngine({
      run: () => {
        throw new Error('spawn uname ENOENT')
      },
    })
    expect(await detectPlatform(engine.$ as never)).toBe('linux')
  })

  it('does not take another OS value for windows', async () => {
    const engine = createEngine({ env: { OS: 'Linux' }, run: () => ({ stdout: 'Darwin' }) })
    expect(await detectPlatform(engine.$ as never)).toBe('mac')
  })
})

describe('tempDir', () => {
  it('uses TMPDIR on mac and trims trailing separators', async () => {
    const engine = createEngine({ env: { TMPDIR: '/var/folders/x/T//' } })
    expect(await tempDir(engine.$ as never, 'mac')).toBe('/var/folders/x/T')
  })

  it('falls back to /tmp on linux when TMPDIR is empty', async () => {
    const engine = createEngine({ env: { TMPDIR: '' } })
    expect(await tempDir(engine.$ as never, 'linux')).toBe('/tmp')
  })

  it('uses TEMP on windows and trims trailing separators', async () => {
    const engine = createEngine({ env: { TEMP: 'C:\\Users\\me\\Temp\\' } })
    expect(await tempDir(engine.$ as never, 'windows')).toBe('C:\\Users\\me\\Temp')
  })

  it('falls back to the windows temp folder when TEMP is missing', async () => {
    const engine = createEngine()
    expect(await tempDir(engine.$ as never, 'windows')).toBe('C:\\Windows\\Temp')
  })

  it('ignores TEMP on posix platforms', async () => {
    const engine = createEngine({ env: { TEMP: 'C:\\Temp' } })
    expect(await tempDir(engine.$ as never, 'linux')).toBe('/tmp')
  })
})

describe('homeDir', () => {
  it('reads HOME on mac and linux', async () => {
    const engine = createEngine({ env: { HOME: '/Users/me', USERPROFILE: 'C:\\Users\\me' } })
    expect(await homeDir(engine.$ as never, 'mac')).toBe('/Users/me')
    expect(await homeDir(engine.$ as never, 'linux')).toBe('/Users/me')
  })

  it('reads USERPROFILE on windows', async () => {
    const engine = createEngine({ env: { HOME: '/Users/me', USERPROFILE: 'C:\\Users\\me' } })
    expect(await homeDir(engine.$ as never, 'windows')).toBe('C:\\Users\\me')
  })

  it('returns undefined when the variable is missing', async () => {
    expect(await homeDir(createEngine().$ as never, 'mac')).toBeUndefined()
  })
})

describe('claudeImagesDir', () => {
  const uidRun = (argv: string[]) => (argv[0] === 'id' ? { stdout: '501\n' } : {})

  it('finds the images folder under the uid root by testing each project folder', async () => {
    const engine = createEngine({
      sessionId: 'sess-find',
      dirs: ['/tmp/claude-501/other/sess-zzz/images', '/tmp/claude-501/proj/sess-find/images'],
      run: uidRun,
    })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBe('/tmp/claude-501/proj/sess-find/images')
    expect(engine.calls[0]?.argv).toEqual(['id', '-u'])
  })

  it('skips plain files in the root', async () => {
    const engine = createEngine({
      sessionId: 'sess-files',
      files: { '/tmp/claude-501/stray.txt': 'x' },
      dirs: ['/tmp/claude-501/proj/sess-files/images'],
      run: uidRun,
    })
    expect(await claudeImagesDir(engine.$ as never, 'linux')).toBe('/tmp/claude-501/proj/sess-files/images')
  })

  it('honors CLAUDE_CODE_TMPDIR on posix', async () => {
    const engine = createEngine({
      sessionId: 'sess-override',
      env: { CLAUDE_CODE_TMPDIR: '/custom/' },
      dirs: ['/custom/claude-501/proj/sess-override/images'],
      run: uidRun,
    })
    expect(await claudeImagesDir(engine.$ as never, 'linux')).toBe('/custom/claude-501/proj/sess-override/images')
  })

  it('uses TEMP\\claude on windows without running a process', async () => {
    const engine = createEngine({
      sessionId: 'sess-win',
      env: { TEMP: 'C:\\Temp\\' },
      dirs: ['C:\\Temp\\claude\\proj\\sess-win\\images'],
    })
    expect(await claudeImagesDir(engine.$ as never, 'windows')).toBe('C:\\Temp\\claude\\proj\\sess-win\\images')
    expect(engine.calls).toEqual([])
  })

  it('prefers CLAUDE_CODE_TMPDIR over TEMP on windows', async () => {
    const engine = createEngine({
      sessionId: 'sess-win-override',
      env: { CLAUDE_CODE_TMPDIR: 'D:\\cache', TEMP: 'C:\\Temp' },
      dirs: ['D:\\cache\\claude\\proj\\sess-win-override\\images'],
    })
    expect(await claudeImagesDir(engine.$ as never, 'windows')).toBe('D:\\cache\\claude\\proj\\sess-win-override\\images')
  })

  it('falls back to the windows temp folder when TEMP is missing', async () => {
    const engine = createEngine({
      sessionId: 'sess-win-fallback',
      dirs: ['C:\\Windows\\Temp\\claude\\proj\\sess-win-fallback\\images'],
    })
    expect(await claudeImagesDir(engine.$ as never, 'windows')).toBe(
      'C:\\Windows\\Temp\\claude\\proj\\sess-win-fallback\\images',
    )
  })

  it('returns undefined when id -u fails', async () => {
    const engine = createEngine({ sessionId: 'sess-uid-fail', run: () => ({ exitCode: 1, stdout: '501' }) })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
  })

  it('returns undefined when id -u prints nothing', async () => {
    const engine = createEngine({ sessionId: 'sess-uid-empty', run: () => ({ stdout: '\n' }) })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
  })

  it('returns undefined when id cannot start', async () => {
    const engine = createEngine({
      sessionId: 'sess-uid-throw',
      run: () => {
        throw new Error('spawn id ENOENT')
      },
    })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
  })

  it('returns undefined when the root cannot be listed', async () => {
    const engine = createEngine({ sessionId: 'sess-no-root', run: uidRun })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
  })

  it('returns undefined when no project holds the session', async () => {
    const engine = createEngine({
      sessionId: 'sess-missing',
      dirs: ['/tmp/claude-501/proj/another/images'],
      run: uidRun,
    })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
  })

  it('remembers a found folder per session id', async () => {
    const engine = createEngine({
      sessionId: 'sess-memo',
      dirs: ['/tmp/claude-501/proj/sess-memo/images'],
      run: uidRun,
    })
    const first = await claudeImagesDir(engine.$ as never, 'mac')
    const callsAfterFirst = engine.calls.length
    const second = await claudeImagesDir(engine.$ as never, 'mac')
    expect(second).toBe(first)
    expect(engine.calls.length).toBe(callsAfterFirst)
  })

  it('does not remember a failed lookup', async () => {
    const engine = createEngine({ sessionId: 'sess-late', run: uidRun })
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBeUndefined()
    engine.dirs.add('/tmp/claude-501/proj/sess-late/images')
    expect(await claudeImagesDir(engine.$ as never, 'mac')).toBe('/tmp/claude-501/proj/sess-late/images')
  })
})
