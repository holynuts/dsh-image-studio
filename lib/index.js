/**
 * Image Studio — host half.
 *
 * Owns the on-disk library, the provider credentials, the `/api/image-studio`
 * route family, and the agent tools. The browser half (`./client`) renders the
 * sidebar entry and the panel. Keys live in the Harness credential service; the
 * library lives under `$DSH_HOME/image-studio` unless `config.libraryDir` says
 * otherwise.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { Library } from './core/library.js';
import { createCredentialStore } from './core/credentials.js';
import { createService } from './core/service.js';
import { createRoutes } from './core/router.js';
import { createTools } from './core/tools.js';
import { getAdapter } from './providers/index.js';

/** Build marker: changing this line forces a fresh host module generation. */
const BUILD_MARKER = '0.3.5+vertex';

/** Stable cordis plugin name. */
export const name = 'image-studio';

/** Services that must exist before the routes and tools can mount. */
export const inject = ['webServer', 'tools'];

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const GUIDANCE = `Image Studio is installed (sidebar panel "Image Studio").
- When the user asks you to create, draw, illustrate, or edit an image, use image_generate. It saves every result to a shared library with its prompt and settings, and returns absolute file paths.
- Call image_providers first only when the user named a provider or model; otherwise omit provider/model and let the configured default apply.
- To edit or vary an earlier image, pass its item id (img_…) or absolute path in \`references\`.
- To look at a generated file, read the returned path with read_image. To find earlier work, use image_library_search / image_library_get instead of regenerating.
- Generation costs the user real money: do not batch speculative variations unless asked.`;

/**
 * Mount the plugin.
 * @param {object} ctx cordis host context
 * @param {{libraryDir?: string, enabled?: boolean}} [config] row config
 */
export async function apply(ctx, config = {}) {
  if (config?.enabled === false) return;
  try {
    if (ctx.get?.('imageStudio', false)) return;
  } catch {
    // A context without the lookup still proceeds; duplicate registration fails loudly.
  }

  const logger = ctx.logger ?? console;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const root =
    typeof config?.libraryDir === 'string' && config.libraryDir.trim()
      ? resolve(config.libraryDir.trim())
      : join(home, 'image-studio');

  const library = new Library({ root, logger });
  await library.init();

  const credentials = createCredentialStore(ctx, getAdapter);
  const service = createService({ ctx, library, credentials, logger, version: VERSION });

  try {
    ctx.provide('imageStudio', service);
  } catch (error) {
    logger?.warn?.(`image-studio: could not publish the imageStudio service: ${error?.message ?? error}`);
  }

  const routes = createRoutes({ ctx, service, logger });
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'image-studio: routes');

  const { tools } = createTools({ ctx, service, library });
  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, 'image-studio: tools');

  const systemPrompt = (() => {
    try {
      return ctx.get?.('systemPrompt', false) ?? undefined;
    } catch {
      return undefined;
    }
  })();
  if (systemPrompt?.section) {
    ctx.effect(() => systemPrompt.section({ name: 'plugin:image-studio', order: 210, text: GUIDANCE }), 'image-studio: guidance');
  }

  logger?.info?.(`image-studio: library ${root}; ${tools.length} tools; routes /api/image-studio`);
}
