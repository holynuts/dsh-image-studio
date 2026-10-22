/**
 * `/api/image-studio/*` route table.
 *
 * One prefix route registered on `ctx.webServer`; the handler matches the method
 * and `:param` segments itself so the plugin needs no router dependency. Every
 * request passes the loopback/paired-device fence before touching data.
 */

import { basename } from 'node:path';

import { isAllowed, matchPath, readJson, sendBytes, sendError, sendJson } from '../util/http.js';

const PREFIX = '/api/image-studio';

/** Turn any thrown value into the response envelope. */
function failure(res, error, logger) {
  const status = Number(error?.status) || 500;
  const code = typeof error?.code === 'string' ? error.code : status === 500 ? 'internal_error' : 'request_failed';
  const message = String(error?.message || 'request failed');
  if (status >= 500) logger?.error?.(`image-studio: ${code}: ${message}`);
  if (res.writableEnded) return;
  sendError(res, status, code, message, error?.hint);
}

/** Query helpers. */
function queryValue(url, name) {
  return url.searchParams.get(name) ?? undefined;
}

/**
 * @param {object} options
 * @param {object} options.ctx
 * @param {ReturnType<import('./service.js').createService>} options.service
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 */
export function createRoutes({ ctx, service, logger }) {
  /** @type {Array<{method: string, path: string, handler: (context: object) => unknown}>} */
  const routes = [
    {
      method: 'GET',
      path: '/health',
      handler: () => ({ ok: true }),
    },
    {
      method: 'GET',
      path: '/bootstrap',
      handler: () => service.bootstrap(),
    },
    {
      method: 'POST',
      path: '/generate',
      handler: async ({ body, signal }) => ({ item: await service.generate(body, { source: { kind: 'ui' }, signal }) }),
    },
    {
      method: 'POST',
      path: '/compare',
      handler: async ({ body, signal }) => ({ run: await service.compare(body, { signal }) }),
    },
    {
      method: 'GET',
      path: '/items',
      handler: ({ url }) =>
        service.listItems({
          q: queryValue(url, 'q') ?? '',
          provider: queryValue(url, 'provider') ?? '',
          model: queryValue(url, 'model') ?? '',
          favorite: queryValue(url, 'favorite') === '1',
          tag: queryValue(url, 'tag') ?? '',
          sort: queryValue(url, 'sort') ?? 'newest',
          limit: Number(queryValue(url, 'limit')) || 40,
          cursor: queryValue(url, 'cursor') ?? '',
        }),
    },
    {
      method: 'GET',
      path: '/items/:id',
      handler: async ({ params }) => ({ item: await service.getItem(params.id) }),
    },
    {
      method: 'PATCH',
      path: '/items/:id',
      handler: async ({ params, body }) => ({ item: await service.updateItem(params.id, body) }),
    },
    {
      method: 'DELETE',
      path: '/items/:id',
      handler: async ({ params }) => service.deleteItem(params.id),
    },
    {
      method: 'GET',
      path: '/runs',
      handler: async ({ url }) => {
        const limit = Math.min(50, Math.max(1, Number(queryValue(url, 'limit')) || 20));
        return { runs: await service.listRuns?.(limit) };
      },
    },
    {
      method: 'GET',
      path: '/runs/:id',
      handler: async ({ params }) => ({ run: await service.getRun?.(params.id) }),
    },
    {
      method: 'DELETE',
      path: '/runs/:id',
      handler: async ({ params }) => service.deleteRun(params.id),
    },
    {
      method: 'GET',
      path: '/prompts',
      handler: async ({ url }) => ({ prompts: await service.prompts(Number(queryValue(url, 'limit')) || 20) }),
    },
    {
      method: 'GET',
      path: '/providers',
      handler: async () => ({ providers: await service.providersView() }),
    },
    {
      method: 'POST',
      path: '/credentials',
      handler: async ({ body }) => ({ providers: await service.saveCredential(body.provider, body.apiKey) }),
    },
    {
      method: 'DELETE',
      path: '/credentials/:provider',
      handler: async ({ params }) => ({ providers: await service.clearCredential(params.provider) }),
    },
    {
      method: 'POST',
      path: '/credentials/test',
      handler: async ({ body }) => service.testCredential(body.provider, body.model, { project: body.project, location: body.location }),
    },
    {
      method: 'GET',
      path: '/settings',
      handler: async () => ({ settings: await service.settings() }),
    },
    {
      method: 'PATCH',
      path: '/settings',
      handler: async ({ body }) => ({ settings: await service.updateSettings(body) }),
    },
    {
      method: 'POST',
      path: '/reveal',
      handler: async ({ body }) => service.reveal(body?.path),
    },
    {
      method: 'GET',
      path: '/file/:id/:index',
      handler: async ({ params, url, request, response }) => {
        const image = await service.readImage(params.id, Number(params.index), { thumb: queryValue(url, 'thumb') === '1' });
        const name = basename(image.path);
        const etag = `W/"${params.id}-${params.index}-${image.bytes}"`;
        const ifNoneMatch = request.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          response.writeHead(304, { etag, 'cache-control': 'private, max-age=31536000, immutable' });
          response.end();
          return undefined;
        }
        sendBytes(response, 200, image.data, image.mediaType, {
          etag,
          'cache-control': 'private, max-age=31536000, immutable',
          'content-disposition': `inline; filename="${name}"`,
        });
        return undefined;
      },
    },
    {
      method: 'GET',
      path: '/download/:id/:index',
      handler: async ({ params, url, request, response }) => {
        const image = await service.readImage(params.id, Number(params.index), { thumb: queryValue(url, 'thumb') === '1' });
        const name = basename(image.path);
        sendBytes(response, 200, image.data, image.mediaType, {
          'cache-control': 'private, no-store',
          'content-disposition': `attachment; filename="${name}"`,
        });
        return undefined;
      },
    },
  ];

  async function handle(request, response) {
    if (!isAllowed(ctx, request)) {
      sendError(response, 403, 'forbidden', 'this route only accepts loopback or paired-device requests');
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    } catch {
      sendError(response, 400, 'bad_request', 'malformed request URL');
      return;
    }
    if (!url.pathname.startsWith(PREFIX)) {
      sendError(response, 404, 'not_found', 'unknown route');
      return;
    }
    const segments = url.pathname.slice(PREFIX.length).split('/').filter(Boolean);
    if (segments.length === 0) {
      sendError(response, 404, 'not_found', 'unknown route');
      return;
    }

    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort(new Error('client disconnected'));
    };
    response.on('close', onClose);

    try {
      let matched;
      let params;
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const candidate = matchPath(segments, route.path);
        if (candidate) {
          matched = route;
          params = candidate;
          break;
        }
      }
      if (!matched) {
        const pathExists = routes.some((route) => matchPath(segments, route.path));
        if (pathExists) {
          sendError(response, 405, 'method_not_allowed', `${request.method} is not allowed here`);
        } else {
          sendError(response, 404, 'not_found', 'unknown route');
        }
        return;
      }

      let body = {};
      if (request.method !== 'GET' && request.method !== 'DELETE' && request.method !== 'HEAD') {
        body = await readJson(request);
      }
      const value = await matched.handler({ request, response, url, params, body, signal: controller.signal });
      if (value !== undefined && !response.writableEnded) {
        sendJson(response, 200, value);
      }
    } catch (error) {
      failure(response, error, logger);
    } finally {
      response.off('close', onClose);
    }
  }

  return [{ kind: 'prefix', path: PREFIX, handler: handle }];
}
