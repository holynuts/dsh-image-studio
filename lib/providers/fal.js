/**
 * fal.ai image generation. Model slugs are advisory: users may type any slug,
 * so the URL is `{base}/{model}`.
 *
 * `sync_mode: true` makes most endpoints return a `data:` URI in `images[].url`;
 * those are decoded locally. Plain http(s) URLs are downloaded without auth.
 */
const DEFAULT_BASE_URL = 'https://fal.run'
const LABEL = 'fal.ai'
const MAX_COUNT = 4
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const MODEL_DEFAULTS = {
  aspects: ASPECTS,
  sizes: [],
  qualities: [],
  supportsRefs: true,
  maxRefs: 4,
}

function resolveFetch(fetchImpl) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof impl !== 'function') throw new Error(`${LABEL}: no fetch implementation available`)
  return impl
}

function trimBase(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
}

function statusError(status, text, statusText) {
  let detail = ''
  try {
    const parsed = JSON.parse(text)
    const raw = parsed?.error ?? parsed?.message ?? parsed?.detail
    detail = typeof raw === 'string' ? raw : raw?.message || raw?.msg || ''
  } catch {
    detail = ''
  }
  const suffix = detail || String(text || '').trim().slice(0, 200) || statusText || ''
  const error = new Error(`${LABEL} request failed (HTTP ${status})${suffix ? `: ${suffix}` : ''}`)
  error.status = status
  error.body = String(text || '').slice(0, 400)
  error.hint = status === 401 || status === 403
    ? 'Check the fal API key.'
    : status === 429
      ? 'fal is rate limiting — wait a moment and retry.'
      : status >= 500
        ? 'fal had a server error — retry shortly.'
        : ''
  return error
}

async function ensureOk(response) {
  if (response && response.ok) return response
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  throw statusError(response?.status ?? 0, text, response?.statusText || '')
}

async function readJson(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    const error = new Error(`${LABEL} returned a non-JSON response: ${String(text).slice(0, 160)}`)
    error.status = response.status
    error.body = String(text).slice(0, 400)
    throw error
  }
}

function withNegative(prompt, negativePrompt) {
  const text = String(prompt ?? '').trim()
  const negative = String(negativePrompt ?? '').trim()
  return negative ? `${text}\n\nAvoid: ${negative}` : text
}

function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  return 'image/png'
}

function dataUri(ref) {
  const mediaType = ref?.mediaType || 'image/png'
  const bytes = typeof ref?.data === 'string'
    ? new Uint8Array(Buffer.from(ref.data.replace(/^data:[^,]*,/, ''), 'base64'))
    : ref?.data
  if (!(bytes instanceof Uint8Array)) throw new Error(`${LABEL}: reference images must be bytes`)
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

function decodeDataUri(value) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(value)
  if (!match) return undefined
  const mediaType = IMAGE_MIME.test(match[1] || '') ? match[1] : 'image/png'
  const body = match[2] ? match[3] : decodeURIComponent(match[3])
  const bytes = match[2]
    ? new Uint8Array(Buffer.from(body.replace(/\s+/g, ''), 'base64'))
    : new Uint8Array(Buffer.from(body, 'binary'))
  return { data: bytes, mediaType }
}

function collectEntries(json) {
  const entries = []
  const push = (entry) => {
    if (!entry) return
    if (typeof entry === 'string') entries.push({ url: entry })
    else if (typeof entry.url === 'string' && entry.url) entries.push(entry)
  }
  if (Array.isArray(json?.images)) json.images.forEach(push)
  if (json?.image) push(json.image)
  if (Array.isArray(json?.data)) json.data.forEach(push)
  return entries
}

function entryMediaType(entry, response, bytes) {
  for (const value of [entry?.content_type, entry?.mime_type, entry?.mediaType]) {
    if (typeof value === 'string' && IMAGE_MIME.test(value.split(';')[0].trim())) return value.split(';')[0].trim()
  }
  const header = String(response?.headers?.get?.('content-type') || '').split(';')[0].trim()
  if (IMAGE_MIME.test(header)) return header
  return sniffMediaType(bytes)
}

async function fetchImage(entry, impl, signal) {
  if (typeof entry.url === 'string' && entry.url.startsWith('data:')) {
    const decoded = decodeDataUri(entry.url)
    if (!decoded) throw new Error(`${LABEL} returned a malformed data URI`)
    return { data: decoded.data, mediaType: decoded.mediaType, width: numberOrUndefined(entry.width), height: numberOrUndefined(entry.height) }
  }
  const response = await impl(entry.url, { signal })
  await ensureOk(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    data: bytes,
    mediaType: entryMediaType(entry, response, bytes),
    width: numberOrUndefined(entry.width),
    height: numberOrUndefined(entry.height),
  }
}

function numberOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(MAX_COUNT, count)
}

export const falAdapter = {
  id: 'fal',
  label: 'fal.ai',
  kind: 'sync',
  docsUrl: 'https://fal.ai/models',
  keyRefs: ['IMAGE_STUDIO_FAL_API_KEY', 'FAL_KEY', 'FAL_API_KEY'],
  keyHint: 'key-id:key-secret',
  keyUrl: 'https://fal.ai/dashboard/keys',
  defaultBaseUrl: DEFAULT_BASE_URL,
  configurableBaseUrl: true,
  beta: true,
  needsApiKey: true,
  models: [
    { ...MODEL_DEFAULTS, id: 'fal-ai/nano-banana-2.1', label: 'Nano Banana 2.1 · fal', note: 'Gemini image model hosted by fal.' },
    { ...MODEL_DEFAULTS, id: 'fal-ai/flux-2-pro', label: 'FLUX 2 Pro · fal', note: 'Black Forest Labs FLUX 2.' },
  ],

  async generate(req = {}) {
    const impl = resolveFetch(req.fetchImpl)
    const model = String(req.model || 'fal-ai/nano-banana-2.1').trim().replace(/^\/+/, '')
    if (!model) throw new Error('fal needs a model slug (for example fal-ai/nano-banana-2.1)')
    const base = trimBase(req.baseUrl)
    const signal = req.signal
    const count = clampCount(req.count)

    const body = {
      prompt: withNegative(req.prompt, req.negativePrompt),
      num_images: count,
      sync_mode: true,
    }
    const aspect = String(req.aspect || '').trim()
    const size = String(req.size || '').trim()
    if (aspect) body.image_size = aspect
    else if (size) body.image_size = size
    if (Number.isFinite(req.seed)) body.seed = req.seed
    const refs = Array.isArray(req.refs) ? req.refs : []
    if (refs.length > 0) body.image_urls = refs.map(dataUri)

    const response = await impl(`${base}/${model}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Key ${req.apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
    await ensureOk(response)
    const json = await readJson(response)
    const entries = collectEntries(json)
    if (entries.length === 0) {
      const error = new Error('fal returned no image data.')
      error.hint = 'The model slug may be wrong, or the prompt was rejected.'
      throw error
    }

    const images = []
    for (const entry of entries) images.push(await fetchImage(entry, impl, signal))
    return { images, revisedPrompt: '', raw: json }
  },

  async test() {
    return { ok: false, message: 'Use Test image instead' }
  },
}

export default falAdapter
