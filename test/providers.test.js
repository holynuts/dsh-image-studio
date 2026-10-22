/**
 * Provider-layer tests. Every HTTP call goes through a hand-written `fetchImpl`
 * stub — no network, no API keys, no environment reads.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

import { adapters, getAdapter, catalog, generateWithAdapter, testAdapter } from '../lib/providers/index.js'
import { encodePng } from '../lib/util/png.js'

const API_KEY = 'sk-test-not-a-real-key-1234'
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function tinyPng(tint = 200) {
  return encodePng(2, 2, new Uint8Array(2 * 2 * 4).fill(tint))
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesResponse(bytes, mediaType = 'image/png') {
  return new Response(bytes, { status: 200, headers: { 'content-type': mediaType } })
}

function headerObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) out[key.toLowerCase()] = String(value)
  } else {
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value)
  }
  return out
}

/** Wraps a handler: (call, index, calls) → Response. Records every call. */
function stubFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      headers: headerObject(init.headers),
      body: init.body,
      signal: init.signal,
      json() {
        return JSON.parse(String(this.body))
      },
    }
    calls.push(call)
    return handler(call, calls.length - 1, calls)
  }
  impl.calls = calls
  return impl
}

function formEntries(body) {
  assert.ok(body instanceof FormData, 'expected a FormData body')
  return [...body.entries()]
}

function field(entries, name) {
  const hit = entries.find(([key]) => key === name)
  return hit ? hit[1] : undefined
}

function idatOf(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const parts = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'IDAT') parts.push(Buffer.from(png.subarray(offset + 8, offset + 8 + length)))
    offset += 12 + length
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

/* ------------------------------------------------------------------ Gemini */

test('gemini: request shape (URL, key header, JSON body) and steps parsing', async () => {
  const png = tinyPng()
  const fetchImpl = stubFetch(() =>
    jsonResponse({
      steps: [
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'Here is your image.' },
            { type: 'image', data: base64(png), mime_type: 'image/png' },
          ],
        },
      ],
    }),
  )

  const result = await generateWithAdapter({
    adapterId: 'gemini',
    apiKey: API_KEY,
    model: 'gemini-nano-banana-2.1',
    prompt: 'a red fox in snow',
    negativePrompt: 'blurry',
    aspect: '16:9',
    quality: '2k',
    refs: [{ data: tinyPng(9), mediaType: 'image/png' }],
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 1)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/interactions')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers['x-goog-api-key'], API_KEY)
  assert.match(call.headers['content-type'], /application\/json/)

  const body = call.json()
  assert.equal(body.model, 'gemini-nano-banana-2.1')
  assert.equal(body.store, false)
  assert.deepEqual(body.response_format, {
    type: 'image',
    mime_type: 'image/jpeg',
    aspect_ratio: '16:9',
    image_size: '2K',
  })
  assert.equal(body.input.length, 2)
  assert.deepEqual(body.input[0], { type: 'text', text: 'a red fox in snow\n\nAvoid: blurry' })
  assert.equal(body.input[1].type, 'image')
  assert.equal(body.input[1].mime_type, 'image/png')
  assert.equal(body.input[1].data, base64(tinyPng(9)))

  assert.equal(result.images.length, 1)
  assert.deepEqual(result.images[0].data, png)
  assert.equal(result.images[0].mediaType, 'image/png')
})

test('gemini: tolerant parsing (output_image, inline_data, deep nesting) and no aspect/image_size when unset', async () => {
  const png = tinyPng(77)
  const bodies = []
  let response
  const fetchImpl = stubFetch((call) => {
    bodies.push(call.json())
    return response
  })

  response = jsonResponse({ output_image: { data: base64(png), mime_type: 'image/png' } })
  let result = await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'p', fetchImpl })
  assert.deepEqual(result.images[0].data, png)
  assert.equal(bodies[0].response_format.aspect_ratio, undefined)
  assert.equal(bodies[0].response_format.image_size, undefined)
  assert.equal(bodies[0].input[0].type, 'text')

  // camelCase inlineData nested inside candidates → content → parts
  response = jsonResponse({
    candidates: [{ content: { parts: [{ inlineData: { data: base64(png), mimeType: 'image/png' } }] } }],
  })
  result = await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'p', fetchImpl })
  assert.deepEqual(result.images[0].data, png)

  // snake_case steps with inline_data (and a text part that must be ignored)
  response = jsonResponse({
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'no image here' }] },
      { type: 'model_output', content: [{ type: 'image', inline_data: { data: base64(png), mime_type: 'image/png' } }] },
    ],
  })
  result = await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'p', fetchImpl })
  assert.deepEqual(result.images[0].data, png)
})

