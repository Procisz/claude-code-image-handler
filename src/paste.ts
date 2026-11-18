import { readClipboard } from './clipboard'
import type { ControllerDollar, Memory } from './controller'
import { start } from './controller'
import { clipboardRequest, discardOffer, insertPicture } from './offer'

export const PASTE_SPEC = {
  name: 'paste',
  description: 'Adds the clipboard picture to the prompt.',
  argumentHint: '[auto on|off]',
}

export const NO_TOOL = 'Could not read the clipboard. It needs osascript (macOS), PowerShell (Windows), or wl-paste or xclip (Linux).'
export const NO_PICTURE = 'No picture on the clipboard.'
export const NOT_ADDED = 'Could not add the picture to the prompt.'
export const ADDED = 'Added the clipboard picture to the prompt.'
export const USAGE = 'Usage: /paste, /paste auto on, /paste auto off'

async function pasteNow($: ControllerDollar, memory: Memory): Promise<string> {
  await start($, memory)
  const result = await readClipboard($, memory.platform, await clipboardRequest($, memory, 'always'))
  if (result === null) return NO_TOOL
  memory.clipboardSeen = result.token
  if (result.path === undefined) return NO_PICTURE
  await discardOffer($, memory)
  return (await insertPicture($, memory, result.path)) ? ADDED : NOT_ADDED
}

async function setAuto($: ControllerDollar, memory: Memory, value: string): Promise<string> {
  if (value === 'on') {
    memory.watch = true
    memory.clipboardSeen = undefined
    memory.polledAt = undefined
    return 'Clipboard watching is on.'
  }
  memory.watch = false
  await discardOffer($, memory)
  return 'Clipboard watching is off.'
}

export async function runPaste($: ControllerDollar, memory: Memory, args: string): Promise<{ text: string }> {
  const words = args.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return { text: await pasteNow($, memory) }
  if (words[0] === 'auto' && words.length === 1) {
    const state = memory.watch ? 'on' : 'off'
    return { text: `Clipboard watching is ${state}. Use /paste auto on or /paste auto off.` }
  }
  if (words[0] === 'auto' && words.length === 2 && (words[1] === 'on' || words[1] === 'off')) {
    return { text: await setAuto($, memory, words[1]) }
  }
  return { text: USAGE }
}
