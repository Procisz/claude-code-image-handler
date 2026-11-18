import { decodeBase64 } from './base64'
import { joinPath, tempDir } from './platform'
import type { Platform, SystemDollar } from './platform'

const TIMEOUT_MS = 20_000
export const THUMB_SIDE = 320
const SOURCE_ENV = 'CLAUDE_IMAGE_HANDLER_SOURCE'
const TARGET_ENV = 'CLAUDE_IMAGE_HANDLER_TARGET'
const POWERSHELL = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

const POWERSHELL_CONVERT = [
  '$ErrorActionPreference = "Stop"',
  `$p = $env:${SOURCE_ENV}`,
  'function Send($bytes) { [Console]::Out.Write([Convert]::ToBase64String($bytes)) }',
  'try {',
  '  Add-Type -AssemblyName PresentationCore',
  '  $s = [System.IO.File]::OpenRead($p)',
  '  try {',
  '    $d = [System.Windows.Media.Imaging.BitmapDecoder]::Create($s, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)',
  '    $f = $d.Frames[0]',
  `    $k = [Math]::Min(1.0, ${THUMB_SIDE}.0 / [Math]::Max($f.PixelWidth, $f.PixelHeight))`,
  '    $t = New-Object System.Windows.Media.Imaging.TransformedBitmap($f, (New-Object System.Windows.Media.ScaleTransform($k, $k)))',
  '    $e = New-Object System.Windows.Media.Imaging.PngBitmapEncoder',
  '    $e.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($t))',
  '    $m = New-Object System.IO.MemoryStream',
  '    $e.Save($m)',
  '    Send $m.ToArray()',
  '  } finally { $s.Dispose() }',
  '} catch {',
  '  try {',
  '    Add-Type -AssemblyName System.Drawing',
  '    $i = [System.Drawing.Image]::FromFile($p)',
  `    $k = [Math]::Min(1.0, ${THUMB_SIDE}.0 / [Math]::Max($i.Width, $i.Height))`,
  '    $w = [Math]::Max(1, [int]($i.Width * $k))',
  '    $h = [Math]::Max(1, [int]($i.Height * $k))',
  '    $b = New-Object System.Drawing.Bitmap($w, $h)',
  '    $g = [System.Drawing.Graphics]::FromImage($b)',
  '    $g.DrawImage($i, 0, 0, $w, $h)',
  '    $m = New-Object System.IO.MemoryStream',
  '    $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)',
  '    Send $m.ToArray()',
  '  } catch { exit 1 }',
  '}',
].join('\n')

const POWERSHELL_REMOVE = `Remove-Item -LiteralPath $env:${TARGET_ENV} -Force`

type Tool = {
  name: string
  run: (source: string, out: string) => { argv: string[]; env?: Record<string, string> }
  usesFile: boolean
}

const missing = new Set<string>()

function guardSource(source: string): string {
  return source.startsWith('-') ? `./${source}` : source
}

function magickTool(name: string): Tool {
  return {
    name,
    usesFile: true,
    run: (source, out) => ({
      argv: [
        name,
        `${guardSource(source)}[0]`,
        '-auto-orient',
        '-thumbnail',
        `${THUMB_SIDE}x${THUMB_SIDE}>`,
        '-strip',
        `PNG32:${out}`,
      ],
    }),
  }
}

const SIPS: Tool = {
  name: 'sips',
  usesFile: true,
  run: (source, out) => ({
    argv: ['sips', '-s', 'format', 'png', '-Z', String(THUMB_SIDE), guardSource(source), '--out', out],
  }),
}

const WINDOWS_SHELL: Tool = {
  name: 'powershell.exe',
  usesFile: false,
  run: (source) => ({
    argv: [...POWERSHELL, POWERSHELL_CONVERT],
    env: { [SOURCE_ENV]: source },
  }),
}

function toolChain(platform: Platform): Tool[] {
  if (platform === 'mac') return [SIPS, magickTool('magick'), magickTool('convert')]
  if (platform === 'windows') return [WINDOWS_SHELL, magickTool('magick.exe')]
  return [magickTool('magick'), magickTool('convert')]
}

export function resetMissingTools(): void {
  missing.clear()
}

export async function removeFile($: SystemDollar, platform: Platform, out: string): Promise<void> {
  const argv =
    platform === 'windows' ? [...POWERSHELL, POWERSHELL_REMOVE] : ['rm', '-f', out]
  const env = platform === 'windows' ? { [TARGET_ENV]: out } : undefined
  try {
    await $.process.run(argv, { env, timeoutMs: TIMEOUT_MS })
  } catch {
    return
  }
}

async function readOutput($: SystemDollar, out: string): Promise<Uint8Array | null> {
  try {
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    return base64 === '' ? null : decodeBase64(base64)
  } catch {
    return null
  }
}

function readStdout(stdout: string): Uint8Array | null {
  const text = stdout.trim()
  if (text === '') return null
  try {
    return decodeBase64(text)
  } catch {
    return null
  }
}

async function attempt(
  $: SystemDollar,
  platform: Platform,
  tool: Tool,
  source: string,
  out: string,
): Promise<Uint8Array | null> {
  const { argv, env } = tool.run(source, out)
  let result
  try {
    result = await $.process.run(argv, { env, timeoutMs: TIMEOUT_MS })
  } catch {
    missing.add(tool.name)
    return null
  }
  if (!tool.usesFile) {
    return result.exitCode === 0 ? readStdout(result.stdout) : null
  }
  const bytes = result.exitCode === 0 ? await readOutput($, out) : null
  await removeFile($, platform, out)
  return bytes
}

export async function convertToPng(
  $: SystemDollar,
  platform: Platform,
  source: string,
): Promise<Uint8Array | null> {
  const out = joinPath(platform, await tempDir($, platform), `claude-image-handler-${crypto.randomUUID()}.png`)
  for (const tool of toolChain(platform)) {
    if (missing.has(tool.name)) continue
    const bytes = await attempt($, platform, tool, source, out)
    if (bytes !== null) return bytes
  }
  return null
}
