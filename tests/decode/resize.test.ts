import { describe, expect, it } from 'vitest'
import { fitWithin } from '../../src/decode/resize'
import type { RawImage } from '../../src/decode/types'
import { pixelAt, solid } from './support/fixtures'

const fromPixels = (width: number, height: number, pixels: number[][]): RawImage => ({
  width,
  height,
  rgba: Uint8Array.from(pixels.flat()),
})

describe('fitWithin', () => {
  it('returns the very same image when it is already within the limit', () => {
    const image = solid(4, 3, [1, 2, 3, 4])
    expect(fitWithin(image, 10)).toBe(image)
  })

  it('returns the same image when the longest side equals the limit', () => {
    const image = solid(8, 2, [1, 2, 3, 4])
    expect(fitWithin(image, 8)).toBe(image)
  })

  it('halves a square image by averaging 2 by 2 blocks', () => {
    const image = fromPixels(4, 4, [
      ...[[0, 0, 0, 255], [100, 0, 0, 255], [10, 10, 10, 255], [30, 30, 30, 255]],
      ...[[100, 0, 0, 255], [200, 0, 0, 255], [10, 10, 10, 255], [30, 30, 30, 255]],
      ...[[0, 0, 200, 255], [0, 0, 200, 255], [255, 255, 255, 255], [255, 255, 255, 255]],
      ...[[0, 0, 200, 255], [0, 0, 200, 255], [255, 255, 255, 255], [255, 255, 255, 255]],
    ])
    const out = fitWithin(image, 2)
    expect({ width: out.width, height: out.height }).toEqual({ width: 2, height: 2 })
    expect(pixelAt(out, 0, 0)).toEqual([100, 0, 0, 255])
    expect(pixelAt(out, 1, 0)).toEqual([20, 20, 20, 255])
    expect(pixelAt(out, 0, 1)).toEqual([0, 0, 200, 255])
    expect(pixelAt(out, 1, 1)).toEqual([255, 255, 255, 255])
  })

  it('keeps the aspect ratio of a wide image', () => {
    const out = fitWithin(solid(400, 100, [9, 8, 7, 255]), 96)
    expect({ width: out.width, height: out.height }).toEqual({ width: 96, height: 24 })
    expect(out.rgba.length).toBe(96 * 24 * 4)
    expect(pixelAt(out, 50, 10)).toEqual([9, 8, 7, 255])
  })

  it('keeps the aspect ratio of a tall image', () => {
    const out = fitWithin(solid(100, 300, [9, 8, 7, 255]), 96)
    expect({ width: out.width, height: out.height }).toEqual({ width: 32, height: 96 })
  })

  it('never shrinks a side below one pixel', () => {
    const out = fitWithin(solid(1000, 2, [5, 5, 5, 255]), 10)
    expect({ width: out.width, height: out.height }).toEqual({ width: 10, height: 1 })
    expect(pixelAt(out, 9, 0)).toEqual([5, 5, 5, 255])
  })

  it('shrinks a one pixel wide strip to one pixel wide', () => {
    const out = fitWithin(solid(1, 500, [5, 6, 7, 255]), 10)
    expect({ width: out.width, height: out.height }).toEqual({ width: 1, height: 10 })
  })

  it('weights a source pixel split between two output pixels by its overlap', () => {
    const pixels = Array.from({ length: 5 }, (_, x) => [x * 50, 0, 0, 255])
    const out = fitWithin(fromPixels(5, 1, pixels), 2)
    expect({ width: out.width, height: out.height }).toEqual({ width: 2, height: 1 })
    expect(pixelAt(out, 0, 0)).toEqual([40, 0, 0, 255])
    expect(pixelAt(out, 1, 0)).toEqual([160, 0, 0, 255])
  })

  it('splits one source pixel between two output pixels when the factor is 1.5', () => {
    const image = fromPixels(3, 1, [
      [0, 0, 0, 255],
      [90, 0, 0, 255],
      [240, 0, 0, 255],
    ])
    const out = fitWithin(image, 2)
    expect({ width: out.width, height: out.height }).toEqual({ width: 2, height: 1 })
    expect(pixelAt(out, 0, 0)).toEqual([30, 0, 0, 255])
    expect(pixelAt(out, 1, 0)).toEqual([190, 0, 0, 255])
  })

  it('weights colors by alpha so transparent pixels do not tint the result', () => {
    const image = fromPixels(2, 1, [
      [200, 100, 50, 255],
      [0, 255, 0, 0],
    ])
    const out = fitWithin(image, 1)
    expect(pixelAt(out, 0, 0)).toEqual([200, 100, 50, 128])
  })

  it('averages partial alpha into the output alpha', () => {
    const image = fromPixels(2, 2, [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 200],
      [100, 100, 100, 200],
    ])
    expect(pixelAt(fitWithin(image, 1), 0, 0)).toEqual([100, 100, 100, 150])
  })

  it('leaves a fully transparent block fully transparent', () => {
    const image = fromPixels(2, 2, [
      [1, 2, 3, 0],
      [4, 5, 6, 0],
      [7, 8, 9, 0],
      [10, 11, 12, 0],
    ])
    expect(pixelAt(fitWithin(image, 1), 0, 0)).toEqual([0, 0, 0, 0])
  })

  it('does not change the input image', () => {
    const image = solid(4, 4, [1, 2, 3, 255])
    const before = Uint8Array.from(image.rgba)
    fitWithin(image, 2)
    expect(image.rgba).toEqual(before)
    expect(image.width).toBe(4)
  })
})
