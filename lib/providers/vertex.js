/**
 * Google Vertex AI image generation (Nano Banana family) over `generateContent`.
 *
 *   POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}
 *        /locations/{location}/publishers/google/models/{model}:generateContent
 *   Authorization: Bearer <token from Application Default Credentials>
 *
 * The credential is the one the harness profile already uses for its own
 * `google-vertex` model route: `GOOGLE_APPLICATION_CREDENTIALS`, gcloud ADC, or
 * the metadata server. Nothing is configured or stored by this plugin.
 *
 * Project and location come from the standard Google Cloud environment
 * (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`); the service account's
 * `project_id` is the fallback.
 */

import { googleLocation, googleProject, resolveAccessToken, describeGoogleAuth } from './google-auth.js';
import { extractImage } from './gemini.js';

const LABEL = 'Vertex AI';
const MAX_COUNT = 4;

const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4', '21:9'];
const QUALITIES = ['1K', '2K', '4K'];
const BASE_MODEL = {
  aspects: ASPECTS,
  sizes: [],
  qualities: QUALITIES,
  supportsRefs: true,
  maxRefs: 14,
};

const MODELS = [
  // Verified against a live project: the 3.x image models are served from the
  // global endpoint; only 2.5 is also available in regional endpoints.
  { ...BASE_MODEL, id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1 · Vertex', defaultLocation: 'global', note: 'Global endpoint; 1K/2K/4K, up to 14 refs.' },
  { ...BASE_MODEL, id: 'gemini-3-pro-image', label: 'Nano Banana Pro · Vertex', defaultLocation: 'global', note: 'Highest fidelity, slower.' },
  { ...BASE_MODEL, id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 · Vertex', defaultLocation: 'global', note: 'Fast general purpose.' },
  { ...BASE_MODEL, id: 'gemini-2.5-flash-image', label: 'Nano Banana · Vertex', defaultLocation: 'us-central1', note: 'First generation; also regional.' },
];

/** A model's own verified location, then the caller's override. */
function defaultLocationFor(modelId) {
  const entry = MODELS.find((model) => model.id === modelId);
  return entry?.defaultLocation || 'us-central1';
}

function implFor(fetchImpl) {
  const impl = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof impl !== 'function') throw new Error(`${LABEL}: no fetch implementation available`);
  return impl;
}

function withNegative(prompt, negativePrompt) {
  const text = String(prompt ?? '');
  const negative = String(negativePrompt ?? '').trim();
  return negative ? `${text}\n\nAvoid: ${negative}` : text;
}

function toBase64(data) {
  if (typeof data === 'string') return data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64');
  throw new Error(`${LABEL}: reference images must be bytes or base64 strings`);
}

function clampCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.min(MAX_COUNT, count);
}

function imageSizeFor(quality) {
  const text = String(quality || '').trim().toUpperCase();
  return /^(1|2|4)K$/.test(text) ? text : '';
}

/** Endpoint for one model in one project/location. */
export function vertexEndpoint({ project, location, model }) {
  const region = String(location || 'us-central1').trim();
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  const base = `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}`;
  return base;
}

function statusError(status, text, statusText) {
  let detail = '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = '';
  }
  const suffix = detail || String(text || '').trim().slice(0, 240) || statusText || '';
  const error = new Error(`${LABEL} request failed (HTTP ${status})${suffix ? `: ${suffix}` : ''}`);
  error.status = status;
  error.body = String(text || '').slice(0, 400);
  if (status === 401 || status === 403) {
    error.hint = 'The Google credential was rejected or lacks the Vertex AI permission (roles/aiplatform.user). DSH\'s google-vertex provider uses the same credential.';
  } else if (status === 404) {
    error.hint = 'Check the model id, the project, and the location (the model may not be enabled in this region).';
  } else if (status === 429) {
    error.hint = 'Vertex AI is rate limiting this project — wait a moment.';
  }
  return error;
}

async function ensureOk(response) {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw statusError(response.status, text, response.statusText);
}

function place(resolved, model, options) {
  // Explicit settings override → the model's verified location → the standard
  // GOOGLE_CLOUD_LOCATION environment → the regional fallback.
  const project = (options?.project || '').trim() || resolved?.projectId || googleProject();
  const location = (options?.location || '').trim() || defaultLocationFor(model) || googleLocation();
  return { project, location, model };
}

