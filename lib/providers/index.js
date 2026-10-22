/**
 * Provider registry and the single entry point the host uses to talk to them.
 *
 *   adapters()               → frozen list of adapter objects (with functions)
 *   getAdapter(id)           → adapter | undefined
 *   catalog()                → JSON-safe, function-free descriptors
 *   generateWithAdapter(req) → {images:[{data,mediaType,width?,height?}], revisedPrompt, raw}
 *   testAdapter(req)         → {ok, latencyMs, message}
 *
 * `generateWithAdapter` owns the shared validation/wrapping so every adapter can
 * stay focused on its wire format: fetch resolution, API-key requirement, model
 * defaulting, ref normalisation, and status/body/hint preserved on thrown errors.
 */
import { geminiAdapter } from './gemini.js'
import { openaiAdapter } from './openai.js'
import { falAdapter } from './fal.js'
import { replicateAdapter } from './replicate.js'
import { openaiCompatibleAdapter } from './openai-compatible.js'
import { mockAdapter } from './mock.js'
import { vertexAdapter } from './vertex.js'

const ADAPTERS = Object.freeze([
  geminiAdapter,
  vertexAdapter,
  openaiAdapter,
  falAdapter,
  replicateAdapter,
  openaiCompatibleAdapter,
  mockAdapter,
])

const BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]))

function asString(value) {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim()
}

function clampCount(value) {
  const count = Number.parseInt(value, 10)
  if (!Number.isFinite(count) || count < 1) return 1
  return Math.min(4, count)
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl
  if (typeof globalThis.fetch === 'function') return globalThis.fetch
  throw new Error('No fetch implementation is available — run on Node 18+ or pass fetchImpl.')
}

/** Redact a credential from any text that might reach the caller. */
function redact(text, apiKey) {
  const message = asString(text)
  if (!message || !apiKey || apiKey.length < 4) return message
  return message.split(apiKey).join('***')
}

function hintFor(adapter, status) {
  if (status === 401 || status === 403) {
    return adapter.keyUrl ? `Check the API key (${adapter.keyUrl}).` : 'Check the API key for this provider.'
  }
  if (status === 402) return 'The provider account may be out of credit.'
  if (status === 404) return 'Check the model id and endpoint URL.'
  if (status === 429) return 'Rate limited — wait a moment and retry.'
  if (typeof status === 'number' && status >= 500) return 'The provider had a server error — retry shortly.'
  return ''
}

/** Normalise one reference into `{data: Uint8Array, mediaType}`. */
function normalizeRef(ref) {
  if (!ref || typeof ref !== 'object') return undefined
  let data = ref.data
  let mediaType = asString(ref.mediaType)
  if (typeof data === 'string') {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(data)
    if (match && !mediaType) mediaType = match[1]
    const cleaned = (match ? match[2] : data).replace(/\s+/g, '')
    data = new Uint8Array(Buffer.from(cleaned, 'base64'))
  } else if (data instanceof ArrayBuffer) {
    data = new Uint8Array(data)
  }
  if (!(data instanceof Uint8Array) || data.length === 0) return undefined
  return { data, mediaType: mediaType || 'image/png' }
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return []
  return refs.map(normalizeRef).filter(Boolean)
}

function wrapError(error, adapter, apiKey) {
  const source = error instanceof Error ? error : new Error(String(error ?? 'Unknown error'))
  const wrapped = new Error(redact(source.message, apiKey), { cause: source })
  if (source.name && source.name !== 'Error') wrapped.name = source.name
  if (source.status !== undefined) wrapped.status = source.status
  if (source.body !== undefined) wrapped.body = source.body
  wrapped.hint = redact(source.hint || hintFor(adapter, source.status), apiKey)
  return wrapped
}

/** JSON-safe descriptor: fresh arrays/objects, no functions, structuredClone-safe. */
function describe(adapter) {
  return {
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind,
    docsUrl: adapter.docsUrl || '',
    keyRefs: [...(adapter.keyRefs || [])],
    keyHint: adapter.keyHint || '',
    keyUrl: adapter.keyUrl || '',
    defaultBaseUrl: adapter.defaultBaseUrl || '',
    configurableBaseUrl: Boolean(adapter.configurableBaseUrl),
    beta: Boolean(adapter.beta),
    needsApiKey: adapter.needsApiKey !== false,
    hasTest: typeof adapter.test === 'function',
    ambientAuth: adapter.ambientAuth === true,
    options: Array.isArray(adapter.options) ? adapter.options.map((option) => ({ ...option })) : [],
    models: (adapter.models || []).map((model) => ({
      id: model.id,
      label: model.label,
      aspects: [...(model.aspects || [])],
      sizes: [...(model.sizes || [])],
      qualities: [...(model.qualities || [])],
      supportsRefs: Boolean(model.supportsRefs),
      maxRefs: Number.isFinite(model.maxRefs) ? model.maxRefs : 0,
      note: model.note || '',
    })),
  }
}

