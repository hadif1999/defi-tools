// The dashboard's API client: JSON in and out, errors as ApiError with the server's message, aborts when a page is
// left, and one retry for network hiccups on reads. The session cookie is sent automatically (same origin).

export class ApiError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

/** Build a query string, leaving out empty values; arrays repeat the key. */
export function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) value.filter((item) => item !== '' && item !== undefined).forEach((item) => search.append(key, String(item)));
    else search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request(method, path, { body, params, signal, retry = method === 'GET' } = {}) {
  const url = `${path}${query(params)}`;
  let response;
  try {
    response = await fetch(url, {
      method, signal, credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    if (retry) { await new Promise((resolve) => setTimeout(resolve, 800)); return request(method, path, { body, params, signal, retry: false }); }
    throw new ApiError(0, 'The dashboard server cannot be reached. Is defi-tool dashboard serve still running?', 'offline');
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: { message: text.slice(0, 300) } }; }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('dashboard:locked'));
    throw new ApiError(response.status, data?.error?.message ?? `HTTP ${response.status}`, data?.error?.code, data?.error?.details);
  }
  return data;
}

export const api = {
  get: (path, params, options = {}) => request('GET', path, { ...options, params }),
  post: (path, body, options = {}) => request('POST', path, { ...options, body: body ?? {} }),
  patch: (path, body, options = {}) => request('PATCH', path, { ...options, body: body ?? {} }),
  put: (path, body, options = {}) => request('PUT', path, { ...options, body: body ?? {} }),
  delete: (path, options = {}) => request('DELETE', path, options),
};
