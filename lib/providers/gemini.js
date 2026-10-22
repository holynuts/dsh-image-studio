/**
 * Google Gemini image generation ("Nano Banana") over the Interactions API.
 *
 * POST {base}/interactions
 *   { model, input: [{type:'text',text}, {type:'image',data,mime_type}...],
 *     response_format: {type:'image', mime_type:'image/jpeg', aspect_ratio?, image_size?},
 *     store: false }
 *
 * The endpoint returns one image per call, so `count > 1` fans out into parallel
 * calls. Response parsing is intentionally tolerant: output_image, steps[].content
 * and deeply nested inline_data variants are all accepted.
 */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const LABEL = 'Gemini'
const MAX_COUNT = 4

const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4', '21:9']
const QUALITIES = ['1K', '2K', '4K']
const BASE_MODEL = {
  aspects: ASPECTS,
  sizes: [],
  qualities: QUALITIES,
  supportsRefs: true,
  maxRefs: 14,
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
    ? 'Check the Gemini API key.'
    : status === 429
      ? 'Gemini is rate limiting — wait a moment and retry.'
      : status >= 500
        ? 'Gemini had a server error — retry shortly.'
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

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i
const BASE64_BODY = /^[A-Za-z0-9+/=\s]+$/

function stripDataUri(value) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value)
  return match ? { mediaType: match[1], data: match[2] } : { mediaType: '', data: value }
}

function toBase64(data) {
  if (typeof data === 'string') {
    const stripped = stripDataUri(data).data.replace(/\s+/g, '')
    return stripped
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64')
  throw new Error(`${LABEL}: reference images must be bytes or base64 strings`)
}

function bytesFromBase64(value) {
  const cleaned = stripDataUri(String(value)).data.replace(/\s+/g, '')
  return new Uint8Array(Buffer.from(cleaned, 'base64'))
}

/** Pull one `{data, mediaType}` image out of a single node, without walking. */
function imagePart(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
  const mime = node.mime_type || node.mimeType || node.media_type || node.mediaType || ''
  const raw = typeof node.data === 'string' && node.data
    ? node.data
    : typeof node.b64_json === 'string' && node.b64_json
      ? node.b64_json
      : ''
  if (raw) {
    const stripped = stripDataUri(raw)
    const data = stripped.data.replace(/\s+/g, '')
    const mediaType = IMAGE_MIME.test(mime) ? mime : IMAGE_MIME.test(stripped.mediaType) ? stripped.mediaType : ''
    if (mediaType && data.length > 24 && BASE64_BODY.test(data)) return { data, mediaType }
  }
  const inline = node.inline_data || node.inlineData
  if (inline && typeof inline === 'object') return imagePart(inline)
  if (node.image && typeof node.image === 'object') return imagePart(node.image)
  return undefined
}

function findDeepImage(root) {
  const seen = new WeakSet()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 10 || seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1)
        if (hit) return hit
      }
      return undefined
    }
    const direct = imagePart(node)
    if (direct) return direct
    for (const value of Object.values(node)) {
      const hit = walk(value, depth + 1)
      if (hit) return hit
    }
    return undefined
  }
  return walk(root, 0)
}

/** Tolerant image extractor: output_image → steps[].content[] → deep walk. */
export function extractImage(json) {
  if (!json || typeof json !== 'object') return undefined
  const top = imagePart(json.output_image) || imagePart(json.outputImage) || imagePart(json.image)
  if (top) return top

  const steps = Array.isArray(json.steps) ? json.steps : []
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue
    const contents = step.content || step.contents || step.parts || step.output
    if (Array.isArray(contents)) {
      for (const part of contents) {
        const hit = imagePart(part)
        if (hit) return hit
      }
    }
    const stepHit = imagePart(step)
    if (stepHit) return stepHit
  }

  for (const candidate of [json.candidates, json.outputs, json.output, json.data, json.result]) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        const hit = imagePart(entry)
        if (hit) return hit
      }
    } else {
      const hit = imagePart(candidate)
      if (hit) return hit
    }
  }

  return findDeepImage(json)
}

function imageSizeFor(quality, resolution) {
  for (const value of [resolution, quality]) {
    const text = String(value || '').trim().toUpperCase()
    if (/^[124]K$/.test(text)) return text
  }
  return ''
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(MAX_COUNT, count)
}

export const geminiAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  kind: 'sync',
  docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
  keyRefs: ['IMAGE_STUDIO_GEMINI_API_KEY', 'GEMINI_API_KEY'],
  keyHint: 'AIza…',
  keyUrl: 'https://aistudio.google.com/apikey',
  defaultBaseUrl: DEFAULT_BASE_URL,
  configurableBaseUrl: false,
  beta: false,
  needsApiKey: true,
  models: [
    { ...BASE_MODEL, id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1', note: 'Default. Picks 1K unless you choose 2K/4K.' },
    { ...BASE_MODEL, id: 'gemini-3-pro-image', label: 'Nano Banana Pro', note: 'Highest fidelity, slower.' },
    { ...BASE_MODEL, id: 'gemini-3.1-flash-image', label: 'Nano Banana 2', note: 'Fast general purpose.' },
    { ...BASE_MODEL, id: 'gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite', note: 'Cheapest / fastest.' },
  ],

  async generate(req = {}) {
    const impl = resolveFetch(req.fetchImpl)
    const model = req.model || 'gemini-nano-banana-2.1'
    const base = trimBase(req.baseUrl)
    const prompt = withNegative(req.prompt, req.negativePrompt)
    const count = clampCount(req.count)
    const signal = req.signal

    // The Interactions API accepts only image/jpeg for the generated image
    // (a live 400 rejects image/png on 'response_format.mime_type').
    const responseFormat = { type: 'image', mime_type: 'image/jpeg' }
    if (String(req.aspect || '').trim()) responseFormat.aspect_ratio = String(req.aspect).trim()
    const imageSize = imageSizeFor(req.quality, req.resolution)
    if (imageSize) responseFormat.image_size = imageSize

    const input = [{ type: 'text', text: prompt }]
    for (const ref of req.refs || []) {
      input.push({ type: 'image', data: toBase64(ref?.data), mime_type: ref?.mediaType || 'image/png' })
    }

    const body = JSON.stringify({ model, input, response_format: responseFormat, store: false })
    const call = async () => {
      const response = await impl(`${base}/interactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey },
        body,
        signal,
      })
      await ensureOk(response)
      const json = await readJson(response)
      const found = extractImage(json)
      if (!found) {
        const error = new Error('Gemini returned no image data. The prompt may have been blocked, or the model returned text only.')
        error.status = response.status
        error.hint = 'Try rephrasing the prompt, or pick a different Nano Banana model.'
        throw error
      }
      return { image: found, json }
    }

    const results = await Promise.all(Array.from({ length: count }, () => call()))
    const images = results.map(({ image }) => ({
      data: bytesFromBase64(image.data),
      mediaType: image.mediaType,
    }))
    const raws = results.map(({ json }) => json)
    return { images, revisedPrompt: '', raw: count === 1 ? raws[0] : raws }
  },

  async test({ apiKey, baseUrl, fetchImpl } = {}) {
    const impl = resolveFetch(fetchImpl)
    const base = trimBase(baseUrl)
    try {
      const response = await impl(`${base}/models?pageSize=1`, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
      })
      await ensureOk(response)
      return { ok: true, message: `Connected to Gemini (HTTP ${response.status})` }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  },
}

export default geminiAdapter
