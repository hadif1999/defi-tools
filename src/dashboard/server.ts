import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../storage.js';
import { GeckoTerminalClient } from '../providers/geckoterminal.js';
import { chartLibrary } from '../html-chart.js';
import type { AppConfig } from '../types.js';
import { TtlCache } from './cache.js';
import { Jobs, jobSummary } from './jobs.js';
import { EventHub } from './events.js';
import { HttpError, Router, readJson, sendError, sendJson, type Context } from './http.js';
import { registerApi, type DashboardState } from './api.js';
import { allowedHosts, authorized, baseHeaders, checkHost, checkOrigin, isLoopback, newNonce, newToken, pageCsp, sessionCookie, type Guard } from './security.js';

// defi-tool dashboard serve: a local web server for the dashboard (assets/dashboard/), its JSON API and live events.
// Only node:http; no framework. See security.ts for how access is guarded.

export interface DashboardOptions {
  config: AppConfig;
  port: number;
  host: string;
  /** Try the next ports when the port is taken (up to 10), unless strict. */
  strictPort?: boolean;
  token?: string;
  readOnly?: boolean;
  offline?: boolean;
  dataDir: string;
  marketDir: string;
  refreshMs: number;
  /** Request log lines (method, path, status, time). */
  log?: (line: string) => void;
}

export interface RunningDashboard {
  url: string;
  /** The URL with the access token, to open once. */
  loginUrl: string;
  host: string;
  port: number;
  token: string;
  server: Server;
  state: DashboardState;
  close: () => Promise<void>;
}

const PORT_ATTEMPTS = 10;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

/** The project's assets/dashboard folder, found from this module whether it runs from src/ or dist/src/. */
export function dashboardRoot(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'assets', 'dashboard', 'index.html'))) return join(dir, 'assets', 'dashboard');
  }
  throw new Error('The dashboard files (assets/dashboard/) are missing. Reinstall defi-tool from its project folder.');
}

