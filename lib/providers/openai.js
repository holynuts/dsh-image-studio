/**
 * OpenAI image generation (GPT Image).
 *
 * Text-to-image: POST {base}/images/generations (JSON, b64_json response).
 * With references: POST {base}/images/edits (multipart, repeated `image` parts).
 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const LABEL = 'OpenAI'
const MAX_COUNT = 4
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

const MODELS = [
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', note: 'Default — balanced speed and quality.' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', note: 'Higher detail, slower.' },
].map((model) => ({
  ...model,
  aspects: [],
  sizes: ['1024x1024', '1536x1024', '1024x1536'],
  qualities: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
  supportsRefs: true,
  maxRefs: 4,
}))

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
    ? 'Check the OpenAI API key.'
    : status === 429
      ? 'OpenAI is rate limiting — wait a moment and retry.'
      : status >= 500
        ? 'OpenAI had a server error — retry shortly.'
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

function bytesFromBase64(value) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(value)
  const cleaned = (match ? match[2] : value).replace(/\s+/g, '')
  return new Uint8Array(Buffer.from(cleaned, 'base64'))
}

function extensionFor(mediaType) {
  if (/jpe?g$/i.test(mediaType)) return 'jpg'
  if (/webp$/i.test(mediaType)) return 'webp'
  if (/gif$/i.test(mediaType)) return 'gif'
  return 'png'
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(MAX_COUNT, count)
}

async function downloadJsonUrl(url, impl, signal, apiKey) {
  let response = await impl(url, { signal })
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    response = await impl(url, { signal, headers: { authorization: `Bearer ${apiKey}` } })
  }
  await ensureOk(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = String(response.headers?.get?.('content-type') || '').split(';')[0].trim()
  return { data: bytes, mediaType: IMAGE_MIME.test(header) ? header : sniffMediaType(bytes) }
}

async function imagesFromResponse(json, impl, signal, apiKey) {
  const entries = Array.isArray(json?.data) ? json.data : []
  const images = []
  let revisedPrompt = ''
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (!revisedPrompt && typeof entry.revised_prompt === 'string') revisedPrompt = entry.revised_prompt
    if (typeof entry.b64_json === 'string' && entry.b64_json) {
      images.push({ data: bytesFromBase64(entry.b64_json), mediaType: 'image/png' })
    } else if (typeof entry.url === 'string' && entry.url) {
      images.push(await downloadJsonUrl(entry.url, impl, signal, apiKey))
    }
  }
  if (images.length === 0) {
    const error = new Error('OpenAI returned no image data.')
    error.hint = 'The prompt may have been rejected by the safety system — try rephrasing it.'
    throw error
  }
  return { images, revisedPrompt }
}

export const openaiAdapter = {
  id: 'openai',
  label: 'OpenAI',
  kind: 'sync',
  docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
  keyRefs: ['IMAGE_STUDIO_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  keyHint: 'sk-…',
  keyUrl: 'https://platform.openai.com/api-keys',
  defaultBaseUrl: DEFAULT_BASE_URL,
  configurableBaseUrl: false,
  beta: false,
  needsApiKey: true,
  models: MODELS,

  async generate(req = {}) {
    const impl = resolveFetch(req.fetchImpl)
    const model = req.model || MODELS[0].id
    const base = trimBase(req.baseUrl)
    const prompt = withNegative(req.prompt, req.negativePrompt)
    const count = clampCount(req.count)
    const size = String(req.size || '').trim()
    const quality = String(req.quality || '').trim()
    const refs = Array.isArray(req.refs) ? req.refs : []
    const signal = req.signal

    let response
    if (refs.length > 0) {
      const form = new FormData()
      refs.forEach((ref, index) => {
        const mediaType = ref?.mediaType || 'image/png'
        const bytes = typeof ref?.data === 'string' ? bytesFromBase64(ref.data) : ref?.data
        form.append('image', new Blob([bytes], { type: mediaType }), `reference-${index + 1}.${extensionFor(mediaType)}`)
      })
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('n', String(count))
      if (size) form.append('size', size)
      if (quality) form.append('quality', quality)
      // No content-type header: fetch derives the multipart boundary itself.
      response = await impl(`${base}/images/edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${req.apiKey}` },
        body: form,
        signal,
      })
    } else {
      const body = { model, prompt, n: count, output_format: 'png' }
      if (size) body.size = size
      if (quality) body.quality = quality
      if (typeof req.background === 'string' && req.background.trim()) body.background = req.background.trim()
      response = await impl(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(body),
        signal,
      })
    }

    await ensureOk(response)
    const json = await readJson(response)
    const { images, revisedPrompt } = await imagesFromResponse(json, impl, signal, req.apiKey)
    return { images, revisedPrompt, raw: json }
  },

  async test({ apiKey, baseUrl, fetchImpl } = {}) {
    const impl = resolveFetch(fetchImpl)
    const base = trimBase(baseUrl)
    try {
      const response = await impl(`${base}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await ensureOk(response)
      return { ok: true, message: `Connected to OpenAI (HTTP ${response.status})` }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  },
}

export default openaiAdapter
