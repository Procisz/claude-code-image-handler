import { MAX_PIXELS } from './types'
import type { RawImage } from './types'

type Huffman = {
  mincode: Int32Array
  maxcode: Int32Array
  valptr: Int32Array
  values: Uint8Array
}

type Component = {
  id: number
  h: number
  v: number
  tq: number
  stride: number
  plane: Uint8ClampedArray
  done: boolean
}

type Frame = {
  width: number
  height: number
  hmax: number
  vmax: number
  mcusX: number
  mcusY: number
  components: Component[]
}

type Reader = {
  bytes: Uint8Array
  pos: number
  bits: number
  count: number
  error: boolean
}

type State = {
  frame: Frame | null
  quant: Array<Int32Array | undefined>
  tables: Array<Huffman | undefined>
  restartInterval: number
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]

const COSINES = (() => {
  const table = new Float64Array(64)
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      table[u * 8 + x] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2
    }
  }
  return table
})()

const UNSUPPORTED_FRAMES = new Set([0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function readBit(r: Reader): number {
  if (r.count === 0) {
    const byte = r.bytes[r.pos]
    if (byte === undefined) {
      r.error = true
      return 0
    }
    if (byte === 0xff) {
      if (r.bytes[r.pos + 1] !== 0) {
        r.error = true
        return 0
      }
      r.pos += 2
    } else {
      r.pos += 1
    }
    r.bits = byte
    r.count = 8
  }
  r.count -= 1
  return (r.bits >> r.count) & 1
}

function receive(r: Reader, size: number): number {
  let value = 0
  for (let i = 0; i < size; i++) value = (value << 1) | readBit(r)
  return value
}

function extend(value: number, size: number): number {
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value
}

function decodeSymbol(r: Reader, table: Huffman): number {
  let code = 0
  for (let length = 1; length <= 16; length++) {
    code = (code << 1) | readBit(r)
    if (code <= table.maxcode[length]!) return table.values[table.valptr[length]! + code - table.mincode[length]!]!
  }
  r.error = true
  return 0
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const mincode = new Int32Array(17)
  const maxcode = new Int32Array(17)
  const valptr = new Int32Array(17)
  let code = 0
  let index = 0
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!
    valptr[length] = index
    mincode[length] = code
    code += count
    index += count
    maxcode[length] = count > 0 ? code - 1 : -1
    code <<= 1
  }
  return { mincode, maxcode, valptr, values }
}

function idctBlock(
  coefs: Float64Array,
  temp: Float64Array,
  plane: Uint8ClampedArray,
  offset: number,
  stride: number,
): void {
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) sum += coefs[v * 8 + u]! * COSINES[u * 8 + x]!
      temp[v * 8 + x] = sum
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let v = 0; v < 8; v++) sum += temp[v * 8 + x]! * COSINES[v * 8 + y]!
      plane[offset + y * stride + x] = sum + 128
    }
  }
}

function decodeBlock(
  r: Reader,
  dc: Huffman,
  ac: Huffman,
  quant: Int32Array,
  pred: number,
  coefs: Float64Array,
): number {
  coefs.fill(0)
  const size = decodeSymbol(r, dc)
  if (size > 15) {
    r.error = true
    return pred
  }
  const next = pred + (size === 0 ? 0 : extend(receive(r, size), size))
  coefs[0] = next * quant[0]!
  let k = 1
  while (k < 64) {
    const symbol = decodeSymbol(r, ac)
    const bitsCount = symbol & 15
    const run = symbol >> 4
    if (bitsCount === 0) {
      if (run !== 15) break
      k += 16
      continue
    }
    k += run
    if (k > 63) {
      r.error = true
      break
    }
    const index = ZIGZAG[k]!
    coefs[index] = extend(receive(r, bitsCount), bitsCount) * quant[index]!
    k += 1
  }
  return next
}

function restart(r: Reader): boolean {
  r.count = 0
  const marker = r.bytes[r.pos + 1]
  if (r.bytes[r.pos] === 0xff && marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
    r.pos += 2
    return true
  }
  return false
}

