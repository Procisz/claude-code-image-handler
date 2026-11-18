import { decodeBase64 } from './base64'
import { THUMB_SIDE, convertToPng } from './convert'
import { decodeImage } from './decode'
import { decodePng } from './decode/png'
import { fitWithin } from './decode/resize'
import type { RawImage } from './decode/types'
import type { DraftRef } from './draft'
import { joinPath } from './platform'
import type { Platform, SystemDollar } from './platform'

export type LoaderContext = {
  platform: Platform
  imagesDir: string | undefined
  pastedPath?: string | undefined
  locateImagesDir?: () => Promise<string | undefined>
  noteSource?: (path: string) => void
}

const MAX_READ_BYTES = 4 * 1024 * 1024
const RETRY_MS = 200
const WAIT_LIMIT_MS = 3000

async function findCachedFile($: SystemDollar, dir: string, tag: number): Promise<string | undefined> {
  try {
    const entries = await $.fs.list(dir)
    const entry = entries.find((item) => item.kind === 'file' && item.name.startsWith(`${tag}.`))
    return entry === undefined ? undefined : entry.name
  } catch {
    return undefined
  }
}

async function readBuiltIn($: SystemDollar, source: string): Promise<RawImage | null> {
  try {
    const { size } = await $.fs.stat(source)
    if (size > MAX_READ_BYTES) return null
    const { base64 } = await $.fs.read(source, { as: 'bytes' })
    return decodeImage(decodeBase64(base64))
  } catch {
    return null
  }
}

async function decodeSource($: SystemDollar, platform: Platform, source: string): Promise<RawImage | null> {
  const png = await convertToPng($, platform, source)
  const fromTool = png === null ? null : decodePng(png)
  return fromTool ?? (await readBuiltIn($, source))
}

async function decodePasted($: SystemDollar, context: LoaderContext): Promise<RawImage | null> {
  const { platform, pastedPath, noteSource } = context
  if (pastedPath === undefined) return null
  const image = await decodeSource($, platform, pastedPath)
  if (image !== null) noteSource?.(pastedPath)
  return image
}

async function loadTagImage($: SystemDollar, tag: number, context: LoaderContext): Promise<RawImage | null> {
  const { platform, imagesDir, pastedPath, locateImagesDir } = context
  if (imagesDir === undefined && locateImagesDir === undefined) return decodePasted($, context)
  let dir = imagesDir
  for (let waited = 0; ; waited += RETRY_MS) {
    dir ??= await locateImagesDir?.()
    if (dir !== undefined) {
      const name = await findCachedFile($, dir, tag)
      const file = name === undefined ? undefined : joinPath(platform, dir, name)
      const image = file === undefined ? null : await decodeSource($, platform, file)
      if (image !== null && file !== undefined) {
        context.noteSource?.(file)
        return image
      }
    }
    if (waited >= WAIT_LIMIT_MS) return decodePasted($, context)
    await $.clock.sleep(RETRY_MS)
  }
}

export async function loadThumb(
  $: SystemDollar,
  ref: DraftRef,
  context: LoaderContext,
): Promise<RawImage | null> {
  const image =
    ref.kind === 'path'
      ? await decodeSource($, context.platform, ref.path)
      : await loadTagImage($, ref.n, context)
  return image === null ? null : fitWithin(image, THUMB_SIDE)
}
