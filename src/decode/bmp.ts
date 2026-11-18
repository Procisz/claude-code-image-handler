import { MAX_PIXELS, type RawImage } from './types';

const BI_RGB = 0;
const BI_BITFIELDS = 3;
const BIT_DEPTHS = new Set([1, 4, 8, 16, 24, 32]);

const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

const u32 = (bytes: Uint8Array, at: number): number =>
  (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

const channel = (mask: number, empty: number): ((pixel: number) => number) => {
  if (mask === 0) {
    return () => empty;
  }
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) {
    shift++;
  }
  const max = mask >>> shift;
  return (pixel) => Math.round((((pixel & mask) >>> shift) * 255) / max);
};

export function decodeBmp(bytes: Uint8Array): RawImage | null {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return null;
  }
  const headerSize = u32(bytes, 14);
  const width = u32(bytes, 18) | 0;
  const signedHeight = u32(bytes, 22) | 0;
  const bpp = u16(bytes, 28);
  const compression = u32(bytes, 30);
  const height = Math.abs(signedHeight);
  if (
    headerSize < 40 ||
    headerSize > 124 ||
    width <= 0 ||
    height === 0 ||
    width * height > MAX_PIXELS ||
    !BIT_DEPTHS.has(bpp) ||
    (compression !== BI_RGB && !(compression === BI_BITFIELDS && (bpp === 16 || bpp === 32)))
  ) {
    return null;
  }

  const dataOffset = u32(bytes, 10);
  const rowBytes = Math.floor((width * bpp + 31) / 32) * 4;
  if (dataOffset + rowBytes * height > bytes.length) {
    return null;
  }

  const palette = new Uint8Array(1024);
  if (bpp <= 8) {
    const used = u32(bytes, 46);
    const entries = used === 0 ? 1 << bpp : Math.min(used, 1 << bpp);
    const start = 14 + headerSize;
    palette.set(bytes.subarray(start, start + entries * 4));
  }

  let redMask = bpp === 16 ? 0x7c00 : 0x00ff0000;
  let greenMask = bpp === 16 ? 0x03e0 : 0x0000ff00;
  let blueMask = bpp === 16 ? 0x001f : 0x000000ff;
  let alphaMask = 0;
  if (compression === BI_BITFIELDS) {
    redMask = u32(bytes, 54);
    greenMask = u32(bytes, 58);
    blueMask = u32(bytes, 62);
    alphaMask = headerSize >= 108 ? u32(bytes, 66) : 0;
  }
  const red = channel(redMask, 0);
  const green = channel(greenMask, 0);
  const blue = channel(blueMask, 0);
  const alpha = channel(alphaMask, 255);

  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const y = signedHeight < 0 ? row : height - 1 - row;
    const rowStart = dataOffset + row * rowBytes;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bpp <= 8) {
        const bit = x * bpp;
        const index = (bytes[rowStart + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        rgba[out] = palette[index * 4 + 2]!;
        rgba[out + 1] = palette[index * 4 + 1]!;
        rgba[out + 2] = palette[index * 4]!;
        rgba[out + 3] = 255;
      } else if (bpp === 24) {
        const at = rowStart + x * 3;
        rgba[out] = bytes[at + 2]!;
        rgba[out + 1] = bytes[at + 1]!;
        rgba[out + 2] = bytes[at]!;
        rgba[out + 3] = 255;
      } else {
        const pixel = bpp === 16 ? u16(bytes, rowStart + x * 2) : u32(bytes, rowStart + x * 4);
        rgba[out] = red(pixel);
        rgba[out + 1] = green(pixel);
        rgba[out + 2] = blue(pixel);
        rgba[out + 3] = alpha(pixel);
      }
    }
  }
  return { width, height, rgba };
}
