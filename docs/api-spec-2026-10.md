# Image-Generation API Spec — 10 Providers

Research date: **2026-10-20**. Every endpoint/param below is taken from the vendor's own docs unless marked `UNVERIFIED`.
Note on `UNVERIFIED`: where a vendor's docs page is client-rendered and the rendered body could not be retrieved (Volcengine/BytePlus ModelArk, several pricing tables), the field is marked rather than guessed.

---

## Comparison table

| Provider | Documented? | Endpoint | Auth header | Text-to-image | Reference images | Async job? | Notes |
|---|---|---|---|---|---|---|---|
| **fal.ai** | Yes, full OpenAPI-ish reference | `POST https://fal.run/{owner}/{app}` (sync) / `https://queue.fal.run/...` (queue) | `Authorization: Key $FAL_KEY` (**not** Bearer) | `POST /fal-ai/flux-2-pro`, `/fal-ai/flux-pro/kontext`, `/fal-ai/nano-banana` | `image_urls: []` (flux-2-pro/edit, nano-banana/edit), `image_url` (kontext) | Yes — queue + `status_url` + `response_url`, or `?fal_webhook=` | No OpenAI-compatible image endpoint documented (own queue/sync REST + SDKs). `sync_mode: true` ⇒ data URI |
| **Replicate** | Yes | `POST https://api.replicate.com/v1/predictions` (versioned) / `POST /v1/models/{owner}/{name}/predictions` (official) | `Authorization: Bearer r8_...` | `black-forest-labs/flux-2-pro`, `google/nano-banana-2.1`, … | Model-specific input keys; files passed as HTTPS URLs or `data:` URLs | Yes (default); `Prefer: wait` for sync ≤60 s | No OpenAI-compatible image endpoint. Output = HTTPS URLs on `replicate.delivery`, **require the auth header** |
| **Black Forest Labs** | Yes (OpenAPI published) | `POST https://api.bfl.ai/v1/{model}` | `x-key: $BFL_API_KEY` | `/v1/flux-2-pro`, `/v1/flux-3-image`, `/v1/flux-kontext-pro` | flux-2: `input_image`…`input_image_8`; flux-3: `images: [url\|b64]` (1–10) | **Always** — `{id, polling_url}` → `GET polling_url` | No OpenAI-compat. BFL is upstream for fal/Replicate/OpenRouter. Signed `result.sample` URL valid **10 min** |
| **Stability AI** | Yes (OpenAPI) | `POST https://api.stability.ai/v2beta/stable-image/generate/{core\|ultra\|sd3}` | `Authorization: Bearer sk-...` | same path, `multipart/form-data` | `image` + `strength` (+`mode=image-to-image`); or `/v2beta/stable-image/edit/*` | No (sync); separate async services exist | No OpenAI-compat. Two response modes via `accept`: `image/*` (bytes) or `application/json` (base64) |
| **Ideogram** | Yes (v2 default) | `POST https://api.ideogram.ai/v2/image/generate/{model}` | `Api-Key: <key>` | `/v2/image/generate/ideogram-4-5`, `/ideogram-4`, `/ideogram-3` | `images` (≤5, 4.5), `style_reference_images`, `character_reference_images`, `mask` | Optional — `async` / `webhook_url` → `generation_id` → `GET /v2/generations/{id}` | No OpenAI-compat, but v2 also resells `gpt-image-2.5`, `nano-banana-2/2.1/pro` under its paths |
| **Recraft** | Yes (single-page agent doc) | `POST https://external.api.recraft.ai/v1/images/generations` | `Authorization: Bearer $RECRAFT_API_TOKEN` | same | `image_url` (edit endpoints), `style_reference_urls` (1–10), `mask_url` | No (sync); 100 img/min, 5 req/s | No OpenAI-compat. Only provider here with **explicit per-image USD prices** |
| **ByteDance Seedream (Ark)** | Partially — docs are JS-rendered | `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` | `Authorization: Bearer $ARK_API_KEY` | same | `UNVERIFIED` (image-input param name) | No | **OpenAI-compatible surface** (ModelArk publishes a "Compatible with OpenAI API" page). Model ids/params `UNVERIFIED` |
| **Alibaba Qwen-Image** | Yes | `POST https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` | `Authorization: Bearer $DASHSCOPE_API_KEY` | same | Separate edit API (`qwen-image-edit-api`) | Optional (async task API) | **Explicitly NOT OpenAI-compatible** for images (stated in docs) |
| **xAI Grok Imagine** | Yes | `POST https://api.x.ai/v1/images/generations` | `Authorization: Bearer $XAI_API_KEY` | same | `POST /v1/images/edits` | Optional `deferred: true` → `GET /v1/images/{request_id}` | **Yes — OpenAI-compatible** images API (OpenAI SDK works with `base_url`) |
| **OpenRouter** | Yes | `POST https://openrouter.ai/api/v1/images` | `Authorization: Bearer $OPENROUTER_API_KEY` | same (dedicated Image API) | `input_references: [{type:"image_url", image_url:{url}}]` | No (stream via SSE `stream: true`) | **Not** OpenAI `/images/generations` shape; returns base64 always. Billing all-or-nothing |

