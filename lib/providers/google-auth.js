/**
 * Already-configured Google credentials for the Vertex AI provider.
 *
 * The harness profile already authenticates Google Cloud for its own model
 * routes (pi-ai's `google-vertex` provider). This module reads the very same
 * Application Default Credentials so Image Studio never asks the user for a
 * second copy: `$GOOGLE_APPLICATION_CREDENTIALS` (a service-account JSON), then
 * `gcloud auth application-default login`, then the GCE metadata server.
 *
 * Vertex's REST API still needs an OAuth bearer token, so an ADC credential is
 * exchanged for one here — with no interactive flow and nothing stored by this
 * plugin. Tokens are cached per credential until shortly before expiry.
 */

import { createSign, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const CACHE_SKEW_MS = 60_000;
const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** @type {Map<string, {token: string, expiresAt: number, projectId: string, source: string}>} */
const tokenCache = new Map();

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function authError(message, hint) {
  const error = new Error(message);
  error.code = 'google_auth_failed';
  error.status = 401;
  if (hint) error.hint = hint;
  return error;
}

/** Project the configured Google Cloud project, if any. */
export function googleProject(credential) {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_VERTEX_PROJECT ||
    (credential && typeof credential.project_id === 'string' ? credential.project_id : '') ||
    ''
  );
}

/** Location for the Vertex endpoint (region name, or `global`). */
export function googleLocation() {
  return (
    process.env.GOOGLE_CLOUD_LOCATION ||
    process.env.GOOGLE_VERTEX_LOCATION ||
    process.env.VERTEX_LOCATION ||
    'us-central1'
  );
}

/** Read the ADC file the environment points at, then the gcloud default. */
async function loadApplicationDefault() {
  const candidates = [];
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (fromEnv) candidates.push({ path: fromEnv, source: 'GOOGLE_APPLICATION_CREDENTIALS' });
  // A copy inside DSH's own directory, for machines where macOS denies the
  // harness access to Documents (the env path then fails with EPERM).
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  candidates.push({ path: join(dshHome, 'vertex-service-account.json'), source: 'DSH home' });
  candidates.push({ path: join(dshHome, 'vertex_ai_service_account.json'), source: 'DSH home' });
  candidates.push({ path: join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'), source: 'gcloud ADC' });
  for (const candidate of candidates) {
    try {
      return { credential: JSON.parse(await readFile(candidate.path, 'utf8')), source: candidate.source };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Exchange a service-account key for an access token (JWT bearer grant). */
async function tokenFromServiceAccount(credential, fetchImpl, signal) {
  if (!credential.client_email || !credential.private_key) {
    throw authError('This is not a usable service account key.', 'It must contain client_email and private_key.');
  }
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credential.token_uri || DEFAULT_TOKEN_URI;
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credential.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(credential.private_key);
  } catch {
    throw authError('The service account private key could not sign a token.', 'Re-download the JSON key; it may be corrupted.');
  }
  const assertion = `${signingInput}.${base64Url(signature)}`;
  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.access_token) {
    const field = payload.error;
    const detail =
      payload.error_description ||
      (typeof field === 'string' ? field : field?.message) ||
      text.slice(0, 200) ||
      `HTTP ${response.status}`;
    throw authError(`Google rejected the service account: ${detail}`, 'Check that the key is active and the Vertex AI API is enabled for the project.');
  }
  return {
    token: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    projectId: typeof credential.project_id === 'string' ? credential.project_id : '',
    source: 'Application Default Credentials',
  };
}

/** Exchange a gcloud authorized-user refresh token for an access token. */
async function tokenFromAuthorizedUser(credential, fetchImpl, signal) {
  if (!credential.client_id || !credential.client_secret || !credential.refresh_token) {
    throw authError('The Application Default Credentials file is incomplete.', 'Run `gcloud auth application-default login` again.');
  }
  const response = await fetchImpl(DEFAULT_TOKEN_URI, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
    }).toString(),
    signal,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.access_token) {
    const field = payload.error;
    const detail =
      payload.error_description ||
      (typeof field === 'string' ? field : field?.message) ||
      text.slice(0, 200) ||
      `HTTP ${response.status}`;
    throw authError(`Google rejected the gcloud credentials: ${detail}`, 'Run `gcloud auth application-default login` again.');
  }
  return {
    token: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    projectId: '',
    source: 'gcloud ADC',
  };
}

/** One token from the metadata server when the harness runs on Google Cloud. */
async function tokenFromMetadata(fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(METADATA_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    if (!payload?.access_token) return undefined;
    return {
      token: payload.access_token,
      expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      projectId: '',
      source: 'metadata server',
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an access token from the environment's Application Default Credentials.
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{token: string, projectId: string, source: string}>}
 */
export async function resolveAccessToken({ fetchImpl, signal } = {}) {
  const impl = fetchImpl || globalThis.fetch;
  const adc = await loadApplicationDefault();

  if (adc?.credential) {
    const kind = adc.credential.type;
    if (kind === 'service_account') {
      const key = `sa:${fingerprint(adc.credential.client_email)}`;
      const cached = tokenCache.get(key);
      if (cached && cached.expiresAt - CACHE_SKEW_MS > Date.now()) return cached;
      const fresh = await tokenFromServiceAccount(adc.credential, impl, signal);
      tokenCache.set(key, fresh);
      return fresh;
    }
    if (kind === 'authorized_user') {
      const key = `au:${fingerprint(adc.credential.refresh_token)}`;
      const cached = tokenCache.get(key);
      if (cached && cached.expiresAt - CACHE_SKEW_MS > Date.now()) return cached;
      const fresh = await tokenFromAuthorizedUser(adc.credential, impl, signal);
      tokenCache.set(key, fresh);
      return fresh;
    }
    throw authError(
      'The Google credential type is not supported.',
      `Expected service_account or authorized_user, got "${kind || 'unknown'}". Create a service-account key and point GOOGLE_APPLICATION_CREDENTIALS at it.`,
    );
  }

  const metadata = await tokenFromMetadata(impl);
  if (metadata) return metadata;

  throw authError(
    'No Google Cloud credentials were found for Vertex AI.',
    'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON, run `gcloud auth application-default login`, or copy the key to ~/.dsh/vertex-service-account.json (needed when macOS denies the harness access to Documents).',
  );
}

/** Describe the ambient Google auth state for the settings surface. */
export async function describeGoogleAuth() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  const adc = await loadApplicationDefault();
  if (adc) {
    return {
      configured: true,
      source: adc.source,
      projectId: googleProject(adc.credential),
      location: googleLocation(),
      envPath: Boolean(envPath),
      error: '',
    };
  }
  let error = '';
  if (envPath) {
    try {
      JSON.parse(await readFile(envPath, 'utf8'));
    } catch (reason) {
      error = `${reason?.code || reason?.name || 'read_error'}`;
    }
  }
  return { configured: false, source: '', projectId: googleProject(), location: googleLocation(), envPath: Boolean(envPath), error };
}
