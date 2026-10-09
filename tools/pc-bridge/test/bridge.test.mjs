import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

// Starts the bridge with a private HOME (so its token file is throwaway) and a plain shell.
async function startBridge() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-bridge-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TERMFORGE_BRIDGE_PORT: '0' };
  const proc = spawn(process.execPath, [path.join(here, '..', 'bridge.mjs'), '--host', '127.0.0.1', '--port', '0', '--show-token', '--shell', WIN ? 'cmd.exe' : '/bin/sh', '--claude', WIN ? 'cmd.exe' : '/bin/sh'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  // the bridge prints its pairing link once listening; port 0 means we read the real port from the link
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start:\n${out}`)), 15000);
    const check = () => {
      if (/termforge:\/\/pair/.test(out)) {
        clearTimeout(t);
        resolve();
      }
    };
    proc.stdout.on('data', check);
    proc.once('exit', () => reject(new Error(`bridge exited:\n${out}`)));
  });
  const link = new URL(/termforge:\/\/pair\?\S+/.exec(out)[0]);
  const token = link.searchParams.get('token');
  const config = JSON.parse(fs.readFileSync(path.join(home, '.termforge-bridge', 'config.json'), 'utf8'));
  assert.strictEqual(token, config.token);
  // --port 0: the printed URL carries the hostname, not the bound port; read the port from the log line
  const port = Number(/on 127\.0\.0\.1:(\d+)/.exec(out)[1]);
  return { proc, home, token, port, base: `http://127.0.0.1:${port}`, out: () => out };
}

test('bridge: token auth, /info, pty session over websocket, resize, exit', async (t) => {
  const b = await startBridge();
  t.after(() => {
    b.proc.kill();
    fs.rmSync(b.home, { recursive: true, force: true });
  });

  assert.strictEqual((await fetch(`${b.base}/health`)).status, 200);
  // the one-time pairing page: wrong code refused, the printed code serves the termforge:// link
  assert.strictEqual((await fetch(`${b.base}/pair?code=000000x`)).status, 403);
  const code = /\/pair\?code=(\d{6})/.exec(b.out())[1];
  const page = await fetch(`${b.base}/pair?code=${code}`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes(`termforge://pair?url=`), 'pair page carries the link');
  assert.strictEqual((await fetch(`${b.base}/info`)).status, 401);
  assert.strictEqual((await fetch(`${b.base}/info?token=nope`)).status, 401);
  const info = await (await fetch(`${b.base}/info`, { headers: { authorization: `Bearer ${b.token}` } })).json();
  assert.strictEqual(info.name, os.hostname());
  assert.ok(Array.isArray(info.projects));

  // unauthenticated upgrade is refused
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/pty?cmd=shell`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('refused'));
  }), /refused/);

  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/pty?cmd=shell&cols=100&rows=30&token=${b.token}`);
  ws.binaryType = 'arraybuffer';
  let text = '';
  const events = [];
  const closed = new Promise((r) => (ws.onclose = r));
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') events.push(JSON.parse(e.data));
    else text += Buffer.from(e.data).toString('utf8');
  };
  await new Promise((r) => (ws.onopen = r));
  const waitFor = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error(`timeout; output:\n${text}\nevents: ${JSON.stringify(events)}`)) : setTimeout(tick, 25));
    tick();
  });
  await waitFor(() => events.some((e) => e.t === 'hello'));
  assert.strictEqual(events[0].cmd, 'shell');
  ws.send(Buffer.from('echo hello-from-bridge\r'));
  await waitFor(() => /hello-from-bridge/.test(text.replace(/echo hello-from-bridge/g, '')));
  ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
  ws.send(Buffer.from('exit\r'));
  await waitFor(() => events.some((e) => e.t === 'exit'));
  await closed;
  assert.match(b.out(), /open shell pid \d+/);
  assert.match(b.out(), /exit shell pid \d+ code \d+/);
});
