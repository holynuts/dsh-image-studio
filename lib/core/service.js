/**
 * Image Studio operations.
 *
 * One implementation of every operation, shared by the HTTP routes (the panel)
 * and the agent tools — see the Harness plugin practice "one operation, two
 * callers". Nothing here touches HTTP request/response objects.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';

import { getAdapter, adapters, generateWithAdapter, testAdapter } from '../providers/index.js';

const MAX_PROMPT_CHARS = 8000;
const MAX_COUNT = 4;
const MAX_COMPARE_TARGETS = 4;
const MAX_REFERENCE_BYTES = 24 * 1024 * 1024;

/** Media type from a file extension (reference images picked by the agent). */
function mediaTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return '';
  }
}

/** Human, non-secret failure description for a provider call. */
function describeProviderError(error) {
  const status = Number(error?.status) || 0;
  let hint = '';
  if (status === 401 || status === 403) {
    hint = 'Check the API key for this provider in Image Studio → Settings.';
  } else if (status === 429) {
    hint = 'The provider is rate limiting. Wait a moment or pick another model.';
  } else if (status === 402) {
    hint = 'The provider account has no credit. Top it up or pick another model.';
  } else if (status === 400 || status === 422) {
    hint = 'The provider rejected this request — often the prompt, size, or model id.';
  } else if (error?.name === 'AbortError') {
    hint = 'The request was cancelled.';
  }
  return {
    message: String(error?.message || 'image generation failed'),
    hint,
    status,
  };
}

/** Coerce a stored or submitted count into 1..4. */
function clampCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 1;
  return Math.min(MAX_COUNT, Math.max(1, Math.round(count)));
}