---

## 1. fal.ai

Base URLs: `https://fal.run` (synchronous), `https://queue.fal.run` (async queue).
Endpoint ID goes straight into the path: `POST /{owner}/{app}` and `/{owner}/{app}/{subpath}` (e.g. `/fal-ai/flux-2-pro/edit`).

**Current FLUX / Gemini-image endpoints (Oct 2026)**

| Endpoint ID | Notes |
|---|---|
| `fal-ai/flux-2-pro` / `fal-ai/flux-2-pro/edit` | FLUX.2 [pro]; no steps/guidance exposed |
| `fal-ai/flux-pro/kontext`, `/flux-pro/kontext/max`, `/flux-pro/kontext/multi`, `/flux-pro/kontext/text-to-image` | FLUX.1 Kontext |
| `fal-ai/flux-pro/v1.1`, `/v1.1/ultra` | FLUX 1.1 |
| `fal-ai/nano-banana`, `/nano-banana/edit`, `fal-ai/nano-banana-2`, `fal-ai/nano-banana-pro` | Gemini image family hosted by fal |
| `fal-ai/gemini-3-pro-image-preview`, `fal-ai/gpt-image-1.5` | third-party models also hosted |

**Text-to-image (sync)**

```bash
curl -X POST https://fal.run/fal-ai/flux-2-pro \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "close-up of a knight's visor reflecting battle, cinematic lighting",
    "image_size": "landscape_4_3",
    "output_format": "jpeg",
    "seed": 42,
    "sync_mode": false
  }'
```

```json
{
  "images": [{ "url": "https://fal.media/files/.../out.png", "width": 1024, "height": 768 }],
  "seed": 42
}
```

- **Size / aspect**: `image_size` — enum `square_hd | square | portrait_4_3 | portrait_16_9 | landscape_4_3 | landscape_16_9` (`auto` on the `/edit` variant), or an object `{width, height}`. Kontext and nano-banana instead take `aspect_ratio` (`"21:9" … "9:16"`).
- **n**: `num_images` (1–4) on kontext / nano-banana. Not exposed on `flux-2-pro`.
- **Seed**: `seed` (integer). `flux-2-pro` output schema echoes it.
- **Format**: `output_format` — `jpeg | png` (flux-2-pro); `jpeg | png | webp` (nano-banana).
- **Response**: `images[].url` (public `fal.media` / `storage.googleapis.com` URL). With `sync_mode: true` the media is returned as a **data URI** and is not stored.
- **Reference images**: `image_urls: ["https://…"]` on `/edit` and `/nano-banana/edit`; `image_url` (single) on kontext. FLUX.2 prompting uses `@image1`-style references.

**Queue (recommended by fal)**

```bash
curl -X POST https://queue.fal.run/fal-ai/flux-2-pro \
  -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"a sunset over mountains"}'
# → {"request_id":"...","response_url":"...","status_url":"...","cancel_url":"...","queue_position":0}
```
`GET {status_url}?logs=1` → `{"status":"IN_QUEUE"|"IN_PROGRESS"|"COMPLETED", "queue_position":…, "logs":[…], "metrics":{…}}`
`GET {response_url}` → the model output. Webhook: `?fal_webhook=https://…`. Note the status/result URLs are owner/app scoped — including the subpath returns `405`, so use the returned URLs verbatim.

**Pricing**: `fal-ai/flux-pro/kontext` documented at **$0.04 per image**. FLUX.2 / nano-banana per-image prices are not stated on their reference pages — `UNVERIFIED` (they are resolution-tiered).

