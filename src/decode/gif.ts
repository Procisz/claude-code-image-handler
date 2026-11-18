import { MAX_PIXELS, type RawImage } from './types';

const INTERLACE_PASSES = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
] as const;

const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

const readSubBlocks = (bytes: Uint8Array, start: number): { data: Uint8Array; end: number } | null => {
  const chunks: Uint8Array[] = [];
  let pos = start;
  for (;;) {
    const size = bytes[pos];
    if (size === undefined) {
      return null;
    }
    pos++;
    if (size === 0) {
      break;
    }
    if (pos + size > bytes.length) {
      return null;
    }
    chunks.push(bytes.subarray(pos, pos + size));
    pos += size;
  }
  const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return { data, end: pos };
};

const readColors = (bytes: Uint8Array, start: number, count: number): Uint8Array => {
  const table = new Uint8Array(768);
  table.set(bytes.subarray(start, start + count * 3));
  return table;
};

const lzw = (data: Uint8Array, minCodeSize: number, total: number): Uint8Array | null => {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  const indices = new Uint8Array(total);
  let size = minCodeSize + 1;
  let next = end + 1;
  let previous = -1;
  let first = 0;
  let written = 0;
  let pos = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  while (written < total) {
    while (bitCount < size) {
      if (pos >= data.length) {
        return null;
      }
      bitBuffer |= data[pos++]! << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << size) - 1);
    bitBuffer >>>= size;
    bitCount -= size;
    if (code === clear) {
      size = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end || (code >= next && (code > next || previous < 0))) {
      return null;
    }
    let sp = 0;
    let current = code;
    if (code === next) {
      stack[sp++] = first;
      current = previous;
    }
    while (current >= clear) {
      stack[sp++] = suffix[current]!;
      current = prefix[current]!;
    }
    stack[sp++] = current;
    first = current;
    while (sp > 0 && written < total) {
      indices[written++] = stack[--sp]!;
    }
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = first;
      next++;
      size = Math.min(12, 32 - Math.clz32(next));
    }
    previous = code;
  }
  return indices;
};

export function decodeGif(bytes: Uint8Array): RawImage | null {
  if (
    bytes.length < 13 ||
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  ) {
    return null;
  }
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
    return null;
  }
  const screenFlags = bytes[10]!;
  let pos = 13;
  let globalColors: Uint8Array | null = null;
  if ((screenFlags & 0x80) !== 0) {
    const count = 2 << (screenFlags & 7);
    globalColors = readColors(bytes, pos, count);
    pos += count * 3;
  }

  let transparent = -1;
  for (;;) {
    const marker = bytes[pos];
    if (marker === 0x21) {
      if (bytes[pos + 1] === 0xf9) {
        transparent = (bytes[pos + 3]! & 1) !== 0 ? bytes[pos + 6]! : -1;
      }
      const skipped = readSubBlocks(bytes, pos + 2);
      if (skipped === null) {
        return null;
      }
      pos = skipped.end;
    } else if (marker === 0x2c) {
      pos++;
      break;
    } else {
      return null;
    }
  }

  const left = u16(bytes, pos);
  const top = u16(bytes, pos + 2);
  const frameWidth = u16(bytes, pos + 4);
  const frameHeight = u16(bytes, pos + 6);
  const frameFlags = bytes[pos + 8]!;
  pos += 9;
  if (frameWidth === 0 || frameHeight === 0 || frameWidth * frameHeight > MAX_PIXELS) {
    return null;
  }
  let colors = globalColors;
  if ((frameFlags & 0x80) !== 0) {
    const count = 2 << (frameFlags & 7);
    colors = readColors(bytes, pos, count);
    pos += count * 3;
  }
  const minCodeSize = bytes[pos++]!;
  if (colors === null || minCodeSize < 2 || minCodeSize > 8) {
    return null;
  }
  const blocks = readSubBlocks(bytes, pos);
  if (blocks === null) {
    return null;
  }
  const indices = lzw(blocks.data, minCodeSize, frameWidth * frameHeight);
  if (indices === null) {
    return null;
  }

  const order: number[] = [];
  if ((frameFlags & 0x40) !== 0) {
    for (const [start, step] of INTERLACE_PASSES) {
      for (let y = start; y < frameHeight; y += step) {
        order.push(y);
      }
    }
  } else {
    for (let y = 0; y < frameHeight; y++) {
      order.push(y);
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < frameHeight; row++) {
    const y = top + order[row]!;
    for (let column = 0; column < frameWidth; column++) {
      const x = left + column;
      const index = indices[row * frameWidth + column]!;
      if (x < width && y < height && index !== transparent) {
        const out = (y * width + x) * 4;
        rgba[out] = colors[index * 3]!;
        rgba[out + 1] = colors[index * 3 + 1]!;
        rgba[out + 2] = colors[index * 3 + 2]!;
        rgba[out + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}
