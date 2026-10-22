/**
 * Service-level integration tests: Library + adapters + the shared operations.
 *
 * These run without the Harness: the context is a stub that exposes no optional
 * services, which is also the degradation path the plugin must survive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Library } from '../lib/core/library.js';
import { createCredentialStore } from '../lib/core/credentials.js';
import { createService } from '../lib/core/service.js';
import { createTools } from '../lib/core/tools.js';
import { getAdapter } from '../lib/providers/index.js';

/** Minimal in-memory stand-in for the Harness credential service. */
class FakeCredentials {
  constructor() {
    this.values = new Map();
  }
  async describe(ref) {
    return this.values.has(ref)
      ? { configured: true, source: 'stored', writable: true }
      : { configured: false, writable: true };
  }
  async resolve(ref) {
    return this.values.has(ref) ? { value: this.values.get(ref), source: 'stored' } : undefined;
  }
  async set(ref, value) {
    this.values.set(ref, value);
  }
  async unset(ref) {
    this.values.delete(ref);
  }
}

/** Stub host context: in-memory credentials, no attachments, no shell. */
function stubContext() {
  const values = new Map();
  values.set('credentials', new FakeCredentials());
  return {
    get(name) {
      return values.get(name);
    },
    provide(name, value) {
      values.set(name, value);
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'image-studio-service-'));
  const ctx = stubContext();
  const library = new Library({ root, logger: ctx.logger });
  await library.init();
  const credentials = createCredentialStore(ctx, getAdapter);
  const service = createService({ ctx, library, credentials, logger: ctx.logger, version: 'test' });
  return { root, ctx, library, credentials, service, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('bootstrap describes providers and an empty library', async () => {
  const h = await harness();
  try {
    const boot = await h.service.bootstrap();
    assert.equal(boot.version, 'test');
    assert.equal(boot.library.dir, h.root);
    assert.equal(boot.library.itemCount, 0);
    const ids = boot.providers.map((provider) => provider.id);
    assert.ok(ids.includes('gemini'));
    assert.ok(ids.includes('openai'));
    assert.ok(ids.includes('mock'));
    const mock = boot.providers.find((provider) => provider.id === 'mock');
    assert.equal(mock.configured, true);
    const gemini = boot.providers.find((provider) => provider.id === 'gemini');
    assert.equal(gemini.configured, false);
    assert.ok(gemini.models.some((model) => model.id === 'gemini-nano-banana-2.1'));
  } finally {
    await h.cleanup();
  }
});

test('mock generation persists files, metadata, and appears in listings', async () => {
  const h = await harness();
  try {
    const item = await h.service.generate({ provider: 'mock', model: 'mock-1', prompt: 'a quiet lighthouse at dusk', aspect: '16:9', count: 1 });
    assert.equal(item.status, 'succeeded');
    assert.equal(item.provider, 'mock');
    assert.equal(item.prompt, 'a quiet lighthouse at dusk');
    assert.equal(item.images.length, 1);
    assert.ok(item.images[0].width > 0 && item.images[0].height > 0);
    const bytes = await readFile(join(h.root, item.images[0].file));
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const listed = await h.service.listItems({ q: 'lighthouse' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, item.id);
    assert.equal(listed.items[0].notes, undefined);

    const detail = await h.service.getItem(item.id);
    assert.equal(detail.id, item.id);
    assert.equal(detail.params.aspect, '16:9');

    const fav = await h.service.updateItem(item.id, { favorite: true, rating: 4, tags: ['sea', 'dusk'] });
    assert.equal(fav.favorite, true);
    assert.equal(fav.rating, 4);
    assert.deepEqual(fav.tags, ['sea', 'dusk']);

    const onlyFavorites = await h.service.listItems({ favorite: true });
    assert.equal(onlyFavorites.total, 1);

    const prompts = await h.service.prompts();
    assert.equal(prompts[0].prompt, 'a quiet lighthouse at dusk');
    assert.equal(prompts[0].uses, 1);

    await h.service.deleteItem(item.id);
    assert.equal((await h.service.listItems({})).total, 0);
  } finally {
    await h.cleanup();
  }
});

test('compare runs two mock targets and records a durable run', async () => {
  const h = await harness();
  try {
    const run = await h.service.compare({
      prompt: 'an isometric reading nook',
      targets: [
        { provider: 'mock', model: 'mock-1' },
        { provider: 'mock', model: 'mock-1' },
      ],
    });
    assert.equal(run.results.length, 2);
    assert.ok(run.results.every((result) => result.status === 'succeeded' && result.itemId.startsWith('img_')));
    const runs = await h.service.listRuns(5);
    assert.equal(runs[0].id, run.id);
    assert.equal((await h.service.listItems({})).total, 2);
    await assert.rejects(() => h.service.compare({ prompt: 'x', targets: [{ provider: 'mock', model: 'mock-1' }] }), /two targets/);
  } finally {
    await h.cleanup();
  }
});

test('missing credentials produce an actionable failure', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.service.generate({ provider: 'openai', model: 'gpt-image-2.5-flare', prompt: 'x' }),
      (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.code, 'not_configured');
        assert.match(error.hint, /Settings/);
        return true;
      },
    );
    await assert.rejects(() => h.service.generate({ provider: 'mock', model: 'mock-1', prompt: '   ' }), /prompt is required/);
    await assert.rejects(() => h.service.generate({ provider: 'nope', model: 'x', prompt: 'x' }), /unknown provider/);
  } finally {
    await h.cleanup();
  }
});

