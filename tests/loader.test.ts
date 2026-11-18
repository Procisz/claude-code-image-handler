import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMissingTools } from '../src/convert'
import { loadThumb } from '../src/loader'
import { createEngine } from './helpers/engine'
import { makePng, makePpm, solidRgba } from './helpers/png'

const pathRef = (path: string) => ({ id: `path:${path}`, kind: 'path' as const, path, spans: [] })
const tagRef = (n: number) => ({ id: `tag:${n}`, kind: 'tag' as const, n, spans: [] })

function outOf(argv: string[]): string {
  return argv.at(-1)?.replace(/^PNG32:/, '') ?? ''
}

beforeEach(() => {
  resetMissingTools()
})

describe('loadThumb for a path reference', () => {
  it('uses the system tool png first and returns its pixels', async () => {
    const png = makePng(2, 2, solidRgba(2, 2, [10, 20, 30, 255]))
    const engine = createEngine({
      files: { '/pics/a.heic': makePpm(1, 1, [1, 2, 3]) },
      run: (argv) => {
        if (argv[0] === 'sips') engine.setFile(outOf(argv), png)
        return {}
      },
    })
    const image = await loadThumb(engine.$ as never, pathRef('/pics/a.heic'), { platform: 'mac', imagesDir: undefined })
    expect(image?.width).toBe(2)
    expect(image?.height).toBe(2)
    expect(Array.from(image?.rgba.subarray(0, 4) ?? [])).toEqual([10, 20, 30, 255])
  })

  it('falls back to the built-in decoder when every tool fails', async () => {
    const engine = createEngine({
      files: { '/pics/a.ppm': makePpm(2, 1, [200, 100, 50]) },
      run: () => ({ exitCode: 1 }),
    })
    const image = await loadThumb(engine.$ as never, pathRef('/pics/a.ppm'), { platform: 'linux', imagesDir: undefined })
    expect(image).toEqual({ width: 2, height: 1, rgba: Uint8Array.from([200, 100, 50, 255, 200, 100, 50, 255]) })
  })

  it('falls back to the built-in decoder when the tool png is corrupt', async () => {
    const engine = createEngine({
      files: { '/pics/a.ppm': makePpm(1, 1, [9, 8, 7]) },
      run: (argv) => {
        if (argv[0] === 'magick') engine.setFile(outOf(argv), Uint8Array.of(1, 2, 3, 4))
        return {}
      },
    })
    const image = await loadThumb(engine.$ as never, pathRef('/pics/a.ppm'), { platform: 'linux', imagesDir: undefined })
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([9, 8, 7, 255]) })
  })

  it('scales a large image down to 320 pixels on the long side', async () => {
    const engine = createEngine({ files: { '/pics/big.ppm': makePpm(200, 100, [5, 5, 5]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, pathRef('/pics/big.ppm'), { platform: 'linux', imagesDir: undefined })
    expect(image?.width).toBe(200)
    expect(image?.height).toBe(100)
  })

  it('returns null when the file is larger than 4 MiB and no tool can read it', async () => {
    const engine = createEngine({
      files: { '/pics/huge.ppm': new Uint8Array(4 * 1024 * 1024 + 1) },
      run: () => ({ exitCode: 1 }),
    })
    expect(await loadThumb(engine.$ as never, pathRef('/pics/huge.ppm'), { platform: 'linux', imagesDir: undefined })).toBeNull()
    expect(engine.$.fs.read).not.toHaveBeenCalled()
  })

  it('reads a file of exactly 4 MiB with the built-in decoders', async () => {
    const header = new TextEncoder().encode('P6\n1 1\n255\n')
    const bytes = new Uint8Array(4 * 1024 * 1024)
    bytes.set(header)
    bytes.set([1, 2, 3], header.length)
    const engine = createEngine({ files: { '/pics/edge.ppm': bytes }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, pathRef('/pics/edge.ppm'), { platform: 'linux', imagesDir: undefined })
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([1, 2, 3, 255]) })
  })

  it('returns null for a format no decoder knows', async () => {
    const engine = createEngine({ files: { '/pics/a.heic': Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112) }, run: () => ({ exitCode: 1 }) })
    expect(await loadThumb(engine.$ as never, pathRef('/pics/a.heic'), { platform: 'linux', imagesDir: undefined })).toBeNull()
  })

  it('returns null when the file cannot be read at all', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    expect(await loadThumb(engine.$ as never, pathRef('/pics/missing.png'), { platform: 'linux', imagesDir: undefined })).toBeNull()
  })
})

