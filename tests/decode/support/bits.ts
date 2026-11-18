export class BitSink {
  private bytes: number[] = []
  private accumulator = 0
  private used = 0

  low(value: number, count: number): this {
    for (let i = 0; i < count; i++) {
      this.accumulator |= ((value >> i) & 1) << this.used
      this.used++
      if (this.used === 8) {
        this.bytes.push(this.accumulator)
        this.accumulator = 0
        this.used = 0
      }
    }
    return this
  }

  high(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) {
      this.low((value >> i) & 1, 1)
    }
    return this
  }

  align(): this {
    if (this.used > 0) {
      this.bytes.push(this.accumulator)
      this.accumulator = 0
      this.used = 0
    }
    return this
  }

  raw(...values: number[]): this {
    this.align()
    this.bytes.push(...values)
    return this
  }

  done(): Uint8Array {
    this.align()
    return Uint8Array.from(this.bytes)
  }
}

export const ZLIB_HEADER = [0x78, 0x9c]

export const fixedLiteral = (sink: BitSink, symbol: number): void => {
  if (symbol < 144) {
    sink.high(0x30 + symbol, 8)
  } else if (symbol < 256) {
    sink.high(0x190 + symbol - 144, 9)
  } else if (symbol < 280) {
    sink.high(symbol - 256, 7)
  } else {
    sink.high(0xc0 + symbol - 280, 8)
  }
}

export const withHeader = (sink: BitSink): Uint8Array => Uint8Array.from([...ZLIB_HEADER, ...sink.done()])
