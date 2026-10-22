/**
 * Minimal, dependency-free PNG encoder (8-bit RGBA, non-interlaced).
 *
 * Only what the offline mock provider needs: truecolour+alpha, filter 0 on
 * every scanline, one IDAT chunk. `deflateSync` comes from node:zlib, which is
 * a builtin, so the plugin keeps its zero-runtime-dependency promise.
 */
import { deflateSync } from 'node:zlib'

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (PNG / zlib polynomial) over a byte array. */
export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function uint32(value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0)
  return out
}

/** length(4) + type(4) + payload + crc32(type + payload)(4) */
function chunk(type, payload) {
  const typed = new Uint8Array(4 + payload.length)
  for (let i = 0; i < 4; i += 1) typed[i] = type.charCodeAt(i)
  typed.set(payload, 4)
  const out = new Uint8Array(12 + payload.length)
  out.set(uint32(payload.length), 0)
  out.set(typed, 4)
  out.set(uint32(crc32(typed)), 8 + payload.length)
  return out
}

function ihdr(width, height) {
  const data = new Uint8Array(13)
  const view = new DataView(data.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  data[8] = 8 // bit depth
  data[9] = 6 // colour type: RGBA
  data[10] = 0 // compression: deflate
  data[11] = 0 // filter method: adaptive
  data[12] = 0 // interlace: none
  return chunk('IHDR', data)
}

/**
 * Encode RGBA pixels into PNG bytes.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba width*height*4 bytes, row-major, none premultiplied
 * @param {{level?: number}} [options] zlib level (0-9)
 * @returns {Uint8Array}
 */
export function encodePng(width, height, rgba, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('encodePng: width and height must be positive integers')
  }
  if (!(rgba instanceof Uint8Array)) throw new Error('encodePng: rgba must be a Uint8Array')
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(`encodePng: rgba must hold ${expected} bytes for ${width}x${height}, got ${rgba.length}`)
  }

  const stride = width * 4
  const scanlines = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (stride + 1)] = 0 // filter type: none
    scanlines.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const level = Number.isInteger(options.level) && options.level >= 0 && options.level <= 9 ? options.level : 6
  const idat = new Uint8Array(deflateSync(scanlines, { level }))

  const parts = [PNG_SIGNATURE, ihdr(width, height), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export default encodePng
