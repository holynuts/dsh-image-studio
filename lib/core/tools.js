/**
 * Agent tools for Image Studio.
 *
 * Every tool calls the same service methods the panel calls, so a generation
 * started from chat and one started from the UI land in the library identically.
 * Results carry absolute file paths plus (when the attachment service is
 * available) inline image blocks the model can actually see.
 */

const TOOL_NAMES = [
  'image_generate',
  'image_library_search',
  'image_library_get',
  'image_library_update',
  'image_providers',
];

/** Model-facing description of one item, without internal file layout. */
function itemSummary(item) {
  return {
    id: String(item?.id ?? ''),
    createdAt: Number(item?.createdAt ?? 0),
    provider: String(item?.provider ?? ''),
    model: String(item?.model ?? ''),
    prompt: String(item?.prompt ?? ''),
    aspect: String(item?.params?.aspect ?? ''),
    size: String(item?.params?.size ?? ''),
    quality: String(item?.params?.quality ?? ''),
    favorite: item?.favorite === true,
    rating: Number(item?.rating ?? 0),
    tags: Array.isArray(item?.tags) ? item.tags.slice(0, 20) : [],
    status: String(item?.status ?? ''),
    images: (Array.isArray(item?.images) ? item.images : []).map((image) => ({
      width: Number(image?.width ?? 0),
      height: Number(image?.height ?? 0),
      bytes: Number(image?.bytes ?? 0),
      mediaType: String(image?.mediaType ?? ''),
    })),
  };
}

/** Human-readable one-block summary for the model. */
function summaryText(lines) {
  return lines.filter(Boolean).join('\n');
}

/** Absolute paths of an item on the host, for the model to read or reference. */
export function itemPaths(library, item) {
  return (Array.isArray(item?.images) ? item.images : []).map((image) => `${library.root}/${image.file}`);
}

const OUTPUT_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    mediaType: { type: 'string' },
  },
  required: ['path', 'width', 'height', 'bytes', 'mediaType'],
};

const GENERATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemId: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    prompt: { type: 'string' },
    aspect: { type: 'string' },
    seed: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    latencyMs: { type: 'integer' },
    files: { type: 'array', items: OUTPUT_FILE_SCHEMA },
    library: { type: 'string' },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  required: ['itemId', 'provider', 'model', 'prompt', 'files', 'library'],
};

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

/** Resolve the calling session's working directory without hard dependencies. */
function sessionCwd(ctx, exec) {
  try {
    const sessions = ctx.get?.('sessions', false);
    const session = sessions?.get?.(exec?.agent?.id);
    const cwd = session?.header?.cwd;
    return typeof cwd === 'string' ? cwd : '';
  } catch {
    return '';
  }
}

/**
 * Build the tool definitions.
 * @param {object} options
 * @param {object} options.ctx host context
 * @param {ReturnType<import('./service.js').createService>} options.service
 * @param {import('./library.js').Library} options.library
 */
