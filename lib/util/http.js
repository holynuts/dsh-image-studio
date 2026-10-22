/**
 * Small HTTP helpers for the Image Studio route family.
 *
 * The trust fence mirrors the pattern the shipped Web plugins use: a request may
 * enter only from a loopback socket + loopback Host header, or when the profile's
 * remote pairing service vouches for the caller. `X-Forwarded-For` is never trusted.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Whether a socket address names the loopback range. */
export function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false;
  const normalized = String(address).toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}

/** Whether a normalized URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}

/** Request-level fence: loopback socket + loopback Host + same-origin browser markers. */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers?.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** Loopback or a live paired remote-device cookie. */
export function isAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true;
  try {
    const fromGet = typeof ctx?.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined;
    const pairing = fromGet ?? ctx?.remoteWebUiPairing;
    return typeof pairing?.isPairedDevice === 'function' && pairing.isPairedDevice(request) === true;
  } catch {
    return false;
  }
}

/** Write one JSON response. */
export function sendJson(res, status, value, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** Write one error envelope: `{ error: { code, message, hint } }`. */
export function sendError(res, status, code, message, hint) {
  /** @type {{code: string, message: string, hint?: string}} */
  const error = { code, message: String(message ?? 'request failed') };
  if (hint) error.hint = String(hint);
  sendJson(res, status, { error });
}

/** Write raw bytes with an explicit content type. */
export function sendBytes(res, status, bytes, contentType, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(bytes.length),
    ...headers,
  });
  res.end(bytes);
}

/** Read the whole request body (bounded) as a Buffer. */
export async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.status = 413;
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read and parse a JSON request body; empty body becomes `{}`. */
export async function readJson(request) {
  const body = await readBody(request);
  if (body.length === 0) return {};
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('request body must be a JSON object');
    error.status = 400;
    error.code = 'invalid_json';
    throw error;
  }
  return value;
}

/**
 * Match one request path against `:param` patterns.
 * @param {string[]} segments request path segments (already split, decoded)
 * @param {string} pattern e.g. `/items/:id`
 * @returns {Record<string,string>|undefined} params when the path matches
 */
export function matchPath(segments, pattern) {
  const patternSegments = pattern.split('/').filter(Boolean);
  if (patternSegments.length !== segments.length) return undefined;
  const params = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index];
    const actual = segments[index];
    if (expected.startsWith(':')) {
      if (!actual) return undefined;
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}
