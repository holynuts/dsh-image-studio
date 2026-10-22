# Image Studio

**[English](README.md) · [简体中文](README.zh-CN.md)**

![Image Studio panel](docs/panel.png)

A DeepSeek Harness plugin that lets **both the agent and you call several image APIs**, storing every generation — prompt, parameters and result — in a **built-in library**, and gives you a dedicated web panel for trying prompts and comparing one prompt across models.

- A new **Image Studio** icon in the sidebar: click to open, it never takes over the conversation area.
- The agent uses the same capability through 5 tools; its results and yours land in the same library.
- Zero runtime dependencies: the host side uses Node built-ins only, the browser side only React (shipped by Harness).

## Installation

This is a DeepSeek Harness **bundle plugin** (`dsh.bundle` is declared in `package.json`): no build step, no runtime dependencies.

```bash
git clone https://github.com/holynuts/dsh-image-studio.git
```

Then install the repository directory as a bundle in your profile (Harness plugin manager → Install bundle → pick this directory), or add one row to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: ui-image-studio
      name: 'dsh-image-studio'
```

Refresh the Harness web UI once and the **Image Studio** icon appears in the sidebar.

> API keys are not stored in this plugin's settings: they go through the Harness credential service (one ref per provider, preferring the `OPENAI_API_KEY` / `GEMINI_API_KEY` you already configured). See [§2](#2-where-api-keys-live-a-design-choice).

---

## 1. Supported providers

| provider id | service | default model | notes |
|---|---|---|---|
| `gemini` | Google Gemini / Nano Banana | `gemini-nano-banana-2.1` | Interactions API; also Nano Banana Pro / 2 / 2 Lite; 1K/2K/4K, up to 14 reference images |
| `openai` | ChatGPT Image | `gpt-image-2.5-flare` | `/v1/images/generations` + `/v1/images/edits`; Flare / Sunburst; low→max quality tiers |
| `vertex` | Google Vertex AI | `gemini-nano-banana-2.1` | `generateContent` + ADC (shares credentials with DSH's `google-vertex` provider); no key to paste; Vertex Express API keys also work |
| `fal` | fal.ai | `fal-ai/nano-banana-2.1` | any fal endpoint via the model slug; `sync_mode` returns a data URI directly |
| `replicate` | Replicate | `google/nano-banana-2.1` | `Prefer: wait` + polling; output URLs downloaded with a Bearer token |
| `openai-compatible` | any OpenAI-shaped gateway | you choose | OpenRouter / LiteLLM / self-hosted gateways / local servers |
| `mock` | offline placeholder | `mock-1` | no network, no key — for exploring the panel and library first |

### Vertex models and regions (measured 2026-10)

| model id | region | notes |
|---|---|---|
| `gemini-nano-banana-2.1` | `global` | Nano Banana 2.1, 1K/2K/4K, up to 14 reference images |
| `gemini-3-pro-image` | `global` | Nano Banana Pro; note the id has no `-preview` suffix |
| `gemini-3.1-flash-image` | `global` | Nano Banana 2 |
| `gemini-2.5-flash-image` | `us-central1` (also `us-east5` / `global`) | first generation |

3.x image models are only served from the `global` endpoint; `us-central1` / `us-east5` answer 404. The plugin picks the region per model and you can override it with `location` in settings.

The model catalogue is editable: change model ids in the panel, or add custom models in `settings.json`. Vendors rename models faster than plugins ship releases, so the defaults are a starting point only.

---

## 2. Where API keys live (a design choice)

**In short: the plugin manages them, but they live in DSH's credential service, and it reuses keys you already configured for DSH providers.**

- Each provider has its own ref, e.g. `IMAGE_STUDIO_OPENAI_API_KEY`, `IMAGE_STUDIO_GEMINI_API_KEY`. Writes go through `ctx.credentials.set()` into the Harness credential store (`~/.dsh/.credentials.yaml`, private entries) — **never into the plugin's `settings.json`, never into logs**.
- Reads fall back through a chain: `IMAGE_STUDIO_*` → `OPENAI_API_KEY` / `GEMINI_API_KEY` / `FAL_KEY` / `REPLICATE_API_TOKEN`. If you already configured OpenAI or Gemini in DSH's Models settings, this panel shows "connected" without pasting anything again.
- Why not extend DSH's provider catalogue: that catalogue describes **chat/completions routing** (provider + model + reasoning effort). Image endpoints differ in URL, auth header, size/quality parameters and async task shape — forcing them in would just grow a second adapter layer. Keys are the only genuinely shared part, so only keys are shared.
- In the panel's Settings, every provider shows its status (connected / no key / from environment), a key field, a connection test, and a link to the official key page.

**Vertex is the exception — it needs no key at all.** It shares Google Application Default Credentials with DSH's own `google-vertex` provider (`GOOGLE_APPLICATION_CREDENTIALS` / `gcloud auth application-default login` / the metadata server); project and region come from `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. The plugin only exchanges that ADC for a bearer token for Vertex REST calls — no login prompt, no new credential stored.

