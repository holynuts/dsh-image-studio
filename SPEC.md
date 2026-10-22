# Image Studio — build contract (internal)

Package: `dsh-image-studio` · row id: `ui-image-studio` · panel key: `image-studio`
Zero runtime dependencies. Node 22, ESM (`"type": "module"`). No TypeScript, no bundler, no JSX.

The plugin has two halves:

- **Host** (`lib/index.js` + `lib/**`): stores the library on disk, holds API keys in DSH's credential
  service, calls providers over `fetch`, serves `/api/image-studio/*`, and registers agent tools.
- **Client** (`client.js`): the Image Studio panel in the Harness Web UI. Plain JS, React comes from
  `require('react')`; register into slots `sidebar.panellist` + `main`.

Everything below is a contract. Do not change a shape another module depends on without editing this file.

---

## 1. Data model (JSON, on disk and over HTTP)

### Item

```jsonc
{
  "id": "img_20261020T215530_ab12cd",   // Library.newId()
  "createdAt": 1761098130123,           // ms epoch
  "provider": "gemini",                 // adapter id
  "model": "gemini-nano-banana-2.1",
  "prompt": "…",
  "negativePrompt": "",                 // "" when unused
  "params": {
    "aspect": "16:9",                   // may be ""
    "size": "1536x1024",                // may be ""
    "quality": "high",                  // may be ""
    "count": 1,
    "seed": 42,                         // null when unused
    "refs": ["img_…"]                   // library items used as references
  },
  "status": "succeeded",                // "succeeded" | "failed"
  "error": "",                          // failure message when status === "failed"
  "latencyMs": 4210,
  "revisedPrompt": "",                  // provider rewrite when it returns one
  "title": "",                          // user-editable
  "tags": [],
  "favorite": false,
  "rating": 0,                          // 0..5
  "notes": "",
  "source": {                           // who asked
    "kind": "ui",                       // "ui" | "agent" | "compare"
    "sessionId": "",                    // agent path only
    "cwd": "",                          // agent path only
    "runId": ""                         // compare path only
  },
  "images": [
    {
      "index": 0,
      "file": "images/img_20261020T215530_ab12cd-0.png", // relative to library root
      "mediaType": "image/png",
      "bytes": 1843200,
      "width": 2752,
      "height": 1536,
      "thumb": "thumbs/img_20261020T215530_ab12cd-0.png"  // optional; "" when absent
    }
  ]
}
```

`ItemSummary` = the same object with `images[].thumb/file` kept but `notes` dropped. Listing returns
summaries; detail returns the full item.

### Run (a comparison of one prompt across targets)

```jsonc
{
  "id": "run_20261020T215540_9f8e7d",
  "createdAt": 1761098140123,
  "prompt": "…",
  "negativePrompt": "",
  "params": { "aspect": "1:1", "size": "", "quality": "", "count": 1, "seed": null, "refs": [] },
  "targets": [{ "provider": "gemini", "model": "gemini-nano-banana-2.1" }],
  "results": [
    {
      "provider": "gemini",
      "model": "gemini-nano-banana-2.1",
      "status": "succeeded",            // "succeeded" | "failed"
      "itemId": "img_…",
      "latencyMs": 8100,
      "error": ""                        // failure message when failed
    }
  ]
}
```

### Settings (non-secret, `settings.json` in the library root)

```jsonc
{
  "version": 1,
  "defaults": { "provider": "gemini", "model": "gemini-nano-banana-2.1", "aspect": "1:1", "quality": "high", "count": 1 },
  "providers": {
    "fal": { "baseUrl": "", "defaultModel": "fal-ai/nano-banana-2.1", "models": [] },
    "openai-compatible": { "baseUrl": "", "defaultModel": "", "models": [] }
  },
  "ui": { "lastTab": "create", "compareTargets": [] }
}
```

Secrets never enter this file.

---

## 2. Provider adapter contract (`lib/providers/*.js`)

`lib/providers/index.js` exports:

```js
export function adapters()                 // readonly array of adapter objects
export function getAdapter(id)             // adapter | undefined
export function catalog()                  // JSON-safe descriptors, functions stripped
export async function generateWithAdapter({ adapterId, apiKey, baseUrl, ...req }) // -> GenerateResult
export async function testAdapter({ adapterId, apiKey, baseUrl, fetchImpl })      // -> {ok, latencyMs, message}
```

An adapter object:

