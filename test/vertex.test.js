/**
 * Vertex AI adapter tests: ADC credential exchange, endpoint shape, request
 * body, response parsing, and the ambient-auth status surface.
 *
 * No network and no real credentials: a throwaway RSA key signs the JWT and a
 * stub fetch answers the token endpoint and the Vertex endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vertexAdapter, vertexEndpoint } from '../lib/providers/vertex.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function bogusPng(size = 64) {
  const buffer = Buffer.alloc(size);
  PNG.copy(buffer);
  return buffer;
}

/** One throwaway service-account key per call (distinct identity avoids cache hits). */
function serviceAccountJson(projectId = 'demo-project') {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    client_email: `image-studio-${Math.random().toString(36).slice(2)}@${projectId}.iam.gserviceaccount.com`,
    private_key: privateKey,
    token_uri: 'https://oauth2.example.test/token',
  });
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Stub every outbound call and record it. */
function stubFetch({ tokenResponse, generateResponse, failGenerate } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/token')) {
      return tokenResponse || jsonResponse({ access_token: 'ya29.test-token', expires_in: 3600 });
    }
    if (String(url).includes(':generateContent')) {
      if (failGenerate) return failGenerate;
      return generateResponse || jsonResponse({
        candidates: [{
          content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: bogusPng().toString('base64') } }] },
          finishReason: 'STOP',
        }],
      });
    }
    return jsonResponse({ error: { message: 'unexpected url' } }, 404);
  };
  return { fetchImpl, calls };
}

async function withCredentials(projectId, run) {
  const dir = await mkdtemp(join(tmpdir(), 'image-studio-vertex-'));
  const file = join(dir, 'sa.json');
  await writeFile(file, serviceAccountJson(projectId));
  const previousEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
  };
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_LOCATION = 'us-east5';
  try {
    return await run({ file, dir });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test('vertex endpoint uses the regional host and the global host', () => {
  assert.equal(
    vertexEndpoint({ project: 'p', location: 'us-east5', model: 'gemini-nano-banana-2.1' }),
    'https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/google/models/gemini-nano-banana-2.1',
  );
  assert.equal(
    vertexEndpoint({ project: 'p', location: 'global', model: 'm' }),
    'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/m',
  );
});

test('ADC service-account exchange signs a JWT and calls generateContent', async () => {
  await withCredentials('demo-project', async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await vertexAdapter.generate({
      model: 'gemini-nano-banana-2.1',
      prompt: 'a brass diving helmet on wet slate',
      negativePrompt: 'text, watermark',
      aspect: '16:9',
      quality: '2K',
      count: 1,
      fetchImpl,
    });

    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mediaType, 'image/png');
    assert.deepEqual([...result.images[0].data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const tokenCall = calls.find((call) => call.url.includes('/token'));
    assert.ok(tokenCall);
    const tokenBody = new URLSearchParams(tokenCall.init.body);
    assert.equal(tokenBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const segments = tokenBody.get('assertion').split('.');
    assert.equal(segments.length, 3);
    const claims = decodeSegment(segments[1]);
    assert.match(claims.iss, /@demo-project\.iam\.gserviceaccount\.com$/);
    assert.equal(claims.aud, 'https://oauth2.example.test/token');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
    assert.ok(claims.exp > claims.iat);

    const generateCall = calls.find((call) => call.url.includes(':generateContent'));
    assert.equal(
      generateCall.url,
      'https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/publishers/google/models/gemini-nano-banana-2.1:generateContent',
    );
    assert.equal(generateCall.init.headers.authorization, 'Bearer ya29.test-token');
    assert.equal(generateCall.init.headers['x-goog-user-project'], 'demo-project');

    const body = JSON.parse(generateCall.init.body);
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[0].parts[0].text, 'a brass diving helmet on wet slate\n\nAvoid: text, watermark');
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '2K' });
  });
});

test('the access token is cached across calls with the same credential', async () => {
  await withCredentials('cache-project', async () => {
    const { fetchImpl, calls } = stubFetch();
    await vertexAdapter.generate({ model: 'gemini-2.5-flash-image', prompt: 'one', fetchImpl });
    await vertexAdapter.generate({ model: 'gemini-2.5-flash-image', prompt: 'two', fetchImpl });
    assert.equal(calls.filter((call) => call.url.includes('/token')).length, 1);
    assert.equal(calls.filter((call) => call.url.includes(':generateContent')).length, 2);
  });
});

test('count fans out into parallel generateContent calls', async () => {
  await withCredentials('fanout-project', async () => {
    const { fetchImpl, calls } = stubFetch();
    const result = await vertexAdapter.generate({ model: 'gemini-3.1-flash-image', prompt: 'x', count: 3, fetchImpl });
    assert.equal(result.images.length, 3);
    assert.equal(calls.filter((call) => call.url.includes(':generateContent')).length, 3);
  });
});

