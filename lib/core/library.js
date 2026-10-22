/**
 * Image Studio library storage.
 *
 * One root directory holds everything the plugin has ever produced:
 *
 *   items/<id>.json      one Item record per generation (SPEC §1)
 *   images/<id>-<n>.ext  original image bytes
 *   thumbs/<id>-<n>.ext  optional thumbnails
 *   runs/<id>.json       one comparison run per record
 *   settings.json        non-secret settings
 *
 * The item index is loaded into memory once by `init()`; every mutation writes
 * the record atomically (tmp file + rename) and then updates that index, so
 * listings never touch the disk. Records that fail to parse are reported through
 * the injected logger and skipped — a corrupt file must never make the panel
 * unusable.
 *
 * No dependencies beyond Node's standard library.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'

const ITEMS_DIR = 'items'
const IMAGES_DIR = 'images'
const THUMBS_DIR = 'thumbs'
const RUNS_DIR = 'runs'
const SETTINGS_FILE = 'settings.json'

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 200

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

/** Accepted request media types -> on-disk extension + canonical type. */
const MEDIA_TYPES = new Map([
  ['image/png', { ext: 'png', format: 'png', mediaType: 'image/png' }],
  ['image/jpeg', { ext: 'jpg', format: 'jpeg', mediaType: 'image/jpeg' }],
  ['image/jpg', { ext: 'jpg', format: 'jpeg', mediaType: 'image/jpeg' }],
  ['image/webp', { ext: 'webp', format: 'webp', mediaType: 'image/webp' }],
  ['image/gif', { ext: 'gif', format: 'gif', mediaType: 'image/gif' }],
])

const FORMATS = {
  png: MEDIA_TYPES.get('image/png'),
  jpeg: MEDIA_TYPES.get('image/jpeg'),
  webp: MEDIA_TYPES.get('image/webp'),
  gif: MEDIA_TYPES.get('image/gif'),
}

const MEDIA_BY_EXT = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/* ------------------------------------------------------------------ */
/* small value helpers                                                 */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    SAFE_ID.test(value) &&
    !value.includes('..')
  )
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function clampLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function isTruthyFlag(value) {
  if (value === true || value === 1) return true
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  }
  return false
}

function favoriteOf(record) {
  return record.favorite === true || isTruthyFlag(record.favorite)
}

/** `YYYYMMDDTHHmmss` in local time. */
function localStamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Deep merge: objects merge recursively, arrays (and scalars) replace. */
function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return cloneJson(patch)
  if (!isPlainObject(patch)) return cloneJson(patch)
  const result = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    const current = result[key]
    if (Array.isArray(value)) {
      result[key] = cloneJson(value)
    } else if (isPlainObject(value)) {
      result[key] = mergeDeep(isPlainObject(current) ? current : {}, value)
    } else {
      result[key] = cloneJson(value)
    }
  }
  return result
}

/** Resolve a library-relative path, refusing anything outside the root. */
function insideRoot(root, relative) {
  if (!isNonEmptyString(relative) || relative.includes('\0') || isAbsolute(relative)) {
    return undefined
  }
  const absolute = resolve(root, relative)
  if (absolute === root) return undefined
  return absolute.startsWith(`${root}${sep}`) ? absolute : undefined
}

/** Write a file atomically: write `<file>.tmp`, then rename over the target. */
async function writeAtomic(file, data) {
  await mkdir(join(file, '..'), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, file)
}

/** Remove one file, ignoring an already-missing target. */
async function unlinkQuiet(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/* ------------------------------------------------------------------ */
/* image sniffing (magic bytes + header dimensions)                    */
/* ------------------------------------------------------------------ */

function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return undefined
}

function startsWithAscii(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readU32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  )
}