function readDht(state: State, bytes: Uint8Array, start: number, end: number): boolean {
  let pos = start
  while (pos < end) {
    if (pos + 17 > end) return false
    const info = bytes[pos]!
    const tableClass = info >> 4
    const id = info & 15
    if (tableClass > 1 || id > 3) return false
    const counts = bytes.subarray(pos + 1, pos + 17)
    let total = 0
    for (const count of counts) total += count
    if (total > 256 || pos + 17 + total > end) return false
    state.tables[tableClass * 4 + id] = buildHuffman(counts, bytes.slice(pos + 17, pos + 17 + total))
    pos += 17 + total
  }
  return true
}

function readDqt(state: State, bytes: Uint8Array, start: number, end: number): boolean {
  let pos = start
  while (pos < end) {
    const info = bytes[pos]!
    const wide = info >> 4
    const id = info & 15
    if (wide > 1 || id > 3) return false
    const size = wide === 1 ? 128 : 64
    if (pos + 1 + size > end) return false
    const table = new Int32Array(64)
    for (let i = 0; i < 64; i++) {
      const at = pos + 1 + (wide === 1 ? i * 2 : i)
      table[ZIGZAG[i]!] = wide === 1 ? (bytes[at]! << 8) | bytes[at + 1]! : bytes[at]!
    }
    state.quant[id] = table
    pos += 1 + size
  }
  return true
}

function readFrame(state: State, bytes: Uint8Array, start: number, end: number): boolean {
  if (state.frame !== null || end - start < 6) return false
  const height = (bytes[start + 1]! << 8) | bytes[start + 2]!
  const width = (bytes[start + 3]! << 8) | bytes[start + 4]!
  const count = bytes[start + 5]!
  if (bytes[start] !== 8 || (count !== 1 && count !== 3) || end - start !== 6 + count * 3) return false
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) return false
  const parsed: Array<{ id: number; h: number; v: number; tq: number }> = []
  for (let i = 0; i < count; i++) {
    const at = start + 6 + i * 3
    const sampling = bytes[at + 1]!
    const h = count === 1 ? 1 : sampling >> 4
    const v = count === 1 ? 1 : sampling & 15
    const tq = bytes[at + 2]!
    if (h < 1 || h > 2 || v < 1 || v > 2 || tq > 3) return false
    parsed.push({ id: bytes[at]!, h, v, tq })
  }
  if (new Set(parsed.map((c) => c.id)).size !== count) return false
  const hmax = Math.max(...parsed.map((c) => c.h))
  const vmax = Math.max(...parsed.map((c) => c.v))
  const mcusX = Math.ceil(width / (8 * hmax))
  const mcusY = Math.ceil(height / (8 * vmax))
  const components = parsed.map((c) => {
    const stride = mcusX * c.h * 8
    return {
      ...c,
      stride,
      plane: new Uint8ClampedArray(stride * mcusY * c.v * 8),
      done: false,
    }
  })
  state.frame = { width, height, hmax, vmax, mcusX, mcusY, components }
  return true
}

function decodeScan(state: State, r: Reader, start: number, end: number): boolean {
  const frame = state.frame
  if (frame === null) return false
  const count = frame.components.length
  const scanCount = r.bytes[start]!
  if ((scanCount !== 1 && scanCount !== count) || end - start !== 4 + scanCount * 2) return false
  const spectralStart = r.bytes[start + 1 + scanCount * 2]!
  const spectralEnd = r.bytes[start + 2 + scanCount * 2]!
  const approximation = r.bytes[start + 3 + scanCount * 2]!
  if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) return false
  const selected: Array<{ component: Component; dc: Huffman; ac: Huffman; quant: Int32Array }> = []
  for (let i = 0; i < scanCount; i++) {
    const id = r.bytes[start + 1 + i * 2]!
    const tableIds = r.bytes[start + 2 + i * 2]!
    const component = frame.components.find((c) => c.id === id)
    const dc = state.tables[tableIds >> 4]
    const ac = state.tables[4 + (tableIds & 15)]
    const quant = component === undefined ? undefined : state.quant[component.tq]
    if (
      component === undefined ||
      dc === undefined ||
      ac === undefined ||
      quant === undefined ||
      selected.some((s) => s.component === component) ||
      tableIds >> 4 > 3 ||
      (tableIds & 15) > 3
    ) {
      return false
    }
    selected.push({ component, dc, ac, quant })
  }
  const interleaved = scanCount > 1
  const first = selected[0]!.component
  const mcusX = interleaved ? frame.mcusX : Math.ceil(Math.ceil((frame.width * first.h) / frame.hmax) / 8)
  const mcusY = interleaved ? frame.mcusY : Math.ceil(Math.ceil((frame.height * first.v) / frame.vmax) / 8)
  const preds = selected.map(() => 0)
  const coefs = new Float64Array(64)
  const temp = new Float64Array(64)
  r.pos = end
  r.count = 0
  r.error = false
  const total = mcusX * mcusY
  for (let mcu = 0; mcu < total; mcu++) {
    if (state.restartInterval > 0 && mcu > 0 && mcu % state.restartInterval === 0) {
      if (!restart(r)) return false
      preds.fill(0)
    }
    const mcuX = mcu % mcusX
    const mcuY = (mcu / mcusX) | 0
    for (let s = 0; s < selected.length; s++) {
      const { component, dc, ac, quant } = selected[s]!
      const across = interleaved ? component.h : 1
      const down = interleaved ? component.v : 1
      for (let by = 0; by < down; by++) {
        for (let bx = 0; bx < across; bx++) {
          preds[s] = decodeBlock(r, dc, ac, quant, preds[s]!, coefs)
          if (r.error) return false
          const blockX = mcuX * across + bx
          const blockY = mcuY * down + by
          idctBlock(coefs, temp, component.plane, blockY * 8 * component.stride + blockX * 8, component.stride)
        }
      }
    }
  }
  for (const { component } of selected) component.done = true
  return true
}

