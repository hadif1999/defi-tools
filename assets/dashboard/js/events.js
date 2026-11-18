// The live event stream (server-sent events): job progress, wallet changes, and tickers for the pools a page watches.
// Changing the watched tickers reconnects once (debounced); EventSource reconnects by itself after drops.

const handlers = new Map();
let source;
let tickers = [];
let timer;
let status = 'connecting';
const statusListeners = new Set();

function setStatus(next) {
  status = next;
  for (const listener of statusListeners) listener(next);
}

function connect() {
  source?.close();
  const params = new URLSearchParams();
  if (tickers.length) params.set('tickers', tickers.join(','));
  source = new EventSource(`/api/events${params.size ? `?${params}` : ''}`);
  source.onopen = () => setStatus('live');
  source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
  for (const event of ['hello', 'ticker', 'ticker-error', 'job', 'wallets', 'notice', 'ping']) {
    source.addEventListener(event, (message) => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (event === 'ping' || event === 'hello') setStatus('live');
      for (const handler of handlers.get(event) ?? []) handler(data);
    });
  }
}

export const events = {
  start() { connect(); },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => handlers.get(event)?.delete(handler);
  },
  /** The ticker keys (chainId:pool:quote) to stream; replaces the previous set. */
  watch(keys) {
    const next = [...new Set(keys)].sort();
    if (next.join() === tickers.join()) return;
    tickers = next;
    clearTimeout(timer);
    timer = setTimeout(connect, 150);
  },
  get status() { return status; },
  onStatus(listener) { statusListeners.add(listener); listener(status); return () => statusListeners.delete(listener); },
};
