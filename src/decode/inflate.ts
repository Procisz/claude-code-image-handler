type Huffman = { counts: Uint16Array; symbols: Uint16Array };

const MAX_OUTPUT = 1 << 30;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const fail = (): Error => new Error('Malformed deflate stream');

const buildHuffman = (lengths: ArrayLike<number>): Huffman => {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) {
    counts[lengths[i]!]!++;
  }
  const offsets = new Uint16Array(17);
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len]!;
    if (left < 0) {
      throw fail();
    }
    offsets[len + 1] = offsets[len]! + counts[len]!;
  }
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (len !== 0) {
      symbols[offsets[len]!++] = i;
    }
  }
  return { counts, symbols };
};

const fixedLiteralLengths = new Uint8Array(288);
fixedLiteralLengths.fill(8, 0, 144);
fixedLiteralLengths.fill(9, 144, 256);
fixedLiteralLengths.fill(7, 256, 280);
fixedLiteralLengths.fill(8, 280, 288);
const FIXED_LITERALS = buildHuffman(fixedLiteralLengths);
const FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5));

const run = (zlib: Uint8Array, maxLength: number): Uint8Array => {
  if (zlib.length < 2 || (zlib[0]! & 15) !== 8 || ((zlib[0]! << 8) | zlib[1]!) % 31 !== 0 || (zlib[1]! & 32) !== 0) {
    throw fail();
  }
  let pos = 2;
  let bitBuffer = 0;
  let bitCount = 0;
  let out = new Uint8Array(Math.min(maxLength, Math.max(1024, zlib.length * 4)));
  let outLength = 0;

  const bits = (count: number): number => {
    while (bitCount < count) {
      if (pos >= zlib.length) {
        throw fail();
      }
      bitBuffer |= zlib[pos++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  };

  const reserve = (extra: number): void => {
    const needed = outLength + extra;
    if (needed > maxLength) {
      throw fail();
    }
    if (needed > out.length) {
      const grown = new Uint8Array(Math.min(maxLength, Math.max(out.length * 2, needed)));
      grown.set(out.subarray(0, outLength));
      out = grown;
    }
  };

  const decodeSymbol = (huffman: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = huffman.counts[len]!;
      if (code - count < first) {
        return huffman.symbols[index + (code - first)]!;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw fail();
  };

  const inflateCodes = (literals: Huffman, distances: Huffman): void => {
    for (;;) {
      const symbol = decodeSymbol(literals);
      if (symbol < 256) {
        reserve(1);
        out[outLength++] = symbol;
      } else if (symbol === 256) {
        return;
      } else {
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) {
          throw fail();
        }
        const length = LENGTH_BASE[lengthIndex]! + bits(LENGTH_EXTRA[lengthIndex]!);
        const distanceIndex = decodeSymbol(distances);
        const distance = DISTANCE_BASE[distanceIndex]! + bits(DISTANCE_EXTRA[distanceIndex]!);
        if (distance > outLength) {
          throw fail();
        }
        reserve(length);
        for (let i = 0; i < length; i++) {
          out[outLength] = out[outLength - distance]!;
          outLength++;
        }
      }
    }
  };

  const inflateStored = (): void => {
    bitBuffer = 0;
    bitCount = 0;
    if (pos + 4 > zlib.length) {
      throw fail();
    }
    const length = zlib[pos]! | (zlib[pos + 1]! << 8);
    const inverse = zlib[pos + 2]! | (zlib[pos + 3]! << 8);
    pos += 4;
    if ((length ^ inverse) !== 0xffff || pos + length > zlib.length) {
      throw fail();
    }
    reserve(length);
    out.set(zlib.subarray(pos, pos + length), outLength);
    outLength += length;
    pos += length;
  };

  const inflateDynamic = (): void => {
    const literalCount = bits(5) + 257;
    const distanceCount = bits(5) + 1;
    const codeLengthCount = bits(4) + 4;
    if (literalCount > 286 || distanceCount > 30) {
      throw fail();
    }
    const codeLengthLengths = new Uint8Array(19);
    for (let i = 0; i < codeLengthCount; i++) {
      codeLengthLengths[CODE_LENGTH_ORDER[i]!] = bits(3);
    }
    const codeLengths = buildHuffman(codeLengthLengths);
    const total = literalCount + distanceCount;
    const lengths = new Uint8Array(total);
    let index = 0;
    while (index < total) {
      const symbol = decodeSymbol(codeLengths);
      if (symbol < 16) {
        lengths[index++] = symbol;
      } else {
        let value = 0;
        let repeat: number;
        if (symbol === 16) {
          if (index === 0) {
            throw fail();
          }
          value = lengths[index - 1]!;
          repeat = 3 + bits(2);
        } else if (symbol === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (index + repeat > total) {
          throw fail();
        }
        lengths.fill(value, index, index + repeat);
        index += repeat;
      }
    }
    inflateCodes(buildHuffman(lengths.subarray(0, literalCount)), buildHuffman(lengths.subarray(literalCount)));
  };

  let last: boolean;
  do {
    last = bits(1) === 1;
    const type = bits(2);
    if (type === 0) {
      inflateStored();
    } else if (type === 1) {
      inflateCodes(FIXED_LITERALS, FIXED_DISTANCES);
    } else if (type === 2) {
      inflateDynamic();
    } else {
      throw fail();
    }
  } while (!last);
  return out.slice(0, outLength);
};

export function inflate(zlib: Uint8Array, maxLength: number = MAX_OUTPUT): Uint8Array | null {
  try {
    return run(zlib, maxLength);
  } catch {
    return null;
  }
}
