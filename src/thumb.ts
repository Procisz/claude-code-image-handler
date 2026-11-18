import { encodeBase64 } from './base64'
import type { RawImage } from './decode/types'
import type { Thumb } from './view'

export function makeThumb(image: RawImage): Thumb {
  return {
    image,
    rgba: encodeBase64(image.rgba),
  }
}
