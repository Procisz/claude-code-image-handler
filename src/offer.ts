import { readClipboard } from './clipboard'
import type { ClipboardMode, ClipboardRequest } from './clipboard'
import { removeFile } from './convert'
import { sync } from './controller'
import type { ControllerDollar, Memory } from './controller'
import { loadThumb } from './loader'
import { joinPath, tempDir } from './platform'
import { makeThumb } from './thumb'
import { CLIPBOARD_ID } from './view'

export const CLIPBOARD_POLL_MS = 1500
export const ADD_FAILED = 'Could not add the picture to the prompt'

export async function clipboardRequest(
  $: ControllerDollar,
  memory: Memory,
  mode: ClipboardMode,
): Promise<ClipboardRequest> {
  return {
    mode,
    seen: memory.clipboardSeen,
    directory: joinPath(memory.platform, await tempDir($, memory.platform), 'claude-image-handler'),
    stem: `clipboard-${crypto.randomUUID()}`,
  }
}

export async function discardOffer($: ControllerDollar, memory: Memory): Promise<void> {
  const offer = memory.offer
  if (offer === undefined) return
  memory.offer = undefined
  memory.thumbs.delete(CLIPBOARD_ID)
  memory.isStateDirty = true
  await removeFile($, memory.platform, offer.path)
}

async function settleOffer($: ControllerDollar, memory: Memory, path: string, token: object): Promise<void> {
  let image = null
  try {
    image = await loadThumb($, { id: CLIPBOARD_ID, kind: 'path', path, spans: [] }, { platform: memory.platform, imagesDir: undefined })
  } catch {
    image = null
  }
  const offer = memory.offer
  if (offer === undefined || offer.token !== token) return
  if (image === null) {
    memory.offer = { ...offer, status: 'failed' }
  } else {
    memory.thumbs.set(CLIPBOARD_ID, makeThumb(image))
    memory.offer = { ...offer, status: 'ready', width: image.width, height: image.height }
  }
  memory.isStateDirty = true
}

export async function showOffer($: ControllerDollar, memory: Memory, path: string): Promise<void> {
  await discardOffer($, memory)
  const token = {}
  memory.offer = { status: 'loading', width: 0, height: 0, path, token }
  memory.isStateDirty = true
  await settleOffer($, memory, path, token)
}

export async function pollClipboard($: ControllerDollar, memory: Memory): Promise<void> {
  if (!memory.watch || memory.isPolling) return
  const now = await $.clock.now()
  if (memory.polledAt !== undefined && now - memory.polledAt < CLIPBOARD_POLL_MS) return
  memory.isPolling = true
  memory.polledAt = now
  try {
    const mode = memory.clipboardSeen === undefined ? 'baseline' : 'changed'
    const result = await readClipboard($, memory.platform, await clipboardRequest($, memory, mode))
    if (result === null) return
    memory.clipboardSeen = result.token
    if (result.path !== undefined) await showOffer($, memory, result.path)
  } catch {
    return
  } finally {
    memory.isPolling = false
  }
}

function promptText(path: string, before: string): string {
  const shown = /\s/.test(path) ? `"${path}"` : path
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : ''
  return `${lead}${shown} `
}

export async function insertPicture($: ControllerDollar, memory: Memory, path: string): Promise<boolean> {
  try {
    const box = await $.prompt.read()
    const filled = await $.prompt.fill({ text: promptText(path, box.text.slice(0, box.cursor)), mode: 'insert' })
    if (!filled.isFilled) return false
    await sync($, memory, filled.text)
    memory.clipboardFiles.add(path)
    return true
  } catch {
    return false
  }
}

export async function addOffer($: ControllerDollar, memory: Memory): Promise<void> {
  const offer = memory.offer
  if (offer === undefined) return
  if (!(await insertPicture($, memory, offer.path))) {
    $.ui.toast(ADD_FAILED)
    return
  }
  memory.offer = undefined
  memory.thumbs.delete(CLIPBOARD_ID)
  memory.isStateDirty = true
}

export async function dismissOffer($: ControllerDollar, memory: Memory): Promise<void> {
  await discardOffer($, memory)
}

export async function cleanupClipboard($: ControllerDollar, memory: Memory): Promise<void> {
  const paths = new Set(memory.clipboardFiles)
  if (memory.offer !== undefined) paths.add(memory.offer.path)
  memory.clipboardFiles.clear()
  memory.offer = undefined
  memory.thumbs.delete(CLIPBOARD_ID)
  await Promise.all([...paths].map((path) => removeFile($, memory.platform, path)))
}
