import type { CoreEngineInterface, PluginOptions, Timer } from 'claude-code'
import type { ClipboardOffer, PreviewItem } from '../types'
import type { RawImage } from './decode/types'
import { parseDraft, removeRef } from './draft'
import type { DraftRef } from './draft'
import { SPINNER_FRAMES, drawsPictures, readRendererEnv, spinnerCells } from './layout'
import type { RendererEnv } from './layout'
import { loadThumb } from './loader'
import { baseName } from './names'
import { findImagePaths } from './paths'
import { createPasteMemory } from './paste-memory'
import type { PasteMemory } from './paste-memory'
import { claudeImagesDir, detectPlatform, homeDir } from './platform'
import type { Platform, SystemDollar } from './platform'
import { pollClipboard } from './offer'
import { writeItems, writeOffer } from './state'
import { makeThumb } from './thumb'
import { openInViewer } from './viewer'
import type { Thumb } from './view'

export type ControllerDollar = SystemDollar & Pick<CoreEngineInterface, 'state' | 'prompt' | 'ui'>

type Job = { id: string; ref: DraftRef; token: object; pastedPath: string | undefined }

export type ClipboardState = ClipboardOffer & { path: string; token: object }

export type Memory = {
  platform: Platform
  home: string | undefined
  rendererEnv: RendererEnv
  timer: Timer | undefined
  starting: Promise<void> | undefined
  items: PreviewItem[]
  thumbs: Map<string, Thumb>
  tokens: Map<string, object>
  pasted: Map<string, string>
  files: Set<string>
  paste: PasteMemory
  pending: Job[]
  running: number
  frame: number
  requestId: string | undefined
  lastText: string | undefined
  isDirty: boolean
  isStateDirty: boolean
  isBusy: boolean
  chain: Promise<void>
  watch: boolean
  clipboardSeen: string | undefined
  polledAt: number | undefined
  isPolling: boolean
  offer: ClipboardState | undefined
  sources: Map<string, string>
  clipboardFiles: Set<string>
}

export const JOB_LIMIT = 3
export const TICK_MS = 200
export const REMOVE_FAILED = 'Could not remove the image from the prompt'
export const OPEN_FAILED = 'Could not open the image'

export function createMemory(): Memory {
  return {
    platform: 'linux',
    home: undefined,
    rendererEnv: {},
    timer: undefined,
    starting: undefined,
    items: [],
    thumbs: new Map(),
    tokens: new Map(),
    pasted: new Map(),
    files: new Set(),
    paste: createPasteMemory(),
    pending: [],
    running: 0,
    frame: 0,
    requestId: undefined,
    lastText: undefined,
    isDirty: false,
    isStateDirty: false,
    isBusy: false,
    chain: Promise.resolve(),
    watch: true,
    clipboardSeen: undefined,
    polledAt: undefined,
    isPolling: false,
    offer: undefined,
    sources: new Map(),
    clipboardFiles: new Set(),
  }
}

export function configure(memory: Memory, options: PluginOptions): void {
  memory.watch = options.clipboard_watch !== false
}

function settleChain(): undefined {
  return undefined
}

function serialize(memory: Memory, work: () => Promise<void>): Promise<void> {
  const result = memory.chain.then(work)
  memory.chain = result.then(settleChain, settleChain)
  return result
}

async function begin($: ControllerDollar, memory: Memory): Promise<void> {
  try {
    memory.platform = await detectPlatform($)
    memory.home = await homeDir($, memory.platform)
    memory.rendererEnv = await readRendererEnv($)
    memory.timer = $.clock.every(TICK_MS, () => {
      void tick($, memory)
    })
  } catch {
    memory.starting = undefined
  }
}

export function start($: ControllerDollar, memory: Memory): Promise<void> {
  memory.starting ??= begin($, memory)
  return memory.starting
}

export function stop(memory: Memory): void {
  memory.timer?.cancel()
  memory.timer = undefined
  memory.starting = undefined
}

export function markDirty(memory: Memory): void {
  memory.isDirty = true
}

export function setRequestId(memory: Memory, requestId: string): void {
  memory.requestId = requestId
}

export function pictures(memory: Memory, isFullscreen: boolean): boolean {
  return drawsPictures(memory.rendererEnv, isFullscreen)
}

export function notePaste(memory: Memory, text: string, at: number): void {
  const options = { platform: memory.platform, home: memory.home }
  memory.paste.record(
    findImagePaths(text, options).map((match) => match.path),
    at,
  )
}

async function isFile($: ControllerDollar, memory: Memory, path: string): Promise<boolean> {
  if (memory.files.has(path)) return true
  try {
    if ((await $.fs.stat(path)).kind === 'file') {
      memory.files.add(path)
      return true
    }
  } catch {
    return false
  }
  return false
}

function labelFor(memory: Memory, ref: DraftRef): string {
  if (ref.kind === 'path') return baseName(ref.path)
  const path = memory.pasted.get(ref.id)
  return path === undefined ? `Image #${ref.n}` : baseName(path)
}

function settle(memory: Memory, id: string, image: RawImage | null): void {
  if (image !== null) memory.thumbs.set(id, makeThumb(image))
  const outcome =
    image === null
      ? ({ status: 'failed', width: 0, height: 0 } as const)
      : ({ status: 'ready', width: image.width, height: image.height } as const)
  memory.items = memory.items.map((item) => (item.id === id ? { ...item, ...outcome } : item))
  memory.isStateDirty = true
}

