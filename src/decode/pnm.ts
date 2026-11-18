import { MAX_PIXELS, type RawImage } from './types';

const isSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);

export function decodePnm(bytes: Uint8Array): RawImage | null {
  if (bytes.length < 3 || bytes[0] !== 0x50) {
    return null;
  }
  const kind = bytes[1]! - 0x30;
  if (kind < 1 || kind > 6) {
    return null;
  }
  let pos = 2;

  const skip = (): void => {
    while (pos < bytes.length) {
      const code = bytes[pos]!;
      if (code === 35) {
        while (pos < bytes.length && bytes[pos] !== 10 && bytes[pos] !== 13) {
          pos++;
        }
      } else if (isSpace(code)) {
        pos++;
      } else {
        return;
      }
    }
  };

  const number = (): number | null => {
    skip();
    const start = pos;
    while (pos < bytes.length && !isSpace(bytes[pos]!)) {
      pos++;
    }
    const text = String.fromCharCode(...bytes.subarray(start, Math.min(pos, start + 10)));
    return /^[0-9]{1,9}$/.test(text) ? Number(text) : null;
  };

  const width = number();
  const height = number();
  if (width === null || height === null || width === 0 || height === 0 || width * height > MAX_PIXELS) {
    return null;
  }
  const bitmap = kind === 1 || kind === 4;
  const maxValue = bitmap ? 1 : number();
  if (maxValue === null || maxValue === 0 || maxValue > 65535) {
    return null;
  }

  const binary = kind >= 4;
  const wide = maxValue > 255;
  const channels = kind === 3 || kind === 6 ? 3 : 1;
  if (binary) {
    pos++;
    const needed = kind === 4 ? Math.ceil(width / 8) * height : width * height * channels * (wide ? 2 : 1);
    if (pos + needed > bytes.length) {
      return null;
    }
  }

  const sample = (): number | null => {
    if (!binary) {
      return number();
    }
    if (wide) {
      const value = (bytes[pos]! << 8) | bytes[pos + 1]!;
      pos += 2;
      return value;
    }
    return bytes[pos++]!;
  };
  const scale = (value: number): number => Math.min(255, Math.round((value * 255) / maxValue));

  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = pos;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      let red: number;
      let green: number;
      let blue: number;
      if (kind === 4) {
        const black = (bytes[rowStart + (x >> 3)]! >> (7 - (x & 7))) & 1;
        red = green = blue = black === 1 ? 0 : 255;
      } else if (kind === 1) {
        skip();
        const char = bytes[pos++];
        if (char !== 0x30 && char !== 0x31) {
          return null;
        }
        red = green = blue = char === 0x31 ? 0 : 255;
      } else if (channels === 1) {
        const value = sample();
        if (value === null) {
          return null;
        }
        red = green = blue = scale(value);
      } else {
        const r = sample();
        const g = sample();
        const b = sample();
        if (r === null || g === null || b === null) {
          return null;
        }
        red = scale(r);
        green = scale(g);
        blue = scale(b);
      }
      rgba[out] = red;
      rgba[out + 1] = green;
      rgba[out + 2] = blue;
      rgba[out + 3] = 255;
    }
    if (kind === 4) {
      pos = rowStart + rowBytes;
    }
  }
  return { width, height, rgba };
}
