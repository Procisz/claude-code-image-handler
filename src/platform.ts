import type { CoreEngineInterface } from 'claude-code'
import type { PathPlatform } from './paths'

export type Platform = PathPlatform

export type SystemDollar = Pick<CoreEngineInterface, 'env' | 'process' | 'fs' | 'session' | 'clock'>

const FALLBACK_POSIX_TEMP = '/tmp'
const FALLBACK_WINDOWS_TEMP = 'C:\\Windows\\Temp'
const TRAILING_SEPARATORS = /[\\/]+$/

const imagesDirs = new Map<string, string>()

function trimSeparators(value: string): string {
  return value.replace(TRAILING_SEPARATORS, '')
}

export function joinPath(platform: Platform, ...parts: string[]): string {
  return parts.join(platform === 'windows' ? '\\' : '/')
}

export async function detectPlatform($: SystemDollar): Promise<Platform> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  try {
    const { stdout } = await $.process.run(['uname', '-s'])
    return stdout.trim() === 'Darwin' ? 'mac' : 'linux'
  } catch {
    return 'linux'
  }
}

export async function tempDir($: SystemDollar, platform: Platform): Promise<string> {
  if (platform === 'windows') {
    return trimSeparators((await $.env.get('TEMP')) || FALLBACK_WINDOWS_TEMP)
  }
  return trimSeparators((await $.env.get('TMPDIR')) || FALLBACK_POSIX_TEMP)
}

export async function homeDir($: SystemDollar, platform: Platform): Promise<string | undefined> {
  return platform === 'windows' ? $.env.get('USERPROFILE') : $.env.get('HOME')
}

async function cacheRoot($: SystemDollar, platform: Platform): Promise<string | undefined> {
  const override = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (platform === 'windows') {
    const base = override || (await $.env.get('TEMP')) || FALLBACK_WINDOWS_TEMP
    return joinPath(platform, trimSeparators(base), 'claude')
  }
  try {
    const { exitCode, stdout } = await $.process.run(['id', '-u'])
    const uid = stdout.trim()
    if (exitCode !== 0 || uid === '') return undefined
    return joinPath(platform, trimSeparators(override || FALLBACK_POSIX_TEMP), `claude-${uid}`)
  } catch {
    return undefined
  }
}

export async function claudeImagesDir($: SystemDollar, platform: Platform): Promise<string | undefined> {
  const sessionId = await $.session.id()
  const known = imagesDirs.get(sessionId)
  if (known !== undefined) return known
  const root = await cacheRoot($, platform)
  if (root === undefined) return undefined
  try {
    const entries = await $.fs.list(root)
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      const candidate = joinPath(platform, root, entry.name, sessionId, 'images')
      if (await $.fs.exists(candidate)) {
        imagesDirs.set(sessionId, candidate)
        return candidate
      }
    }
  } catch {
    return undefined
  }
  return undefined
}
