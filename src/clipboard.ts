import { joinPath } from './platform'
import type { Platform, SystemDollar } from './platform'

export type ClipboardMode = 'baseline' | 'changed' | 'always'
export type ClipboardRequest = {
  mode: ClipboardMode
  seen: string | undefined
  directory: string
  stem: string
}
export type ClipboardRead = { token: string; path: string | undefined }

const TIMEOUT_MS = 20_000
const MODE_ENV = 'CLAUDE_IMAGE_HANDLER_CLIP_MODE'
const SEEN_ENV = 'CLAUDE_IMAGE_HANDLER_CLIP_SEEN'
const TARGET_ENV = 'CLAUDE_IMAGE_HANDLER_CLIP_TARGET'
const POWERSHELL = [
  'powershell.exe',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Sta',
  '-Command',
]

const MAC_SCRIPT = [
  "ObjC.import('AppKit')",
  'function run(argv) {',
  '  var mode = argv[0]',
  '  var seen = argv[1]',
  '  var target = argv[2]',
  '  var board = $.NSPasteboard.generalPasteboard',
  '  var token = String(board.changeCount)',
  "  var saved = ''",
  "  if (mode === 'baseline' || (mode === 'changed' && token === seen)) {",
  '    return JSON.stringify({ token: token, path: saved })',
  '  }',
  "  var data = board.dataForType('public.png')",
  '  if (data.isNil()) {',
  "    var tiff = board.dataForType('public.tiff')",
  '    if (!tiff.isNil()) {',
  '      var rep = $.NSBitmapImageRep.imageRepWithData(tiff)',
  '      if (!rep.isNil()) data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $())',
  '    }',
  '  }',
  '  if (!data.isNil()) {',
  '    var folder = $(target).stringByDeletingLastPathComponent',
  '    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(folder, true, $(), $())',
  '    if (data.writeToFileAtomically($(target), true)) saved = target',
  '  }',
  '  return JSON.stringify({ token: token, path: saved })',
  '}',
].join('\n')

const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  `$mode = $env:${MODE_ENV}`,
  `$seen = $env:${SEEN_ENV}`,
  `$target = $env:${TARGET_ENV}`,
  'Add-Type -Namespace ImageHandler -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();\'',
  '$token = [string][ImageHandler.Native]::GetClipboardSequenceNumber()',
  '$saved = ""',
  'if ($mode -ne "baseline" -and -not ($mode -eq "changed" -and $token -eq $seen)) {',
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  Add-Type -AssemblyName System.Drawing',
  '  $image = [System.Windows.Forms.Clipboard]::GetImage()',
  '  if ($image -ne $null) {',
  '    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null',
  '    $image.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)',
  '    $saved = $target',
  '  }',
  '}',
  '@{ token = $token; path = $saved } | ConvertTo-Json -Compress',
].join('\n')

const LINUX_TYPES: { type: string; ext: string }[] = [
  { type: 'image/png', ext: 'png' },
  { type: 'image/jpeg', ext: 'jpg' },
  { type: 'image/gif', ext: 'gif' },
  { type: 'image/bmp', ext: 'bmp' },
  { type: 'image/tiff', ext: 'tiff' },
  { type: 'image/webp', ext: 'webp' },
]

type LinuxTool = {
  name: string
  listArgv: string[]
  readCommand: string
}

const WL_PASTE: LinuxTool = {
  name: 'wl-paste',
  listArgv: ['wl-paste', '--list-types'],
  readCommand: 'wl-paste --no-newline --type "$1"',
}

const XCLIP: LinuxTool = {
  name: 'xclip',
  listArgv: ['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'],
  readCommand: 'xclip -selection clipboard -t "$1" -o',
}

const SH_NAME = 'image-handler'
const missing = new Set<string>()

export function resetMissingClipboardTools(): void {
  missing.clear()
}

function parseRead(stdout: string): ClipboardRead | null {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { token, path } = value as Record<string, unknown>
  if (typeof token !== 'string' || typeof path !== 'string') return null
  return { token, path: path === '' ? undefined : path }
}

async function runScript(
  $: SystemDollar,
  name: string,
  argv: string[],
  env?: Record<string, string>,
): Promise<ClipboardRead | null> {
  let result
  try {
    result = await $.process.run(argv, { env, timeoutMs: TIMEOUT_MS })
  } catch {
    missing.add(name)
    return null
  }
  return result.exitCode === 0 ? parseRead(result.stdout) : null
}

async function readMac($: SystemDollar, request: ClipboardRequest, target: string) {
  if (missing.has('osascript')) return null
  const argv = ['osascript', '-l', 'JavaScript', '-e', MAC_SCRIPT, request.mode, request.seen ?? '', target]
  return runScript($, 'osascript', argv)
}

async function readWindows($: SystemDollar, request: ClipboardRequest, target: string) {
  if (missing.has('powershell.exe')) return null
  const env = {
    [MODE_ENV]: request.mode,
    [SEEN_ENV]: request.seen ?? '',
    [TARGET_ENV]: target,
  }
  return runScript($, 'powershell.exe', [...POWERSHELL, WINDOWS_SCRIPT], env)
}

async function linuxTools($: SystemDollar): Promise<LinuxTool[]> {
  const wayland = (await $.env.get('WAYLAND_DISPLAY')) !== undefined
  const order = wayland ? [WL_PASTE, XCLIP] : [XCLIP, WL_PASTE]
  return order.filter((tool) => !missing.has(tool.name))
}

async function readLinuxWith(
  $: SystemDollar,
  platform: Platform,
  tool: LinuxTool,
  request: ClipboardRequest,
): Promise<ClipboardRead | null> {
  let listing
  try {
    listing = await $.process.run(tool.listArgv, { timeoutMs: TIMEOUT_MS })
  } catch {
    missing.add(tool.name)
    return null
  }
  const types = listing.exitCode === 0 ? listing.stdout.split(/\r?\n/).map((line) => line.trim()) : []
  const found = LINUX_TYPES.find((candidate) => types.includes(candidate.type))
  if (found === undefined) return { token: 'none', path: undefined }

  const sum = await $.process.run(['sh', '-c', `${tool.readCommand} | cksum`, SH_NAME, found.type], {
    timeoutMs: TIMEOUT_MS,
  })
  const token = `${found.type} ${sum.stdout.trim()}`
  if (request.mode === 'baseline' || (request.mode === 'changed' && token === request.seen)) {
    return { token, path: undefined }
  }
  const target = joinPath(platform, request.directory, `${request.stem}.${found.ext}`)
  const save = await $.process.run(
    ['sh', '-c', `mkdir -p "$(dirname "$2")" && ${tool.readCommand} > "$2"`, SH_NAME, found.type, target],
    { timeoutMs: TIMEOUT_MS },
  )
  return { token, path: save.exitCode === 0 ? target : undefined }
}

async function readLinux($: SystemDollar, platform: Platform, request: ClipboardRequest) {
  for (const tool of await linuxTools($)) {
    try {
      const read = await readLinuxWith($, platform, tool, request)
      if (read !== null) return read
    } catch {
      return null
    }
  }
  return null
}

export async function readClipboard(
  $: SystemDollar,
  platform: Platform,
  request: ClipboardRequest,
): Promise<ClipboardRead | null> {
  const target = joinPath(platform, request.directory, `${request.stem}.png`)
  if (platform === 'mac') return readMac($, request, target)
  if (platform === 'windows') return readWindows($, request, target)
  return readLinux($, platform, request)
}