function packageVersion(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) { try { return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; } }
  }
  return '0.0.0';
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen((server.address() as { port: number }).port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** A page for a browser that arrives without the token. */
const lockedPage = (nonce: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>defi-tool dashboard · locked</title>
<style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;background:#0f1218;color:#d7dce5;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34rem;padding:2rem}code{background:#1b2130;padding:.15rem .4rem;border-radius:4px}h1{font-size:1.3rem}</style></head>
<body><main><h1>Access token required</h1><p>This dashboard only opens from the link <code>defi-tool dashboard serve</code> printed in your terminal (it carries a one-time access token).</p><p>Copy that link into the address bar, or restart the command to open it again.</p></main></body></html>`;

export async function startDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  const root = dashboardRoot();
  const token = options.token ?? newToken();
  if (token.length < 16) throw new Error('--token must be at least 16 characters.');
  const store = new Store(options.config.databasePath);
  const gecko = options.offline ? undefined : new GeckoTerminalClient({ endpoint: process.env.DEFI_TOOL_GECKOTERMINAL_URL });
  const jobs = new Jobs();
  const hub = new EventHub(gecko);
  const state: DashboardState = {
    config: options.config, store, cache: new TtlCache(), jobs, hub, gecko, version: packageVersion(), startedAt: Date.now(),
    options: { dataDir: options.dataDir, marketDir: options.marketDir, readOnly: Boolean(options.readOnly), offline: Boolean(options.offline), refreshMs: options.refreshMs, host: options.host, port: options.port },
  };
  jobs.onChange((job) => hub.broadcast('job', jobSummary(job)));
  const router = new Router();
  registerApi(router, state);
  const vendor = chartLibrary();
  let guard: Guard = { token, hosts: new Set(), anyHost: !isLoopback(options.host) && options.host !== '127.0.0.1' };

  const serveStatic = async (ctx: Context): Promise<boolean> => {
    if (ctx.url.pathname === '/vendor/lightweight-charts.js') {
      ctx.res.writeHead(200, { 'content-type': MIME['.js']!, 'cache-control': 'private, max-age=86400' });
      ctx.res.end(vendor);
      return true;
    }
    const path = ctx.url.pathname === '/' ? '/index.html' : ctx.url.pathname;
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return false; }
    const file = resolve(root, `.${decoded}`);
    if (!file.startsWith(root + sep) || decoded.includes('\0')) return false;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return false;
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    if (file.endsWith('index.html')) {
      // The app shell: its CSP allows this server's scripts and the nonce (unused by the shell itself, but kept so the
      // policy is the same everywhere).
      const html = (await readFile(file, 'utf8')).replaceAll('{{nonce}}', ctx.nonce).replaceAll('{{version}}', state.version);
      ctx.res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': pageCsp(ctx.nonce) });
      ctx.res.end(html);
      return true;
    }
    ctx.res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': info.size });
    ctx.res.end(await readFile(file));
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const nonce = newNonce();
    baseHeaders(res);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { sendJson(res, 400, { error: { message: 'Bad request URL.', code: 'bad_url' } }); return; }
    res.on('finish', () => options.log?.(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    const isApi = url.pathname.startsWith('/api/');
    try {
      const host = checkHost(req, guard);
      if (!host.ok) throw new HttpError(host.status, host.message, host.code);
      // The one-time token in the URL becomes a session cookie, and the address bar loses the token.
      if (!isApi && url.searchParams.has('token')) {
        if (!authorized(req, url, guard)) throw new HttpError(401, 'That access token is not valid for this dashboard.', 'unauthorized');
        url.searchParams.delete('token');
        res.writeHead(303, { location: `${url.pathname}${url.search}`, 'set-cookie': sessionCookie(token, false), 'cache-control': 'no-store' });
        res.end();
        return;
      }
      const publicAsset = /^\/(favicon\.svg|app\.css|icons\.svg)$/.test(url.pathname);
      if (!publicAsset && !authorized(req, url, guard)) {
        if (isApi || url.pathname.startsWith('/report/') || url.pathname.startsWith('/js/') || url.pathname.startsWith('/vendor/')) throw new HttpError(401, 'An access token is required: open the link defi-tool dashboard serve printed.', 'unauthorized');
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': pageCsp(nonce) });
        res.end(lockedPage(nonce));
        return;
      }
      const method = req.method ?? 'GET';
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = checkOrigin(req);
        if (!origin.ok) throw new HttpError(origin.status, origin.message, origin.code);
      }
      const found = router.match(method, url.pathname);
      const queryAll = (key: string) => url.searchParams.getAll(key);
      const ctx: Context = { req, res, url, params: {}, query: Object.fromEntries(url.searchParams), queryAll, body: () => readJson(req), nonce };
      if (found && 'route' in found) {
        if (found.route.write && state.options.readOnly && !url.pathname.startsWith('/api/downloads/')) throw new HttpError(403, 'The dashboard runs with --read-only; changes are turned off.', 'read_only');
        ctx.params = found.params;
        const result = await found.route.handler(ctx);
        if (result !== undefined && !res.headersSent) sendJson(res, method === 'POST' && url.pathname.startsWith('/api/downloads/') || url.pathname === '/api/alerts/check' ? 202 : 200, result);
        return;
      }
      if (found && 'allowed' in found) {
        res.setHeader('allow', [...new Set(found.allowed)].join(', '));
        throw new HttpError(405, `${method} is not allowed here.`, 'method_not_allowed');
      }
      if (!isApi && (method === 'GET' || method === 'HEAD') && await serveStatic(ctx)) return;
      throw new HttpError(404, `Nothing at ${url.pathname}.`, 'not_found');
    } catch (error) {
      if (!isApi && error instanceof HttpError && error.status === 404 && !url.pathname.includes('.')) {
        // Unknown app paths fall back to the shell (the app routes with #hash, so this is only for typed URLs).
        res.writeHead(302, { location: '/' });
        res.end();
        return;
      }
      sendError(res, error);
    }
  };

  const server = createServer((req, res) => { void handle(req, res); });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0; // event streams stay open
  let port = options.port;
  for (let attempt = 0; ; attempt += 1) {
    try {
      port = await listen(server, port, options.host);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && !options.strictPort && options.port !== 0 && attempt < PORT_ATTEMPTS) { port += 1; continue; }
      store.close();
      hub.close();
      if (code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use.${options.strictPort ? ' Choose another with --port, or drop --strict-port to try the next ones.' : ` Ports ${options.port}-${port} are all taken; choose another with --port.`}`);
      if (code === 'EACCES') throw new Error(`Not allowed to listen on port ${port}; use a port above 1024, e.g. --port 8787.`);
      if (code === 'EADDRNOTAVAIL') throw new Error(`--host ${options.host} is not an address of this machine.`);
      throw error;
    }
  }
  guard = { ...guard, hosts: allowedHosts(options.host, port) };
  const shownHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${shownHost}:${port}/`;

  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>((done) => {
    hub.close();
    server.close(() => { store.close(); done(); });
    server.closeAllConnections();
  });
  return { url, loginUrl: `${url}?token=${encodeURIComponent(token)}`, host: options.host, port, token, server, state, close };
}
