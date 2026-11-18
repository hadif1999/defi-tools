import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

// The dashboard serves your wallets and can change saved data, so every request is checked:
// - Host must name this server (localhost, a loopback address, or --host), which stops DNS-rebinding pages from
//   reaching it through a name they control.
// - An access token is required. The URL the command prints and opens carries it once (?token=…); the server swaps it
//   for an HttpOnly, SameSite=Strict cookie and redirects to the same page without it. Scripts can send it as
//   Authorization: Bearer <token>. Tokens are compared in constant time.
// - Requests that change data must come from this origin (Origin, or Sec-Fetch-Site same-origin), so another site
//   cannot submit forms to it even if the cookie were sent.

export const COOKIE = 'defi_tool_session';

export function newToken(): string { return randomBytes(32).toString('base64url'); }

export function newNonce(): string { return randomBytes(16).toString('base64'); }

const sameToken = (given: string | undefined, token: string): boolean => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export const isLoopback = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Host header values this server answers to, for the address it listens on. */
export function allowedHosts(host: string, port: number): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (host && host !== '0.0.0.0' && host !== '::') names.add(isIP(host) === 6 ? `[${host}]` : host.toLowerCase());
  return new Set([...names].flatMap((name) => [name, `${name}:${port}`]));
}

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export interface Guard {
  token: string;
  hosts: Set<string>;
  /** Exposed beyond loopback (--host 0.0.0.0): every Host is accepted, the token still guards access. */
  anyHost: boolean;
}

export type Verdict = { ok: true } | { ok: false; status: number; message: string; code: string };

/** Host check, before anything else. */
export function checkHost(req: IncomingMessage, guard: Guard): Verdict {
  const host = (req.headers.host ?? '').toLowerCase();
  if (guard.anyHost || guard.hosts.has(host)) return { ok: true };
  return { ok: false, status: 421, message: `This dashboard does not answer to host "${host}". Open it at the address defi-tool printed.`, code: 'bad_host' };
}

/** Whether the request carries the token (cookie, bearer header, or the one-time ?token=). */
export function authorized(req: IncomingMessage, url: URL, guard: Guard): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  return sameToken(cookieValue(req, COOKIE), guard.token) || sameToken(bearer, guard.token) || sameToken(url.searchParams.get('token') ?? undefined, guard.token);
}

/** Requests that change data must come from the dashboard's own pages. */
export function checkOrigin(req: IncomingMessage): Verdict {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return { ok: false, status: 403, message: 'Cross-site requests cannot change dashboard data.', code: 'cross_site' };
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host: string | undefined;
    try { host = new URL(origin).host.toLowerCase(); } catch { /* malformed */ }
    if (host !== (req.headers.host ?? '').toLowerCase()) return { ok: false, status: 403, message: 'Requests from another origin cannot change dashboard data.', code: 'cross_origin' };
  }
  return { ok: true };
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Headers for every response; pages add their Content-Security-Policy. */
export function baseHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
}

/**
 * The policy for HTML pages: scripts only from this server or inline with this response's nonce, no plugins, framing
 * only by the dashboard itself, connections only back to this server. Inline styles are allowed (the charts set them).
 */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'", "frame-src 'self'",
  ].join('; ');
}

/** Add the nonce to every inline <script> and <style> of a page built elsewhere (the chart and position reports). */
export const withNonce = (html: string, nonce: string): string => html.replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);