/** Frozen array of adapter objects (internal handlers included). */
export function adapters() {
  return ADAPTERS
}

/** Look up an adapter by its stable id. */
export function getAdapter(id) {
  return BY_ID.get(asString(id).toLowerCase())
}

/** Function-free copy of every provider descriptor; safe to JSON.stringify or structuredClone. */
export function catalog() {
  return ADAPTERS.map(describe)
}

/**
 * Call one adapter. Resolves fetch (default globalThis.fetch), validates the
 * adapter and API key, defaults the model, normalises refs, and rethrows provider
 * failures as `Error` with `status`, `body` and `hint` preserved.
 */
export async function generateWithAdapter(input = {}) {
  const adapterId = asString(input.adapterId ?? input.provider)
  const adapter = getAdapter(adapterId)
  if (!adapter) {
    const error = new Error(`Unknown image provider "${adapterId || '(none)'}"`)
    error.hint = 'Pick a provider from the list.'
    throw error
  }

  const apiKey = asString(input.apiKey)
  if (adapter.needsApiKey !== false && !apiKey) {
    const error = new Error(`${adapter.label} is not configured — add an API key first.`)
    error.hint = adapter.keyUrl ? `Get a key at ${adapter.keyUrl}` : `Add an API key for ${adapter.label}.`
    throw error
  }

  const fetchImpl = resolveFetch(input.fetchImpl)
  const model = asString(input.model) || adapter.models[0]?.id || ''
  if (!model) {
    const error = new Error(`Choose a model for ${adapter.label}.`)
    error.hint = 'Type the model id the endpoint expects.'
    throw error
  }

  const req = {
    apiKey,
    model,
    prompt: asString(input.prompt),
    negativePrompt: asString(input.negativePrompt),
    aspect: asString(input.aspect),
    size: asString(input.size),
    quality: asString(input.quality),
    resolution: asString(input.resolution),
    count: clampCount(input.count),
    seed: Number.isFinite(input.seed) ? input.seed : null,
    refs: normalizeRefs(input.refs),
    background: asString(input.background),
    baseUrl: asString(input.baseUrl) || adapter.defaultBaseUrl,
    options: input.options && typeof input.options === 'object' ? input.options : undefined,
    signal: input.signal,
    fetchImpl,
  }

  let result
  try {
    result = await adapter.generate(req)
  } catch (error) {
    throw wrapError(error, adapter, apiKey)
  }

  if (!result || !Array.isArray(result.images) || result.images.length === 0) {
    throw wrapError(new Error(`${adapter.label} returned no images.`), adapter, apiKey)
  }

  const images = result.images.map((image, index) => {
    const data = image?.data
    if (!(data instanceof Uint8Array) || data.length === 0) {
      throw wrapError(new Error(`${adapter.label} returned an empty image at index ${index}.`), adapter, apiKey)
    }
    return {
      data,
      mediaType: asString(image.mediaType) || 'image/png',
      width: Number.isFinite(image.width) ? image.width : undefined,
      height: Number.isFinite(image.height) ? image.height : undefined,
    }
  })

  return { images, revisedPrompt: asString(result.revisedPrompt), raw: result.raw }
}

/** Run the adapter's lightweight capability probe. Never throws. */
export async function testAdapter(input = {}) {
  const startedAt = Date.now()
  const adapterId = asString(input.adapterId ?? input.provider)
  const adapter = getAdapter(adapterId)
  if (!adapter) {
    return { ok: false, latencyMs: 0, message: `Unknown image provider "${adapterId || '(none)'}"` }
  }
  if (typeof adapter.test !== 'function') {
    return { ok: false, latencyMs: 0, message: `${adapter.label} has no connection test.` }
  }

  const apiKey = asString(input.apiKey)
  if (adapter.needsApiKey !== false && !apiKey) {
    return { ok: false, latencyMs: 0, message: `${adapter.label} needs an API key before it can be tested.` }
  }

  let fetchImpl
  try {
    fetchImpl = resolveFetch(input.fetchImpl)
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: redact(error?.message, apiKey) }
  }

  try {
    const result = await adapter.test({
      apiKey,
      baseUrl: asString(input.baseUrl) || adapter.defaultBaseUrl,
      options: input.options && typeof input.options === 'object' ? input.options : undefined,
      fetchImpl,
    })
    return {
      ok: Boolean(result?.ok),
      latencyMs: Date.now() - startedAt,
      message: redact(result?.message || (result?.ok ? 'Connection OK' : 'Connection failed'), apiKey),
    }
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: redact(error?.message || 'Connection test failed', apiKey) }
  }
}