function readU32LE(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

function dimension(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Identify a supported image by its magic bytes, or undefined. */
function sniffFormat(bytes) {
  if (startsWithAscii(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (startsWithAscii(bytes, 0, 'GIF87a') || startsWithAscii(bytes, 0, 'GIF89a')) return 'gif'
  if (bytes.length >= 12 && startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) {
    return 'webp'
  }
  return undefined
}

function pngDimensions(bytes) {
  // signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4)
  if (bytes.length < 24 || !startsWithAscii(bytes, 12, 'IHDR')) return { width: 0, height: 0 }
  return { width: dimension(readU32BE(bytes, 16)), height: dimension(readU32BE(bytes, 20)) }
}

function jpegDimensions(bytes) {
  let offset = 2
  // Guard against hostile inputs that would otherwise make this walk forever.
  while (offset + 1 < bytes.length && offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers carry no length: SOI, EOI, TEM, RSTn.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (offset + 4 > bytes.length) break
    const size = readU16BE(bytes, offset + 2)
    if (size < 2) break
    // SOFn frames (excluding DHT/JPG/DAC): FFC0-FFCF minus C4, C8, CC.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      if (offset + 9 > bytes.length) break
      return {
        width: dimension(readU16BE(bytes, offset + 7)),
        height: dimension(readU16BE(bytes, offset + 5)),
      }
    }
    if (marker === 0xda) break // start of scan; no frame header before it
    offset += 2 + size
  }
  return { width: 0, height: 0 }
}

function webpDimensions(bytes) {
  // RIFF(4) + size(4) + WEBP(4) + chunk fourcc(4) + chunk size(4) => payload at 20.
  if (bytes.length < 21) return { width: 0, height: 0 }
  if (startsWithAscii(bytes, 12, 'VP8X')) {
    if (bytes.length < 30) return { width: 0, height: 0 }
    return { width: dimension(readU24LE(bytes, 24) + 1), height: dimension(readU24LE(bytes, 27) + 1) }
  }
  if (startsWithAscii(bytes, 12, 'VP8L')) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return { width: 0, height: 0 }
    const header = readU32LE(bytes, 21)
    return {
      width: dimension((header & 0x3fff) + 1),
      height: dimension(((header >>> 14) & 0x3fff) + 1),
    }
  }
  if (startsWithAscii(bytes, 12, 'VP8 ')) {
    // Lossy VP8 frame: 3-byte frame tag, sync code 9d 01 2a, then 14-bit sizes.
    if (bytes.length < 30 || !startsWithAscii(bytes, 23, '\x9d\x01\x2a')) {
      return { width: 0, height: 0 }
    }
    return {
      width: dimension(readU16LE(bytes, 26) & 0x3fff),
      height: dimension(readU16LE(bytes, 28) & 0x3fff),
    }
  }
  return { width: 0, height: 0 }
}

function gifDimensions(bytes) {
  if (bytes.length < 10) return { width: 0, height: 0 }
  return { width: dimension(readU16LE(bytes, 6)), height: dimension(readU16LE(bytes, 8)) }
}

/** Real dimensions for an already-sniffed format; 0/0 when unknown. */
function readDimensions(bytes, format) {
  try {
    if (format === 'png') return pngDimensions(bytes)
    if (format === 'jpeg') return jpegDimensions(bytes)
    if (format === 'webp') return webpDimensions(bytes)
    if (format === 'gif') return gifDimensions(bytes)
  } catch {
    // A truncated header is not a failure: dimensions simply stay unknown.
  }
  return { width: 0, height: 0 }
}

function parseMediaType(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.split(';')[0].trim().toLowerCase()
  return MEDIA_TYPES.get(normalized)
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export class Library {
  #root
  #logger

  /** id -> full record (used as the listing index; summaries strip notes). */
  #items = new Map()
  /** id -> full run record. */
  #runs = new Map()
  /** id -> images written by saveFiles but not yet attached to a stored item. */
  #pendingImages = new Map()
  /** ids handed out by newId() during this session, to guarantee uniqueness. */
  #issued = new Set()
  #settingsQueue = Promise.resolve()

  constructor({ root, logger } = {}) {
    if (!isNonEmptyString(root)) throw new Error('library root is required')
    this.#root = resolve(root)
    this.#logger = logger
  }

  get root() {
    return this.#root
  }

  /** Create the folder layout and load items + runs into memory. */
  async init() {
    await Promise.all(
      [ITEMS_DIR, IMAGES_DIR, THUMBS_DIR, RUNS_DIR].map((dir) =>
        mkdir(join(this.#root, dir), { recursive: true }),
      ),
    )
    await this.#loadItems()
    await this.#loadRuns()
    return this
  }

  /** `img_20261020T215530_ab12cd` — local time plus a crypto-random suffix. */
  newId(prefix = 'img') {
    const head = String(prefix ?? '').replace(/[^A-Za-z0-9]+/g, '') || 'id'
    const stamp = localStamp(new Date())
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = `${head}_${stamp}_${randomBytes(3).toString('hex')}`
      if (this.#issued.has(id) || this.#items.has(id) || this.#runs.has(id)) continue
      this.#issued.add(id)
      return id
    }
    throw new Error('failed to allocate a unique library id')
  }

  /**
   * Persist generated image buffers under `images/` and return `Item['images']`.
   * Dimensions are read from the file header unless the caller supplied them.
   */
  async saveFiles(id, images) {
    if (!isSafeId(id)) throw new Error('invalid image id')
    if (!Array.isArray(images)) throw new Error('images must be an array')

    // Validate and plan first, so one bad buffer cannot leave half a set behind.
    const plans = images.map((entry, index) => {
      const bytes = asBytes(entry?.data)
      if (!bytes || bytes.byteLength === 0) throw new Error('unsupported image bytes')
      const format = sniffFormat(bytes)
      if (!format) throw new Error('unsupported image bytes')
      const declared = parseMediaType(entry?.mediaType)
      const chosen = declared ?? FORMATS[format]
      const detected = readDimensions(bytes, format)
      const width = dimension(entry?.width) || detected.width
      const height = dimension(entry?.height) || detected.height
      return {
        index,
        name: `${id}-${index}.${chosen.ext}`,
        file: `${IMAGES_DIR}/${id}-${index}.${chosen.ext}`,
        mediaType: chosen.mediaType,
        bytes,
        width,
        height,
      }
    })

    for (const plan of plans) {
      await writeAtomic(join(this.#root, IMAGES_DIR, plan.name), plan.bytes)
    }

    const stored = plans.map((plan) => ({
      index: plan.index,
      file: plan.file,
      mediaType: plan.mediaType,
      bytes: plan.bytes.byteLength,
      width: plan.width,
      height: plan.height,
      thumb: '',
    }))
    // Generation reads the files back (e.g. to build attachments) before the
    // item record is persisted, so the index keeps them reachable in between.
    this.#pendingImages.set(id, stored)
    return stored
  }

  /** Best-effort thumbnail write; returns the relative path or ''. */
  async writeThumb(id, index, data, mediaType) {
    try {
      if (!isSafeId(id)) return ''
      const position = Number(index)
      if (!Number.isInteger(position) || position < 0) return ''
      const bytes = asBytes(data)
      if (!bytes || bytes.byteLength === 0) return ''
      const declared = parseMediaType(mediaType)
      const format = declared?.format ?? sniffFormat(bytes)
      const chosen = declared ?? (format ? FORMATS[format] : undefined)
      if (!chosen) return ''
      const name = `${id}-${position}.${chosen.ext}`
      await writeAtomic(join(this.#root, THUMBS_DIR, name), bytes)
      return `${THUMBS_DIR}/${name}`
    } catch (error) {
      this.#warn(`failed to write thumbnail for ${id}/${index}`, error)
      return ''
    }
  }

  /** Validate, stamp and store one item; the in-memory index follows. */
  async saveItem(item) {
    if (!isPlainObject(item)) throw new Error('invalid item: expected an object')
    if (!isNonEmptyString(item.id)) throw new Error('invalid item: id is required')
    if (!isSafeId(item.id)) throw new Error('invalid item: id must be a file-safe string')
    if (!isNonEmptyString(item.provider)) throw new Error('invalid item: provider is required')
    if (!isNonEmptyString(item.model)) throw new Error('invalid item: model is required')

    const stored = { ...item }
    if (!isFiniteNumber(stored.createdAt)) stored.createdAt = Date.now()

    await writeAtomic(this.#itemPath(stored.id), `${JSON.stringify(stored, null, 2)}\n`)
    this.#items.set(stored.id, cloneJson(stored))
    this.#pendingImages.delete(stored.id)
    return stored
  }

  async getItem(id) {
    if (!isSafeId(id)) return undefined
    try {
      const raw = await readFile(this.#itemPath(id), 'utf8')
      const parsed = JSON.parse(raw)
      if (!isPlainObject(parsed) || !isNonEmptyString(parsed.id)) return undefined
      return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`failed to read item ${id}`, error)
      return undefined
    }
  }

  /** Shallow-merge a patch into the stored item; createdAt never moves. */
  async updateItem(id, patch) {
    const current = await this.getItem(id)
    if (!current) return undefined
    if (!isPlainObject(patch)) throw new Error('invalid patch: expected an object')
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt }
    return this.saveItem(next)
  }

  /** Delete the record and every image/thumbnail file that belongs to it. */
  async deleteItem(id) {
    if (!isSafeId(id)) return false
    const record = this.#items.get(id) ?? (await this.getItem(id))
    let existed = this.#items.has(id) || record !== undefined

    if (record && Array.isArray(record.images)) {
      const files = new Set()
      for (const image of record.images) {
        if (image && isNonEmptyString(image.file)) files.add(image.file)
        if (image && isNonEmptyString(image.thumb)) files.add(image.thumb)
      }
      for (const relative of files) {
        const absolute = insideRoot(this.#root, relative)
        if (!absolute) continue
        try {
          await unlinkQuiet(absolute)
        } catch (error) {
          this.#warn(`failed to delete library file ${relative}`, error)
        }
      }
    }

    // Thumbs written for an item that was never saved are not in the record.
    for (const dir of [IMAGES_DIR, THUMBS_DIR]) {
      let names = []
      try {
        names = await readdir(join(this.#root, dir))
      } catch (error) {
        if (error?.code !== 'ENOENT') this.#warn(`failed to scan ${dir} while deleting ${id}`, error)
      }
      for (const name of names) {
        if (!name.startsWith(`${id}-`)) continue
        try {
          await unlinkQuiet(join(this.#root, dir, name))
        } catch (error) {
          this.#warn(`failed to delete ${dir}/${name}`, error)
        }
      }
    }

    try {
      await unlink(this.#itemPath(id))
      existed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    this.#items.delete(id)
    this.#pendingImages.delete(id)
    return existed
  }

  /**
   * Filter, sort and keyset-page the item index.
   * @param {{q?: string, provider?: string, model?: string, favorite?: unknown,
   *          tag?: string, sort?: 'newest'|'oldest', limit?: number|string,
   *          cursor?: string}} [query]
   */
  async listItems(query = {}) {
    const source = isPlainObject(query) ? query : {}
    const needle = typeof source.q === 'string' ? source.q.trim().toLowerCase() : ''
    const provider = isNonEmptyString(source.provider) ? source.provider.trim() : ''
    const model = isNonEmptyString(source.model) ? source.model.trim() : ''
    const tag = isNonEmptyString(source.tag) ? source.tag.trim() : ''
    const favoritesOnly = isTruthyFlag(source.favorite)
    const oldestFirst = source.sort === 'oldest'
    const limit = clampLimit(source.limit, DEFAULT_LIMIT, MAX_LIMIT)
    const cursor = typeof source.cursor === 'string' ? source.cursor.trim() : ''

    let rows = [...this.#items.values()]
    if (provider) rows = rows.filter((row) => row.provider === provider)
    if (model) rows = rows.filter((row) => row.model === model)
    if (favoritesOnly) rows = rows.filter((row) => favoriteOf(row))
    if (tag) rows = rows.filter((row) => Array.isArray(row.tags) && row.tags.includes(tag))
    if (needle) rows = rows.filter((row) => matchesQuery(row, needle))

    rows.sort((left, right) => {
      const leftAt = Number(left.createdAt) || 0
      const rightAt = Number(right.createdAt) || 0
      if (leftAt !== rightAt) return oldestFirst ? leftAt - rightAt : rightAt - leftAt
      const a = String(left.id)
      const b = String(right.id)
      if (a === b) return 0
      return oldestFirst ? (a < b ? -1 : 1) : a < b ? 1 : -1
    })

    const total = rows.length
    let start = 0
    if (cursor) {
      const found = rows.findIndex((row) => row.id === cursor)
      if (found >= 0) start = found + 1
    }
    const page = rows.slice(start, start + limit)
    const hasMore = start + limit < total

    return {
      items: page.map(toSummary),
      total,
      hasMore,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : '',
    }
  }

  async saveRun(run) {
    if (!isPlainObject(run)) throw new Error('invalid run: expected an object')
    if (!isNonEmptyString(run.id)) throw new Error('invalid run: id is required')
    if (!isSafeId(run.id)) throw new Error('invalid run: id must be a file-safe string')

    const stored = { ...run }
    if (!isFiniteNumber(stored.createdAt)) stored.createdAt = Date.now()

    await writeAtomic(this.#runPath(stored.id), `${JSON.stringify(stored, null, 2)}\n`)
    this.#runs.set(stored.id, cloneJson(stored))
    return stored
  }

  async getRun(id) {
    if (!isSafeId(id)) return undefined
    const cached = this.#runs.get(id)
    if (cached) return cloneJson(cached)
    try {
      const raw = await readFile(this.#runPath(id), 'utf8')
      const parsed = JSON.parse(raw)
      if (!isPlainObject(parsed) || !isNonEmptyString(parsed.id)) return undefined
      return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`failed to read run ${id}`, error)
      return undefined
    }
  }

  async listRuns(limit = 20) {
    const max = clampLimit(limit, 20, MAX_LIMIT)
    return [...this.#runs.values()]
      .sort(
        (left, right) =>
          (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0) ||
          String(right.id).localeCompare(String(left.id)),
      )
      .slice(0, max)
      .map((run) => cloneJson(run))
  }

  async deleteRun(id) {
    if (!isSafeId(id)) return false
    const known = this.#runs.delete(id)
    try {
      await unlink(this.#runPath(id))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return known
      this.#warn(`failed to delete run ${id}`, error)
      return false
    }
  }

  /** Distinct non-empty prompts from successful items, newest first. */
  async recentPrompts(limit = 20) {
    const max = clampLimit(limit, 20, MAX_LIMIT)
    const seen = new Map()
    for (const record of this.#items.values()) {
      if (record.status === 'failed') continue
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
      if (!prompt) continue
      const createdAt = Number(record.createdAt) || 0
      const existing = seen.get(prompt)
      if (existing) {
        existing.uses += 1
        if (createdAt > existing.lastUsedAt) existing.lastUsedAt = createdAt
      } else {
        seen.set(prompt, { prompt, lastUsedAt: createdAt, uses: 1 })
      }
    }
    return [...seen.values()]
      .sort(
        (left, right) =>
          right.lastUsedAt - left.lastUsedAt || left.prompt.localeCompare(right.prompt),
      )
      .slice(0, max)
  }

  /** Aggregate counts from the index; `bytes` is the originals' size on disk. */
  stats() {
    let imageCount = 0
    let bytes = 0
    for (const record of this.#items.values()) {
      if (!Array.isArray(record.images)) continue
      for (const image of record.images) {
        if (!image || typeof image !== 'object') continue
        imageCount += 1
        const size = Number(image.bytes)
        if (Number.isFinite(size) && size > 0) bytes += size
      }
    }
    return { itemCount: this.#items.size, imageCount, bytes }
  }

  /**
   * Locate one stored image (or thumbnail) and read it.
   * `thumb` falls back to the original when no thumbnail exists.
   * @returns {Promise<{path: string, mediaType: string, bytes: number, data: Buffer}|undefined>}
   */
  async readImage(id, index, options = {}) {
    if (!isSafeId(id)) return undefined
    const position = Number(index)
    if (!Number.isInteger(position) || position < 0) return undefined

    const record = this.#items.get(id) ?? (await this.getItem(id))
    const images = Array.isArray(record?.images)
      ? record.images
      : this.#pendingImages.get(id) ?? []
    const image =
      images.find((entry) => Number(entry?.index) === position) ?? images[position] ?? undefined
    if (!image || typeof image !== 'object') return undefined

    const wantsThumb = Boolean(options?.thumb)
    const relative = wantsThumb && isNonEmptyString(image.thumb) ? image.thumb : image.file
    const absolute = insideRoot(this.#root, relative)
    if (!absolute) return undefined

    try {
      const data = await readFile(absolute)
      const extension = extname(absolute).slice(1).toLowerCase()
      return {
        path: absolute,
        mediaType:
          MEDIA_BY_EXT.get(extension) ??
          (isNonEmptyString(image.mediaType) ? image.mediaType : 'application/octet-stream'),
        bytes: data.byteLength,
        data,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`failed to read image ${id}/${position}`, error)
      return undefined
    }
  }

  /** Current settings: the defaults deep-merged with settings.json. */
  async readSettings() {
    try {
      const raw = await readFile(join(this.#root, SETTINGS_FILE), 'utf8')
      const parsed = JSON.parse(raw)
      if (!isPlainObject(parsed)) {
        this.#warn(`${SETTINGS_FILE} is not an object; using defaults`)
        return cloneJson(DEFAULT_SETTINGS)
      }
      return mergeDeep(cloneJson(DEFAULT_SETTINGS), parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`failed to read ${SETTINGS_FILE}; using defaults`, error)
      return cloneJson(DEFAULT_SETTINGS)
    }
  }

  /** Deep-merge a patch (objects merge, arrays replace) and persist it. */
  async writeSettings(patch = {}) {
    if (!isPlainObject(patch)) throw new Error('settings patch must be an object')
    const run = async () => {
      const current = await this.readSettings()
      const next = mergeDeep(current, patch)
      await writeAtomic(join(this.#root, SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`)
      return next
    }
    // Serialize writes so two concurrent PATCHes cannot lose one another.
    const operation = this.#settingsQueue.then(run, run)
    this.#settingsQueue = operation.catch(() => {})
    return operation
  }

  /* ---------------------------------------------------------------- */

  #itemPath(id) {
    return join(this.#root, ITEMS_DIR, `${id}.json`)
  }

  #runPath(id) {
    return join(this.#root, RUNS_DIR, `${id}.json`)
  }

  #warn(message, error) {
    try {
      this.#logger?.warn?.(`[image-studio] ${message}`, error)
    } catch {
      // A logger must never break a library operation.
    }
  }

  async #loadItems() {
    this.#items.clear()
    const directory = join(this.#root, ITEMS_DIR)
    let names
    try {
      names = await readdir(directory)
    } catch (error) {
      this.#warn(`failed to scan ${ITEMS_DIR}/`, error)
      return
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .map(async (name) => {
          try {
            const raw = await readFile(join(directory, name), 'utf8')
            const parsed = JSON.parse(raw)
            if (!isPlainObject(parsed) || !isSafeId(parsed.id)) {
              this.#warn(`skipping malformed item record: ${ITEMS_DIR}/${name}`)
              return
            }
            this.#items.set(parsed.id, parsed)
          } catch (error) {
            if (error?.code === 'ENOENT') return
            this.#warn(`skipping unreadable item record: ${ITEMS_DIR}/${name}`, error)
          }
        }),
    )
  }

  async #loadRuns() {
    this.#runs.clear()
    const directory = join(this.#root, RUNS_DIR)
    let names
    try {
      names = await readdir(directory)
    } catch (error) {
      this.#warn(`failed to scan ${RUNS_DIR}/`, error)
      return
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .map(async (name) => {
          try {
            const raw = await readFile(join(directory, name), 'utf8')
            const parsed = JSON.parse(raw)
            if (!isPlainObject(parsed) || !isSafeId(parsed.id)) {
              this.#warn(`skipping malformed run record: ${RUNS_DIR}/${name}`)
              return
            }
            this.#runs.set(parsed.id, parsed)
          } catch (error) {
            if (error?.code === 'ENOENT') return
            this.#warn(`skipping unreadable run record: ${RUNS_DIR}/${name}`, error)
          }
        }),
    )
  }
}

/* ------------------------------------------------------------------ */
/* listing helpers                                                     */
/* ------------------------------------------------------------------ */

/** Case-insensitive substring search over the fields named by SPEC §4. */
function matchesQuery(record, needle) {
  const tags = Array.isArray(record.tags) ? record.tags.join(' ') : ''
  const haystack = [
    record.prompt,
    record.title,
    record.notes,
    tags,
    record.model,
  ]
    .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
    .join('\n')
  return haystack.includes(needle)
}

/** Public listing shape: the item record without `notes`, defaults applied. */
function toSummary(record) {
  const summary = cloneJson(record)
  delete summary.notes
  summary.title = typeof summary.title === 'string' ? summary.title : ''
  summary.tags = Array.isArray(summary.tags) ? summary.tags : []
  summary.favorite = favoriteOf(summary)
  summary.rating = Number.isFinite(summary.rating) ? summary.rating : 0
  summary.images = Array.isArray(summary.images) ? summary.images : []
  return summary
}
