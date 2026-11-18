import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function makePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]), Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)))
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', new Uint8Array(0)),
    ]),
  )
}

export function solidRgba(width: number, height: number, color: [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) rgba.set(color, i * 4)
  return rgba
}

export function makePpm(width: number, height: number, color: [number, number, number]): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`)
  const pixels = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) pixels.set(color, i * 3)
  return Uint8Array.from([...header, ...pixels])
}
