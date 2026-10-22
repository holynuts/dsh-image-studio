import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { test } from 'node:test'

import { Library } from '../lib/core/library.js'

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** SPEC §1 default settings, duplicated here so a change is visible. */
const DEFAULT_SETTINGS = {
  version: 1,
  defaults: {
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    aspect: '1:1',
    quality: 'high',
    count: 1,
  },
  providers: {
    fal: { baseUrl: '', defaultModel: 'fal-ai/nano-banana-2.1', models: [] },
    'openai-compatible': { baseUrl: '', defaultModel: '', models: [] },
  },
  ui: { lastTab: 'create', compareTargets: [] },
}

async function setup(t, logger) {
  const root = await mkdtemp(join(tmpdir(), 'image-studio-'))
  const library = new Library({ root, logger })
  await library.init()
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return { root, library }
}

function makeItem(library, overrides = {}) {
  return {
    id: library.newId('img'),
    createdAt: 1_700_000_000_000,
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    prompt: '',
    negativePrompt: '',
    params: { aspect: '1:1', size: '', quality: 'high', count: 1, seed: null, refs: [] },
    status: 'succeeded',
    error: '',
    latencyMs: 10,
    revisedPrompt: '',
    title: '',
    tags: [],
    favorite: false,
    rating: 0,
    notes: '',
    source: { kind: 'ui', sessionId: '', cwd: '', runId: '' },
    images: [],
    ...overrides,
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, payload) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(payload.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), body.length + 4)
  return chunk
}

/** A real, decodable PNG built from scratch (RGB, one filter byte per row). */
function makePng(width = 1, height = 1) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour RGB
  const rowBytes = width * 3 + 1
  const raw = Buffer.alloc(rowBytes * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * rowBytes] = 0 // filter type: none
    for (let x = 0; x < width; x += 1) raw[row * rowBytes + 1 + x * 3] = 0xff
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function u16be(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value)
  return buffer
}

