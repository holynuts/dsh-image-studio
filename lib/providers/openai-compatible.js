/**
 * Catch-all adapter for OpenRouter / LiteLLM / self-hosted gateways that speak
 * the OpenAI images protocol (`POST {root}/images/generations`).
 *
 * The base URL is user-supplied: `https://gw.example.com` becomes
 * `https://gw.example.com/v1/images/generations`, while a base that already ends
 * in a version segment (…/v1) is not doubled. A full generations URL is used as-is.
 */
const LABEL = 'OpenAI-compatible'
const MAX_COUNT = 4
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i

function resolveFetch(fetchImpl) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof impl !== 'function') throw new Error(`${LABEL}: no fetch implementation available`)
  return impl
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
    ? 'Check the API key and endpoint for this gateway.'
    : status === 404
      ? 'The endpoint path may be wrong — check whether it should end with /v1.'
      : status >= 500
        ? 'The gateway had a server error — retry shortly.'
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

/**
 * Resolve the API root and the generations endpoint from a user-entered base.
 * @returns {{endpoint: string, root: string, models: string}}
 */
export function resolveEndpoint(baseUrl) {
  let base = String(baseUrl || '').trim()
  if (!base) {
    throw new Error('Set the endpoint URL for the OpenAI-compatible provider (for example https://api.openai.com/v1)')
  }
  base = base.replace(/\/+$/, '')

  if (!/^https?:\/\//i.test(base)) {
    base = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(base) ? `http://${base}` : `https://${base}`
  }

  if (/\/images\/(generations|edits)$/i.test(base)) {
    const root = base.replace(/\/images\/(generations|edits)$/i, '')
    return { endpoint: `${root}/images/generations`, root, models: `${root}/models` }
  }

  const root = /\/v\d+[a-z0-9.-]*$/i.test(base) ? base : `${base}/v1`
  return { endpoint: `${root}/images/generations`, root, models: `${root}/models` }
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(MAX_COUNT, count)
}

async function downloadUrl(url, impl, signal, apiKey) {
  let response = await impl(url, { signal })
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    response = await impl(url, { signal, headers: { authorization: `Bearer ${apiKey}` } })
  }
  await ensureOk(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = String(response.headers?.get?.('content-type') || '').split(';')[0].trim()
  return { data: bytes, mediaType: IMAGE_MIME.test(header) ? header : sniffMediaType(bytes) }
}

export const openaiCompatibleAdapter = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  kind: 'sync',
  docsUrl: 'https://platform.openai.com/docs/api-reference/images',
  keyRefs: ['IMAGE_STUDIO_OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_API_KEY'],
  keyHint: 'sk-…',
  keyUrl: '',
  defaultBaseUrl: '',
  configurableBaseUrl: true,
  beta: true,
  needsApiKey: true,
  models: [],

  async generate(req = {}) {
    const impl = resolveFetch(req.fetchImpl)
    const model = String(req.model || '').trim()
    if (!model) throw new Error(`${LABEL} needs a model id — type one in Settings.`)
    const refs = Array.isArray(req.refs) ? req.refs : []
    if (refs.length > 0) {
      throw new Error(`${LABEL} does not support reference images — use OpenAI, Gemini, fal or Replicate for those.`)
    }
    const { endpoint } = resolveEndpoint(req.baseUrl)
    const signal = req.signal

    const body = {
      model,
      prompt: withNegative(req.prompt, req.negativePrompt),
      n: clampCount(req.count),
      response_format: 'b64_json',
    }
    const size = String(req.size || '').trim()
    const quality = String(req.quality || '').trim()
    if (size) body.size = size
    if (quality) body.quality = quality

    const response = await impl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
    await ensureOk(response)
    const json = await readJson(response)
    const entries = Array.isArray(json?.data) ? json.data : []
    const images = []
    let revisedPrompt = ''
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      if (!revisedPrompt && typeof entry.revised_prompt === 'string') revisedPrompt = entry.revised_prompt
      if (typeof entry.b64_json === 'string' && entry.b64_json) {
        images.push({ data: bytesFromBase64(entry.b64_json), mediaType: 'image/png' })
      } else if (typeof entry.url === 'string' && entry.url) {
        images.push(await downloadUrl(entry.url, impl, signal, req.apiKey))
      }
    }
    if (images.length === 0) {
      const error = new Error(`${LABEL} returned no image data — the gateway may not support images for this model.`)
      error.hint = 'Check that the endpoint exposes /images/generations and that the model id is an image model.'
      throw error
    }
    return { images, revisedPrompt, raw: json }
  },

  async test({ apiKey, baseUrl, fetchImpl } = {}) {
    const impl = resolveFetch(fetchImpl)
    try {
      const { models } = resolveEndpoint(baseUrl)
      const response = await impl(models, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await ensureOk(response)
      return { ok: true, message: `Connected to the endpoint (HTTP ${response.status})` }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  },
}

export default openaiCompatibleAdapter