test('gemini: count issues parallel requests, capped at 4', async () => {
  const png = tinyPng(31)
  const fetchImpl = stubFetch(() => jsonResponse({ output_image: { data: base64(png), mime_type: 'image/png' } }))

  const two = await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'p', count: 2, fetchImpl })
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(two.images.length, 2)
  assert.equal(two.images[1].mediaType, 'image/png')

  fetchImpl.calls.length = 0
  const capped = await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'p', count: 9, fetchImpl })
  assert.equal(fetchImpl.calls.length, 4)
  assert.equal(capped.images.length, 4)
})

/* ------------------------------------------------------------------ OpenAI */

test('openai: generations request shape and b64 decode', async () => {
  const png = tinyPng(120)
  const fetchImpl = stubFetch(() =>
    jsonResponse({
      created: 1,
      data: [{ b64_json: base64(png) }, { b64_json: base64(tinyPng(121)) }],
    }),
  )

  const result = await generateWithAdapter({
    adapterId: 'openai',
    apiKey: API_KEY,
    model: 'gpt-image-2.5-flare',
    prompt: 'a lighthouse at dusk',
    size: '1536x1024',
    quality: 'high',
    count: 2,
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 1)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.openai.com/v1/images/generations')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.authorization, `Bearer ${API_KEY}`)
  assert.match(call.headers['content-type'], /application\/json/)
  assert.deepEqual(call.json(), {
    model: 'gpt-image-2.5-flare',
    prompt: 'a lighthouse at dusk',
    n: 2,
    output_format: 'png',
    size: '1536x1024',
    quality: 'high',
  })

  assert.equal(result.images.length, 2)
  assert.deepEqual(result.images[0].data, png)
  assert.equal(result.images[0].mediaType, 'image/png')
})

test('openai: edits uses multipart with repeated image fields', async () => {
  const png = tinyPng(55)
  const fetchImpl = stubFetch(() => jsonResponse({ data: [{ b64_json: base64(png) }] }))

  const result = await generateWithAdapter({
    adapterId: 'openai',
    apiKey: API_KEY,
    model: 'gpt-image-2.5-sunburst',
    prompt: 'same style, new scene',
    count: 2,
    refs: [
      { data: tinyPng(1), mediaType: 'image/png' },
      { data: tinyPng(2), mediaType: 'image/jpeg' },
    ],
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 1)
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.openai.com/v1/images/edits')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(call.headers['content-type'], undefined, 'multipart boundary must be left to fetch')

  const entries = formEntries(call.body)
  const imageEntries = entries.filter(([key]) => key === 'image')
  assert.equal(imageEntries.length, 2)
  assert.ok(imageEntries[0][1] instanceof Blob)
  assert.equal(imageEntries[0][1].type, 'image/png')
  assert.equal(imageEntries[1][1].type, 'image/jpeg')
  assert.equal(imageEntries[0][1].name, 'reference-1.png')
  assert.equal(field(entries, 'model'), 'gpt-image-2.5-sunburst')
  assert.equal(field(entries, 'prompt'), 'same style, new scene')
  assert.equal(field(entries, 'n'), '2')

  assert.deepEqual(result.images[0].data, png)
})

/* --------------------------------------------------------------------- fal */

test('fal: Key auth header, JSON body, downloads the returned URL', async () => {
  const png = tinyPng(210)
  const fetchImpl = stubFetch((call) => {
    if (call.url === 'https://cdn.fal.example/out.png') return bytesResponse(png)
    return jsonResponse({
      images: [{ url: 'https://cdn.fal.example/out.png', width: 1280, height: 720, content_type: 'image/png' }],
    })
  })

  const result = await generateWithAdapter({
    adapterId: 'fal',
    apiKey: 'fal-key-1234',
    model: 'fal-ai/flux-2-pro',
    prompt: 'a paper city',
    aspect: '16:9',
    seed: 42,
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 2)
  const request = fetchImpl.calls[0]
  assert.equal(request.url, 'https://fal.run/fal-ai/flux-2-pro')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.authorization, 'Key fal-key-1234')
  assert.match(request.headers['content-type'], /application\/json/)
  assert.deepEqual(request.json(), {
    prompt: 'a paper city',
    num_images: 1,
    sync_mode: true,
    image_size: '16:9',
    seed: 42,
  })

  const download = fetchImpl.calls[1]
  assert.equal(download.url, 'https://cdn.fal.example/out.png')
  assert.equal(download.method, 'GET')
  assert.equal(download.headers.authorization, undefined)
  assert.deepEqual(result.images[0].data, png)
  assert.equal(result.images[0].mediaType, 'image/png')
  assert.equal(result.images[0].width, 1280)
  assert.equal(result.images[0].height, 720)
})

test('fal: sync_mode data: URIs are decoded without a download', async () => {
  const png = tinyPng(66)
  const fetchImpl = stubFetch(() =>
    jsonResponse({ images: [{ url: `data:image/png;base64,${base64(png)}` }] }),
  )

  const result = await generateWithAdapter({
    adapterId: 'fal',
    apiKey: 'fal-key-1234',
    model: 'fal-ai/nano-banana-2.1',
    prompt: 'x',
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(result.images[0].data, png)
  assert.equal(result.images[0].mediaType, 'image/png')
})

/* --------------------------------------------------------------- Replicate */

test('replicate: Prefer wait, array-of-URLs output, authorized delivery download', async () => {
  const png = tinyPng(150)
  const fetchImpl = stubFetch((call) => {
    if (call.url.startsWith('https://replicate.delivery/')) return bytesResponse(png)
    return jsonResponse({
      id: 'pred_1',
      status: 'succeeded',
      output: ['https://replicate.delivery/pbxt/one.png', 'https://replicate.delivery/pbxt/two.png'],
    })
  })

  const result = await generateWithAdapter({
    adapterId: 'replicate',
    apiKey: API_KEY,
    model: 'google/nano-banana-2.1',
    prompt: 'a brass robot',
    aspect: '1:1',
    count: 2,
    fetchImpl,
  })

  assert.equal(fetchImpl.calls.length, 3)
  const request = fetchImpl.calls[0]
  assert.equal(request.url, 'https://api.replicate.com/v1/models/google/nano-banana-2.1/predictions')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(request.headers.prefer, 'wait')
  assert.deepEqual(request.json(), {
    input: { prompt: 'a brass robot', num_outputs: 2, aspect_ratio: '1:1' },
  })

  assert.equal(fetchImpl.calls[1].headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(fetchImpl.calls[2].headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(result.images.length, 2)
  assert.deepEqual(result.images[0].data, png)
})

test('replicate: polls the prediction endpoint until output appears', async () => {
  const png = tinyPng(88)
  let polls = 0
  const fetchImpl = stubFetch((call) => {
    if (call.method === 'POST') return jsonResponse({ id: 'pred_2', status: 'processing', output: null })
    if (call.url.endsWith('/predictions/pred_2')) {
      polls += 1
      return jsonResponse({ id: 'pred_2', status: 'succeeded', output: 'https://cdn.example/pred_2.png' })
    }
    return bytesResponse(png)
  })

  const result = await generateWithAdapter({
    adapterId: 'replicate',
    apiKey: API_KEY,
    model: 'black-forest-labs/flux-2-pro',
    prompt: 'x',
    fetchImpl,
  })

  assert.equal(polls, 1)
  assert.equal(fetchImpl.calls.length, 3)
  const poll = fetchImpl.calls[1]
  assert.equal(poll.url, 'https://api.replicate.com/v1/predictions/pred_2')
  assert.equal(poll.method, 'GET')
  assert.equal(poll.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(fetchImpl.calls[2].headers.authorization, undefined, 'non-delivery hosts get no auth')
  assert.deepEqual(result.images[0].data, png)
})

/* -------------------------------------------------------- OpenAI-compatible */

test('openai-compatible: /v1 is not doubled and URL responses are downloaded', async () => {
  const png = tinyPng(99)
  const fetchImpl = stubFetch((call) => {
    if (call.url === 'https://cdn.gw.example/img.png') return bytesResponse(png)
    return jsonResponse({ data: [{ url: 'https://cdn.gw.example/img.png' }] })
  })

  const result = await generateWithAdapter({
    adapterId: 'openai-compatible',
    apiKey: API_KEY,
    baseUrl: 'https://gw.example.com/v1/',
    model: 'my-image-model',
    prompt: 'a kite',
    size: '1024x1024',
    fetchImpl,
  })

  assert.equal(fetchImpl.calls[0].url, 'https://gw.example.com/v1/images/generations')
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${API_KEY}`)
  assert.deepEqual(fetchImpl.calls[0].json(), {
    model: 'my-image-model',
    prompt: 'a kite',
    n: 1,
    response_format: 'b64_json',
    size: '1024x1024',
  })
  assert.equal(fetchImpl.calls[1].url, 'https://cdn.gw.example/img.png')
  assert.deepEqual(result.images[0].data, png)

  // A base without a version segment gains /v1; b64_json responses are accepted.
  const barePng = tinyPng(100)
  const bare = stubFetch(() => jsonResponse({ data: [{ b64_json: base64(barePng) }] }))
  await generateWithAdapter({
    adapterId: 'openai-compatible',
    apiKey: API_KEY,
    baseUrl: 'https://gw.example.com',
    model: 'my-image-model',
    prompt: 'x',
    fetchImpl: bare,
  })
  assert.equal(bare.calls[0].url, 'https://gw.example.com/v1/images/generations')
})

/* -------------------------------------------------------------------- mock */

test('mock: deterministic, valid PNG with IHDR 1280x720 for 16:9', async () => {
  const first = await generateWithAdapter({
    adapterId: 'mock',
    model: 'mock-1',
    prompt: 'a green meadow',
    seed: 7,
    aspect: '16:9',
  })
  const again = await generateWithAdapter({
    adapterId: 'mock',
    model: 'mock-1',
    prompt: 'a green meadow',
    seed: 7,
    aspect: '16:9',
  })

  const png = first.images[0].data
  assert.ok(png instanceof Uint8Array)
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE)
  assert.equal(String.fromCharCode(...png.subarray(12, 16)), 'IHDR')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  assert.equal(view.getUint32(16), 1280)
  assert.equal(view.getUint32(20), 720)
  assert.equal(first.images[0].width, 1280)
  assert.equal(first.images[0].height, 720)

  // Pixel payload inflates to exactly one filter byte + RGBA per pixel per row.
  assert.equal(inflateSync(idatOf(png)).length, (1280 * 4 + 1) * 720)
  assert.deepEqual(first.images[0].data, again.images[0].data)

  const other = await generateWithAdapter({ adapterId: 'mock', model: 'mock-1', prompt: 'a green meadow', seed: 8, aspect: '16:9' })
  assert.notDeepEqual(first.images[0].data, other.images[0].data)
})

/* ------------------------------------------------------------------ errors */

test('errors: 401 keeps the provider message, status and body but never the key', async () => {
  const secret = 'AIzaSy-SUPER-SECRET-KEY-9999'
  const fetchImpl = stubFetch(() =>
    jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 401),
  )

  let caught
  try {
    await generateWithAdapter({
      adapterId: 'gemini',
      apiKey: secret,
      model: 'gemini-nano-banana-2.1',
      prompt: 'x',
      fetchImpl,
    })
  } catch (error) {
    caught = error
  }

  assert.ok(caught instanceof Error)
  assert.equal(caught.status, 401)
  assert.match(caught.message, /API key not valid/)
  assert.doesNotMatch(caught.message, new RegExp(secret))
  assert.doesNotMatch(`${caught.message} ${caught.hint} ${caught.body}`, new RegExp(secret))
  assert.match(caught.body, /API key not valid/)
  assert.ok(caught.hint.length > 0)
})

/* ------------------------------------------------------- catalog/registry */

function assertNoFunctions(value, path = 'catalog') {
  if (typeof value === 'function') assert.fail(`function found at ${path}`)
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) assertNoFunctions(child, `${path}.${key}`)
}

test('catalog: function-free, structuredClone-safe, unique adapter ids', () => {
  const list = catalog()
  assert.ok(Array.isArray(list))
  assertNoFunctions(list)
  assert.deepEqual(structuredClone(list), list)
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list)

  const ids = list.map((provider) => provider.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(adapters().map((adapter) => adapter.id), ids)

  const keys = new Set(ids)
  for (const id of ['gemini', 'openai', 'fal', 'replicate', 'openai-compatible', 'mock']) {
    assert.ok(keys.has(id), `missing adapter ${id}`)
  }

  const gemini = list.find((provider) => provider.id === 'gemini')
  assert.equal(gemini.models[0].id, 'gemini-nano-banana-2.1')
  assert.deepEqual(gemini.models[0].qualities, ['1K', '2K', '4K'])
  assert.equal(gemini.models[0].maxRefs, 14)
  assert.equal(gemini.keyUrl, 'https://aistudio.google.com/apikey')

  const openai = list.find((provider) => provider.id === 'openai')
  assert.deepEqual(openai.models[0].sizes, ['1024x1024', '1536x1024', '1024x1536'])
  assert.ok(openai.models[0].qualities.includes('xhigh'))
  assert.equal(openai.keyUrl, 'https://platform.openai.com/api-keys')

  assert.equal(getAdapter('fal').keyUrl, 'https://fal.ai/dashboard/keys')
  assert.equal(getAdapter('replicate').keyUrl, 'https://replicate.com/account/api-tokens')
  assert.equal(getAdapter('mock').needsApiKey, false)
  const mock = list.find((provider) => provider.id === 'mock')
  assert.equal(mock.models[0].supportsRefs, true)
  assert.equal(mock.models[0].maxRefs, 4)
  assert.equal(getAdapter('nope'), undefined)
  assert.equal(getAdapter('gemini').kind, 'sync')
  assert.equal(getAdapter('replicate').kind, 'async')
})

test('registry: validation, signals, and offline test results', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ models: [] }))

  await assert.rejects(
    generateWithAdapter({ adapterId: 'nope', prompt: 'x', apiKey: API_KEY, fetchImpl }),
    /Unknown image provider/,
  )
  await assert.rejects(
    generateWithAdapter({ adapterId: 'gemini', prompt: 'x', apiKey: '', fetchImpl }),
    /not configured/,
  )
  await assert.rejects(
    generateWithAdapter({ adapterId: 'openai-compatible', prompt: 'x', apiKey: API_KEY, baseUrl: '', fetchImpl }),
    /Choose a model/,
  )

  const controller = new AbortController()
  const withSignal = stubFetch(() =>
    jsonResponse({ output_image: { data: base64(tinyPng()), mime_type: 'image/png' } }),
  )
  await generateWithAdapter({ adapterId: 'gemini', apiKey: API_KEY, prompt: 'x', signal: controller.signal, fetchImpl: withSignal })
  assert.equal(withSignal.calls[0].signal, controller.signal)

  const mockOffline = await generateWithAdapter({ adapterId: 'mock', model: 'mock-1', prompt: 'x', aspect: '1:1' })
  assert.equal(mockOffline.images.length, 1)

  const mockTest = await testAdapter({ adapterId: 'mock' })
  assert.equal(mockTest.ok, true)
  assert.equal(typeof mockTest.latencyMs, 'number')

  const falTest = await testAdapter({ adapterId: 'fal', apiKey: 'fal-key' })
  assert.equal(falTest.ok, false)
  assert.match(falTest.message, /Test image/)

  const geminiProbe = stubFetch(() => jsonResponse({ models: [{ name: 'models/gemini-nano-banana-2.1' }] }))
  const geminiTest = await testAdapter({ adapterId: 'gemini', apiKey: API_KEY, fetchImpl: geminiProbe })
  assert.equal(geminiTest.ok, true)
  assert.ok(geminiTest.latencyMs >= 0)
  assert.equal(geminiProbe.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1')
  assert.equal(geminiProbe.calls[0].headers['x-goog-api-key'], API_KEY)

  const openaiProbe = stubFetch(() => jsonResponse({ data: [] }))
  const openaiTest = await testAdapter({ adapterId: 'openai', apiKey: API_KEY, fetchImpl: openaiProbe })
  assert.equal(openaiTest.ok, true)
  assert.equal(openaiProbe.calls[0].url, 'https://api.openai.com/v1/models')
  assert.equal(openaiProbe.calls[0].headers.authorization, `Bearer ${API_KEY}`)

  const replicateProbe = stubFetch(() => jsonResponse({ username: 'tester' }))
  const replicateTest = await testAdapter({ adapterId: 'replicate', apiKey: API_KEY, fetchImpl: replicateProbe })
  assert.equal(replicateTest.ok, true)
  assert.equal(replicateProbe.calls[0].url, 'https://api.replicate.com/v1/account')
  assert.equal(replicateProbe.calls[0].headers.authorization, `Bearer ${API_KEY}`)
})

test('openai-compatible: capability test probes /v1/models without doubling', async () => {
  const fetchImpl = stubFetch(() => jsonResponse({ data: [] }))
  const result = await testAdapter({
    adapterId: 'openai-compatible',
    apiKey: API_KEY,
    baseUrl: 'https://gw.example.com/v1',
    fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(fetchImpl.calls[0].url, 'https://gw.example.com/v1/models')
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${API_KEY}`)
})

test('shared: negative prompt reaches every provider and signal is forwarded', async () => {
  const png = tinyPng(180)
  const controller = new AbortController()
  const negative = 'watermark, text'

  const cases = [
    {
      adapterId: 'gemini',
      model: 'gemini-nano-banana-2.1',
      handler: () => jsonResponse({ output_image: { data: base64(png), mime_type: 'image/png' } }),
    },
    {
      adapterId: 'openai',
      model: 'gpt-image-2.5-flare',
      handler: () => jsonResponse({ data: [{ b64_json: base64(png) }] }),
    },
    {
      adapterId: 'fal',
      model: 'fal-ai/flux-2-pro',
      handler: () => jsonResponse({ images: [{ url: `data:image/png;base64,${base64(png)}` }] }),
    },
    {
      adapterId: 'replicate',
      model: 'google/nano-banana-2.1',
      handler: (call) =>
        call.method === 'POST'
          ? jsonResponse({ id: 'pred_shared', status: 'succeeded', output: 'https://cdn.example/shared.png' })
          : bytesResponse(png),
    },
    {
      adapterId: 'openai-compatible',
      model: 'my-image-model',
      baseUrl: 'https://gw.example.com/v1',
      handler: () => jsonResponse({ data: [{ b64_json: base64(png) }] }),
    },
  ]

  for (const item of cases) {
    const fetchImpl = stubFetch(item.handler)
    const result = await generateWithAdapter({
      adapterId: item.adapterId,
      apiKey: API_KEY,
      baseUrl: item.baseUrl,
      model: item.model,
      prompt: 'shared prompt',
      negativePrompt: negative,
      signal: controller.signal,
      fetchImpl,
    })
    const request = fetchImpl.calls[0]
    assert.match(String(request.body), /shared prompt/, `${item.adapterId} prompt`)
    assert.match(String(request.body), /Avoid: watermark, text/, `${item.adapterId} negative prompt`)
    assert.equal(request.signal, controller.signal, `${item.adapterId} signal`)
    assert.equal(result.images.length, 1, `${item.adapterId} image`)
    assert.deepEqual(result.images[0].data, png, `${item.adapterId} bytes`)
    if (item.adapterId === 'replicate') {
      assert.equal(fetchImpl.calls[1].signal, controller.signal, 'replicate download signal')
    }
  }
})
