import { findImagePaths, type PathOptions } from './paths'

export type Span = { start: number; end: number }

export type DraftRef =
  | { id: string; kind: 'tag'; n: number; spans: Span[] }
  | { id: string; kind: 'path'; path: string; spans: Span[] }

const TAG = /\[Image #(\d+)\]/g

type Found = { span: Span; ref: DraftRef }

export function parseDraft(text: string, options: PathOptions): DraftRef[] {
  const found: Found[] = []
  for (const match of text.matchAll(TAG)) {
    const n = Number.parseInt(match[1] as string, 10)
    const start = match.index
    found.push({ span: { start, end: start + match[0].length }, ref: { id: `tag:${n}`, kind: 'tag', n, spans: [] } })
  }
  for (const match of findImagePaths(text, options)) {
    found.push({
      span: { start: match.start, end: match.end },
      ref: { id: `path:${match.path}`, kind: 'path', path: match.path, spans: [] },
    })
  }
  found.sort((a, b) => a.span.start - b.span.start)
  const refs = new Map<string, DraftRef>()
  for (const { span, ref } of found) {
    const existing = refs.get(ref.id) ?? ref
    existing.spans.push(span)
    refs.set(ref.id, existing)
  }
  return [...refs.values()]
}

function removalRange(text: string, span: Span): Span {
  const spaceBefore = span.start > 0 && text.charAt(span.start - 1) === ' '
  const spaceAfter = text.charAt(span.end) === ' '
  if (spaceBefore && (span.end === text.length || spaceAfter)) return { start: span.start - 1, end: span.end }
  if (spaceAfter) return { start: span.start, end: span.end + 1 }
  return span
}

export function removeRef(text: string, cursor: number, ref: DraftRef): { text: string; cursor: number } {
  const ranges = ref.spans.map((span) => removalRange(text, span)).sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  let position = cursor
  let removed = 0
  let result = ''
  let from = 0
  for (const range of merged) {
    result += text.slice(from, range.start)
    from = range.end
    if (range.end <= cursor) removed += range.end - range.start
    else if (range.start < cursor) position = range.start
  }
  result += text.slice(from)
  return { text: result, cursor: position - removed }
}