export const vertexAdapter = {
  id: 'vertex',
  label: 'Google Vertex AI',
  kind: 'sync',
  docsUrl: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/nano-banana-2-1',
  keyRefs: ['IMAGE_STUDIO_VERTEX_API_KEY', 'GOOGLE_VERTEX_API_KEY', 'VERTEX_API_KEY'],
  keyHint: 'Vertex Express API key (optional)',
  keyUrl: 'https://console.cloud.google.com/vertex-ai/studio/multimodal',
  /** ADC is enough; a pasted Express API key is the no-OAuth fallback. */
  optionalKey: true,
  defaultBaseUrl: '',
  configurableBaseUrl: false,
  /** Credential comes from the machine's Google ADC, exactly like DSH's own route. */
  ambientAuth: true,
  needsApiKey: false,
  models: MODELS,

  /** Status shown in Settings: a pasted Express key, or the machine's ADC. */
  async credentialStatus({ credentials, settings } = {}) {
    const adc = await describeGoogleAuth();
    const override = settings?.providers?.vertex || {};
    let key = { configured: false, source: '' };
    try {
      key = credentials ? await credentials.describe('vertex') : key;
    } catch {
      // A credential service that refuses the ref simply leaves ADC in charge.
    }
    return {
      configured: key.configured || adc.configured,
      source: key.configured ? key.source : adc.source,
      auth: key.configured ? 'express' : 'adc',
      projectId: override.project || adc.projectId,
      // Image models default to the global endpoint (verified per model).
      location: override.location || 'global',
      envPath: adc.envPath,
      error: key.configured ? '' : adc.error,
    };
  },

  async generate(req = {}) {
    const impl = implFor(req.fetchImpl);
    const model = req.model || MODELS[0].id;
    const options = req.options || {};
    const expressKey = String(req.apiKey || '').trim();
    let url;
    let headers;
    if (expressKey) {
      // Vertex AI Express mode: an API key replaces OAuth and project/location.
      url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(expressKey)}`;
      headers = { 'content-type': 'application/json' };
    } else {
      const resolved = await resolveAccessToken({ fetchImpl: impl, signal: req.signal });
      const { project, location } = place(resolved, model, options);
      if (!project) {
        throw Object.assign(
          new Error('No Google Cloud project is configured for Vertex AI.'),
          { status: 400, code: 'vertex_project_missing', hint: 'Set GOOGLE_CLOUD_PROJECT (DSH uses the same variable) or add project_id to the service account key.' },
        );
      }
      url = `${vertexEndpoint({ project, location, model })}:generateContent`;
      headers = {
        authorization: `Bearer ${resolved.token}`,
        'content-type': 'application/json',
        'x-goog-user-project': project,
      };
    }

    const imageConfig = {};
    const aspect = String(req.aspect || '').trim();
    if (aspect) imageConfig.aspectRatio = aspect;
    const imageSize = imageSizeFor(req.quality);
    if (imageSize) imageConfig.imageSize = imageSize;

    const parts = [{ text: withNegative(req.prompt, req.negativePrompt) }];
    for (const ref of req.refs || []) {
      parts.push({ inlineData: { mimeType: ref?.mediaType || 'image/png', data: toBase64(ref?.data) } });
    }

    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
      },
    });

    const count = clampCount(req.count);
    const call = async () => {
      const response = await impl(url, {
        method: 'POST',
        headers,
        body,
        signal: req.signal,
      });
      await ensureOk(response);
      const json = await response.json();
      const found = extractImage(json);
      if (!found) {
        const blocked = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || '';
        throw Object.assign(
          new Error(`${LABEL} returned no image${blocked ? ` (${blocked})` : ''}.`),
          { status: 502, hint: 'Try rephrasing the prompt, or pick another Nano Banana model.' },
        );
      }
      return found;
    };

    const found = await Promise.all(Array.from({ length: count }, () => call()));
    return {
      images: found.map((image) => ({ data: new Uint8Array(Buffer.from(image.data, 'base64')), mediaType: image.mediaType })),
      revisedPrompt: '',
      raw: { provider: 'vertex', auth: expressKey ? 'express' : 'adc', model, count },
    };
  },

  async test({ apiKey, fetchImpl, options } = {}) {
    const impl = implFor(fetchImpl);
    const model = options?.model || MODELS[0].id;
    const expressKey = String(apiKey || '').trim();
    if (expressKey) {
      // A bare POST validates the key before the request body: 401/403 means the
      // key is bad; any other status means Google accepted it.
      const response = await impl(
        `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(expressKey)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => '');
        throw statusError(response.status, text, response.statusText);
      }
      return { ok: true, message: `Vertex Express key accepted for ${model}.` };
    }
    const resolved = await resolveAccessToken({ fetchImpl: impl });
    const { project, location } = place(resolved, model, options);
    if (!project) return { ok: false, message: 'No project: set GOOGLE_CLOUD_PROJECT or service account project_id.' };
    // A bare POST is free: it validates the credential and the model path before
    // any generation happens. 400/422 means "model exists, body incomplete".
    const url = `${vertexEndpoint({ project, location, model })}:generateContent`;
    const response = await impl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resolved.token}`,
        'content-type': 'application/json',
        'x-goog-user-project': project,
      },
      body: '{}',
    });
    if (response.ok || [400, 422, 429, 500, 503].includes(response.status)) {
      return { ok: true, message: `Vertex AI ready — ${project} / ${location} / ${model}` };
    }
    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => '');
      throw statusError(response.status, text, response.statusText);
    }
    if (response.status === 404) {
      // Help the user land on a usable combination: list the publisher's image
      // models in this location and name them in the failure.
      let available = [];
      try {
        const listResponse = await impl(
          `https://${location === 'global' ? 'aiplatform' : `${location}-aiplatform`}.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models?pageSize=200`,
          { headers: { authorization: `Bearer ${resolved.token}`, 'x-goog-user-project': project } },
        );
        if (listResponse.ok) {
          const payload = await listResponse.json();
          available = (payload.models || [])
            .map((entry) => String(entry.name || '').split('/').pop())
            .filter((id) => /image/i.test(id))
            .slice(0, 8);
        }
      } catch {
        // The probe is best effort; the 404 answer below is still correct.
      }
      return {
        ok: false,
        message: `Credentials work, but ${model} is not available in ${location} for ${project}.${available.length ? ` Image models in ${location}: ${available.join(', ')}.` : ''}`,
      };
    }
    const text = await response.text().catch(() => '');
    throw statusError(response.status, text, response.statusText);
  },
};

export default vertexAdapter;
