import type { RawImage } from './types'
import { decodeBmp } from './bmp'
import { decodeGif } from './gif'
import { decodeJpeg } from './jpeg'
import { decodePng } from './png'
import { decodePnm } from './pnm'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'bmp' | 'pnm'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const BMP_SIGNATURE = [0x42, 0x4d]
const PNM_FIRST = 0x50
const PNM_DIGIT_MIN = 0x31
const PNM_DIGIT_MAX = 0x36
const SPACE = 0x20
const HASH = 0x23

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)
}

function isPnmSeparator(byte: number | undefined): boolean {
  return byte === SPACE || byte === HASH || (byte !== undefined && byte >= 0x09 && byte <= 0x0d)
}

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg'
  if (startsWith(bytes, GIF_SIGNATURE)) return 'gif'
  if (startsWith(bytes, BMP_SIGNATURE)) return 'bmp'
  const digit = bytes[1]
  if (
    bytes[0] === PNM_FIRST &&
    digit !== undefined &&
    digit >= PNM_DIGIT_MIN &&
    digit <= PNM_DIGIT_MAX &&
    isPnmSeparator(bytes[2])
  ) {
    return 'pnm'
  }
  return null
}

export function decodeImage(bytes: Uint8Array): RawImage | null {
  switch (sniffFormat(bytes)) {
    case 'png':
      return decodePng(bytes)
    case 'jpeg':
      return decodeJpeg(bytes)
    case 'gif':
      return decodeGif(bytes)
    case 'bmp':
      return decodeBmp(bytes)
    case 'pnm':
      return decodePnm(bytes)
    default:
      return null
  }
}
