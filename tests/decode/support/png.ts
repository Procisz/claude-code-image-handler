import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export const be32 = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]

export const chunk = (type: string, data: ArrayLike<number>): number[] => {
  const body = [...Array.from(type, (character) => character.charCodeAt(0)), ...Array.from(data)]
  return [...be32(data.length), ...body, ...be32(crc32(Uint8Array.from(body)))]
}

export const header = (
  width: number,
  height: number,
  depth: number,
  colorType: number,
  interlace = 0,
  compression = 0,
  filterMethod = 0,
): number[] => chunk('IHDR', [...be32(width), ...be32(height), depth, colorType, compression, filterMethod, interlace])

export const assemble = (...chunks: number[][]): Uint8Array => Uint8Array.from([...SIGNATURE, ...chunks.flat()])

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) {
    return a
  }
  return pb <= pc ? b : c
}

export type PngSpec = {
  width: number
  height: number
  depth: number
  colorType: number
  interlace?: number
  sample: (x: number, y: number, channel: number) => number
  filter?: (pass: number, row: number) => number
}

export const scanlines = (spec: PngSpec): Uint8Array => {
  const { width, height, depth, colorType } = spec
  const channels = CHANNELS[colorType]!
  const step = Math.max(1, (channels * depth) >> 3)
  const passes = spec.interlace === 1 ? PASSES : [[0, 0, 1, 1] as const]
  const out: number[] = []
  passes.forEach(([x0, y0, dx, dy], passIndex) => {
    const passWidth = Math.ceil((width - x0) / dx)
    const passHeight = Math.ceil((height - y0) / dy)
    if (passWidth <= 0 || passHeight <= 0) {
      return
    }
    let previous: number[] = []
    for (let row = 0; row < passHeight; row++) {
      const y = y0 + row * dy
      const raw: number[] = []
      let accumulator = 0
      let used = 0
      for (let column = 0; column < passWidth; column++) {
        for (let channel = 0; channel < channels; channel++) {
          const value = spec.sample(x0 + column * dx, y, channel)
          if (depth === 16) {
            raw.push(value >> 8, value & 255)
          } else if (depth === 8) {
            raw.push(value)
          } else {
            accumulator = (accumulator << depth) | value
            used += depth
            if (used === 8) {
              raw.push(accumulator)
              accumulator = 0
              used = 0
            }
          }
        }
      }
      if (used > 0) {
        raw.push(accumulator << (8 - used))
      }
      if (previous.length === 0) {
        previous = raw.map(() => 0)
      }
      const filter = spec.filter?.(passIndex, row) ?? 0
      out.push(filter)
      raw.forEach((value, index) => {
        const left = index >= step ? raw[index - step]! : 0
        const up = previous[index]!
        const upLeft = index >= step ? previous[index - step]! : 0
        const predictors = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)]
        out.push((value - predictors[filter]! + 256) & 255)
      })
      previous = raw
    }
  })
  return Uint8Array.from(out)
}

export type BuildOptions = {
  palette?: number[]
  trns?: number[]
  idatSplit?: number
  idat?: Uint8Array
  omitIend?: boolean
  extraChunks?: number[][]
}

export const buildPng = (spec: PngSpec, options: BuildOptions = {}): Uint8Array => {
  const compressed = options.idat ?? new Uint8Array(deflateSync(scanlines(spec)))
  const split = options.idatSplit ?? compressed.length
  const idats: number[][] = []
  for (let at = 0; at < compressed.length; at += split) {
    idats.push(chunk('IDAT', compressed.subarray(at, at + split)))
  }
  return assemble(
    header(spec.width, spec.height, spec.depth, spec.colorType, spec.interlace ?? 0),
    ...(options.palette ? [chunk('PLTE', options.palette)] : []),
    ...(options.trns ? [chunk('tRNS', options.trns)] : []),
    ...(options.extraChunks ?? []),
    ...idats,
    ...(options.omitIend ? [] : [chunk('IEND', [])]),
  )
}