/** Trim a string field, bounded. */
function clean(value, max = MAX_PROMPT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** Normalise one target descriptor. */
function cleanTarget(target) {
  if (target === null || typeof target !== 'object') return undefined;
  const provider = clean(target.provider, 64);
  const model = clean(target.model, 200);
  if (!provider || !model) return undefined;
  return { provider, model };
}

/**
 * @param {object} options
 * @param {object} options.ctx host context
 * @param {import('./library.js').Library} options.library
 * @param {object} options.credentials
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @param {string} [options.version]
 */
export function createService({ ctx, library, credentials, logger, version = '0.1.0' }) {
  const attachments = () => {
    try {
      return ctx.get?.('attachments', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** Settings with adapter defaults filled in. */
  async function settings() {
    const stored = await library.readSettings();
    return {
      ...stored,
      defaults: { ...stored.defaults },
      providers: { ...stored.providers },
      ui: { ...stored.ui },
    };
  }

  /** Resolve the provider/model pair a request means. */
  async function resolveTarget(target) {
    const current = await settings();
    const providerId = clean(target?.provider, 64) || current.defaults.provider || adapters()[0]?.id;
    const adapter = getAdapter(providerId);
    if (!adapter) throw Object.assign(new Error(`unknown provider "${providerId}"`), { status: 400, code: 'unknown_provider' });
    const configured = current.providers?.[providerId] ?? {};
    const models = [
      ...(adapter.models ?? []),
      ...(Array.isArray(configured.models) ? configured.models.map((model) => ({ id: String(model.id ?? model), label: String(model.label ?? model.id ?? model) })) : []),
    ];
    const requested = clean(target?.model, 200) || configured.defaultModel || current.defaults.model || '';
    const model = models.find((entry) => entry.id === requested) ?? (requested ? { id: requested, label: requested } : models[0]);
    if (!model) throw Object.assign(new Error(`provider "${providerId}" has no models configured`), { status: 400, code: 'no_model' });
    return {
      adapter,
      providerId,
      model,
      modelId: model.id,
      baseUrl: clean(configured.baseUrl, 500) || adapter.defaultBaseUrl || '',
    };
  }

  /** Provider directory for the panel, with key status and the models users can pick. */
  async function providersView() {
    const current = await settings();
    const views = [];
    for (const adapter of adapters()) {
      // Ambient-auth providers (Vertex) report the machine's Google credentials
      // instead of a key this plugin stores.
      let key;
      let ambient;
      if (typeof adapter.credentialStatus === 'function') {
        key = await adapter.credentialStatus({ credentials, settings: current });
        ambient = {
          source: key?.source ?? '',
          project: key?.projectId ?? '',
          location: key?.location ?? '',
          envPath: key?.envPath === true,
          error: key?.error ?? '',
        };
      } else {
        key = await credentials.describe(adapter.id);
      }
      const configured = current.providers?.[adapter.id] ?? {};
      const customModels = Array.isArray(configured.models)
        ? configured.models
            .map((model) => ({
              id: String(model?.id ?? model ?? ''),
              label: String(model?.label ?? model?.id ?? model ?? ''),
              custom: true,
            }))
            .filter((model) => model.id)
        : [];
      views.push({
        id: adapter.id,
        label: adapter.label,
        ambientAuth: adapter.ambientAuth === true,
        ambient: ambient ?? null,
        kind: adapter.kind,
        beta: adapter.beta === true,
        docsUrl: adapter.docsUrl ?? '',
        keyUrl: adapter.keyUrl ?? '',
        keyHint: adapter.keyHint ?? '',
        configurableBaseUrl: adapter.configurableBaseUrl === true,
        baseUrl: clean(configured.baseUrl, 500) || adapter.defaultBaseUrl || '',
        configured: key.configured,
        source: key.source,
        defaultModel: configured.defaultModel || (current.defaults.provider === adapter.id ? current.defaults.model : '') || '',
        models: [...(adapter.models ?? []).map((model) => ({ ...model })), ...customModels],
      });
    }
    return views;
  }

  /** Load one reference image (library item first, then an absolute host path). */
  async function loadReference(reference) {
    if (typeof reference !== 'string' || !reference) return undefined;
    if (reference.startsWith('img_')) {
      const item = await library.getItem(reference);
      const image = item?.images?.[0];
      if (!image) throw Object.assign(new Error(`reference "${reference}" has no image`), { status: 400 });
      const located = await library.readImage(reference, image.index, {});
      if (!located) throw Object.assign(new Error(`reference "${reference}" file is missing`), { status: 404 });
      return { data: located.data, mediaType: located.mediaType };
    }
    if (!isAbsolute(reference)) return undefined;
    const mediaType = mediaTypeForPath(reference);
    if (!mediaType) throw Object.assign(new Error(`unsupported reference image: ${basename(reference)}`), { status: 400 });
    const info = await stat(reference).catch(() => undefined);
    if (!info?.isFile()) throw Object.assign(new Error(`reference image not found: ${reference}`), { status: 404 });
    if (info.size > MAX_REFERENCE_BYTES) throw Object.assign(new Error('reference image is larger than 24 MB'), { status: 413 });
    return { data: await readFile(reference), mediaType };
  }

  async function loadReferences(list) {
    const references = Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry).slice(0, 14) : [];
    const loaded = [];
    for (const reference of references) {
      const image = await loadReference(reference);
      if (image) loaded.push(image);
    }
    return loaded;
  }

  /** Save generated bytes as a library item; returns the stored item. */
  async function persistItem({ target, prompt, negativePrompt, params, images, latencyMs, revisedPrompt, source }) {
    const id = library.newId('img');
    const stored = await library.saveFiles(id, images);
    const item = {
      id,
      createdAt: Date.now(),
      provider: target.providerId,
      model: target.modelId,
      prompt,
      negativePrompt,
      params,
      status: 'succeeded',
      error: '',
      latencyMs,
      revisedPrompt: revisedPrompt ?? '',
      title: '',
      tags: [],
      favorite: false,
      rating: 0,
      notes: '',
      source: source ?? { kind: 'ui' },
      images: stored,
    };
    await attachImages(item);
    return library.saveItem(item);
  }

  /**
   * Best effort: give the model the generated image through the attachment
   * service. UI-only generations skip this (the library file is enough and the
   * attachment store would keep a second copy).
   */
  async function attachImages(item) {
    if (item.source?.kind !== 'agent') return;
    const service = attachments();
    if (!service) return;
    for (const image of item.images) {
      try {
        const located = await library.readImage(item.id, image.index, {});
        if (!located) continue;
        const ref = await service.saveImage({
          data: located.data,
          mediaType: image.mediaType,
          name: basename(image.file),
        });
        if (ref) image.attachment = ref;
      } catch (error) {
        logger?.warn?.(`image-studio: could not attach ${item.id}#${image.index}: ${error?.message ?? error}`);
      }
    }
  }

  async function generate(input, options = {}) {
    const prompt = clean(input?.prompt);
    if (!prompt) throw Object.assign(new Error('prompt is required'), { status: 400, code: 'prompt_required' });
    const target = await resolveTarget(input);
    const current = await settings();
    const count = clampCount(input?.count ?? current.defaults.count);
    const aspect = clean(input?.aspect, 16) || clean(current.defaults.aspect, 16);
    const size = clean(input?.size, 32);
    const quality = clean(input?.quality, 32) || clean(current.defaults.quality, 32);
    const seed = Number.isFinite(Number(input?.seed)) && input.seed !== null && input.seed !== '' ? Math.max(0, Math.trunc(Number(input.seed))) : null;
    const negativePrompt = clean(input?.negativePrompt);
    const references = await loadReferences(input?.refs);
    if (references.length > 0 && target.adapter.models?.length) {
      const capabilities = target.adapter.models.find((model) => model.id === target.modelId);
      if (capabilities && capabilities.supportsRefs === false) {
        throw Object.assign(new Error(`${target.modelId} does not accept reference images`), { status: 400, code: 'refs_unsupported' });
      }
    }

    const key = target.adapter.id === 'mock' ? { value: '', source: 'mock' } : await credentials.resolve(target.providerId);
    const needsKey = target.adapter.needsApiKey !== false && target.adapter.ambientAuth !== true;
    if (!key?.value && needsKey) {
      throw Object.assign(new Error(`${target.adapter.label} is not connected`), {
        status: 401,
        code: 'not_configured',
        hint: `Add an API key for ${target.adapter.label} in Image Studio → Settings.`,
      });
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await generateWithAdapter({
        adapterId: target.adapter.id,
        apiKey: key?.value ?? '',
        baseUrl: target.baseUrl,
        // Optional advanced overrides; Vertex falls back to the standard
        // GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION environment.
        options: {
          project: clean(current.providers?.[target.providerId]?.project, 200),
          location: clean(current.providers?.[target.providerId]?.location, 80),
        },
        model: target.modelId,
        prompt,
        negativePrompt,
        aspect,
        size,
        quality,
        count,
        seed,
        refs: references,
        signal: options.signal,
      });
    } catch (error) {
      const described = describeProviderError(error);
      const failure = Object.assign(new Error(described.message), {
        status: described.status || 502,
        code: 'provider_error',
        hint: error?.hint || described.hint,
      });
      throw failure;
    }
    if (!Array.isArray(result?.images) || result.images.length === 0) {
      throw Object.assign(new Error('the provider returned no image'), { status: 502, code: 'no_image' });
    }

    return persistItem({
      target,
      prompt,
      negativePrompt,
      params: { aspect, size, quality, count: result.images.length, seed, refs: Array.isArray(input?.refs) ? input.refs.filter((entry) => typeof entry === 'string').slice(0, 14) : [] },
      images: result.images,
      latencyMs: Date.now() - startedAt,
      revisedPrompt: result.revisedPrompt,
      source: options.source ?? { kind: 'ui' },
    });
  }

  async function compare(input, options = {}) {
    const prompt = clean(input?.prompt);
    if (!prompt) throw Object.assign(new Error('prompt is required'), { status: 400, code: 'prompt_required' });
    const requested = Array.isArray(input?.targets) ? input.targets.map(cleanTarget).filter(Boolean) : [];
    const targets = requested.slice(0, MAX_COMPARE_TARGETS);
    if (targets.length < 2) throw Object.assign(new Error('compare needs at least two targets'), { status: 400, code: 'targets_required' });
    const current = await settings();
    const params = {
      aspect: clean(input?.aspect, 16) || clean(current.defaults.aspect, 16),
      size: clean(input?.size, 32),
      quality: clean(input?.quality, 32) || clean(current.defaults.quality, 32),
      count: 1,
      seed: Number.isFinite(Number(input?.seed)) && input.seed !== null && input.seed !== '' ? Math.max(0, Math.trunc(Number(input.seed))) : null,
      refs: [],
    };
    const run = {
      id: library.newId('run'),
      createdAt: Date.now(),
      prompt,
      negativePrompt: clean(input?.negativePrompt),
      params,
      targets,
      results: [],
    };

    const settled = await Promise.allSettled(
      targets.map(async (target) => {
        const startedAt = Date.now();
        const item = await generate(
          { ...target, prompt, negativePrompt: run.negativePrompt, ...params },
          { signal: options.signal, source: { kind: 'compare', runId: run.id } },
        );
        return { ...target, status: 'succeeded', itemId: item.id, latencyMs: item.latencyMs, error: '' };
      }),
    );
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      const target = targets[index];
      if (outcome.status === 'fulfilled') {
        run.results.push(outcome.value);
      } else {
        const described = describeProviderError(outcome.reason);
        run.results.push({
          provider: target.provider,
          model: target.model,
          status: 'failed',
          itemId: '',
          latencyMs: 0,
          error: outcome.reason?.hint ? `${described.message} — ${outcome.reason.hint}` : described.message,
        });
      }
    }
    await library.saveRun(run);
    return run;
  }

  async function listItems(query = {}) {
    return library.listItems(query);
  }

  async function getItem(id) {
    const item = await library.getItem(id);
    if (!item) throw Object.assign(new Error('image not found'), { status: 404, code: 'not_found' });
    return item;
  }

  async function updateItem(id, patch = {}) {
    const update = {};
    if (patch.favorite !== undefined) update.favorite = patch.favorite === true;
    if (patch.rating !== undefined) update.rating = Math.min(5, Math.max(0, Math.trunc(Number(patch.rating) || 0)));
    if (patch.tags !== undefined) {
      update.tags = (Array.isArray(patch.tags) ? patch.tags : [])
        .map((tag) => clean(tag, 40))
        .filter(Boolean)
        .slice(0, 20);
    }
    if (patch.notes !== undefined) update.notes = clean(patch.notes, 4000);
    if (patch.title !== undefined) update.title = clean(patch.title, 200);
    const item = await library.updateItem(id, update);
    if (!item) throw Object.assign(new Error('image not found'), { status: 404, code: 'not_found' });
    return item;
  }

  async function deleteItem(id) {
    const removed = await library.deleteItem(id);
    if (!removed) throw Object.assign(new Error('image not found'), { status: 404, code: 'not_found' });
    return { ok: true };
  }

  async function saveCredential(providerId, apiKey) {
    const adapter = getAdapter(providerId);
    if (!adapter) throw Object.assign(new Error(`unknown provider "${providerId}"`), { status: 400, code: 'unknown_provider' });
    const value = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!value) throw Object.assign(new Error('API key is empty'), { status: 400, code: 'key_required' });
    if (value.length > 4096) throw Object.assign(new Error('API key is too long'), { status: 400, code: 'key_too_long' });
    await credentials.save(providerId, value);
    return providersView();
  }

  async function clearCredential(providerId) {
    const adapter = getAdapter(providerId);
    if (!adapter) throw Object.assign(new Error(`unknown provider "${providerId}"`), { status: 400, code: 'unknown_provider' });
    await credentials.clear(providerId);
    return providersView();
  }

  async function testCredential(providerId, model, overrides = {}) {
    const adapter = getAdapter(providerId);
    if (!adapter) throw Object.assign(new Error(`unknown provider "${providerId}"`), { status: 400, code: 'unknown_provider' });
    const current = await settings();
    const configured = current.providers?.[providerId] ?? {};
    const key = adapter.id === 'mock' ? { value: '' } : await credentials.resolve(providerId);
    const needsKey = adapter.needsApiKey !== false && adapter.ambientAuth !== true;
    if (!key?.value && needsKey) {
      return { ok: false, latencyMs: 0, message: 'No API key configured for this provider.' };
    }
    const startedAt = Date.now();
    try {
      const outcome = await testAdapter({
        adapterId: adapter.id,
        apiKey: key?.value ?? '',
        baseUrl: clean(configured.baseUrl, 500) || adapter.defaultBaseUrl || '',
        options: {
          model: clean(model, 200) || configured.defaultModel || adapter.models?.[0]?.id || '',
          project: clean(overrides?.project, 200) || clean(configured.project, 200),
          location: clean(overrides?.location, 80) || clean(configured.location, 80),
        },
      });
      return { ok: outcome?.ok === true, latencyMs: Date.now() - startedAt, message: String(outcome?.message ?? (outcome?.ok ? 'Connection OK' : 'Connection failed')) };
    } catch (error) {
      const described = describeProviderError(error);
      return { ok: false, latencyMs: Date.now() - startedAt, message: described.hint ? `${described.message} — ${described.hint}` : described.message };
    }
  }

  async function updateSettings(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('settings patch must be an object'), { status: 400 });
    }
    const sanitized = {};
    if (patch.defaults && typeof patch.defaults === 'object') {
      sanitized.defaults = {};
      for (const field of ['provider', 'model', 'aspect', 'quality']) {
        if (typeof patch.defaults[field] === 'string') sanitized.defaults[field] = clean(patch.defaults[field], 200);
      }
      if (patch.defaults.count !== undefined) sanitized.defaults.count = clampCount(patch.defaults.count);
    }
    if (patch.providers && typeof patch.providers === 'object' && !Array.isArray(patch.providers)) {
      sanitized.providers = {};
      for (const [providerId, value] of Object.entries(patch.providers)) {
        if (!getAdapter(providerId) || value === null || typeof value !== 'object') continue;
        const entry = {};
        if (typeof value.baseUrl === 'string') entry.baseUrl = clean(value.baseUrl, 500);
        if (typeof value.defaultModel === 'string') entry.defaultModel = clean(value.defaultModel, 200);
        if (typeof value.project === 'string') entry.project = clean(value.project, 200);
        if (typeof value.location === 'string') entry.location = clean(value.location, 80);
        if (Array.isArray(value.models)) {
          entry.models = value.models
            .map((model) => (typeof model === 'string' ? { id: model, label: model } : model && typeof model === 'object' ? { id: clean(model.id, 200), label: clean(model.label ?? model.id, 200) } : undefined))
            .filter((model) => model?.id)
            .slice(0, 40);
        }
        sanitized.providers[providerId] = entry;
      }
    }
    if (patch.ui && typeof patch.ui === 'object' && !Array.isArray(patch.ui)) {
      sanitized.ui = {};
      if (typeof patch.ui.lastTab === 'string') sanitized.ui.lastTab = clean(patch.ui.lastTab, 20);
      if (Array.isArray(patch.ui.compareTargets)) {
        sanitized.ui.compareTargets = patch.ui.compareTargets.map(cleanTarget).filter(Boolean).slice(0, MAX_COMPARE_TARGETS);
      }
    }
    return library.writeSettings(sanitized);
  }

  async function listRuns(limit = 20) {
    return library.listRuns(Math.min(50, Math.max(1, Number(limit) || 20)));
  }

  async function getRun(id) {
    const run = await library.getRun(id);
    if (!run) throw Object.assign(new Error('run not found'), { status: 404, code: 'not_found' });
    return run;
  }

  async function deleteRun(id) {
    const removed = await library.deleteRun(id)
    if (!removed) throw Object.assign(new Error('run not found'), { status: 404, code: 'not_found' })
    return { ok: true }
  }

  async function prompts(limit = 20) {
    return library.recentPrompts(Math.min(50, Math.max(1, Number(limit) || 20)));
  }

  async function reveal(path) {
    const target = typeof path === 'string' && path ? path : library.root;
    const shell = (() => {
      try {
        return ctx.get?.('shell', false) ?? undefined;
      } catch {
        return undefined;
      }
    })();
    if (shell?.execute && shell?.resolve) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      try {
        const spec = shell.resolve({ command: `${command} ${JSON.stringify(target)}`, timeoutMs: 8000, onExpiry: 'kill' });
        const execution = await shell.execute(spec);
        await execution.result();
        return { ok: true, path: target };
      } catch (error) {
        logger?.warn?.(`image-studio: reveal failed: ${error?.message ?? error}`);
      }
    }
    return { ok: false, path: target, message: 'Open the folder manually on the host.' };
  }

  async function bootstrap() {
    const current = await settings();
    return {
      version,
      library: { dir: library.root, ...library.stats() },
      providers: await providersView(),
      defaults: current.defaults,
      settings: current,
      compareTargets: current.ui?.compareTargets ?? [],
    };
  }

  async function readImage(id, index, options = {}) {
    const image = await library.readImage(id, Number(index), options);
    if (!image) throw Object.assign(new Error('image not found'), { status: 404, code: 'not_found' });
    return image;
  }

  return {
    bootstrap,
    providersView,
    generate,
    compare,
    listItems,
    getItem,
    updateItem,
    deleteItem,
    saveCredential,
    clearCredential,
    testCredential,
    settings,
    updateSettings,
    prompts,
    listRuns,
    getRun,
    deleteRun,
    reveal,
    readImage,
  };
}