```js
{
  id: 'gemini',                  // stable, used in items and settings
  label: 'Google Gemini',        // English display name (UI localizes the rest)
  kind: 'sync',                  // 'sync' | 'async' (async = polls a job)
  docsUrl: 'https://…',
  keyRefs: ['IMAGE_STUDIO_GEMINI_API_KEY', 'GEMINI_API_KEY'], // first = this plugin's own ref
  keyHint: 'AIza…',              // placeholder shown in the key field
  keyUrl: 'https://aistudio.google.com/apikey',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  configurableBaseUrl: false,    // true = UI shows an endpoint field
  beta: false,
  models: [{
    id: 'gemini-nano-banana-2.1',
    label: 'Nano Banana 2.1',
    aspects: ['1:1','16:9','9:16','4:3','3:4','2:3','3:2','4:5','5:4','21:9'], // [] = not controllable
    sizes: [],                   // explicit WxH options; [] when the provider uses aspect only
    qualities: [],               // e.g. ['low','medium','high']
    supportsRefs: true,
    maxRefs: 14,
    note: ''                     // short hint shown under the model picker
  }],
  async generate(req),           // req: {apiKey, model, prompt, negativePrompt, aspect, size, quality,
                                 //       count, seed, refs:[{data:Uint8Array, mediaType}], baseUrl,
                                 //       signal, fetchImpl}
                                 // -> {images:[{data:Uint8Array, mediaType, width?, height?}],
                                 //     revisedPrompt?, raw?}
  async test({apiKey, baseUrl, fetchImpl}) // optional; -> {ok, message}
}
```

Rules for adapters:

- Throw `Error` with a human message on failure. Set `err.status` (HTTP status) and `err.body`
  (first ~400 chars of the provider body) when available. Never include the API key in messages.
- `generate` always returns ≥1 image or throws.
- Respect `signal` (pass to fetch) and `fetchImpl` (default `globalThis.fetch`) so tests can stub HTTP.
- No dependencies; no disk access; no reading env.

Built-in adapters: `gemini`, `vertex`, `openai`, `fal`, `replicate`, `openai-compatible`, `mock`.
`vertex` is ambient-auth: it reads the machine's Google ADC (the same credential DSH's
`google-vertex` provider uses) and falls back to an optional Vertex Express API key.

---

## 3. HTTP API (`/api/image-studio/*`)

All routes are `exact` kind, registered through `ctx.webServer.register`. Every handler starts with the
trust fence: loopback, or a live paired device (mirror `isPairedOrLoopbackAllowed`). Mutating routes
require `content-type: application/json` for JSON bodies.