test('reference images ride as inlineData and no imageConfig appears when empty', async () => {
  await withCredentials('refs-project', async () => {
    const { fetchImpl, calls } = stubFetch();
    await vertexAdapter.generate({
      model: 'gemini-nano-banana-2.1',
      prompt: 'same scene at night',
      refs: [{ data: bogusPng(128), mediaType: 'image/png' }],
      fetchImpl,
    });
    const body = JSON.parse(calls.find((call) => call.url.includes(':generateContent')).init.body);
    assert.equal(body.contents[0].parts.length, 2);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.equal(typeof body.contents[0].parts[1].inlineData.data, 'string');
    assert.equal(body.generationConfig.imageConfig, undefined);
  });
});

test('a 403 surfaces the status and an actionable hint', async () => {
  await withCredentials('denied-project', async () => {
    const { fetchImpl } = stubFetch({
      failGenerate: jsonResponse({ error: { message: 'Permission denied on resource project' } }, 403),
    });
    await assert.rejects(
      () => vertexAdapter.generate({ model: 'gemini-nano-banana-2.1', prompt: 'x', fetchImpl }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /Permission denied/);
        assert.match(error.hint, /aiplatform/);
        return true;
      },
    );
  });
});

test('the model metadata probe reports readiness and region mismatches', async () => {
  await withCredentials('probe-project', async (context) => {
    const ok = await vertexAdapter.test({
      options: { model: 'gemini-nano-banana-2.1', location: 'us-east5' },
      fetchImpl: async (url, init) => {
        if (String(url).includes('/token')) return jsonResponse({ access_token: 'ya29.test-token', expires_in: 3600 });
        assert.equal(
          String(url),
          'https://us-east5-aiplatform.googleapis.com/v1/projects/probe-project/locations/us-east5/publishers/google/models/gemini-nano-banana-2.1:generateContent',
        );
        assert.equal(init.headers.authorization, 'Bearer ya29.test-token');
        return jsonResponse({ name: 'publishers/google/models/gemini-nano-banana-2.1' });
      },
    });
    assert.equal(ok.ok, true);
    assert.match(ok.message, /probe-project \/ us-east5/);

    const missing = await vertexAdapter.test({
      options: { model: 'gemini-3-pro-image', location: 'us-east5' },
      fetchImpl: async (url) => {
        if (String(url).includes('/token')) return jsonResponse({ access_token: 'ya29.other', expires_in: 3600 });
        return jsonResponse({ error: { message: 'not found' } }, 404);
      },
    });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /not available in us-east5/);
  });
});

test('no ADC produces a clear, actionable failure', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'image-studio-empty-home-'));
  const previous = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    DSH_HOME: process.env.DSH_HOME,
  };
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/image-studio.json';
  process.env.DSH_HOME = emptyHome;
  try {
    const fetchImpl = async () => jsonResponse({ error: { message: 'no metadata' } }, 404);
    await assert.rejects(
      () => vertexAdapter.generate({ model: 'gemini-nano-banana-2.1', prompt: 'x', fetchImpl }),
      (error) => {
        assert.equal(error.code, 'google_auth_failed');
        assert.match(error.message, /No Google Cloud credentials/);
        assert.match(error.hint, /GOOGLE_APPLICATION_CREDENTIALS/);
        return true;
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test('an Express API key bypasses OAuth and the project path', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: bogusPng().toString('base64') } }] } }],
    });
  };
  const result = await vertexAdapter.generate({
    apiKey: 'AIza-express-test',
    model: 'gemini-nano-banana-2.1',
    prompt: 'a paper crane',
    aspect: '1:1',
    fetchImpl,
  });
  assert.equal(result.images[0].mediaType, 'image/jpeg');
  const call = calls[0];
  assert.equal(
    call.url,
    'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-nano-banana-2.1:generateContent?key=AIza-express-test',
  );
  assert.equal(call.init.headers.authorization, undefined);
  assert.equal(call.init.headers['x-goog-user-project'], undefined);
  assert.equal(JSON.parse(call.init.body).generationConfig.imageConfig.aspectRatio, '1:1');
});

test('the Express probe accepts any non-auth status and rejects 401', async () => {
  const accepted = await vertexAdapter.test({
    apiKey: 'AIza-express-test',
    options: { model: 'gemini-nano-banana-2.1' },
    fetchImpl: async (url, init) => {
      assert.match(String(url), /:generateContent\?key=AIza-express-test$/);
      assert.equal(init.body, '{}');
      return jsonResponse({ error: { message: 'invalid argument' } }, 400);
    },
  });
  assert.equal(accepted.ok, true);

  await assert.rejects(
    () => vertexAdapter.test({
      apiKey: 'bad-key',
      fetchImpl: async () => jsonResponse({ error: { message: 'API key not valid' } }, 401),
    }),
    (error) => {
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('a key copied into DSH_HOME is used when the env path is unreadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'image-studio-dsh-home-'));
  await writeFile(join(dir, 'vertex-service-account.json'), serviceAccountJson('dsh-home-project'));
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
  };
  process.env.DSH_HOME = dir;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/nonexistent/denied.json';
  delete process.env.GOOGLE_CLOUD_LOCATION;
  try {
    const { fetchImpl, calls } = stubFetch();
    const result = await vertexAdapter.generate({ model: 'gemini-nano-banana-2.1', prompt: 'fallback', fetchImpl });
    assert.equal(result.images.length, 1);
    assert.match(
      calls.find((call) => call.url.includes(':generateContent')).url,
      /projects\/dsh-home-project\/locations\/global\//,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
