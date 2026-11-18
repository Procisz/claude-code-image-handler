import type { RawImage } from './types';

export type Span = { index: number; weight: number };

export function spanCoverage(index: number, count: number, length: number): Span[] {
  const start = (index * length) / count;
  const end = ((index + 1) * length) / count;
  const spans: Span[] = [];
  for (let source = Math.floor(start); source < Math.ceil(end); source++) {
    spans.push({ index: source, weight: Math.min(end, source + 1) - Math.max(start, source) });
  }
  return spans;
}

export function fitWithin(image: RawImage, maxSide: number): RawImage {
  const { width, height, rgba } = image;
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return image;
  }
  const scale = maxSide / longest;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(newWidth * newHeight * 4);
  const area = (width / newWidth) * (height / newHeight);
  const columns = Array.from({ length: newWidth }, (_unused, dx) => spanCoverage(dx, newWidth, width));
  for (let dy = 0; dy < newHeight; dy++) {
    const rows = spanCoverage(dy, newHeight, height);
    for (let dx = 0; dx < newWidth; dx++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (const { index: y, weight: rowWeight } of rows) {
        for (const { index: x, weight: columnWeight } of columns[dx]!) {
          const at = (y * width + x) * 4;
          const weighted = rgba[at + 3]! * rowWeight * columnWeight;
          red += rgba[at]! * weighted;
          green += rgba[at + 1]! * weighted;
          blue += rgba[at + 2]! * weighted;
          alpha += weighted;
        }
      }
      const to = (dy * newWidth + dx) * 4;
      if (alpha > 0) {
        out[to] = Math.round(red / alpha);
        out[to + 1] = Math.round(green / alpha);
        out[to + 2] = Math.round(blue / alpha);
        out[to + 3] = Math.round(alpha / area);
      }
    }
  }
  return { width: newWidth, height: newHeight, rgba: out };
}
