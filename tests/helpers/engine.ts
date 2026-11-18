import { vi } from 'vitest'
import { encodeBase64 } from '../../src/base64'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { env?: Record<string, string>; timeoutMs?: number } | undefined
export type RunCall = { argv: string[]; options: RunOptions }
export type RunHandler = (argv: string[], options: RunOptions) => Partial<RunResult> | Promise<Partial<RunResult>>

export type FakeTimer = { ms: number; fn: () => void; cancelled: boolean }

export type EngineOptions = {
  env?: Record<string, string>
  files?: Record<string, Uint8Array | string>
  dirs?: string[]
  sessionId?: string
  now?: number
  draft?: string
  cursor?: number
  run?: RunHandler
}

const ELEMENTS = {
  Box: 'Box',
  Text: 'Text',
  Button: 'Button',
  Raster: 'Raster',
  Image: 'Image',
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? '' : path.slice(0, cut)
}

function nameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

export function createEngine(options: EngineOptions = {}) {
  const env = new Map<string, string>(Object.entries(options.env ?? {}))
  const files = new Map<string, Uint8Array>(
    Object.entries(options.files ?? {}).map(([path, value]) => [path, toBytes(value)]),
  )
  const dirs = new Set<string>(options.dirs ?? [])
  const timers: FakeTimer[] = []
  const state = new Map<string, unknown>()
  const calls: RunCall[] = []

  const clock = { now: options.now ?? 1_000_000 }
  const prompt = { text: options.draft ?? '', cursor: options.cursor ?? (options.draft ?? '').length, accepts: true }
  const handlers: { run: RunHandler } = { run: options.run ?? (() => ({})) }

  const hasDir = (path: string) => {
    if (dirs.has(path)) return true
    const prefix = path.endsWith('/') || path.endsWith('\\') ? path : `${path}/`
    const winPrefix = `${path}\\`
    for (const file of files.keys()) if (file.startsWith(prefix) || file.startsWith(winPrefix)) return true
    for (const dir of dirs) if (dir.startsWith(prefix) || dir.startsWith(winPrefix)) return true
    return false
  }

  const $ = {
    env: {
      get: vi.fn(async (name: string) => env.get(name)),
    },
    session: {
      id: vi.fn(async () => options.sessionId ?? 'session-1'),
    },
    process: {
      run: vi.fn(async (argv: string[], runOptions?: RunOptions) => {
        calls.push({ argv: [...argv], options: runOptions })
        const result = await handlers.run(argv, runOptions)
        return { exitCode: 0, stdout: '', stderr: '', ...result }
      }),
    },
    fs: {
      read: vi.fn(async (path: string, _readOptions?: unknown) => {
        const bytes = files.get(path)
        if (bytes === undefined) throw new Error(`ENOENT: ${path}`)
        return { base64: encodeBase64(bytes) }
      }),
      stat: vi.fn(async (path: string) => {
        const bytes = files.get(path)
        if (bytes !== undefined) return { kind: 'file' as const, size: bytes.length }
        if (hasDir(path)) return { kind: 'dir' as const, size: 0 }
        throw new Error(`ENOENT: ${path}`)
      }),
      exists: vi.fn(async (path: string) => files.has(path) || hasDir(path)),
      list: vi.fn(async (path: string) => {
        if (!hasDir(path)) throw new Error(`ENOENT: ${path}`)
        const entries = new Map<string, 'file' | 'dir'>()
        for (const file of files.keys()) {
          if (parentOf(file) === path) entries.set(nameOf(file), 'file')
        }
        const known = [...dirs, ...[...files.keys()].map(parentOf)]
        for (const start of known) {
          let current = start
          while (current !== '') {
            if (parentOf(current) === path) entries.set(nameOf(current), 'dir')
            current = parentOf(current)
          }
        }
        return [...entries].map(([name, kind]) => ({ name, kind }))
      }),
    },
    clock: {
      now: vi.fn(async () => clock.now),
      sleep: vi.fn(async (ms: number) => {
        clock.now += ms
      }),
      every: vi.fn((ms: number, fn: () => void) => {
        const timer: FakeTimer = { ms, fn, cancelled: false }
        timers.push(timer)
        return {
          cancel: () => {
            timer.cancelled = true
          },
        }
      }),
    },
    state: {
      get: vi.fn(async (ref: { plugin: string; key: string }) => ({ value: state.get(`${ref.plugin}/${ref.key}`) })),
      set: vi.fn(async (ref: { plugin: string; key: string }, value: unknown) => {
        state.set(`${ref.plugin}/${ref.key}`, structuredClone(value))
      }),
    },
    prompt: {
      read: vi.fn(async () => ({ text: prompt.text, cursor: prompt.cursor })),
      fill: vi.fn(async (input: { text: string; mode: string; cursor?: number }) => {
        if (!prompt.accepts) return { isFilled: false as const, text: prompt.text, cursor: prompt.cursor }
        prompt.text = input.text
        prompt.cursor = input.cursor ?? input.text.length
        return { isFilled: true as const, text: prompt.text, cursor: prompt.cursor }
      }),
    },
    command: {
      register: vi.fn(async (spec: { name: string }) => ({ command: spec.name })),
    },
    ui: {
      toast: vi.fn(),
      blit: vi.fn(async (_args: { requestId: string; key: string; cells: string }) => ({})),
      resolve: vi.fn((_event: unknown) => ELEMENTS),
    },
  }

  return {
    $,
    env,
    files,
    dirs,
    timers,
    state,
    calls,
    clock,
    prompt,
    handlers,
    setFile(path: string, value: Uint8Array | string) {
      files.set(path, toBytes(value))
    },
    removeFile(path: string) {
      files.delete(path)
    },
    setDraft(text: string, cursor = text.length) {
      prompt.text = text
      prompt.cursor = cursor
    },
    activeTimers() {
      return timers.filter((timer) => !timer.cancelled)
    },
    fireTimers() {
      for (const timer of this.activeTimers()) timer.fn()
    },
  }
}

export type FakeEngine = ReturnType<typeof createEngine>

export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

export async function flushAll(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