export function createTools({ ctx, service, library }) {
  const generateTool = {
    name: 'image_generate',
    description:
      'Generate an image with the configured image provider (Nano Banana 2.1, ChatGPT Image, fal, Replicate, or an OpenAI-compatible endpoint). ' +
      'The result is written to the Image Studio library and returned with absolute file paths. ' +
      'Use `provider`/`model` freely only from image_providers; pass reference images as library item ids (img_…) or absolute paths to make an edit/variation. ' +
      'Prefer one good prompt over many speculative calls. Images cost real money on the user account.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be specific about subject, style, lighting, composition, and any text to render.' },
        provider: { type: 'string', description: 'Provider id from image_providers (e.g. gemini, openai, fal, replicate, openai-compatible, mock). Omit for the default.' },
        model: { type: 'string', description: 'Model id from image_providers. Omit for the provider default.' },
        negativePrompt: { type: 'string', description: 'What to avoid. Folded into the prompt when the provider has no negative field.' },
        aspect: { type: 'string', description: 'Aspect ratio such as 1:1, 16:9, 9:16, 4:3, 3:4. Omit for the model default.' },
        size: { type: 'string', description: 'Explicit WxH when the provider takes sizes (e.g. 1536x1024). Usually prefer aspect.' },
        quality: { type: 'string', description: 'Quality or resolution tier the model advertises (e.g. low|medium|high|xhigh|max for OpenAI, 1K|2K|4K for Gemini).' },
        count: { type: 'integer', description: 'How many images to generate, 1-4. Default 1.' },
        seed: { type: 'integer', description: 'Seed for reproducibility when the provider supports it.' },
        references: { ...STRING_ARRAY, description: 'Reference images: library item ids (img_…) or absolute paths. Use for edits, variations, or character consistency.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: GENERATE_OUTPUT_SCHEMA,
      render(_args, value) {
        const blocks = [
          {
            type: 'text',
            text: summaryText([
              `Generated ${value.files?.length ?? 0} image(s) with ${value.provider} · ${value.model}${value.aspect ? ` · ${value.aspect}` : ''}${value.seed !== null && value.seed !== undefined ? ` · seed ${value.seed}` : ''}.`,
              `Item: ${value.itemId} (in the Image Studio library, ${value.library})`,
              ...(value.files ?? []).map((file) => `File: ${file.path} (${file.width}x${file.height})`),
              'Open the Image Studio panel in the sidebar to browse, rate, and reuse it.',
            ]),
          },
        ];
        for (const image of Array.isArray(value.images) ? value.images : []) {
          if (image?.attachment) blocks.push({ type: 'image', attachment: image.attachment });
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = sessionCwd(ctx, exec);
      const item = await service.generate(
        {
          provider: args?.provider,
          model: args?.model,
          prompt: args?.prompt,
          negativePrompt: args?.negativePrompt,
          aspect: args?.aspect,
          size: args?.size,
          quality: args?.quality,
          count: args?.count,
          seed: args?.seed,
          refs: args?.references,
        },
        {
          signal: exec?.signal,
          source: { kind: 'agent', sessionId: String(exec?.agent?.id ?? ''), cwd },
        },
      );
      return {
        itemId: item.id,
        provider: item.provider,
        model: item.model,
        prompt: item.prompt,
        aspect: item.params?.aspect ?? '',
        seed: item.params?.seed ?? null,
        latencyMs: item.latencyMs,
        files: (item.images ?? []).map((image) => ({
          path: `${library.root}/${image.file}`,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
          mediaType: image.mediaType,
        })),
        library: library.root,
        images: (item.images ?? []).map((image) => (image.attachment ? { attachment: image.attachment } : {})),
      };
    },
  };

  const searchTool = {
    name: 'image_library_search',
    description:
      'Search the Image Studio library (generated images with their prompts and settings). Returns compact metadata — use image_library_get for one item, and open a file path with read_image when you need to look at it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Case-insensitive text over prompt, title, notes, tags, and model.' },
        provider: { type: 'string', description: 'Filter by provider id.' },
        model: { type: 'string', description: 'Filter by model id.' },
        favorite: { type: 'boolean', description: 'Only favorited items.' },
        tag: { type: 'string', description: 'Filter by one tag.' },
        sort: { type: 'string', enum: ['newest', 'oldest'], description: 'Sort order. Default newest.' },
        limit: { type: 'integer', description: 'Page size, 1-100. Default 20.' },
        cursor: { type: 'string', description: 'nextCursor from a previous page.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer' },
          hasMore: { type: 'boolean' },
          nextCursor: { type: 'string' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['total', 'hasMore', 'items'],
      },
      render(_args, value) {
        if (!value.items || value.items.length === 0) {
          return [{ type: 'text', text: 'No images matched. Generate one with image_generate.' }];
        }
        const lines = [`${value.total} image(s) matched${value.hasMore ? ` (showing ${value.items.length})` : ''}:`];
        for (const item of value.items) {
          lines.push(
            `- ${item.id} · ${item.provider} · ${item.model} · ${item.aspect || '?'} · ${new Date(item.createdAt).toISOString()}${item.favorite ? ' · ★' : ''}\n  prompt: ${String(item.prompt).slice(0, 240)}`,
          );
        }
        if (value.nextCursor) lines.push(`Next page cursor: ${value.nextCursor}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await service.listItems({
        q: args?.query ?? '',
        provider: args?.provider ?? '',
        model: args?.model ?? '',
        favorite: args?.favorite === true,
        tag: args?.tag ?? '',
        sort: args?.sort ?? 'newest',
        limit: Math.min(100, Math.max(1, Number(args?.limit) || 20)),
        cursor: args?.cursor ?? '',
      });
      return {
        total: result.total,
        hasMore: result.hasMore === true,
        nextCursor: result.nextCursor ?? '',
        items: result.items.map((item) => ({ ...itemSummary(item), paths: itemPaths(library, item) })),
      };
    },
  };

  const getTool = {
    name: 'image_library_get',
    description: 'Read one Image Studio library item in full: prompt, negative prompt, provider, model, every generation parameter, tags, rating, notes, and absolute file paths.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'Item id (img_…) or an exact prompt search term.' } },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { item: { type: 'object', additionalProperties: true } } },
      render(_args, value) {
        const item = value.item ?? {};
        return [
          {
            type: 'text',
            text: summaryText([
              `${item.id} · ${item.provider} · ${item.model}`,
              `Prompt: ${item.prompt}`,
              item.negativePrompt ? `Avoid: ${item.negativePrompt}` : '',
              `Params: ${JSON.stringify(item.params ?? {})}`,
              `Created: ${new Date(item.createdAt).toISOString()} · ${item.latencyMs}ms${item.favorite ? ' · ★ favorite' : ''}${item.rating ? ` · ${item.rating}/5` : ''}`,
              item.tags?.length ? `Tags: ${item.tags.join(', ')}` : '',
              item.notes ? `Notes: ${item.notes}` : '',
              ...(value.paths ?? []).map((path) => `File: ${path}`),
            ]),
          },
        ];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = String(args?.id ?? '');
      let item;
      try {
        item = await service.getItem(id);
      } catch (error) {
        const result = await service.listItems({ q: id, limit: 1 });
        item = result.items[0];
        if (!item) throw error;
      }
      return { item, paths: itemPaths(library, item) };
    },
  };

  const updateTool = {
    name: 'image_library_update',
    description: 'Update one library item: mark a favorite, set a 0-5 rating, replace its tags, set a short title, or write notes. Use it to keep the user\u2019s picks and annotations durable.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Item id (img_…).' },
        favorite: { type: 'boolean', description: 'Mark as favorite.' },
        rating: { type: 'integer', description: '0-5 stars; 0 clears.' },
        tags: { ...STRING_ARRAY, description: 'Replacement tag list (max 20).' },
        title: { type: 'string', description: 'Short display title.' },
        notes: { type: 'string', description: 'Free-form notes (max 4000 chars).' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { item: { type: 'object', additionalProperties: true } }, required: ['item'] },
      render(_args, value) {
        const item = value.item ?? {};
        return [{ type: 'text', text: `Updated ${item.id}: ${item.favorite ? '★ favorite ' : ''}${item.rating ? `${item.rating}/5 ` : ''}${item.tags?.length ? `tags ${item.tags.join(', ')}` : ''}`.trim() }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const item = await service.updateItem(String(args?.id ?? ''), {
        favorite: args?.favorite,
        rating: args?.rating,
        tags: args?.tags,
        title: args?.title,
        notes: args?.notes,
      });
      return { item };
    },
  };

  const providersTool = {
    name: 'image_providers',
    description: 'List image providers, whether each one has an API key, and the models you may pass to image_generate. Call this before generating when the user names a provider or model.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                configured: { type: 'boolean' },
                source: { type: 'string' },
                models: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
              required: ['id', 'label', 'configured', 'models'],
            },
          },
        },
        required: ['providers'],
      },
      render(_args, value) {
        const lines = (value.providers ?? []).map((provider) => {
          const models = (provider.models ?? []).map((model) => model.id).join(', ');
          return `- ${provider.id} (${provider.label}) — ${provider.configured ? `ready${provider.source && provider.source !== 'offline' ? ` via ${provider.source}` : ''}` : 'no API key'}\n  models: ${models || '(enter a model id in Settings)'}`;
        });
        return [{ type: 'text', text: lines.length ? lines.join('\n') : 'No image providers are installed.' }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const providers = await service.providersView();
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          configured: provider.configured,
          source: provider.source,
          models: provider.models.map((model) => ({
            id: model.id,
            label: model.label,
            aspects: model.aspects ?? [],
            qualities: model.qualities ?? [],
            supportsRefs: model.supportsRefs === true,
            beta: model.beta === true,
          })),
        })),
      };
    },
  };

  return { tools: [generateTool, searchTool, getTool, updateTool, providersTool], names: [...TOOL_NAMES] };
}
