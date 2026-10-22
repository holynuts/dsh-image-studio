/**
 * Replicate predictions. `Prefer: wait` asks the API to hold the request open,
 * but long jobs still come back as `processing`, so the adapter polls the global
 * prediction endpoint until it has output (1500ms, 120s cap) and honours `signal`.
 *
 * Output URLs on replicate.delivery need the Authorization header; other hosts
 * (signed CDN links) get a bare request.
 */
const DEFAULT_BASE_URL = 'https://api.replicate.com/v1'
const LABEL = 'Replicate'
const MAX_COUNT = 4
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 120_000
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

function abortError() {
  const error = new Error('The request was aborted')
  error.name = 'AbortError'
  return error
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
  })
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
    ? 'Check the Replicate API token.'
    : status === 429
      ? 'Replicate is rate limiting — wait a moment and retry.'
      : status >= 500
        ? 'Replicate had a server error — retry shortly.'
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

/** Flatten the three documented output shapes into `{url}` entries. */
function outputEntries(output) {
  const entries = []
  const push = (entry) => {
    if (!entry) return
    if (typeof entry === 'string') entries.push({ url: entry })
    else if (typeof entry.url === 'string' && entry.url) entries.push(entry)
  }
  if (Array.isArray(output)) output.forEach(push)
  else push(output)
  return entries
}

function deliveryHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'replicate.delivery' || host.endsWith('.replicate.delivery')
  } catch {
    return false
  }
}

async function downloadOutput(url, impl, apiKey, signal) {
  const init = deliveryHost(url) ? { signal, headers: { authorization: `Bearer ${apiKey}` } } : { signal }
  const response = await impl(url, init)
  await ensureOk(response)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const header = String(response.headers?.get?.('content-type') || '').split(';')[0].trim()
  return {
    data: bytes,
    mediaType: IMAGE_MIME.test(header) ? header : sniffMediaType(bytes),
    width: undefined,
    height: undefined,
  }
}

function predictionError(prediction) {
  const raw = prediction?.error
  const detail = typeof raw === 'string' ? raw : raw?.message || (raw ? JSON.stringify(raw).slice(0, 300) : '')
  const error = new Error(`${LABEL} prediction failed${detail ? `: ${detail}` : ''}`)
  error.hint = 'Check the model slug and input in the Replicate console, then retry.'
  return error
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(MAX_COUNT, count)
}

export const replicateAdapter = {
  id: 'replicate',
  label: 'Replicate',
  kind: 'async',
  docsUrl: 'https://replicate.com/docs',
  keyRefs: ['IMAGE_STUDIO_REPLICATE_API_TOKEN', 'REPLICATE_API_TOKEN'],
  keyHint: 'r8_…',
  keyUrl: 'https://replicate.com/account/api-tokens',
  defaultBaseUrl: DEFAULT_BASE_URL,
  configurableBaseUrl: true,
  beta: true,
  needsApiKey: true,
  models: [
    { ...MODEL_DEFAULTS, id: 'google/nano-banana-2.1', label: 'Nano Banana 2.1 · Replicate', note: 'Gemini image model on Replicate.' },
    { ...MODEL_DEFAULTS, id: 'black-forest-labs/flux-2-pro', label: 'FLUX 2 Pro · Replicate', note: 'Black Forest Labs FLUX 2.' },
  ],

  async generate(req = {}) {
    const impl = resolveFetch(req.fetchImpl)
    const model = String(req.model || 'google/nano-banana-2.1').trim().replace(/^\/+/, '')
    if (!/^[^/\s]+\/[^/\s]+(?::[^/\s]+)?$/.test(model)) {
      throw new Error(`${LABEL} needs an owner/name model slug (got "${model}")`)
    }
    const base = trimBase(req.baseUrl)
    const signal = req.signal
    const count = clampCount(req.count)

    const input = { prompt: withNegative(req.prompt, req.negativePrompt), num_outputs: count }
    const aspect = String(req.aspect || '').trim()
    if (aspect) input.aspect_ratio = aspect
    if (Number.isFinite(req.seed)) input.seed = req.seed
    const refs = Array.isArray(req.refs) ? req.refs : []
    if (refs.length === 1) input.image = dataUri(refs[0])
    else if (refs.length > 1) input.image_input = refs.map(dataUri)

    const response = await impl(`${base}/models/${model}/predictions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
        prefer: 'wait',
      },
      body: JSON.stringify({ input }),
      signal,
    })
    await ensureOk(response)
    let prediction = await readJson(response)

    if (!prediction || typeof prediction !== 'object') throw new Error(`${LABEL} returned an unexpected response`)

    const deadline = Date.now() + POLL_TIMEOUT_MS
    let entries = outputEntries(prediction.output)
    while (entries.length === 0) {
      const status = String(prediction.status || '').toLowerCase()
      if (status === 'failed' || status === 'canceled' || status === 'cancelled') throw predictionError(prediction)
      if (status === 'succeeded') throw new Error(`${LABEL} finished without returning an image`)
      if (!['starting', 'processing', 'queued'].includes(status)) throw predictionError(prediction)
      if (Date.now() >= deadline) {
        const error = new Error(`${LABEL} is still processing after ${POLL_TIMEOUT_MS / 1000}s — open the prediction on replicate.com and retry.`)
        error.hint = 'Slow models can take several minutes; retry or pick a faster model.'
        throw error
      }
      if (!prediction.id) throw new Error(`${LABEL} returned no prediction id to poll`)
      await sleep(POLL_INTERVAL_MS, signal)
      const pollResponse = await impl(`${base}/predictions/${prediction.id}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${req.apiKey}` },
        signal,
      })
      await ensureOk(pollResponse)
      prediction = await readJson(pollResponse)
      entries = outputEntries(prediction?.output)
    }

    const images = []
    for (const entry of entries) images.push(await downloadOutput(entry.url, impl, req.apiKey, signal))
    return { images, revisedPrompt: '', raw: prediction }
  },

  async test({ apiKey, baseUrl, fetchImpl } = {}) {
    const impl = resolveFetch(fetchImpl)
    const base = trimBase(baseUrl)
    try {
      const response = await impl(`${base}/account`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
      })
      await ensureOk(response)
      return { ok: true, message: `Connected to Replicate (HTTP ${response.status})` }
    } catch (error) {
      return { ok: false, message: error.message }
    }
  },
}

export default replicateAdapter
