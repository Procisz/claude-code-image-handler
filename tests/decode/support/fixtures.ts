import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import type { RawImage } from '../../../src/decode/types'

const FIXTURES = path.join(import.meta.dirname, '..', '..', 'fixtures')

type ExpectedEntry = { width: number; height: number; rgba: string }

const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8')) as Record<
  string,
  ExpectedEntry
>

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, name)))

export const fixtureNames = (): string[] => Object.keys(manifest)

export const oracle = (name: string): RawImage => {
  const entry = manifest[name]
  if (entry === undefined) {
    throw new Error(`No oracle for fixture ${name}`)
  }
  return { width: entry.width, height: entry.height, rgba: new Uint8Array(Buffer.from(entry.rgba, 'base64')) }
}

export const expectSameImage = (actual: RawImage | null, expected: RawImage, tolerance = 0): void => {
  expect(actual).not.toBeNull()
  const image = actual!
  expect({ width: image.width, height: image.height }).toEqual({ width: expected.width, height: expected.height })
  expect(image.rgba.length).toBe(expected.rgba.length)
  for (let at = 0; at < expected.rgba.length; at += 4) {
    const alpha = expected.rgba[at + 3]!
    const pixel = `pixel ${(at / 4) % expected.width},${Math.floor(at / 4 / expected.width)}`
    expect(image.rgba[at + 3], `${pixel} alpha`).toBeGreaterThanOrEqual(alpha - tolerance)
    expect(image.rgba[at + 3], `${pixel} alpha`).toBeLessThanOrEqual(alpha + tolerance)
    if (alpha === 0) {
      continue
    }
    for (let channel = 0; channel < 3; channel++) {
      const want = expected.rgba[at + channel]!
      const got = image.rgba[at + channel]!
      expect(Math.abs(got - want), `${pixel} channel ${channel}: got ${got}, want ${want}`).toBeLessThanOrEqual(tolerance)
    }
  }
}

export const pixelAt = (image: RawImage, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4
  return [image.rgba[at]!, image.rgba[at + 1]!, image.rgba[at + 2]!, image.rgba[at + 3]!]
}

export const solid = (width: number, height: number, color: number[]): RawImage => {
  const rgba = new Uint8Array(width * height * 4)
  for (let at = 0; at < rgba.length; at += 4) {
    rgba.set(color, at)
  }
  return { width, height, rgba }
}
