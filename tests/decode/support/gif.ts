export const lzwEncode = (
  indices: ArrayLike<number>,
  minCodeSize: number,
  options: { onFull?: 'clear' | 'freeze'; clearAfter?: number } = {},
): number[] => {
  const clear = 1 << minCodeSize
  const end = clear + 1
  const out: number[] = []
  let accumulator = 0
  let used = 0
  const emit = (code: number, size: number): void => {
    accumulator |= code << used
    used += size
    while (used >= 8) {
      out.push(accumulator & 255)
      accumulator >>>= 8
      used -= 8
    }
  }
  let size = minCodeSize + 1
  let next = end + 1
  let dictionary = new Map<number, number>()
  let sinceClear = 0
  emit(clear, size)
  let current = indices[0]!
  const sizeFor = (): number => Math.min(12, 32 - Math.clz32(next - 1))
  const flush = (code: number): void => {
    emit(code, size)
    sinceClear++
    if (next < 4096) {
      next++
    }
    size = sizeFor()
  }
  for (let i = 1; i < indices.length; i++) {
    const value = indices[i]!
    const key = current * 256 + value
    const known = dictionary.get(key)
    if (known !== undefined) {
      current = known
      continue
    }
    const addNew = next < 4096
    const entry = next
    flush(current)
    if (addNew) {
      dictionary.set(key, entry)
    }
    if ((next >= 4096 && options.onFull !== 'freeze') || sinceClear === options.clearAfter) {
      emit(clear, size)
      size = minCodeSize + 1
      next = end + 1
      dictionary = new Map()
      sinceClear = 0
    }
    current = value
  }
  flush(current)
  emit(end, size)
  if (used > 0) {
    out.push(accumulator & 255)
  }
  return out
}

export const subBlocks = (data: ArrayLike<number>, blockSize = 255): number[] => {
  const out: number[] = []
  for (let at = 0; at < data.length; at += blockSize) {
    const part = Array.from(data as number[]).slice(at, at + blockSize)
    out.push(part.length, ...part)
  }
  out.push(0)
  return out
}

const le16 = (value: number): number[] => [value & 255, (value >> 8) & 255]

export const colorTable = (colors: number[][], bits: number): number[] => {
  const table = new Array(3 * 2 ** bits).fill(0)
  colors.forEach((color, index) => table.splice(index * 3, 3, ...color))
  return table
}

export type GifSpec = {
  width: number
  height: number
  global?: { bits: number; colors: number[][] }
  extensions?: number[][]
  transparent?: number
  frame: {
    left?: number
    top?: number
    width: number
    height: number
    interlace?: boolean
    local?: { bits: number; colors: number[][] }
    minCodeSize?: number
    indices?: ArrayLike<number>
    lzw?: number[]
    blockSize?: number
  }
  version?: string
  trailer?: boolean
}

export const buildGif = (spec: GifSpec): Uint8Array => {
  const { frame } = spec
  const minCodeSize = frame.minCodeSize ?? 2
  const data = frame.lzw ?? lzwEncode(frame.indices!, minCodeSize)
  const bytes = [
    ...Array.from(`GIF${spec.version ?? '89a'}`, (character) => character.charCodeAt(0)),
    ...le16(spec.width),
    ...le16(spec.height),
    spec.global ? 0x80 | (spec.global.bits - 1) : 0,
    0,
    0,
    ...(spec.global ? colorTable(spec.global.colors, spec.global.bits) : []),
    ...(spec.extensions ?? []).flat(),
    ...(spec.transparent === undefined ? [] : [0x21, 0xf9, 4, 1, 0, 0, spec.transparent, 0]),
    0x2c,
    ...le16(frame.left ?? 0),
    ...le16(frame.top ?? 0),
    ...le16(frame.width),
    ...le16(frame.height),
    (frame.local ? 0x80 | (frame.local.bits - 1) : 0) | (frame.interlace ? 0x40 : 0),
    ...(frame.local ? colorTable(frame.local.colors, frame.local.bits) : []),
    minCodeSize,
    ...subBlocks(data, frame.blockSize),
    ...(spec.trailer === false ? [] : [0x3b]),
  ]
  return Uint8Array.from(bytes)
}
