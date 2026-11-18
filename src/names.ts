export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

export function wrapName(name: string, width: number): string[] {
  const chars = Array.from(name)
  const lines: string[] = []
  for (let start = 0; start < chars.length; start += width) {
    lines.push(chars.slice(start, start + width).join(''))
  }
  return lines.length === 0 ? [''] : lines
}