**OpenAI-compatible image endpoint**: none documented; fal exposes only the queue/sync REST API and its own SDKs.

Sources: [flux-2-pro](https://fal.ai/docs/model-api-reference/image-generation-api/flux-2-pro), [flux-pro-kontext](https://fal.ai/docs/model-api-reference/image-generation-api/flux-pro-kontext), [nano-banana](https://fal.ai/docs/model-api-reference/image-generation-api/nano-banana), [queue API](https://fal.ai/docs/documentation/model-apis/inference/queue)

---

## 2. Replicate

Base: `https://api.replicate.com/v1`. Three create-prediction routes depending on model class:

| Route | Use |
|---|---|
| `POST /v1/predictions` | community models — `version` required as `{owner}/{name}:{64-char-id}` |
| `POST /v1/models/{owner}/{name}/predictions` | **official models** — no version pin needed |
| `POST /v1/deployments/{owner}/{name}/predictions` | your deployments |

Current image model ids (official models, verified on the org pages): `black-forest-labs/flux-3-image`, `black-forest-labs/flux-2-pro`, `flux-2-max`, `flux-2-flex`, `flux-2-klein-4b`, `flux-2-klein-9b`, `flux-kontext-pro`, `flux-kontext-max`, `google/nano-banana-2.1`, `google/nano-banana-pro`, `google/nano-banana-2`.

```bash
curl -s -X POST -H 'Prefer: wait' \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"input": {"prompt": "a sleek silver sports car on a coastal highway at sunset"}}' \
  https://api.replicate.com/v1/models/black-forest-labs/flux-2-pro/predictions
```

```json
{
  "id": "gm3qorzdhgbfurvjtvhg6dckhu",
  "model": "black-forest-labs/flux-2-pro",
  "status": "succeeded",
  "input": { "prompt": "a sleek silver sports car on a coastal highway at sunset" },
  "output": ["https://replicate.delivery/.../out.webp"],
  "error": null,
  "metrics": { "predict_time": 8.1, "total_time": 12.4 },
  "urls": {
    "web": "https://replicate.com/p/gm3qorzdhgbfurvjtvhg6dckhu",
    "get": "https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu",
    "cancel": "https://api.replicate.com/v1/predictions/gm3qorzdhgbfurvjtvhg6dckhu/cancel"
  }
}
```

- **Size / aspect / n / seed / format**: **not normalized by Replicate** — every key lives in the model's own input schema. Fetch it with `GET /v1/models/{owner}/{name}` → `latest_version.openapi_schema.components.schemas.Input`. Do not assume `size`/`aspect_ratio`/`n` exist; `UNVERIFIED` per model. Treat this as the single most important integration caveat for Replicate.
- **Reference images**: "Files should be passed as HTTP URLs or data URLs." Use an HTTPS URL for files >256 KB or reused files; a `data:` URL for ≤256 KB one-shots (not stored).
- **Async**: default. `Prefer: wait` (or `wait=5`) holds the request ≤60 s; `Cancel-After: 1m30s` sets a hard deadline (5 s–24 h).
- **Response**: `output` is `string | string[]`; any file output is an HTTPS URL on `replicate.delivery` / `*.replicate.delivery` — **fetching it needs the `Authorization` header**. Output + inputs are deleted after 1 hour by default.
- **OpenAI-compatible image endpoint**: none documented (predictions API only).
- **Pricing**: per-model (GPU-second or per-output). FLUX.2 [pro] per-image price `UNVERIFIED`.

Sources: [HTTP API reference](https://replicate.com/docs/reference/http), [create a prediction](https://replicate.com/docs/topics/predictions/create-a-prediction), [black-forest-labs org models](https://replicate.com/black-forest-labs), [nano-banana-2.1](https://replicate.com/google/nano-banana-2.1)

---

## 3. Black Forest Labs (direct)

Base: `https://api.bfl.ai` (global, recommended) — regional `https://api.eu.bfl.ai`, `https://api.us.bfl.ai`. **Always poll the returned `polling_url`; do not build it.**

Current paths: `/v1/flux-3-image`, `/v1/flux-3-image-klein` (FLUX 3, newest) · `/v1/flux-2-max`, `/v1/flux-2-pro`, `/v1/flux-2-pro-preview`, `/v1/flux-2-flex`, `/v1/flux-2-klein-9b`, `/v1/flux-2-klein-9b-preview`, `/v1/flux-2-klein-4b` · legacy `/v1/flux-kontext-pro`, `/v1/flux-kontext-max`, `/v1/flux-pro-1.1`, `/v1/flux-pro-1.1-ultra`, `/v1/flux-pro`, `/v1/flux-dev`.

**Submit (FLUX.2 [pro])**

```bash
curl -X POST https://api.bfl.ai/v1/flux-2-pro \
  -H "x-key: $BFL_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt": "a cat on its back legs running like a human", "width": 1440, "height": 2048, "output_format": "jpeg"}'
```

```json
{ "id": "…", "polling_url": "https://api.bfl.ai/v1/get_result?id=…", "cost": 1.4, "input_mp": 0.0, "output_mp": 2.95 }
```

**Poll**

```bash
curl "https://api.bfl.ai/v1/get_result?id=…" -H "x-key: $BFL_API_KEY"
```
```json
{ "id": "…", "status": "Ready", "progress": 1.0, "result": { "sample": "https://delivery.us.bfl.ai/…jpeg" } }
```
`status` ∈ `Task not found | Pending | Reasoning | Generating | Request Moderated | Content Moderated | No Card Generated | Ready | Error`. `result.sample` is a signed URL valid **10 minutes**, served from `delivery.*.bfl.ai` (no CORS — download and re-host).

**Params**

| | FLUX.2 [pro]/[max]/[flex]/[klein] | FLUX 3 |
|---|---|---|
| size | `width`, `height` (min 64; `0`/omitted = model default; up to ~4 MP) | `aspect_ratio` enum (`21:9 … 9:21` + `auto`) and `resolution` ∈ `768sq, 1k, 1.5k, 2k, 4k` |
| refs | `input_image`, `input_image_2` … `input_image_8` (path/URL) — up to 8 on API | `images`: string or array, 1–10, URL **or base64** |
| seed | `seed` (integer) | not in schema |
| n | no `n`; batch requests multiply base cost (param name `UNVERIFIED`) | no `n` |
| format | `output_format` ∈ `jpeg, png, webp` (default `jpeg`) | not in schema |
| other | `safety_tolerance` 0–7 (default 2), `disable_pup` (auto prompt upsampling), `webhook_url`/`webhook_secret` | `safety_tolerance` 0–7, `grounding` (web/image search, default true), `version: "latest"` |

FLUX 3 also supports box-grounded prompting/layout via a JSON `bbox` array inside the prompt.

**OpenAI-compatible image endpoint**: no.
**Pricing**: 1 credit = **$0.01**. Published figures: FLUX 3 Image Klein **$0.008 / $0.009 / $0.011 / $0.014 / $0.036** per image at 768sq / 1K / 1.5K / 2K / 4K. FLUX.2 [pro]/[max]/[flex] are megapixel-tiered; the table's price cells did not render in the retrieved page → `UNVERIFIED` (use the pricing calculator).

Sources: [FLUX.2 [pro] reference](https://docs.bfl.ai/api-reference/models/generate-or-edit-an-image-with-flux2-[pro]), [get result](https://docs.bfl.ai/api-reference/utility/get-result), [image generation guide](https://docs.bfl.ai/quick_start/generating_images), [FLUX 3 image](https://docs.bfl.ai/api-reference/utility/generate-an-image-with-flux-3), [pricing](https://docs.bfl.ai/quick_start/pricing)

---

## 4. Stability AI

Base: `https://api.stability.ai`. Text-to-image: `POST /v2beta/stable-image/generate/{core|ultra|sd3}`. Edits live elsewhere: `/v2beta/stable-image/edit/{inpaint,outpaint,erase,search-and-replace,search-and-recolor,remove-background}`, control: `/v2beta/stable-image/control/{sketch,structure,style}`.

Model selection is a **path** for ultra/core, and a `model` field for `sd3`: `sd3.5-large`, `sd3.5-large-turbo`, `sd3.5-medium` (SD3.0 ids are re-routed to 3.5 at the same price).

```bash
curl -f -sS "https://api.stability.ai/v2beta/stable-image/generate/core" \
  -H "authorization: Bearer $STABILITY_API_KEY" \
  -H "accept: image/*" \
  -F prompt="Lighthouse on a cliff overlooking the ocean" \
  -F aspect_ratio="16:9" -F output_format="webp" -o out.webp
```

JSON variant (`accept: application/json`):

```json
{ "image": "iVBORw0KG...", "seed": 343940597, "finish_reason": "SUCCESS" }
```
`finish_reason` ∈ `SUCCESS | CONTENT_FILTERED`. With `accept: image/*` you get raw bytes and `seed` / `finish-reason` arrive as **response headers**. Note: moderation blocks (`403` `content_moderation`) are not billed; `422` covers `public_figure` / non-English prompts.

- **Size**: `aspect_ratio` only — `21:9, 16:9, 3:2, 5:4, 1:1, 4:5, 2:3, 9:16, 9:21` (default `1:1`). No `width`/`height`. Output is fixed at ~1.5 MP (core) / 1 MP (ultra, sd3).
- **n**: none — one image per request.
- **Seed**: `0–4294967294`; `0`/omitted = random.
- **Format**: `output_format` ∈ `png, jpeg, webp`.
- **Reference images**: `mode=image-to-image` + `image` (jpeg/png/webp, ≥64 px/side) + required `strength` (0–1 denoise). `aspect_ratio` is only valid in text-to-image mode. Whole request ≤10 MiB.
- **Async**: generate endpoints are synchronous. Async exists for some services (creative upscale) via a separate results API.
- **OpenAI-compatible image endpoint**: no.
- **Pricing** (credits, flat per successful generation, failed = free): Core **3**, Ultra **8**, SD3.5 Large **6.5**, Large Turbo **4**, Medium **3.5**, Flash **2.5**. The USD-per-credit rate is `UNVERIFIED` here.

Sources: [Stable Image Core](https://docs.stability.ai/api-reference/generate/stable-image-core), [Stable Image Ultra](https://docs.stability.ai/api-reference/generate/stable-image-ultra), [SD 3.5](https://docs.stability.ai/api-reference/generate/stable-diffusion-35)

---

## 5. Ideogram (v3-era models on the v2 API)

Base `https://api.ideogram.ai`. v2 URL grammar: `POST /v2/{content}/{action}/{model}` — the model is in the path. The old `/v1/ideogram-v3/generate` still works but is legacy; v2 equivalents exist with field renames (v1 `text_prompt` → v2 `prompt`).

| Action | Path |
|---|---|
| generate (current) | `/v2/image/generate/ideogram-4-5`, `/ideogram-4`, `/ideogram-3`, `/auto` |
| precise edit | `/v2/image/precise-edit/ideogram-4-5` |
| remix / inpaint | `/v2/image/remix/{model}`, `/v2/image/inpaint/ideogram-3` |
| poll | `GET /v2/generations/{generation_id}` |

Content type is `multipart/form-data` (multipart is required whenever you upload files/mask).

```bash
curl -X POST https://api.ideogram.ai/v2/image/generate/ideogram-4-5 \
  -H "Api-Key: $IDEOGRAM_API_KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"Knit running shoes in neon coral on a warm stone paper sweep","size":"2048x2048","num_images":1,"seed":12345}'
```

```json
{
  "generation_kind": "sampling",
  "generation_id": "eyJ...",
  "seed": 12345,
  "data": [
    { "prompt": "…final prompt…", "resolution": "2048x2048", "seed": 12345,
      "is_image_safe": true, "url": "https://ideogram.ai/api/images/ephemeral/….png?exp=…&sig=…" }
  ]
}
```
URLs are ephemeral — download immediately. `is_image_safe: false` ⇒ `url` is empty.

- **Size**: 4.5 — `size`: `"auto" | "source" | "WIDTHxHEIGHT"` (both sides multiple of 32, ≥256 px, ≤2048×2048 total, ratio ≤6:1). 3.0 — `aspect_ratio` (e.g. `1x1`, `16x9`) + `resolution` enum (fixed list such as `1024x1024`, `1536x640`), plus `rendering_speed`, `style_type`, `magic_prompt`.
- **n**: `num_images`.
- **Seed**: `seed`.
- **Format**: 4.5 has `background` (`transparent|opaque|auto`) and `quality` (`very_low|…|high`); 3.0 returns PNG.
- **Reference images**: 4.5 `images` (≤5, ≤25 MB each, JPEG/PNG/WEBP — first is the edit target, rest are references) + optional `mask` (black = edit, white = keep). 3.0 `style_reference_images` (≤10), `character_reference_images` (1) + mask.
- **Async**: optional — `async: true` or `webhook_url` returns a `generation_id`; poll `GET /v2/generations/{id}` until `status` is `completed`/`failed`. Webhooks are Ed25519-signed (`https://api.ideogram.ai/v1/.well-known/jwks.json`).
- **OpenAI-compatible image endpoint**: no — but v2 also proxies `gpt-image-2.5`, `gpt-image-2`, `nano-banana-2/2.1/pro`, `z-image`, `p-image` through the same URL grammar.
- **Pricing**: `UNVERIFIED` (not published in the API reference; `dry_run=true` returns a `PriceQuote` — the practical way to price a request).

Sources: [Ideogram 4.5](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4-5), [Ideogram 3.0](https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-3), [API overview](https://developer.ideogram.ai/v2/ideogram-api/api-overview), [legacy v1 v3 endpoint](https://developer.ideogram.ai/v1/api-reference/generate-images/generate-v3)

---

## 6. Recraft (brief)

Base `https://external.api.recraft.ai/v1`, `Authorization: Bearer $RECRAFT_API_TOKEN`, 1 USD = 1000 API units.

```bash
curl https://external.api.recraft.ai/v1/images/generations \
  -H "Authorization: Bearer $RECRAFT_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"minimal fox logo, flat","model":"recraftv4_1_vector","size":"1:1",
       "controls":{"colors":[{"rgb":[255,102,0]},{"rgb":[30,30,30]}]}}'
```
```json
{ "created": 1759140000, "credits": 35,
  "data": [{ "image_id": "0e6a1b8c-…", "url": "https://…" }] }
```

- **Models**: `recraftv4_1` (default, 1K raster), `recraftv4_1_flash`, `_pro` (2K), `_vector` (SVG), `recraftv4_styles`, `recraftv4`, `recraftv3`, `recraftv2` (+ `_raster` aliases).
- **Params**: `n` 1–6, `size` (`1:1…16:9` or exact `WxH` from a per-model table), `random_seed`, `response_format` `url|b64_json|multipart`, `image_format` `webp|png`.
- **Refs / edits**: `style_reference_urls` (1–10, +$0.005), `POST /images/imageToImage` (`image_url` + `prompt` + `strength`), `/images/inpaint` (`mask_url`), `/images/outpaint`.
- **Response**: `data[].url` (≈24 h TTL) or `data[].b64_json`; process endpoints return a single `image` instead of `data`.
- **Pricing (per image, documented)**: `recraftv4_1_flash` $0.007 · `recraftv4_1` $0.035 · `recraftv4_1_vector` $0.08 · `recraftv4_1_pro` $0.21 · `recraftv3` $0.04 · `recraftv2` $0.022.
- **OpenAI-compatible image endpoint**: no.

Source: [Recraft API for AI agents](https://www.recraft.ai/docs/api-reference/agents.md)

---

## 7. ByteDance Seedream / Doubao (Volcengine Ark) — brief, partly UNVERIFIED

Surface (well-established, OpenAI-shaped): `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`, `Authorization: Bearer $ARK_API_KEY`, body `{model, prompt, size, response_format, n, seed, watermark, …}`.

```json
{ "model": "doubao-seedream-<version>", "prompt": "…",
  "size": "2048x2048", "response_format": "url", "n": 1 }
```

- ModelArk's own nav lists a **"Seedream 5.0 pro / flash tutorial"** and a **"Compatible with OpenAI API"** page, so the family is current and the surface is OpenAI-compatible. **Exact model ids, param names, response shape, and pricing for the current Seedream version are `UNVERIFIED`** — the docs are a JS app and the rendered body could not be retrieved. Do not hard-code ids from memory; read `GET /api/v3/models` or the console.
- Punctuation note: Ark's `size` is `WIDTHxHEIGHT` with a lowercase `x`; Qwen uses `WIDTH*HEIGHT` with `*`.

Sources: [ModelArk image generation API](https://docs.byteplus.com/en/docs/modelark/image-generation-api), [Seedream tutorial](https://docs.byteplus.com/en/docs/modelark/seedream-4-0-5-0), [Ark 图片生成 API](https://ark.volcengine.com/region:cn-beijing/docs/image-generation-api)

---

## 8. Alibaba Qwen-Image (DashScope / Model Studio) — brief

Not OpenAI-shaped, and the docs say so explicitly: *"Image generation models such as Qwen-Image are called through the DashScope native API and do not support OpenAI-compatible (compatible-mode) mode."*

**Endpoint** (workspace-scoped, region-specific — Beijing and Singapore keys are not interchangeable):
`POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

```bash
curl --location 'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $DASHSCOPE_API_KEY" \
  --data '{
    "model": "qwen-image-2.0-pro",
    "input": { "messages": [{ "role": "user", "content": [{ "text": "a healing-style hand-drawn poster of three puppies" }] }] },
    "parameters": { "size": "2048*2048", "n": 1, "prompt_extend": true, "watermark": false, "seed": 42 }
  }'
```

```json
{
  "output": { "choices": [{ "finish_reason": "stop",
    "message": { "role": "assistant", "content": [{ "image": "https://dashscope-result-sh.oss-….aliyuncs.com/xxx.png?Expires=…" }] } }] },
  "usage": { "width": 2048, "height": 2048, "image_count": 1 },
  "request_id": "d0250a3d-…"
}
```

- **Models**: `qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro` (+ dated snapshots `…-2026-06-22`, `-2026-04-22`, `-2026-03-03`), `qwen-image-2.0`.
- **Size**: `size` = `"WIDTH*HEIGHT"`; total pixels 512×512 → 2048×2048; presets `2688*1536` (16:9), `1536*2688`, `2048*2048` default, `2368*1728`, `1728*2368`.
- **n**: 1–6 (2.0/3.0 series). **Seed**: `[0, 2147483647]`. **Format**: PNG only.
- **Refs**: image editing is a **separate** model/endpoint family (`qwen-image-edit-api`); this generation endpoint takes text only.
- **Async**: optional task API (`ImageSynthesis.async_call` → `task_status` `PENDING|RUNNING|SUCCEEDED|FAILED` → `results[].url`).
- **OpenAI-compatible**: chat yes (`/compatible-mode/v1`), **images no**.
- **Pricing**: per successfully generated image; rates not captured here → `UNVERIFIED` (see Model Studio pricing page).

Sources: [Qwen-Image API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-image-api)

---

## 9. xAI Grok Imagine — brief

This **is** a public API and it **is** OpenAI-compatible.

- `POST https://api.x.ai/v1/images/generations` · `POST https://api.x.ai/v1/images/edits` · `GET https://api.x.ai/v1/images/{request_id}` · `Authorization: Bearer $XAI_API_KEY`
- Model: `grok-imagine-image-2.0`

```bash
curl -X POST https://api.x.ai/v1/images/generations \
  -H "Content-Type: application/json" -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{"model":"grok-imagine-image-2.0","prompt":"A collage of London landmarks in stenciled street-art style",
       "n":1,"aspect_ratio":"16:9","resolution":"2k","response_format":"url"}'
```

```json
{ "data": [{ "url": "https://…", "mime_type": "image/jpeg" }], "usage": { } }
```

- **Params**: `n` 1–10 · `aspect_ratio` (`1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20, 21:9, 5:2, auto`) · `resolution` `1k|2k` · `quality` `low|medium|auto` (2.0 only) · `response_format` `url|b64_json` · `deferred: true`.
- **Output**: temporary URL by default (download promptly) or `b64_json`.
- **OpenAI-compatible**: yes — `base_url="https://api.x.ai/v1"` with the OpenAI Python/JS SDK works (`client.images.generate`).
- **Pricing**: `UNVERIFIED` here (billed by quality tier; see xAI pricing page).

Source: [Image Generation](https://docs.x.ai/developers/model-capabilities/images/generation)

---

## 10. OpenRouter — brief

Dedicated **Image API** (not the OpenAI `/images/generations` shape; chat `modalities` is not the documented path for image output).

- `POST https://openrouter.ai/api/v1/images` · `GET /api/v1/images/models` · `GET /api/v1/images/models/{id}/endpoints` · `Authorization: Bearer $OPENROUTER_API_KEY`

```bash
curl -X POST "https://openrouter.ai/api/v1/images" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"bytedance-seed/seedream-4.5","prompt":"a red panda astronaut in space",
       "resolution":"2K","aspect_ratio":"16:9","n":1}'
```

```json
{ "created": 1748372400,
  "data": [{ "b64_json": "<base64>", "media_type": "image/png" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 4175, "total_tokens": 4175, "cost": 0.04 } }
```

- **Params**: `n` 1–10 · `resolution` (`512, 768, 1K, 1.5K, 2K, 4K`) · `aspect_ratio` (`auto`, `1:1…21:9`, `1:4`, `4:1`, `1:8`, `8:1`, `9:21`) · `size` (tier or explicit `2048x2048`) · `quality` · `output_format` `png|jpeg|webp|svg` · `background` · `output_compression` · `seed` · `stream` · `user`.
- **Refs**: `input_references: [{"type":"image_url","image_url":{"url":"https://…"}}]` (URL or data URL).
- **Routing**: `provider: {only, order, ignore, sort, allow_fallbacks, options}`; provider-specific knobs go in `provider.options[provider_slug]`.
- **Output**: **always base64** (`b64_json`) plus `media_type`; `usage.cost` in USD. Streaming emits `image_generation.partial_image` / `image_generation.completed` SSE events.
- **Model examples seen in docs**: `openai/gpt-image-2`, `bytedance-seed/seedream-4.5`, `black-forest-labs/flux.2-pro`, `google/gemini-2.5-flash-image`.
- **Billing**: all-or-nothing — a failed/cancelled generation is free, and returns `502` rather than a partial image.
- **Pricing**: exposed per endpoint via the endpoints API (`pricing: [{billable:"output_image", unit:"image", cost_usd: 0.05}]`).

Source: [OpenRouter Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

---

## Cross-provider integration notes

1. **Auth is not uniform.** Only 6 of 10 use `Authorization: Bearer`: Replicate, Stability, Recraft, Qwen, xAI, OpenRouter (+ Ark). fal uses `Authorization: Key …`; BFL uses `x-key`; Ideogram uses `Api-Key`.
2. **OpenAI-compatible image endpoints** exist only at **xAI** (`/v1/images/generations`, OpenAI SDK works) and **ByteDance Ark** (OpenAI-shaped surface, "Compatible with OpenAI API"). **Qwen explicitly refuses it.** fal, Replicate, BFL, Stability, Ideogram, Recraft, OpenRouter each need their own adapter.
3. **Size control is the least portable axis.** Abstract it into `{width,height}` / `aspect_ratio` / `size_tier` and map per provider: fal `image_size` enum-or-object · BFL flux-2 `width`/`height`, BFL flux-3 `aspect_ratio`+`resolution` · Stability `aspect_ratio` only (fixed MP) · Ideogram `size` string (`auto|source|WxH`) · Recraft `size` ratio-or-exact · Qwen `"W*H"` · OpenRouter `resolution` tier + `aspect_ratio`.
4. **`n` is not universal.** fal (kontext/nano-banana) 1–4 · Stability: none · BFL: none (batch instead) · Ideogram/Recraft/Qwen/xAI/OpenRouter: 1–6/6/6/10/10.
5. **Async is the default, not the exception.** BFL is always async (submit → poll → 10-min signed URL). fal/Replicate/Ideogram/xAI/Qwen are sync-capable with async opt-in. Budget for a job store + webhook receiver regardless.
6. **URL TTLs differ wildly**: BFL 10 min · Replicate 1 h (then outputs are deleted) · Ideogram/Qwen ~24 h · Recraft ~24 h · fal/OpenRouter depend on account settings. Fetch-and-rehost on receipt for anything you need to keep.
7. **Reference-image count** ranges from 0 (Stability `generate/*` — use the edit endpoints) to 10 (BFL flux-3, Recraft style refs) and 14 (Replicate `google/nano-banana-2.1`).

## Gap list (all `UNVERIFIED`)

- Ark/Seedream: exact current model ids, param names, response shape, pricing (docs are JS-rendered).
- BFL FLUX.2 [pro]/[max]/[flex] per-image USD (price cells blank in retrieval); batch param name.
- Replicate FLUX.2 [pro] input key names (size/aspect/seed/refs) — model-specific, read `openapi_schema`.
- Stability USD-per-credit rate; Ultra/Core exact MP after aspect-ratio rounding.
- Ideogram per-image pricing (use `?dry_run=true`).
- fal FLUX.2 / nano-banana per-image pricing.
- xAI Grok Imagine per-image pricing.
