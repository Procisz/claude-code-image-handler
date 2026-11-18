import type { Platform, SystemDollar } from './platform'

const TIMEOUT_MS = 10_000
const OPEN_ENV = 'CLAUDE_IMAGE_HANDLER_OPEN'
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i
const WINDOWS_OPEN = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  `Start-Process -FilePath $env:${OPEN_ENV}`,
]

async function isLocalFile($: SystemDollar, path: string): Promise<boolean> {
  if (URL_START.test(path) || path.startsWith('\\\\')) return false
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

export async function openInViewer($: SystemDollar, platform: Platform, path: string): Promise<boolean> {
  if (!(await isLocalFile($, path))) return false
  const guarded = path.startsWith('-') ? `./${path}` : path
  const argv =
    platform === 'windows' ? WINDOWS_OPEN : [platform === 'mac' ? 'open' : 'xdg-open', guarded]
  const env = platform === 'windows' ? { [OPEN_ENV]: guarded } : undefined
  try {
    const result = await $.process.run(argv, { env, timeoutMs: TIMEOUT_MS })
    return result.exitCode === 0
  } catch {
    return false
  }
}