If macOS has not granted Harness permission for your Documents folder (you see `EPERM`), there are two ways around it:

1. Copy the key into the DSH directory — the plugin picks it up immediately, no env change, no restart: `cp ~/Documents/vertex_ai_service_account.json ~/.dsh/vertex-service-account.json`.
2. Or paste a Vertex **Express API key** under Settings → Google Vertex AI (no OAuth; requests go through `aiplatform.googleapis.com` in key mode).

---

## 3. The panel

Sidebar icon → the main column opens **Image Studio**, with four sections:

**Create**

- Left parameter column: provider, model, aspect ratio (with small ratio icons), resolution/quality, count 1–4, seed (dice for random), reference images (pick from the library, up to 2).
- Large prompt box on the right: collapsible negative prompt, character count, recent prompts to click; `⌘/Ctrl + ↵` to generate.
- While generating: elapsed timer and cancel; results stack per run — one large card for a single image, two columns for two, 2×2 for three or four.
- Hover any image to download, copy its prompt, star it, use it as a reference, or open details; click for the lightbox — `←/→` to page, `Esc` to close.
- The empty state offers three example prompts that fill the box on click.

**Library**

- Search prompts, filter by provider, favourites only, sort by time, "load more" paging.
- Detail drawer on the right: large image, copyable prompt, parameter table, tags, 0–5 stars, notes, star, download, delete (with confirmation), copy absolute path, `←/→` paging.
- Every result keeps: provider, model, aspect/size, quality, seed, duration, origin (panel / agent / compare).

**Compare**

- Send the same prompt to up to 4 "provider · model" targets in parallel, side by side per column, including duration and failure reasons.
- Each column can be starred, opened in the library, or have its prompt copied back; past compare runs are stored and can be re-opened with one click.

**Settings**

- Per provider: status, set/clear key, default model, connection test, configurable endpoints (fal / Replicate / OpenAI-compatible).
- Library location and statistics (items / images / size), plus "open folder".
- Default parameters (provider / model / aspect / quality / count) used by both the panel and the agent.

The UI follows the Harness language setting (English and Chinese are shipped).

---

## 4. Agent tools

| tool | purpose |
|---|---|
| `image_generate` | generate from a prompt; returns `itemId`, an absolute file path, and inlines the image as an image block when available |
| `image_library_search` | search the library by text / provider / model / tag / favourite |
| `image_library_get` | read one full record (prompt, parameters, path, rating, notes) |
| `image_library_update` | star, rate, tag, annotate |
| `image_providers` | list providers, key status and models (check this first when the user names a provider or model) |

The plugin also injects a short system-prompt note about when to use these tools, that generation costs real money, and that the agent should inspect results with `read_image`. Tool results carry no base64 — only paths and renderable attachment references.

---

## 5. Library storage

