const le16 = (value: number): number[] => [value & 255, (value >> 8) & 255]
export const le32 = (value: number): number[] => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]

export type BmpSpec = {
  width: number
  height: number
  bpp: number
  topDown?: boolean
  headerSize?: number
  compression?: number
  masks?: number[]
  palette?: number[][]
  colorsUsed?: number
  pixel: (x: number, y: number) => number
  dataOffset?: number
  truncate?: number
}

export const buildBmp = (spec: BmpSpec): Uint8Array => {
  const headerSize = spec.headerSize ?? 40
  const rowBytes = Math.floor((spec.width * spec.bpp + 31) / 32) * 4
  const masks = spec.masks ?? []
  const maskBytes = masks.flatMap(le32)
  const infoPad = Math.max(0, headerSize - 40 - maskBytes.length)
  const paletteBytes = (spec.palette ?? []).flatMap(([r, g, b]) => [b!, g!, r!, 0])
  const rows: number[] = []
  const height = Math.abs(spec.height)
  for (let row = 0; row < height; row++) {
    const y = spec.topDown ? row : height - 1 - row
    const bytes: number[] = new Array(rowBytes).fill(0)
    for (let x = 0; x < spec.width; x++) {
      const value = spec.pixel(x, y)
      if (spec.bpp <= 8) {
        const bit = x * spec.bpp
        bytes[bit >> 3]! |= value << (8 - spec.bpp - (bit & 7))
      } else {
        const size = spec.bpp / 8
        for (let i = 0; i < size; i++) {
          bytes[x * size + i] = Math.floor(value / 2 ** (8 * i)) & 255
        }
      }
    }
    rows.push(...bytes)
  }
  const info = [
    ...le32(headerSize),
    ...le32(spec.width),
    ...le32(spec.topDown ? -height : height),
    ...le16(1),
    ...le16(spec.bpp),
    ...le32(spec.compression ?? 0),
    ...le32(rows.length),
    ...le32(2835),
    ...le32(2835),
    ...le32(spec.colorsUsed ?? 0),
    ...le32(0),
    ...maskBytes,
    ...new Array(infoPad).fill(0),
  ]
  const natural = 14 + info.length + paletteBytes.length
  const dataOffset = spec.dataOffset ?? natural
  const gap = new Array(Math.max(0, dataOffset - natural)).fill(0)
  const fileSize = dataOffset + rows.length
  const all = [0x42, 0x4d, ...le32(fileSize), 0, 0, 0, 0, ...le32(dataOffset), ...info, ...paletteBytes, ...gap, ...rows]
  return Uint8Array.from(spec.truncate === undefined ? all : all.slice(0, spec.truncate))
}
