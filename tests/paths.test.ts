import { describe, expect, it } from 'vitest'
import { IMAGE_EXTENSIONS, findImagePaths, isImagePath } from '../src/paths'

const mac = { platform: 'mac', home: '/Users/me' } as const
const linux = { platform: 'linux', home: '/home/me' } as const
const windows = { platform: 'windows', home: 'C:\\Users\\me' } as const

function pathsOf(text: string, options: Parameters<typeof findImagePaths>[1] = mac): string[] {
  return findImagePaths(text, options).map((match) => match.path)
}

describe('isImagePath', () => {
  it.for(IMAGE_EXTENSIONS)('accepts the %s extension', (extension) => {
    expect(isImagePath(`/tmp/file.${extension}`)).toBe(true)
  })

  it('is case insensitive', () => {
    expect(isImagePath('/tmp/PHOTO.JPG')).toBe(true)
    expect(isImagePath('C:\\pics\\Scan.TiFf')).toBe(true)
  })

  it('rejects a non-image extension', () => {
    expect(isImagePath('/tmp/notes.txt')).toBe(false)
  })

  it('rejects a name without an extension', () => {
    expect(isImagePath('/tmp/png')).toBe(false)
  })

  it('rejects a dot file named like an extension', () => {
    expect(isImagePath('/tmp/.png')).toBe(false)
  })

  it('looks only at the last segment', () => {
    expect(isImagePath('/tmp/photo.png/readme')).toBe(false)
  })
})