Default `$DSH_HOME/image-studio` (on this machine: `~/.dsh/image-studio`):

```
image-studio/
  items/<img_id>.json      # prompt, parameters, rating, tags, origin, image list
  images/<img_id>-<n>.png  # originals
  runs/<run_id>.json       # compare runs
  settings.json            # non-secret settings (defaults, endpoints, custom models, UI prefs)
```

- File names allow `[A-Za-z0-9._-]` only; read paths are validated to stay inside the root.
- Writes use `tmp + rename`; listings come from an in-memory index, consistent within the process.
- Results are not written into the session log and do not depend on any conversation: delete the session and the library is still there.
- To move it: add `config: { libraryDir: /absolute/path }` to this row in your profile's `cordis.patch.yml`.

---

## 6. Custom endpoints

Any OpenAI-shaped gateway: choose **OpenAI-compatible** in settings, fill `baseUrl` (e.g. `https://openrouter.ai/api/v1`, `http://127.0.0.1:4000/v1`), a model id and a key. Requests go to `POST {base}/images/generations` and both `b64_json` and `url` responses are accepted.

To add a brand-new protocol: add a file under `lib/providers/`, implement the adapter object from `SPEC.md` §2, and register it in `ADAPTERS` in `lib/providers/index.js`. Adapters only touch HTTP — never disk or credentials.

`docs/api-spec-2026-10.md` is a 2026-10 verification of ten image APIs (endpoints, auth headers, async shapes, URL lifetimes). Read it before adding an adapter — it saves half the trial and error.

---

## 7. Security and behaviour boundaries

- `/api/image-studio/*` accepts **loopback or paired devices only**; cross-site browser requests (`sec-fetch-site: cross-site`) get 403.
- Keys only ever appear in request headers sent to the provider; error messages redact them; they are not logged, not written to settings, and never returned to the frontend.
- Generation costs real money: both the tool descriptions and the system prompt forbid batch trial-and-error, and every generation in the panel is an explicit click.
- Deletion is physical (record + image files) with a confirmation in the UI; the agent side has no delete tool.

---

## 8. Tests and known limitations

```bash
cd dsh-image-studio
npm test        # 49 tests: library 15, adapters 16, service/tools 7, Vertex 11
```

Verified so far:

- Unit tests cover library CRUD/paging/filtering/corrupt-file tolerance, request shapes and error wrapping for all six adapters, the service layer's generate/compare/credentials/settings paths, and tool output.
- Live (this profile): the plugin installs and activates; `/health`, `/bootstrap`, `/generate` (mock), `/items`, `/file`, `/download`, `/credentials` (written then cleared), `/credentials/test` (really hits OpenAI and reports 401 correctly), `/compare`, `/runs` all pass.
- **Vertex live**: the machine's ADC was exchanged for an access token; all four models passed connectivity probes; `gemini-nano-banana-2.1` really produced a 1024×1024 PNG (15.1 s, stored and retrievable via `/file`).
- Real keys for `gemini` / `openai` / `fal` / `replicate` were not provided, so their **success paths** are not verified online; the Gemini Interactions response parsing is written as a tolerant scan of the documented shapes (`output_image`, `steps[].content[]`, `inline_data`).
- The panel's **visual rendering** was verified after the fact by a real screenshot session; slot registration (`sidebar.panellist#image-studio`, `main#image-studio`) is active, and the client JS passes a syntax check plus a factory/registration smoke test. If layout needs a tweak, edit the CSS block in `client.js`.

The Vertex ADC path is implemented like DSH's own credential handling and is unit-tested; it passed live once the key was moved out of the Documents folder (the 1024×1024 above came from Vertex).

Deliberately left for later:

- Thumbnails (the local loopback serves originals today; grids rely on `loading="lazy"` — revisit past tens of thousands of images).
- Using DSH's text models for "prompt polishing".
- Stability / Ideogram / Recraft / BFL / Ark / xAI adapters (`docs/api-spec-2026-10.md` already carries the parameter tables).
