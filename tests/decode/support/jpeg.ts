export const SOI = [0xff, 0xd8]
export const EOI = [0xff, 0xd9]

export const segment = (marker: number, payload: number[]): number[] => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 255,
  ...payload,
]

export const ones = (): number[] => new Array(64).fill(1)

export const dqt = (id: number, values: number[], wide = false): number[] =>
  segment(0xdb, [(wide ? 16 : 0) | id, ...values.flatMap((value) => (wide ? [value >> 8, value & 255] : [value]))])

export const dht = (tableClass: number, id: number, counts: number[], symbols: number[]): number[] =>
  segment(0xc4, [(tableClass << 4) | id, ...counts, ...symbols])

export const DC_SYMBOLS = Array.from({ length: 12 }, (_, index) => index)
export const DC_COUNTS = [0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
export const AC_SYMBOLS = [
  0x00,
  0xf0,
  ...Array.from({ length: 16 }, (_, run) => Array.from({ length: 10 }, (_, size) => (run << 4) | (size + 1))).flat(),
]
export const AC_COUNTS = [0, 0, 0, 0, 0, 0, 0, AC_SYMBOLS.length, 0, 0, 0, 0, 0, 0, 0, 0]

export const dcTable = (id = 0): number[] => dht(0, id, DC_COUNTS, DC_SYMBOLS)
export const acTable = (id = 0): number[] => dht(1, id, AC_COUNTS, AC_SYMBOLS)

export const sof = (
  marker: number,
  precision: number,
  width: number,
  height: number,
  components: Array<{ id: number; h: number; v: number; tq: number }>,
): number[] =>
  segment(marker, [
    precision,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    components.length,
    ...components.flatMap((component) => [component.id, (component.h << 4) | component.v, component.tq]),
  ])

export const sos = (
  components: Array<{ id: number; dc: number; ac: number }>,
  spectralStart = 0,
  spectralEnd = 63,
  approximation = 0,
): number[] =>
  segment(0xda, [
    components.length,
    ...components.flatMap((component) => [component.id, (component.dc << 4) | component.ac]),
    spectralStart,
    spectralEnd,
    approximation,
  ])

export const dri = (interval: number): number[] => segment(0xdd, [interval >> 8, interval & 255])

export class Entropy {
  private bytes: number[] = []
  private accumulator = 0
  private used = 0

  bits(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) {
      this.accumulator = (this.accumulator << 1) | ((value >> i) & 1)
      this.used++
      if (this.used === 8) {
        this.pushByte(this.accumulator)
        this.accumulator = 0
        this.used = 0
      }
    }
    return this
  }

  private pushByte(byte: number): void {
    this.bytes.push(byte)
    if (byte === 0xff) {
      this.bytes.push(0)
    }
  }

  pad(): this {
    while (this.used !== 0) {
      this.bits(1, 1)
    }
    return this
  }

  marker(code: number): this {
    this.pad()
    this.bytes.push(0xff, code)
    return this
  }

  rawByte(byte: number): this {
    this.pad()
    this.bytes.push(byte)
    return this
  }

  block(dcDiff: number, ac: Array<[number, number] | 'zrl'> = [], endOfBlock = true): this {
    const magnitude = (value: number): number => (value === 0 ? 0 : Math.floor(Math.log2(Math.abs(value))) + 1)
    const amplitude = (value: number, size: number): number => (value < 0 ? value + (1 << size) - 1 : value)
    const dcSize = magnitude(dcDiff)
    this.bits(dcSize, 4)
    this.bits(amplitude(dcDiff, dcSize), dcSize)
    for (const item of ac) {
      if (item === 'zrl') {
        this.bits(AC_SYMBOLS.indexOf(0xf0), 8)
        continue
      }
      const [run, value] = item
      const size = magnitude(value)
      this.bits(AC_SYMBOLS.indexOf((run << 4) | size), 8)
      this.bits(amplitude(value, size), size)
    }
    if (endOfBlock) {
      this.bits(0, 8)
    }
    return this
  }

  done(): number[] {
    this.pad()
    return this.bytes
  }
}

export const grayJpeg = (options: {
  width?: number
  height?: number
  blocks: (entropy: Entropy) => void
  quant?: number[]
  before?: number[]
  restartInterval?: number
  eoi?: boolean
  dc?: number[]
  ac?: number[]
}): Uint8Array => {
  const entropy = new Entropy()
  options.blocks(entropy)
  return Uint8Array.from([
    ...SOI,
    ...(options.before ?? []),
    ...dqt(0, options.quant ?? ones()),
    ...(options.restartInterval === undefined ? [] : dri(options.restartInterval)),
    ...sof(0xc0, 8, options.width ?? 8, options.height ?? 8, [{ id: 1, h: 1, v: 1, tq: 0 }]),
    ...(options.dc ?? dcTable()),
    ...(options.ac ?? acTable()),
    ...sos([{ id: 1, dc: 0, ac: 0 }]),
    ...entropy.done(),
    ...(options.eoi === false ? [] : EOI),
  ])
}