describe('findImagePaths', () => {
  it('finds nothing in an empty draft', () => {
    expect(findImagePaths('', mac)).toEqual([])
  })

  it('finds a posix absolute path with its span', () => {
    expect(findImagePaths('look /tmp/a.png now', mac)).toEqual([
      { start: 5, end: 15, raw: '/tmp/a.png', path: '/tmp/a.png' },
    ])
  })

  it('finds a path at the start of the text', () => {
    expect(findImagePaths('/tmp/a.png', mac)).toEqual([{ start: 0, end: 10, raw: '/tmp/a.png', path: '/tmp/a.png' }])
  })

  it('ignores a non-image path', () => {
    expect(pathsOf('see /tmp/notes.txt')).toEqual([])
  })

  it('reads text glued to a path as one bare relative token', () => {
    expect(pathsOf('x=/tmp/a.png')).toEqual(['x=/tmp/a.png'])
  })

  it('treats a leading @ as part of the token', () => {
    expect(findImagePaths('check @/tmp/a.png please', mac)).toEqual([
      { start: 6, end: 17, raw: '@/tmp/a.png', path: '/tmp/a.png' },
    ])
  })

  it('finds a double quoted path with spaces', () => {
    expect(findImagePaths('see "/tmp/my pics/a b.png" ok', mac)).toEqual([
      { start: 4, end: 26, raw: '"/tmp/my pics/a b.png"', path: '/tmp/my pics/a b.png' },
    ])
  })

  it('finds a single quoted path with spaces', () => {
    expect(pathsOf("see '/tmp/my pics/a b.png' ok")).toEqual(['/tmp/my pics/a b.png'])
  })

  it('finds a quoted path after @', () => {
    expect(pathsOf('@"/tmp/a b.png"')).toEqual(['/tmp/a b.png'])
  })

  it('does not unescape inside quotes', () => {
    expect(pathsOf('"/tmp/a\\b.png"')).toEqual(['/tmp/a\\b.png'])
  })

  it('keeps an unterminated quote as part of a plain token', () => {
    expect(pathsOf('"/tmp/a.png')).toEqual(['"/tmp/a.png'])
  })

  it('skips text glued after a closing quote up to the next whitespace', () => {
    expect(pathsOf('"/tmp/a.png"extra /tmp/b.png')).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('unescapes backslash spaces on mac', () => {
    expect(findImagePaths('/tmp/a\\ b.png', mac)).toEqual([
      { start: 0, end: 13, raw: '/tmp/a\\ b.png', path: '/tmp/a b.png' },
    ])
  })

  it('unescapes backslash spaces on linux', () => {
    expect(pathsOf('/tmp/my\\ pic.png', linux)).toEqual(['/tmp/my pic.png'])
  })

  it('keeps a trailing lone backslash literal', () => {
    expect(pathsOf('/tmp/a.png\\', mac)).toEqual([])
  })

  it('ends an unquoted token at unescaped whitespace', () => {
    expect(pathsOf('/tmp/a.png /tmp/b.jpg', mac)).toEqual(['/tmp/a.png', '/tmp/b.jpg'])
  })

  it('splits tokens on newlines and tabs', () => {
    expect(pathsOf('/tmp/a.png\n/tmp/b.jpg\t/tmp/c.gif')).toEqual(['/tmp/a.png', '/tmp/b.jpg', '/tmp/c.gif'])
  })

  it('finds many dropped files in one line', () => {
    const text = Array.from({ length: 25 }, (_unused, index) => `/tmp/img${index}.png`).join(' ')
    expect(findImagePaths(text, mac)).toHaveLength(25)
  })

  it('returns the same path twice when it is dropped twice', () => {
    expect(pathsOf('/tmp/a.png /tmp/a.png')).toEqual(['/tmp/a.png', '/tmp/a.png'])
  })

  it('finds relative paths', () => {
    expect(pathsOf('./a.png ../b.png c.png sub/d.png')).toEqual(['./a.png', '../b.png', 'c.png', 'sub/d.png'])
  })

  it('expands a home path on mac', () => {
    expect(pathsOf('~/Pictures/a.png', mac)).toEqual(['/Users/me/Pictures/a.png'])
  })

  it('expands a home path on linux and trims a trailing slash of home', () => {
    expect(pathsOf('~/a.png', { platform: 'linux', home: '/home/me/' })).toEqual(['/home/me/a.png'])
  })

  it('expands a home path on windows with a backslash', () => {
    expect(pathsOf('~/a.png', windows)).toEqual(['C:\\Users\\me\\a.png'])
  })

  it('skips a home path when home is unknown', () => {
    expect(pathsOf('~/a.png /tmp/b.png', { platform: 'mac', home: undefined })).toEqual(['/tmp/b.png'])
  })

  it('decodes a file URL with an empty host', () => {
    expect(pathsOf('file:///tmp/my%20pic.png')).toEqual(['/tmp/my pic.png'])
  })

  it('decodes a file URL with the localhost host in any case', () => {
    expect(pathsOf('file://LocalHost/tmp/a.png')).toEqual(['/tmp/a.png'])
  })

  it('matches the file scheme in any case', () => {
    expect(pathsOf('FILE:///tmp/a.png')).toEqual(['/tmp/a.png'])
  })

  it('refuses a file URL with a remote host', () => {
    expect(pathsOf('file://server/tmp/a.png')).toEqual([])
  })

  it('refuses a file URL without a path', () => {
    expect(pathsOf('file://hostonly.png')).toEqual([])
  })

  it('refuses a file URL with a broken percent escape', () => {
    expect(pathsOf('file:///tmp/%E0%A4%A.png')).toEqual([])
  })

  it('turns a file URL with a drive letter into a windows path', () => {
    expect(pathsOf('file:///C:/Users/me/a.png', windows)).toEqual(['C:/Users/me/a.png'])
  })

  it('finds a quoted file URL', () => {
    expect(pathsOf('"file:///tmp/a%20b.png"')).toEqual(['/tmp/a b.png'])
  })

  it('finds a windows drive path with backslashes on windows', () => {
    expect(findImagePaths('see C:\\Users\\me\\a.png', windows)).toEqual([
      { start: 4, end: 21, raw: 'C:\\Users\\me\\a.png', path: 'C:\\Users\\me\\a.png' },
    ])
  })

  it('finds a windows drive path without unescaping on mac', () => {
    expect(pathsOf('C:\\Users\\me\\a.png', mac)).toEqual(['C:\\Users\\me\\a.png'])
  })

  it('finds a windows drive path with forward slashes', () => {
    expect(pathsOf('C:/Users/me/a.png', linux)).toEqual(['C:/Users/me/a.png'])
  })

  it('finds a UNC path without unescaping on linux', () => {
    expect(pathsOf('\\\\server\\share\\a.png', linux)).toEqual(['\\\\server\\share\\a.png'])
  })

  it('finds a UNC path on windows', () => {
    expect(pathsOf('\\\\server\\share\\a.png', windows)).toEqual(['\\\\server\\share\\a.png'])
  })

  it('does not unescape backslashes at all on windows', () => {
    expect(pathsOf('dir\\a.png', windows)).toEqual(['dir\\a.png'])
  })

  it('finds a quoted windows path with spaces', () => {
    expect(pathsOf('"C:\\My Pictures\\a b.png"', windows)).toEqual(['C:\\My Pictures\\a b.png'])
  })

  it('finds odd image types', () => {
    expect(pathsOf('/a/b.heic /a/c.CR2 /a/d.avif /a/e.svg /a/f.tiff')).toEqual([
      '/a/b.heic',
      '/a/c.CR2',
      '/a/d.avif',
      '/a/e.svg',
      '/a/f.tiff',
    ])
  })
})