function toRgba(frame: Frame): RawImage {
  const { width, height, hmax, vmax, components } = frame
  const out = new Uint8ClampedArray(width * height * 4)
  const xmaps = components.map((c) => Int32Array.from({ length: width }, (_, x) => ((x * c.h) / hmax) | 0))
  const ymaps = components.map((c) => Int32Array.from({ length: height }, (_, y) => ((y * c.v) / vmax) | 0))
  const [c0, c1, c2] = components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const luma = c0!.plane[ymaps[0]![y]! * c0!.stride + xmaps[0]![x]!]!
      if (c1 === undefined || c2 === undefined) {
        out[at] = luma
        out[at + 1] = luma
        out[at + 2] = luma
      } else {
        const cb = c1.plane[ymaps[1]![y]! * c1.stride + xmaps[1]![x]!]! - 128
        const cr = c2.plane[ymaps[2]![y]! * c2.stride + xmaps[2]![x]!]! - 128
        out[at] = luma + 1.402 * cr
        out[at + 1] = luma - 0.344136 * cb - 0.714136 * cr
        out[at + 2] = luma + 1.772 * cb
      }
      out[at + 3] = 255
    }
  }
  return { width, height, rgba: new Uint8Array(out.buffer) }
}

export function decodeJpeg(bytes: Uint8Array): RawImage | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const state: State = { frame: null, quant: [], tables: [], restartInterval: 0 }
  const reader: Reader = { bytes, pos: 2, bits: 0, count: 0, error: false }
  const length = bytes.length
  let pos = 2
  while (true) {
    while (pos < length && bytes[pos] !== 0xff) pos++
    while (pos < length && bytes[pos] === 0xff) pos++
    if (pos >= length) break
    const marker = bytes[pos]!
    pos += 1
    if (marker === 0xd9) break
    if (marker === 0 || marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (pos + 2 > length) return null
    const segmentLength = (bytes[pos]! << 8) | bytes[pos + 1]!
    const end = pos + segmentLength
    if (segmentLength < 2 || end > length) return null
    const start = pos + 2
    pos = end
    if (marker === 0xc4) {
      if (!readDht(state, bytes, start, end)) return null
    } else if (marker === 0xdb) {
      if (!readDqt(state, bytes, start, end)) return null
    } else if (marker === 0xdd) {
      if (end - start !== 2) return null
      state.restartInterval = (bytes[start]! << 8) | bytes[start + 1]!
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (!readFrame(state, bytes, start, end)) return null
    } else if (UNSUPPORTED_FRAMES.has(marker)) {
      return null
    } else if (marker === 0xda) {
      if (!decodeScan(state, reader, start, end)) return null
      pos = reader.pos
    }
  }
  const frame = state.frame
  if (frame === null || frame.components.some((c) => !c.done)) return null
  return toRgba(frame)
}
