import { baseName } from './names'

export type PathPlatform = 'windows' | 'mac' | 'linux'

export type PathOptions = { platform: PathPlatform; home: string | undefined }

export type PathMatch = { start: number; end: number; raw: string; path: string }

export const IMAGE_EXTENSIONS: readonly string[] = [
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'bmp', 'dib', 'webp', 'tif', 'tiff',
  'heic', 'heif', 'avif', 'svg', 'svgz', 'ico', 'icns', 'psd', 'tga', 'qoi',
  'ppm', 'pgm', 'pbm', 'pnm', 'pam', 'hdr', 'exr', 'jp2', 'j2k', 'jxl',
  'dng', 'raw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2',
  'raf', 'pef', 'srw', 'x3f', 'erf', 'kdc', 'dcr', 'mrw', '3fr', 'mos',
]

const EXTENSION_SET = new Set(IMAGE_EXTENSIONS)
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const FILE_URL = /^file:\/\//i
const WHITESPACE = /\s/

type Token = { value: string; end: number; next: number }

export function isImagePath(path: string): boolean {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 && EXTENSION_SET.has(name.slice(dot + 1).toLowerCase())
}

function skipToWhitespace(text: string, from: number): number {
  let index = from
  while (index < text.length && !WHITESPACE.test(text.charAt(index))) index++
  return index
}

function readToken(text: string, start: number, platform: PathPlatform): Token {
  const body = text.charAt(start) === '@' ? start + 1 : start
  const quote = text.charAt(body)
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, body + 1)
    if (close !== -1) {
      return { value: text.slice(body + 1, close), end: close + 1, next: skipToWhitespace(text, close + 1) }
    }
  }
  const escapes =
    platform !== 'windows' && !WINDOWS_DRIVE.test(text.slice(body, body + 3)) && !text.startsWith('\\\\', body)
  let value = ''
  let index = body
  while (index < text.length) {
    const char = text.charAt(index)
    if (escapes && char === '\\' && index + 1 < text.length) {
      value += text.charAt(index + 1)
      index += 2
      continue
    }
    if (WHITESPACE.test(char)) break
    value += char
    index++
  }
  return { value, end: index, next: index }
}

function fileUrlPath(url: string): string | null {
  const rest = url.slice(7)
  const slash = rest.indexOf('/')
  if (slash === -1) return null
  const host = rest.slice(0, slash)
  if (host !== '' && host.toLowerCase() !== 'localhost') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rest.slice(slash))
  } catch {
    return null
  }
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
}

function resolvePath(value: string, options: PathOptions): string | null {
  if (FILE_URL.test(value)) return fileUrlPath(value)
  if (value.startsWith('~/')) {
    if (options.home === undefined) return null
    const separator = options.platform === 'windows' ? '\\' : '/'
    return options.home.replace(/[\\/]+$/, '') + separator + value.slice(2)
  }
  return value
}

export function findImagePaths(text: string, options: PathOptions): PathMatch[] {
  const matches: PathMatch[] = []
  let index = 0
  while (index < text.length) {
    if (WHITESPACE.test(text.charAt(index))) {
      index++
      continue
    }
    const token = readToken(text, index, options.platform)
    const path = resolvePath(token.value, options)
    if (path !== null && isImagePath(path)) {
      matches.push({ start: index, end: token.end, raw: text.slice(index, token.end), path })
    }
    index = token.next
  }
  return matches
}