test('reference images come from library items and files', async () => {
  const h = await harness();
  try {
    const base = await h.service.generate({ provider: 'mock', model: 'mock-1', prompt: 'base image' });
    const absolute = join(h.root, base.images[0].file);
    const edited = await h.service.generate({
      provider: 'mock',
      model: 'mock-1',
      prompt: 'same scene at night',
      refs: [base.id, absolute],
    });
    assert.equal(edited.params.refs.length, 2);
    assert.equal(edited.status, 'succeeded');
    await assert.rejects(
      () => h.service.generate({ provider: 'mock', model: 'mock-1', prompt: 'x', refs: ['/etc/hosts'] }),
      /unsupported reference image/,
    );
  } finally {
    await h.cleanup();
  }
});

test('credential save resolves through the stub service and settings merge', async () => {
  const h = await harness();
  try {
    const saved = await h.service.saveCredential('openai', 'sk-test-not-a-real-key');
    const openai = saved.find((provider) => provider.id === 'openai');
    assert.equal(openai.configured, true);
    assert.equal(openai.source, 'IMAGE_STUDIO_OPENAI_API_KEY');

    const merged = await h.service.updateSettings({
      defaults: { provider: 'openai', model: 'gpt-image-2.5-flare', aspect: '16:9', quality: 'high', count: 2 },
      providers: { openai: { baseUrl: 'https://example.test/v1' } },
      ui: { lastTab: 'library' },
    });
    assert.equal(merged.defaults.provider, 'openai');
    assert.equal(merged.defaults.count, 2);
    assert.equal(merged.providers.openai.baseUrl, 'https://example.test/v1');
    assert.deepEqual(merged.ui.lastTab, 'library');
    assert.equal(merged.secrets, undefined);

    const cleared = await h.service.clearCredential('openai');
    assert.equal(cleared.find((provider) => provider.id === 'openai').configured, false);
  } finally {
    await h.cleanup();
  }
});

test('tools share the service path and render file paths', async () => {
  const h = await harness();
  try {
    const { tools } = createTools({ ctx: h.ctx, service: h.service, library: h.library });
    const generate = tools.find((tool) => tool.name === 'image_generate');
    assert.ok(generate);
    const value = await generate.execute({ prompt: 'a red paper crane on a desk', provider: 'mock', model: 'mock-1', aspect: '1:1' }, { agent: { id: 'session-x' }, signal: new AbortController().signal });
    assert.ok(value.itemId.startsWith('img_'));
    assert.equal(value.files.length, 1);
    assert.ok(value.files[0].path.startsWith(h.root));
    const content = generate.output.render({}, value);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /Generated 1 image/);

    const search = tools.find((tool) => tool.name === 'image_library_search');
    const found = await search.execute({ query: 'paper crane' });
    assert.equal(found.total, 1);
    assert.equal(found.items[0].id, value.itemId);

    const providers = tools.find((tool) => tool.name === 'image_providers');
    const providerValue = await providers.execute({});
    assert.ok(providerValue.providers.some((provider) => provider.id === 'mock'));

    const item = await h.service.getItem(value.itemId);
    assert.equal(item.source.kind, 'agent');
    assert.equal(item.source.sessionId, 'session-x');
  } finally {
    await h.cleanup();
  }
});