describe('loadThumb for a tag reference', () => {
  const dir = '/tmp/claude-501/proj/sess/images'

  it('reads the cached file named after the tag', async () => {
    const engine = createEngine({
      files: { [`${dir}/3.png`]: makePpm(1, 1, [4, 5, 6]), [`${dir}/13.png`]: makePpm(1, 1, [9, 9, 9]) },
      run: () => ({ exitCode: 1 }),
    })
    const image = await loadThumb(engine.$ as never, tagRef(3), { platform: 'mac', imagesDir: dir })
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([4, 5, 6, 255]) })
  })

  it('passes the cached file path to the system tool', async () => {
    const engine = createEngine({ files: { [`${dir}/2.heic`]: Uint8Array.of(1) }, run: () => ({ exitCode: 1 }) })
    await loadThumb(engine.$ as never, tagRef(2), { platform: 'mac', imagesDir: dir })
    expect(engine.calls[0]?.argv[6]).toBe(`${dir}/2.heic`)
  })

  it('ignores a folder named after the tag', async () => {
    const engine = createEngine({ dirs: [`${dir}/3.d`], run: () => ({ exitCode: 1 }) })
    expect(await loadThumb(engine.$ as never, tagRef(3), { platform: 'mac', imagesDir: dir })).toBeNull()
  })

  it('joins with backslashes on windows', async () => {
    const winDir = 'C:\\Temp\\claude\\proj\\sess\\images'
    const engine = createEngine({ files: { [`${winDir}\\1.png`]: makePpm(1, 1, [1, 1, 1]) }, run: () => ({ exitCode: 1 }) })
    await loadThumb(engine.$ as never, tagRef(1), { platform: 'windows', imagesDir: winDir })
    expect(engine.calls[0]?.options?.env).toEqual({ CLAUDE_IMAGE_HANDLER_SOURCE: `${winDir}\\1.png` })
  })

  it('waits in 200 ms steps for a file that appears late', async () => {
    const engine = createEngine({ dirs: [dir], run: () => ({ exitCode: 1 }) })
    let sleeps = 0
    engine.$.clock.sleep.mockImplementation(async (ms: number) => {
      sleeps++
      expect(ms).toBe(200)
      if (sleeps === 3) engine.setFile(`${dir}/5.png`, makePpm(1, 1, [7, 7, 7]))
    })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir })
    expect(sleeps).toBe(3)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([7, 7, 7, 255]) })
  })

  it('gives up after 3 seconds and uses the pasted path', async () => {
    const engine = createEngine({ dirs: [dir], files: { '/pics/orig.ppm': makePpm(1, 1, [3, 3, 3]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir, pastedPath: '/pics/orig.ppm' })
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([3, 3, 3, 255]) })
  })

  it('returns null after 3 seconds without a pasted path', async () => {
    const engine = createEngine({ dirs: [dir], run: () => ({ exitCode: 1 }) })
    expect(await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir })).toBeNull()
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
  })

  it('treats an unreadable images folder as an empty one', async () => {
    const engine = createEngine({ files: { '/pics/orig.ppm': makePpm(1, 1, [3, 3, 3]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir, pastedPath: '/pics/orig.ppm' })
    expect(image?.width).toBe(1)
  })

  it('uses the pasted path at once when the images folder is unknown', async () => {
    const engine = createEngine({ files: { '/pics/orig.ppm': makePpm(1, 1, [3, 3, 3]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: undefined, pastedPath: '/pics/orig.ppm' })
    expect(image?.width).toBe(1)
    expect(engine.$.clock.sleep).not.toHaveBeenCalled()
  })

  it('returns null when the images folder and the pasted path are both unknown', async () => {
    const engine = createEngine()
    expect(await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: undefined })).toBeNull()
    expect(engine.calls).toEqual([])
  })

  it('asks for the images folder again in each round until it appears', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    const locateImagesDir = vi.fn(async () => (locateImagesDir.mock.calls.length < 3 ? undefined : dir))
    engine.$.clock.sleep.mockImplementation(async () => {
      if (engine.$.clock.sleep.mock.calls.length === 3) engine.setFile(`${dir}/5.png`, makePpm(1, 1, [7, 7, 7]))
    })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: undefined, locateImagesDir })
    expect(locateImagesDir).toHaveBeenCalledTimes(3)
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(3)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([7, 7, 7, 255]) })
  })

  it('reads the cached file at once when the images folder is located at once', async () => {
    const engine = createEngine({ files: { [`${dir}/5.png`]: makePpm(1, 1, [6, 6, 6]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, tagRef(5), {
      platform: 'mac',
      imagesDir: undefined,
      locateImagesDir: async () => dir,
    })
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([6, 6, 6, 255]) })
    expect(engine.$.clock.sleep).not.toHaveBeenCalled()
  })

  it('does not look for the images folder when one is given', async () => {
    const engine = createEngine({ files: { [`${dir}/5.png`]: makePpm(1, 1, [6, 6, 6]) }, run: () => ({ exitCode: 1 }) })
    const locateImagesDir = vi.fn(async () => '/elsewhere')
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir, locateImagesDir })
    expect(locateImagesDir).not.toHaveBeenCalled()
    expect(image?.width).toBe(1)
  })

  it('returns null after 3 seconds when the images folder never appears', async () => {
    const engine = createEngine({ run: () => ({ exitCode: 1 }) })
    const locateImagesDir = vi.fn(async () => undefined)
    expect(await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: undefined, locateImagesDir })).toBeNull()
    expect(locateImagesDir).toHaveBeenCalledTimes(16)
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
  })

  it('uses the pasted path after 3 seconds when the images folder never appears', async () => {
    const engine = createEngine({ files: { '/pics/orig.ppm': makePpm(1, 1, [3, 3, 3]) }, run: () => ({ exitCode: 1 }) })
    const image = await loadThumb(engine.$ as never, tagRef(5), {
      platform: 'mac',
      imagesDir: undefined,
      pastedPath: '/pics/orig.ppm',
      locateImagesDir: async () => undefined,
    })
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([3, 3, 3, 255]) })
  })

  it('keeps polling while the cached file is not readable yet and loads it once it is', async () => {
    const engine = createEngine({ files: { [`${dir}/5.png`]: Uint8Array.of(1, 2, 3, 4) }, run: () => ({ exitCode: 1 }) })
    engine.$.clock.sleep.mockImplementation(async () => {
      if (engine.$.clock.sleep.mock.calls.length === 2) engine.setFile(`${dir}/5.png`, makePpm(1, 1, [8, 8, 8]))
    })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir })
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(2)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([8, 8, 8, 255]) })
  })

  it('returns null when the cached file stays unreadable for 3 seconds', async () => {
    const engine = createEngine({ files: { [`${dir}/5.png`]: Uint8Array.of(1, 2, 3, 4) }, run: () => ({ exitCode: 1 }) })
    expect(await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir })).toBeNull()
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
  })

  it('uses the pasted path when the cached file stays unreadable for 3 seconds', async () => {
    const engine = createEngine({
      files: { [`${dir}/5.png`]: Uint8Array.of(1, 2, 3, 4), '/pics/orig.ppm': makePpm(1, 1, [3, 3, 3]) },
      run: () => ({ exitCode: 1 }),
    })
    const image = await loadThumb(engine.$ as never, tagRef(5), { platform: 'mac', imagesDir: dir, pastedPath: '/pics/orig.ppm' })
    expect(engine.$.clock.sleep).toHaveBeenCalledTimes(15)
    expect(image).toEqual({ width: 1, height: 1, rgba: Uint8Array.from([3, 3, 3, 255]) })
  })
})