Success: HTTP 200 + JSON. Failure: HTTP 4xx/5xx + `{ "error": { "code": "…", "message": "…", "hint": "…" } }`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/bootstrap` | — | `{version, library:{dir, itemCount, imageCount, bytes}, providers:[ProviderView], defaults, settings, compareTargets}` |
| POST | `/generate` | `{provider, model, prompt, negativePrompt?, aspect?, size?, quality?, count?, seed?, refs?, save?:true}` | `{item: Item}` |
| POST | `/compare` | `{targets:[{provider,model}], prompt, negativePrompt?, aspect?, size?, quality?, count?, seed?}` | `{run: Run}` |
| GET | `/items` | `?q=&provider=&model=&favorite=1&tag=&sort=newest\|oldest&limit=40&cursor=` | `{items:[ItemSummary], total, hasMore, nextCursor}` |
| GET | `/items/:id` | — | `{item}` |
| PATCH | `/items/:id` | `{favorite?, rating?, tags?, notes?, title?}` | `{item}` |
| DELETE | `/items/:id` | — | `{ok:true}` |
| GET | `/file/:id/:index` | `?thumb=1` | image bytes, `cache-control: private, max-age=31536000, immutable` |
| GET | `/download/:id/:index` | — | image bytes, `content-disposition: attachment` |
| GET | `/runs` | `?limit=20` | `{runs: Run[]}` |
| GET | `/runs/:id` | — | `{run}` |
| GET | `/prompts` | `?limit=20` | `{prompts:[{prompt, lastUsedAt, uses}]}` |
| GET | `/providers` | — | `{providers:[ProviderView]}` |
| POST | `/credentials` | `{provider, apiKey}` | `{providers:[ProviderView]}` |
| DELETE | `/credentials/:provider` | — | `{providers:[ProviderView]}` |
| POST | `/credentials/test` | `{provider, model?}` | `{ok, latencyMs, message}` |
| GET | `/settings` | — | `{settings}` |
| PATCH | `/settings` | partial settings | `{settings}` |
| POST | `/reveal` | `{path?}` | `{ok, path}` — opens the library folder on the host (best effort) |
| GET | `/health` | — | `{ok:true, version}` |

`ProviderView`:

```jsonc
{
  "id": "gemini", "label": "Google Gemini", "kind": "sync", "beta": false,
  "docsUrl": "…", "keyUrl": "…", "keyHint": "AIza…",
  "configurableBaseUrl": false, "baseUrl": "…",
  "configured": true, "source": "IMAGE_STUDIO_GEMINI_API_KEY", // '' when unconfigured
  "defaultModel": "gemini-nano-banana-2.1",
  "models": [ /* adapter models + user-defined models with {id,label,custom:true} */ ]
}
```

`:id` routes use a `prefix`-less exact path with an `:id` segment matched by the router (the router
splits on `/`, no glob engine needed).

---

## 4. Library module (`lib/core/library.js`)

```js
export class Library {
  constructor({ root, logger })
  async init()                                   // mkdir -p, load item index into memory
  get root()
  newId(prefix)                                  // 'img_…' / 'run_…'
  async saveFiles(id, images)                    // -> Item['images']; writes originals, detects width/height
  async writeThumb(id, index, data, mediaType)   // best effort, returns relative path or ''
  async saveItem(item)                           // atomic write items/<id>.json + index update
  async getItem(id)
  async updateItem(id, patch)                    // merges, bumps no timestamp
  async deleteItem(id)                           // removes files + record
  async listItems(query)                         // {items, total, hasMore, nextCursor}
  async saveRun(run)
  async getRun(id)
  async listRuns(limit)
  async recentPrompts(limit)
  stats()                                        // {itemCount, imageCount, bytes}
  readImage(id, index, {thumb})                  // -> {path, mediaType, bytes} | undefined
  async readSettings() / async writeSettings(patch)
}
```

Query semantics: `q` is a case-insensitive substring over `prompt`, `title`, `notes`, `tags`, `model`.
`favorite=1` filters favorites. `tag` matches one tag. `sort=newest|oldest`. Cursor is the last id;
`hasMore` and `nextCursor` follow keyset paging over the sorted list.

---

## 5. Client (`client.js`)

```js
window.__ModuleLoader__.load({
  id: 'dsh-image-studio',
  factory(require) {
    const React = require('react')
    // components…
    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) { /* register sidebar.panellist + main, register locale dicts */ },
    }
  },
})
```

- Sidebar icon: `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist', id:'image-studio', order: 30, label: () => t('panel.title')}, Icon))`.
- Page: `ctx.slots.inject('main', () => ctx.slots.register({name:'main', key:'image-studio', inject: () => ({api})}, Page))`.
- The sidebar row already selects the panel by id; no navigation code needed. `ctx.get('layout')?.selectPanel?.('image-studio')` is available for in-page deep links.
- API access: `fetch('/api/image-studio/…')` with JSON; include `credentials:'same-origin'`.
- Styles: inject a `<style>` element from a React component (`<style>{css}</style>`) or create a style tag inside `ctx.effect`; remove on dispose. Use only `--dsw-alias-*` tokens (see list below), plus `color-mix()` for tints. No other plugin's CSS.
- Visible text goes through the locale service: `ctx.locale.register(NS, {zh, en})`, then `const t = ctx.locale.bind(NS)`.
- Keyboard: ⌘/Ctrl+Enter generate; Esc closes drawer; ←/→ in viewer.
- Theme tokens: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-state-error-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`, `--dsw-alias-state-idle-primary`, `--dsw-specific-sidebar-fill`.

Do not import any `@deepseek-ai/*` module. Do not touch `document.body`. Do not read other plugins' DOM.

---

## 6. Tools (host, `lib/core/tools.js`)

`image_generate`, `image_library_search`, `image_library_get`, `image_library_update`, `image_providers`.
Tool results return JSON plus, when attachments are available, image content blocks
(`[{type:'image', attachment: ref}]`). Text fallback lists absolute file paths.

---

## 7. Constraints

- Never log or return API keys. Credential values only ever go into the provider request header.
- All writes stay inside the library root (`$DSH_HOME/image-studio` by default).
- File paths returned to the agent are absolute host paths.
- Every module must run without the Harness present for `node --test` (inject services, don't import them).