/** SOI + APP0/JFIF + SOF0 with the requested frame size. */
function makeJpeg(width = 4, height = 3) {
  const jfif = Buffer.concat([
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ])
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16be(jfif.length + 2), jfif])
  const sof = Buffer.alloc(17)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2) // length: 8 + 3 components
  sof[4] = 8 // precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3 // components
  for (let component = 0; component < 3; component += 1) {
    sof[10 + component * 3] = component + 1
    sof[11 + component * 3] = 0x11
    sof[12 + component * 3] = 0
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

/** RIFF/WEBP with a VP8L (lossless) header. */
function makeWebpLossless(width = 7, height = 5) {
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f // VP8L signature
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)
  payload.writeUInt32LE(bits >>> 0, 1)
  const header = Buffer.alloc(8)
  header.write('VP8L', 0, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  const chunk = Buffer.concat([header, payload, payload.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(4 + chunk.length, 4)
  return Buffer.concat([riff, Buffer.from('WEBP', 'ascii'), chunk])
}

/** GIF89a with a logical screen descriptor. */
function makeGif(width = 3, height = 2) {
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'ascii')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  return Buffer.concat([header, Buffer.from([0x3b])])
}

/* ------------------------------------------------------------------ */
/* layout + identity                                                   */
/* ------------------------------------------------------------------ */

test('init creates the folder layout and starts from empty defaults', async (t) => {
  const { root, library } = await setup(t)

  for (const directory of ['items', 'images', 'thumbs', 'runs']) {
    const info = await stat(join(root, directory))
    assert.equal(info.isDirectory(), true, `${directory}/ should exist`)
  }
  assert.equal(library.root, resolve(root))
  assert.deepEqual(library.stats(), { itemCount: 0, imageCount: 0, bytes: 0 })
  assert.deepEqual(await library.listItems(), {
    items: [],
    total: 0,
    hasMore: false,
    nextCursor: '',
  })
  assert.deepEqual(await library.readSettings(), DEFAULT_SETTINGS)
  assert.equal(await library.getItem('img_missing'), undefined)
  assert.equal(await library.deleteItem('img_missing'), false)
})

test('newId uses the documented shape and never repeats', async (t) => {
  const { library } = await setup(t)

  const id = library.newId('img')
  assert.match(id, /^img_\d{8}T\d{6}_[0-9a-f]{6}$/)
  assert.match(library.newId('run'), /^run_\d{8}T\d{6}_[0-9a-f]{6}$/)

  const ids = new Set()
  for (let index = 0; index < 500; index += 1) ids.add(library.newId('img'))
  assert.equal(ids.size, 500)
  for (const candidate of ids) assert.match(candidate, /^img_\d{8}T\d{6}_[0-9a-f]{6}$/)
})

/* ------------------------------------------------------------------ */
/* images                                                              */
/* ------------------------------------------------------------------ */

test('saveFiles writes originals and detects real dimensions', async (t) => {
  const { root, library } = await setup(t)
  const id = library.newId('img')
  const png = makePng(1, 1)
  const jpeg = makeJpeg(4, 3)
  const webp = makeWebpLossless(7, 5)
  const gif = makeGif(3, 2)

  const images = await library.saveFiles(id, [
    { data: png, mediaType: 'image/png' },
    { data: jpeg, mediaType: 'image/jpeg' },
    { data: webp, mediaType: 'image/webp' },
    { data: gif, mediaType: 'image/gif' },
  ])

  assert.equal(images.length, 4)
  assert.deepEqual(images.map((image) => image.index), [0, 1, 2, 3])
  assert.deepEqual(images.map((image) => image.file), [
    `images/${id}-0.png`,
    `images/${id}-1.jpg`,
    `images/${id}-2.webp`,
    `images/${id}-3.gif`,
  ])
  assert.deepEqual(images.map((image) => image.mediaType), [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ])
  assert.deepEqual(
    images.map((image) => [image.width, image.height]),
    [[1, 1], [4, 3], [7, 5], [3, 2]],
  )
  assert.equal(images[0].bytes, png.length)
  assert.deepEqual(images.map((image) => image.thumb), ['', '', '', ''])

  assert.deepEqual(await readFile(join(root, 'images', `${id}-0.png`)), png)
  assert.deepEqual(await readFile(join(root, 'images', `${id}-1.jpg`)), jpeg)
  assert.deepEqual(await readFile(join(root, 'images', `${id}-2.webp`)), webp)
  assert.deepEqual(await readFile(join(root, 'images', `${id}-3.gif`)), gif)

  // Caller-supplied dimensions win over the header.
  const suppliedId = library.newId('img')
  const supplied = await library.saveFiles(suppliedId, [
    { data: png, mediaType: 'image/png', width: 64, height: 32 },
  ])
  assert.deepEqual([supplied[0].width, supplied[0].height], [64, 32])

  // Recognised container with no frame header: dimensions stay 0/0.
  const headerlessJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const unknown = await library.saveFiles(library.newId('img'), [
    { data: headerlessJpeg, mediaType: 'image/jpeg' },
  ])
  assert.deepEqual([unknown[0].width, unknown[0].height], [0, 0])

  // Anything that is not a known image must be rejected.
  await assert.rejects(
    library.saveFiles(library.newId('img'), [
      { data: Buffer.from('definitely not an image'), mediaType: 'image/png' },
    ]),
    { message: 'unsupported image bytes' },
  )
  await assert.rejects(
    library.saveFiles(library.newId('img'), [
      { data: Buffer.from([1, 2, 3]), mediaType: 'application/octet-stream' },
    ]),
    { message: 'unsupported image bytes' },
  )
})

test('writeThumb, stats and readImage serve the stored files', async (t) => {
  const { root, library } = await setup(t)
  const id = library.newId('img')
  const original = makePng(1, 1)
  const images = await library.saveFiles(id, [{ data: original, mediaType: 'image/png' }])
  await library.saveItem(
    makeItem(library, { id, images, prompt: 'a cat', title: 'Cat', notes: 'private' }),
  )

  // No thumbnail yet: a thumb request falls back to the original.
  const fallback = await library.readImage(id, 0, { thumb: true })
  assert.equal(fallback.path, join(root, 'images', `${id}-0.png`))

  const thumbPath = await library.writeThumb(id, 0, original, 'image/png')
  assert.equal(thumbPath, `thumbs/${id}-0.png`)
  assert.deepEqual(await readFile(join(root, thumbPath)), original)
  assert.equal(await library.writeThumb(id, 0, Buffer.from('nope'), 'image/unknown'), '')

  await library.updateItem(id, { images: [{ ...images[0], thumb: thumbPath }] })

  const stored = await library.readImage(id, 0)
  assert.equal(stored.path, join(root, 'images', `${id}-0.png`))
  assert.equal(stored.mediaType, 'image/png')
  assert.equal(stored.bytes, original.length)
  assert.deepEqual(stored.data, original)

  const thumb = await library.readImage(id, 0, { thumb: true })
  assert.equal(thumb.path, join(root, 'thumbs', `${id}-0.png`))
  assert.equal(thumb.mediaType, 'image/png')
  assert.deepEqual(thumb.data, original)

  assert.equal(await library.readImage(id, 9), undefined)
  assert.equal(await library.readImage('img_missing', 0), undefined)
  assert.deepEqual(library.stats(), {
    itemCount: 1,
    imageCount: 1,
    bytes: original.length,
  })
})

test('readImage serves images written before their item record exists', async (t) => {
  const { library } = await setup(t)
  const id = library.newId('img')
  const png = makePng(1, 1)
  const saved = await library.saveFiles(id, [{ data: png, mediaType: 'image/png' }])

  // The host reads files back (e.g. to build attachments) before saveItem runs.
  const pending = await library.readImage(id, 0)
  assert.equal(pending.path, join(library.root, saved[0].file))
  assert.equal(pending.mediaType, 'image/png')
  assert.equal(pending.bytes, png.length)
  assert.deepEqual(pending.data, png)

  await library.saveItem(makeItem(library, { id, images: saved }))
  assert.deepEqual((await library.readImage(id, 0)).data, png)

  // An id that never became an item can still be cleaned up; nothing is reported
  // as deleted because no record existed.
  const orphanId = library.newId('img')
  await library.saveFiles(orphanId, [{ data: png, mediaType: 'image/png' }])
  assert.equal(await library.deleteItem(orphanId), false)
  assert.equal(await library.readImage(orphanId, 0), undefined)
})

test('readImage refuses paths that escape the library root', async (t) => {
  const { library } = await setup(t)
  const id = library.newId('img')
  const image = { index: 0, file: '../escape.png', mediaType: 'image/png', bytes: 1, width: 1, height: 1, thumb: '' }
  await library.saveItem(makeItem(library, { id, images: [image] }))

  assert.equal(await library.readImage(id, 0), undefined)

  await library.updateItem(id, { images: [{ ...image, file: '/etc/hosts', thumb: '/etc/hosts' }] })
  assert.equal(await library.readImage(id, 0), undefined)
  assert.equal(await library.readImage(id, 0, { thumb: true }), undefined)
})

/* ------------------------------------------------------------------ */
/* items                                                               */
/* ------------------------------------------------------------------ */

test('saveItem validates, stamps createdAt and round-trips through getItem', async (t) => {
  const { root, library } = await setup(t)
  const id = library.newId('img')
  const item = makeItem(library, { id, createdAt: undefined })

  const before = Date.now()
  const stored = await library.saveItem(item)
  assert.ok(stored.createdAt >= before, 'createdAt should be filled in')

  const onDisk = JSON.parse(await readFile(join(root, 'items', `${id}.json`), 'utf8'))
  assert.equal(onDisk.id, id)
  assert.equal(onDisk.createdAt, stored.createdAt)
  assert.deepEqual(await library.getItem(id), stored)
  assert.equal(await library.getItem('img_missing'), undefined)

  await assert.rejects(
    library.saveItem({ ...makeItem(library), provider: '' }),
    /provider is required/,
  )
  await assert.rejects(
    library.saveItem({ ...makeItem(library), model: '   ' }),
    /model is required/,
  )
  await assert.rejects(
    library.saveItem({ ...makeItem(library), id: '../escape' }),
    /file-safe/,
  )

  const updated = await library.updateItem(id, {
    title: 'Renamed',
    favorite: true,
    rating: 4,
    tags: ['cat'],
    notes: 'searchable note',
  })
  assert.equal(updated.id, id)
  assert.equal(updated.createdAt, stored.createdAt)
  assert.equal(updated.title, 'Renamed')
  assert.equal(updated.favorite, true)
  assert.equal(updated.rating, 4)
  assert.deepEqual(updated.tags, ['cat'])

  const reread = await library.getItem(id)
  assert.equal(reread.title, 'Renamed')
  assert.equal(reread.rating, 4)
  assert.equal(await library.updateItem('img_missing', { title: 'x' }), undefined)
})

test('listItems filters over text, provider, model, favorite and tag', async (t) => {
  const { library } = await setup(t)
  const records = [
    makeItem(library, {
      id: 'img_a',
      createdAt: 1,
      provider: 'gemini',
      model: 'gemini-x',
      prompt: 'Watercolor fox',
      title: 'Fox',
      notes: 'warm palette',
      tags: ['animal', 'warm'],
      favorite: true,
      rating: 5,
    }),
    makeItem(library, {
      id: 'img_b',
      createdAt: 2,
      provider: 'openai',
      model: 'gpt-image-1',
      prompt: 'Neon city',
      title: 'City',
      notes: '',
      tags: ['urban'],
      favorite: false,
    }),
    makeItem(library, {
      id: 'img_c',
      createdAt: 3,
      provider: 'gemini',
      model: 'gemini-y',
      prompt: 'Mountain lake',
      title: 'Lake',
      notes: 'cold',
      tags: ['nature'],
      favorite: true,
    }),
  ]
  for (const record of records) await library.saveItem(record)

  const textCases = [
    ['watercolor', ['img_a']],
    ['FOX', ['img_a']],
    ['warm palette', ['img_a']],
    ['animal', ['img_a']],
    ['gpt-image', ['img_b']],
    ['urban', ['img_b']],
    ['cold', ['img_c']],
    ['no-such-text', []],
  ]
  for (const [q, expected] of textCases) {
    const result = await library.listItems({ q })
    assert.deepEqual(result.items.map((item) => item.id), expected, `q=${q}`)
    assert.equal(result.total, expected.length, `total for q=${q}`)
  }

  assert.deepEqual(
    (await library.listItems({ provider: 'gemini' })).items.map((item) => item.id),
    ['img_c', 'img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ model: 'gpt-image-1' })).items.map((item) => item.id),
    ['img_b'],
  )
  assert.deepEqual(
    (await library.listItems({ favorite: '1' })).items.map((item) => item.id),
    ['img_c', 'img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ favorite: true })).items.map((item) => item.id),
    ['img_c', 'img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ favorite: '0' })).items.map((item) => item.id),
    ['img_c', 'img_b', 'img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ tag: 'warm' })).items.map((item) => item.id),
    ['img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ provider: 'gemini', tag: 'nature', favorite: 1 })).items.map(
      (item) => item.id,
    ),
    ['img_c'],
  )

  const summary = (await library.listItems({ q: 'fox' })).items[0]
  assert.equal(summary.title, 'Fox')
  assert.deepEqual(summary.tags, ['animal', 'warm'])
  assert.equal(summary.favorite, true)
  assert.equal(summary.rating, 5)
  assert.deepEqual(summary.images, [])
  assert.equal('notes' in summary, false)

  assert.deepEqual(
    (await library.listItems({ sort: 'newest' })).items.map((item) => item.id),
    ['img_c', 'img_b', 'img_a'],
  )
  assert.deepEqual(
    (await library.listItems({ sort: 'oldest' })).items.map((item) => item.id),
    ['img_a', 'img_b', 'img_c'],
  )
})

test('listItems pages with a keyset cursor and clamps the limit', async (t) => {
  const { library } = await setup(t)
  for (let index = 0; index < 45; index += 1) {
    await library.saveItem(
      makeItem(library, {
        id: `img_page_${String(index).padStart(2, '0')}`,
        createdAt: 1_000 + index,
      }),
    )
  }

  const first = await library.listItems({})
  assert.equal(first.total, 45)
  assert.equal(first.items.length, 40, 'default limit is 40')
  assert.equal(first.hasMore, true)
  assert.equal(first.nextCursor, 'img_page_05')
  assert.equal(first.items[0].id, 'img_page_44')

  const second = await library.listItems({ cursor: first.nextCursor })
  assert.equal(second.total, 45)
  assert.equal(second.items.length, 5)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, '')
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['img_page_04', 'img_page_03', 'img_page_02', 'img_page_01', 'img_page_00'],
  )

  const all = [...first.items, ...second.items].map((item) => item.id)
  assert.equal(new Set(all).size, 45)

  const oldestFirst = await library.listItems({ sort: 'oldest', limit: 10 })
  assert.equal(oldestFirst.items[0].id, 'img_page_00')
  assert.equal(oldestFirst.hasMore, true)
  const nextChunk = await library.listItems({
    sort: 'oldest',
    limit: 10,
    cursor: oldestFirst.nextCursor,
  })
  assert.equal(nextChunk.items[0].id, 'img_page_10')

  assert.equal((await library.listItems({ limit: 999 })).items.length, 45, 'max 200, then all 45')
  assert.equal((await library.listItems({ limit: 'nope' })).items.length, 40, 'bogus limit -> 40')

  // A cursor that no longer exists restarts the walk instead of crashing.
  const restart = await library.listItems({ cursor: 'img_deleted', limit: 2 })
  assert.deepEqual(restart.items.map((item) => item.id), ['img_page_44', 'img_page_43'])
})

test('deleteItem removes the record and every image/thumb file', async (t) => {
  const { root, library } = await setup(t)
  const id = library.newId('img')
  const png = makePng(2, 2)
  const images = await library.saveFiles(id, [
    { data: png, mediaType: 'image/png' },
    { data: makePng(3, 3), mediaType: 'image/png' },
  ])
  const thumb = await library.writeThumb(id, 0, png, 'image/png')
  images[0].thumb = thumb
  await library.saveItem(makeItem(library, { id, images }))

  // A thumb written without a matching record must still be collected.
  const orphanThumb = await library.writeThumb(id, 1, png, 'image/png')
  assert.ok(orphanThumb)

  assert.deepEqual(library.stats(), {
    itemCount: 1,
    imageCount: 2,
    bytes: images[0].bytes + images[1].bytes,
  })
  assert.equal(await library.deleteItem(id), true)
  assert.equal(await library.getItem(id), undefined)
  assert.deepEqual((await library.listItems()).items, [])
  assert.deepEqual(library.stats(), { itemCount: 0, imageCount: 0, bytes: 0 })

  for (const relative of [
    `images/${id}-0.png`,
    `images/${id}-1.png`,
    thumb,
    orphanThumb,
  ]) {
    await assert.rejects(stat(join(root, relative)), { code: 'ENOENT' })
  }
  assert.equal(await library.deleteItem(id), false)
})

test('recentPrompts dedupes, trims and ignores empty or failed prompts', async (t) => {
  const { library } = await setup(t)
  const rows = [
    ['img_p1', '  a cat  ', 'succeeded', 100],
    ['img_p2', 'a cat', 'succeeded', 300],
    ['img_p3', 'a dog', 'succeeded', 200],
    ['img_p4', '', 'succeeded', 400],
    ['img_p5', '   ', 'succeeded', 500],
    ['img_p6', 'broken prompt', 'failed', 600],
  ]
  for (const [id, prompt, status, createdAt] of rows) {
    await library.saveItem(makeItem(library, { id, prompt, status, createdAt }))
  }

  assert.deepEqual(await library.recentPrompts(), [
    { prompt: 'a cat', lastUsedAt: 300, uses: 2 },
    { prompt: 'a dog', lastUsedAt: 200, uses: 1 },
  ])
  assert.deepEqual((await library.recentPrompts(1)).map((entry) => entry.prompt), ['a cat'])
})

/* ------------------------------------------------------------------ */
/* settings + runs                                                     */
/* ------------------------------------------------------------------ */

test('writeSettings deep-merges objects, replaces arrays and persists', async (t) => {
  const { root, library } = await setup(t)
  assert.deepEqual(await library.readSettings(), DEFAULT_SETTINGS)

  const first = await library.writeSettings({ ui: { lastTab: 'library' } })
  assert.equal(first.ui.lastTab, 'library')
  assert.deepEqual(first.ui.compareTargets, [])
  assert.equal(first.defaults.provider, 'gemini')

  const second = await library.writeSettings({
    defaults: { count: 2 },
    ui: { compareTargets: ['gemini', 'openai'] },
  })
  assert.equal(second.defaults.count, 2)
  assert.equal(second.defaults.model, 'gemini-nano-banana-2.1', 'sibling defaults survive')
  assert.deepEqual(second.ui.compareTargets, ['gemini', 'openai'])
  assert.equal(second.ui.lastTab, 'library')
  assert.equal(second.version, 1)

  const third = await library.writeSettings({ ui: { compareTargets: ['fal'] } })
  assert.deepEqual(third.ui.compareTargets, ['fal'], 'arrays replace, they do not append')

  const onDisk = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
  assert.deepEqual(onDisk, third)

  const reloaded = new Library({ root })
  await reloaded.init()
  assert.deepEqual(await reloaded.readSettings(), third)

  await assert.rejects(library.writeSettings(null), /must be an object/)
})

test('readSettings falls back to defaults for a missing or malformed file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'image-studio-'))
  const warnings = []
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const library = new Library({ root, logger: { warn: (...args) => warnings.push(args) } })
  await library.init()
  assert.deepEqual(await library.readSettings(), DEFAULT_SETTINGS)

  await writeFile(join(root, 'settings.json'), '{ not json')
  assert.deepEqual(await library.readSettings(), DEFAULT_SETTINGS)
  assert.ok(warnings.length >= 1)

  await writeFile(join(root, 'settings.json'), JSON.stringify({ defaults: { count: 3 } }))
  const partial = await library.readSettings()
  assert.equal(partial.defaults.count, 3)
  assert.equal(partial.defaults.provider, 'gemini', 'missing defaults are backfilled')
})

test('runs persist, sort newest-first and tolerate malformed records', async (t) => {
  const warnings = []
  const root = await mkdtemp(join(tmpdir(), 'image-studio-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'items'), { recursive: true })
  await mkdir(join(root, 'runs'), { recursive: true })
  await writeFile(join(root, 'items', 'broken.json'), '{ not json')
  await writeFile(join(root, 'items', 'not-an-item.json'), JSON.stringify([1, 2, 3]))
  await writeFile(join(root, 'runs', 'broken.json'), 'nope')

  const library = new Library({ root, logger: { warn: (...args) => warnings.push(args) } })
  await library.init()
  assert.deepEqual((await library.listItems()).items, [])
  assert.deepEqual(await library.listRuns(), [])
  assert.ok(warnings.length >= 3, 'each bad record is reported once')

  const first = await library.saveRun({
    id: 'run_a',
    createdAt: 100,
    prompt: 'x',
    targets: [],
    results: [],
  })
  assert.equal(first.id, 'run_a')
  const second = await library.saveRun({
    id: 'run_b',
    createdAt: 200,
    prompt: 'y',
    targets: [],
    results: [],
  })
  assert.equal(second.createdAt, 200)
  const stamped = await library.saveRun({ id: 'run_c' })
  assert.ok(stamped.createdAt > 0, 'saveRun stamps a missing createdAt')

  assert.deepEqual(await library.getRun('run_a'), first)
  assert.equal(await library.getRun('missing'), undefined)
  assert.equal(await library.getRun('broken'), undefined)
  assert.deepEqual((await library.listRuns()).map((run) => run.id), ['run_c', 'run_b', 'run_a'])
  assert.deepEqual((await library.listRuns(1)).map((run) => run.id), ['run_c'])
  assert.equal((await library.listRuns('bogus')).length, 3)

  // Reopening the library rebuilds the run index from disk.
  const reloaded = new Library({ root })
  await reloaded.init()
  assert.deepEqual(
    (await reloaded.listRuns()).map((run) => run.id),
    ['run_c', 'run_b', 'run_a'],
  )
  assert.equal((await reloaded.getRun('run_b')).prompt, 'y')
})

test('init skips malformed item records but keeps valid neighbours', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'image-studio-'))
  const warnings = []
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const seed = new Library({ root })
  await seed.init()
  const id = seed.newId('img')
  await seed.saveItem(makeItem(seed, { id, prompt: 'survivor', createdAt: 42 }))

  await writeFile(join(root, 'items', 'corrupt.json'), '{"id": ')

  const library = new Library({ root, logger: { warn: (...args) => warnings.push(args) } })
  await library.init()
  assert.deepEqual((await library.listItems()).items.map((item) => item.id), [id])
  assert.equal((await library.getItem(id)).prompt, 'survivor')
  assert.ok(warnings.length >= 1)

  // A malformed record is not listed and cannot be fetched, but deleting its id
  // still removes the unreadable file (and then reports nothing left to delete).
  assert.equal(await library.getItem('corrupt'), undefined)
  assert.equal(await library.deleteItem('corrupt'), true)
  await assert.rejects(stat(join(root, 'items', 'corrupt.json')), { code: 'ENOENT' })
  assert.equal(await library.deleteItem('corrupt'), false)
  assert.deepEqual((await library.listItems()).items.map((item) => item.id), [id])
})
