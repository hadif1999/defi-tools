import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

// A small router for the dashboard: method + path patterns with :params, JSON bodies with a size limit, zod-checked
// input and one error shape ({ error: { message, code } }) for every failure.

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'error', readonly details?: unknown) { super(message); }
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Query values; repeated keys keep the last value (see `queryAll`). */
  query: Record<string, string>;
  queryAll: (key: string) => string[];
  body: () => Promise<unknown>;
  /** A per-response nonce for inline scripts (the Content-Security-Policy allows only scripts carrying it). */
  nonce: string;
}

export type Handler = (ctx: Context) => Promise<unknown> | unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; write: boolean }

export const MAX_BODY_BYTES = 1_000_000;

export class Router {
  private readonly routes: Route[] = [];

  /** Register a route. `write` marks routes that change data, refused in --read-only mode. */
  add(method: string, path: string, handler: Handler, options: { write?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/\/:([A-Za-z]+)/g, (_, key: string) => { keys.push(key); return '/([^/]+)'; })}/?$`);
    this.routes.push({ method, pattern, keys, handler, write: Boolean(options.write) });
    return this;
  }

  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler, { write: true }); }
  patch(path: string, handler: Handler): this { return this.add('PATCH', path, handler, { write: true }); }
  put(path: string, handler: Handler): this { return this.add('PUT', path, handler, { write: true }); }
  delete(path: string, handler: Handler): this { return this.add('DELETE', path, handler, { write: true }); }

  /** The route for a request, with its params; `allowed` lists the methods of a path that exists under another method. */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | undefined {
    const allowed: string[] = [];
    for (const route of this.routes) {
      const found = route.pattern.exec(path);
      if (!found) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) { allowed.push(route.method); continue; }
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        try { params[key] = decodeURIComponent(found[index + 1]!); } catch { throw new HttpError(400, `The path segment for ${key} is not valid URL encoding.`, 'bad_path'); }
      });
      return { route, params };
    }
    return allowed.length ? { allowed } : undefined;
  }
}

/** Read a JSON request body, at most MAX_BODY_BYTES; an empty body is `{}`. */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    if (req.method !== 'GET' && req.headers['content-length'] !== '0' && type && !/^application\/json\b/i.test(type)) {
      reject(new HttpError(415, 'Send the request body as JSON (Content-Type: application/json).', 'unsupported_media_type'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES;
    // Too large: answer 413 and discard the rest of the body (dropping the connection would hide the answer).
    if (tooLarge) { reject(new HttpError(413, 'The request body is too large (1 MB at most).', 'too_large')); req.resume(); return; }
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; reject(new HttpError(413, 'The request body is too large (1 MB at most).', 'too_large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'The request body is not valid JSON.', 'bad_json')); }
    });
    req.on('error', reject);
  });
}

/** Validate input with a zod schema; failures become a 400 naming each field. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  throw new HttpError(400, issues.map((issue) => issue.field ? `${issue.field}: ${issue.message}` : issue.message).join('; '), 'invalid_input', issues);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  if (error instanceof HttpError) return sendJson(res, error.status, { error: { message: error.message, code: error.code, details: error.details } });
  // Errors thrown by the services are user-facing messages about the request (a bad pair, an unknown wallet, a provider
  // that could not be reached); they are 400s or 502s rather than crashes.
  const message = (error as Error)?.message ?? String(error);
  const upstream = /could not be reached|timed out|HTTP 5\d\d|rate limit|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message);
  sendJson(res, upstream ? 502 : 400, { error: { message, code: upstream ? 'upstream' : 'bad_request' } });
}

/** Common zod helpers for query strings. */
export const q = {
  bool: z.preprocess((value) => value === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()), z.boolean().optional()),
  text: z.string().trim().max(500).optional().transform((value) => value === '' ? undefined : value),
  list: z.string().trim().max(1000).optional().transform((value) => value === '' ? undefined : value),
};
