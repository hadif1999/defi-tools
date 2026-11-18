import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Headless Chrome over the DevTools protocol, for tests that drive the HTML pages with real mouse and keyboard events.
// Used when Chrome or Chromium is installed (or CHROME_PATH is set); the tests skip otherwise.

export const browser = [process.env.CHROME_PATH, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .find((name) => name && spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0);

export class Page {
  private id = 0;
  private readonly pending = new Map<number, (message: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }) => void>();
  readonly errors: string[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) { this.pending.get(message.id)!(message); this.pending.delete(message.id); }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
  }
  send(method: string, params: object = {}) { return new Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }>((resolve) => { this.id += 1; this.pending.set(this.id, resolve); this.ws.send(JSON.stringify({ id: this.id, method, params })); }); }
  async eval<T>(expression: string): Promise<T> {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value as T;
  }
  mouse(type: string, x: number, y: number, buttons = 0) { return this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }); }
  async click({ x, y }: { x: number; y: number }) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y, 1); await this.mouse('mouseReleased', x, y); await sleep(60); }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    await this.mouse('mouseMoved', from.x, from.y); await this.mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= 8; i += 1) await this.mouse('mouseMoved', from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8, 1);
    await this.mouse('mouseReleased', to.x, to.y); await sleep(60);
  }
  async key(key: string, code: string, modifiers = 0) {
    const vk = { Delete: 46, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: vk });
  }
  center(selector: string) { return this.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); }
}
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start headless Chrome with a profile in `directory` and attach to its page. */
export async function launch(directory: string, size = '1400,850'): Promise<{ page: Page; close: () => void }> {
  const chrome: ChildProcess = spawn(browser!, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'profile')}`, `--window-size=${size}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(directory, 'profile', 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>).find((item) => item.type === 'page')!;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  const page = new Page(ws);
  await page.send('Runtime.enable');
  return { page, close: () => { ws.close(); chrome.kill(); } };
}