async function attempt($: ControllerDollar, memory: Memory, job: Job): Promise<RawImage | null> {
  try {
    const locateImagesDir = job.ref.kind === 'tag' ? () => claudeImagesDir($, memory.platform) : undefined
    return await loadThumb($, job.ref, {
      platform: memory.platform,
      imagesDir: undefined,
      pastedPath: job.pastedPath,
      locateImagesDir,
      noteSource: (path) => {
        if (memory.tokens.get(job.id) === job.token) memory.sources.set(job.id, path)
      },
    })
  } catch {
    return null
  }
}

async function run($: ControllerDollar, memory: Memory, job: Job): Promise<void> {
  const image = await attempt($, memory, job)
  memory.running--
  if (memory.tokens.get(job.id) === job.token) settle(memory, job.id, image)
  pump($, memory)
}

function pump($: ControllerDollar, memory: Memory): void {
  while (memory.running < JOB_LIMIT) {
    const job = memory.pending.shift()
    if (job === undefined) return
    if (memory.tokens.get(job.id) !== job.token) continue
    memory.running++
    void run($, memory, job)
  }
}

function forget(memory: Memory, id: string): void {
  memory.thumbs.delete(id)
  memory.tokens.delete(id)
  memory.pasted.delete(id)
  memory.sources.delete(id)
}

async function reconcile($: ControllerDollar, memory: Memory, text: string): Promise<void> {
  memory.lastText = text
  const parsed = parseDraft(text, { platform: memory.platform, home: memory.home })
  const checks = await Promise.all(
    parsed.map((ref) => (ref.kind === 'tag' ? true : isFile($, memory, ref.path))),
  )
  const refs = parsed.filter((_ref, index) => checks[index])
  const present = new Set(parsed.flatMap((ref) => (ref.kind === 'path' ? [ref.path] : [])))
  for (const path of [...memory.files]) if (!present.has(path)) memory.files.delete(path)

  const existing = new Map(memory.items.map((item) => [item.id, item]))
  const newTags = refs.flatMap((ref) => (ref.kind === 'tag' && !existing.has(ref.id) ? [ref.n] : []))
  const claimed = memory.paste.claim(newTags, await $.clock.now())
  for (const [tag, path] of claimed) memory.pasted.set(`tag:${tag}`, path)

  const created: Job[] = []
  const next = refs.map((ref) => {
    const kept = existing.get(ref.id)
    if (kept !== undefined) return kept
    const token = {}
    memory.tokens.set(ref.id, token)
    if (ref.kind === 'path') memory.sources.set(ref.id, ref.path)
    created.push({ id: ref.id, ref, token, pastedPath: memory.pasted.get(ref.id) })
    const item: PreviewItem = {
      id: ref.id,
      kind: ref.kind,
      label: labelFor(memory, ref),
      status: 'loading',
      width: 0,
      height: 0,
    }
    return item
  })
  const live = new Set(next.map((item) => item.id))
  for (const item of memory.items) if (!live.has(item.id)) forget(memory, item.id)
  memory.items = next
  memory.isStateDirty = true
  memory.pending = [...memory.pending, ...created]
  pump($, memory)
}

export function sync($: ControllerDollar, memory: Memory, text: string): Promise<void> {
  return serialize(memory, () => reconcile($, memory, text))
}

async function removeFromDraft($: ControllerDollar, memory: Memory, id: string): Promise<boolean> {
  const box = await $.prompt.read()
  const options = { platform: memory.platform, home: memory.home }
  const ref = parseDraft(box.text, options).find((candidate) => candidate.id === id)
  if (ref === undefined) {
    await sync($, memory, box.text)
    return true
  }
  const edit = removeRef(box.text, box.cursor, ref)
  const filled = await $.prompt.fill({ text: edit.text, mode: 'replace', cursor: edit.cursor })
  if (!filled.isFilled) return false
  await sync($, memory, filled.text)
  return true
}

export async function openImage($: ControllerDollar, memory: Memory, id: string): Promise<void> {
  const source = memory.sources.get(id)
  const isOpened = source !== undefined && (await openInViewer($, memory.platform, source))
  if (!isOpened) $.ui.toast(OPEN_FAILED)
}

export async function remove($: ControllerDollar, memory: Memory, id: string): Promise<void> {
  let isRemoved = false
  try {
    isRemoved = await removeFromDraft($, memory, id)
  } catch {
    isRemoved = false
  }
  if (!isRemoved) $.ui.toast(REMOVE_FAILED)
}

async function flush($: ControllerDollar, memory: Memory): Promise<void> {
  if (!memory.isStateDirty) return
  memory.isStateDirty = false
  await writeItems($, memory.items)
  const offer = memory.offer
  await writeOffer($, offer === undefined ? null : { status: offer.status, width: offer.width, height: offer.height })
}

async function blitSpinners($: ControllerDollar, memory: Memory): Promise<void> {
  if (memory.requestId === undefined) return
  const requestId = memory.requestId
  const cells = spinnerCells(memory.frame)
  const loading = memory.items.filter((item) => item.status === 'loading').map((item) => item.id)
  if (memory.offer?.status === 'loading') loading.push('clipboard')
  await Promise.all(loading.map((id) => $.ui.blit({ requestId, key: `spinner:${id}`, cells })))
}

export async function tick($: ControllerDollar, memory: Memory): Promise<void> {
  if (memory.isBusy) return
  memory.isBusy = true
  try {
    memory.frame = (memory.frame + 1) % SPINNER_FRAMES.length
    const box = await $.prompt.read()
    if (memory.isDirty || box.text !== memory.lastText) {
      memory.isDirty = false
      await sync($, memory, box.text)
    }
    await flush($, memory)
    await blitSpinners($, memory)
    void pollClipboard($, memory)
  } catch {
    return
  } finally {
    memory.isBusy = false
  }
}
