/**
 * Offline "mock" provider. Generates a deterministic, dependency-free PNG so the
 * panel, the library and the tests have something real to show without a key
 * or a network call.
 */
import { encodePng } from '../util/png.js'

const DEFAULT_BASE_URL = ''

const MODEL = {
  id: 'mock-1',
  label: 'Mock 1 (no API)',
  aspects: ['1:1', '16:9', '9:16'],
  sizes: [],
  qualities: [],
  supportsRefs: true,
  maxRefs: 4,
  note: 'Offline placeholder — no network, no key. References are accepted but ignored.',
}

const ASPECT_SIZES = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
}

/** FNV-1a, 32-bit. */
function hash32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((((hue % 360) + 360) % 360) / 360)
  const s = Math.max(0, Math.min(1, saturation))
  const l = Math.max(0, Math.min(1, lightness))
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ]
}

/**
 * Paint one frame: vertical two-colour gradient, soft vignette, 16px checker
 * blocks in the four corners. Fully deterministic from `seed`.
 */
function paint(width, height, seed) {
  const pixels = new Uint8Array(width * height * 4)
  const hash = hash32(seed)
  const hueA = hash % 360
  const hueB = (hueA + 25 + ((hash >>> 9) % 110)) % 360
  const [r1, g1, b1] = hslToRgb(hueA, 0.42 + ((hash >>> 17) % 30) / 100, 0.24 + ((hash >>> 5) % 12) / 100)
  const [r2, g2, b2] = hslToRgb(hueB, 0.5 + ((hash >>> 21) % 25) / 100, 0.6 + ((hash >>> 13) % 16) / 100)

  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const maxRadius = Math.sqrt(cx * cx + cy * cy) || 1
  const band = Math.max(16, Math.min(96, Math.floor(Math.min(width, height) / 6)))
  const dx2 = new Float64Array(width)
  for (let x = 0; x < width; x += 1) {
    const dx = x - cx
    dx2[x] = dx * dx
  }

  let offset = 0
  for (let y = 0; y < height; y += 1) {
    const t = height > 1 ? y / (height - 1) : 0
    const baseR = r1 + (r2 - r1) * t
    const baseG = g1 + (g2 - g1) * t
    const baseB = b1 + (b2 - b1) * t
    const dy = y - cy
    const dy2 = dy * dy
    const topCorner = y < band
    const bottomCorner = y >= height - band

    for (let x = 0; x < width; x += 1) {
      const d = Math.sqrt(dx2[x] + dy2) / maxRadius
      const shade = 1 - 0.22 * d * d
      let r = baseR * shade
      let g = baseG * shade
      let b = baseB * shade

      if ((topCorner || bottomCorner) && (x < band || x >= width - band)) {
        const light = ((x >> 4) + (y >> 4)) % 2 === 0
        const delta = light ? 16 : -14
        r += delta
        g += delta
        b += delta
      }

      pixels[offset] = r < 0 ? 0 : r > 255 ? 255 : r
      pixels[offset + 1] = g < 0 ? 0 : g > 255 ? 255 : g
      pixels[offset + 2] = b < 0 ? 0 : b > 255 ? 255 : b
      pixels[offset + 3] = 255
      offset += 4
    }
  }
  return pixels
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(4, count)
}

function dimensions(aspect, size) {
  if (typeof size === 'string') {
    const match = /^(\d{2,5})x(\d{2,5})$/i.exec(size.trim())
    if (match) {
      const width = Number.parseInt(match[1], 10)
      const height = Number.parseInt(match[2], 10)
      if (width > 0 && height > 0) return { width, height }
    }
  }
  return ASPECT_SIZES[aspect] || ASPECT_SIZES['1:1']
}

function withNegative(prompt, negativePrompt) {
  const text = String(prompt ?? '').trim()
  const negative = String(negativePrompt ?? '').trim()
  return negative ? `${text}\n\nAvoid: ${negative}` : text
}

export const mockAdapter = {
  id: 'mock',
  label: 'Mock (offline)',
  kind: 'sync',
  docsUrl: '',
  keyRefs: [],
  keyHint: '',
  keyUrl: '',
  defaultBaseUrl: DEFAULT_BASE_URL,
  configurableBaseUrl: false,
  beta: true,
  needsApiKey: false,
  models: [MODEL],

  async generate(req = {}) {
    const model = req.model || MODEL.id
    const prompt = withNegative(req.prompt, req.negativePrompt)
    const { width, height } = dimensions(req.aspect, req.size)
    const count = clampCount(req.count)
    const seed = req.seed === null || req.seed === undefined ? '' : String(req.seed)
    const images = []
    for (let index = 0; index < count; index += 1) {
      const pixels = paint(width, height, `${prompt}|${model}|${seed}|${index}`)
      images.push({ data: encodePng(width, height, pixels), mediaType: 'image/png', width, height })
    }
    return { images, revisedPrompt: '', raw: { mock: true, model, width, height, count } }
  },

  async test() {
    return { ok: true, message: 'Mock provider is always available' }
  },
}

export default mockAdapter
