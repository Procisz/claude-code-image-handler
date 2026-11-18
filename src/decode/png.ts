import { inflate } from './inflate';
import { MAX_PIXELS, type RawImage } from './types';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const TRNS = 0x74524e53;
const IDAT = 0x49444154;
const IEND = 0x49454e44;

const CHANNELS = [1, 0, 3, 1, 2, 0, 4];
const VALID_COMBINATIONS = new Set([1, 2, 4, 8, 16, 208, 216, 301, 302, 304, 308, 408, 416, 608, 616]);

const PASSES = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
];
const SINGLE_PASS = [{ x: 0, y: 0, dx: 1, dy: 1 }];

type Header = { width: number; height: number; depth: number; colorType: number; interlace: number };

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const readHeader = (bytes: Uint8Array): Header | null => {
  if (
    bytes.length < 33 ||
    !SIGNATURE.every((value, index) => bytes[index] === value) ||
    u32(bytes, 8) !== 13 ||
    u32(bytes, 12) !== IHDR
  ) {
    return null;
  }
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height, depth: bytes[24]!, colorType: bytes[25]!, interlace: bytes[28]! };
};

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const header = readHeader(bytes);
  return header === null ? null : { width: header.width, height: header.height };
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
};

const unfilter = (filter: number, row: Uint8Array, previous: Uint8Array, step: number): void => {
  for (let i = 0; i < row.length; i++) {
    const left = i >= step ? row[i - step]! : 0;
    const up = previous[i]!;
    const upLeft = i >= step ? previous[i - step]! : 0;
    if (filter === 1) {
      row[i] = row[i]! + left;
    } else if (filter === 2) {
      row[i] = row[i]! + up;
    } else if (filter === 3) {
      row[i] = row[i]! + ((left + up) >> 1);
    } else if (filter === 4) {
      row[i] = row[i]! + paeth(left, up, upLeft);
    }
  }
};

export function decodePng(bytes: Uint8Array): RawImage | null {
  const header = readHeader(bytes);
  if (header === null) {
    return null;
  }
  const { width, height, depth, colorType, interlace } = header;
  if (
    width * height > MAX_PIXELS ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    interlace > 1 ||
    !VALID_COMBINATIONS.has(colorType * 100 + depth)
  ) {
    return null;
  }

  const palette = new Uint8Array(768);
  const paletteAlpha = new Uint8Array(256).fill(255);
  let hasPalette = false;
  let transparency: Uint8Array | null = null;
  const parts: Uint8Array[] = [];
  let pos = 33;
  while (pos + 8 <= bytes.length) {
    const length = u32(bytes, pos);
    const type = u32(bytes, pos + 4);
    const start = pos + 8;
    const end = start + length;
    if (end > bytes.length) {
      break;
    }
    const data = bytes.subarray(start, end);
    if (type === IEND) {
      break;
    }
    if (type === PLTE) {
      palette.set(data.subarray(0, 768));
      hasPalette = true;
    } else if (type === TRNS) {
      transparency = data;
      paletteAlpha.set(data.subarray(0, 256));
    } else if (type === IDAT) {
      parts.push(data);
    }
    pos = end + 4;
  }
  if (colorType === 3 && !hasPalette) {
    return null;
  }

  const channels = CHANNELS[colorType]!;
  const bitsPerPixel = channels * depth;
  const step = (bitsPerPixel + 7) >> 3;
  const passes = interlace === 1 ? PASSES : SINGLE_PASS;
  const layouts = passes.map((pass) => {
    const passWidth = Math.floor((width - pass.x + pass.dx - 1) / pass.dx);
    const passHeight = Math.floor((height - pass.y + pass.dy - 1) / pass.dy);
    return { pass, passWidth, passHeight, rowBytes: (passWidth * bitsPerPixel + 7) >> 3 };
  });
  const expected = layouts.reduce(
    (sum, layout) =>
      layout.passWidth === 0 || layout.passHeight === 0
        ? sum
        : sum + layout.passHeight * (layout.rowBytes + 1),
    0,
  );

  const compressed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    compressed.set(part, offset);
    offset += part.length;
  }
  const raw = inflate(compressed, expected);
  if (raw === null || raw.length < expected) {
    return null;
  }

  const maxValue = (1 << depth) - 1;
  const shift = depth === 16 ? 8 : 0;
  const multiplier = depth === 16 ? 1 : 255 / maxValue;
  const scale = (sample: number): number => (sample * multiplier) >> shift;
  const sampleAt = (row: Uint8Array, index: number): number => {
    if (depth === 8) {
      return row[index]!;
    }
    if (depth === 16) {
      return (row[index * 2]! << 8) | row[index * 2 + 1]!;
    }
    const bit = index * depth;
    return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & maxValue;
  };
  const key = (index: number): number => (transparency![index * 2]! << 8) | transparency![index * 2 + 1]!;

  const rgba = new Uint8Array(width * height * 4);
  let cursor = 0;
  for (const { pass, passWidth, passHeight, rowBytes } of layouts) {
    if (passWidth === 0 || passHeight === 0) {
      continue;
    }
    let previous: Uint8Array = new Uint8Array(rowBytes);
    for (let row = 0; row < passHeight; row++) {
      const filter = raw[cursor]!;
      const line = raw.subarray(cursor + 1, cursor + 1 + rowBytes);
      cursor += rowBytes + 1;
      if (filter > 4) {
        return null;
      }
      unfilter(filter, line, previous, step);
      previous = line;
      const y = pass.y + row * pass.dy;
      for (let column = 0; column < passWidth; column++) {
        const out = (y * width + pass.x + column * pass.dx) * 4;
        const base = column * channels;
        let red: number;
        let green: number;
        let blue: number;
        let alpha: number;
        if (colorType === 0) {
          const gray = sampleAt(line, base);
          red = green = blue = scale(gray);
          alpha = transparency !== null && gray === key(0) ? 0 : 255;
        } else if (colorType === 2) {
          const r = sampleAt(line, base);
          const g = sampleAt(line, base + 1);
          const b = sampleAt(line, base + 2);
          red = scale(r);
          green = scale(g);
          blue = scale(b);
          alpha = transparency !== null && r === key(0) && g === key(1) && b === key(2) ? 0 : 255;
        } else if (colorType === 3) {
          const index = sampleAt(line, base);
          red = palette[index * 3]!;
          green = palette[index * 3 + 1]!;
          blue = palette[index * 3 + 2]!;
          alpha = paletteAlpha[index]!;
        } else if (colorType === 4) {
          red = green = blue = scale(sampleAt(line, base));
          alpha = scale(sampleAt(line, base + 1));
        } else {
          red = scale(sampleAt(line, base));
          green = scale(sampleAt(line, base + 1));
          blue = scale(sampleAt(line, base + 2));
          alpha = scale(sampleAt(line, base + 3));
        }
        rgba[out] = red;
        rgba[out + 1] = green;
        rgba[out + 2] = blue;
        rgba[out + 3] = alpha;
      }
    }
  }
  return { width, height, rgba };
}
