#!/usr/bin/env node
// TermForge PC bridge: runs Claude Code (or a shell) on this computer inside a real PTY and
// serves it to the TermForge "PC" tab over a WebSocket, so the phone is the screen and the
// current Claude Code — with this machine's own login — does the work. The phone reaches
// it over your LAN or Tailscale.
//
//   node bridge.mjs [--port 7788] [--host 0.0.0.0] [--url ws://name:7788] [--claude <path>]
//                   [--shell <path>] [--projects <dir>] [--new-token] [--show-token]
//
// Endpoints (token in `Authorization: Bearer <token>` or `?token=`):
//   GET /info                        -> { name, platform, claude, home, projects[] }
//   WS  /pty?cmd=claude|shell&cwd=&cols=&rows=&continue=1
//        binary frames = terminal bytes both ways; text frames = JSON {t:"resize",cols,rows}
//        server sends {t:"hello",...} first and {t:"exit",code} last
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// npm sometimes installs node-pty's spawn helper without its execute bit (macOS/Linux):
// every spawn then fails with "posix_spawnp failed", so restore it before loading the module.
try {
  const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {}
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PORT = Number(opt('port', process.env.TERMFORGE_BRIDGE_PORT || 7788));
const HOST = opt('host', '0.0.0.0');
const WIN = process.platform === 'win32';
const HOME = os.homedir();
const PROJECTS = path.resolve(opt('projects', path.join(HOME, 'Projects')));
const CONFIG_DIR = path.join(HOME, '.termforge-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ---- token
fs.mkdirSync(CONFIG_DIR, { recursive: true });
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {}
if (!config.token || flag('new-token')) {
  config.token = crypto.randomBytes(24).toString('hex');
  config.createdAt = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const TOKEN = config.token;

function authorized(req) {
  const h = req.headers.authorization || '';
  const url = new URL(req.url, 'http://x');
  const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') || '';
  return given.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

// ---- programs
function findClaude() {
  const given = opt('claude');
  if (given) return given;
  const candidates = WIN
    ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(HOME, 'AppData', 'Roaming', 'npm', 'claude.cmd')]
    : [path.join(HOME, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    return execFileSync(WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || 'claude';
  } catch {
    return 'claude';
  }
}
const CLAUDE = findClaude();
const SHELL = opt('shell', WIN ? 'powershell.exe' : process.env.SHELL || '/bin/bash');

function claudeVersion() {
  try {
    return execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (err) {
    return `not found (${err.message.split('\n')[0]})`;
  }
}

function projectFolders() {
  try {
    return fs.readdirSync(PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(PROJECTS, e.name)).sort();
  } catch {
    return [];
  }
}

// ---- http
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// One-time pairing page: a 6-digit code printed at start opens a page whose button is the
// termforge:// link, so the phone pairs from Safari without typing the token.
const pairCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const pairCodeExpires = Date.now() + 30 * 60 * 1000;
let pairLink = '';

function pairPage(ok) {
  const body = ok
    ? `<p>This phone can now run Claude Code on <b>${os.hostname()}</b>.</p><p><a class="b" href="${pairLink}">Open in TermForge</a></p><p class="s">If nothing opens, install TermForge first (TestFlight), then tap again.</p>`
    : '<p>Wrong or expired code. Restart the bridge on the PC and use the code it prints.</p>';
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TermForge pairing</title><style>body{font:17px -apple-system,system-ui;margin:40px auto;max-width:420px;padding:0 20px;color:#eee;background:#141418}.b{display:inline-block;padding:14px 22px;border-radius:12px;background:#4f8cff;color:#fff;text-decoration:none;font-weight:600}.s{color:#999;font-size:14px}</style><h2>TermForge</h2>${body}`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return sendJSON(res, 200, { ok: true, name: os.hostname() });
  if (url.pathname === '/pair') {
    const ok = Date.now() < pairCodeExpires && (url.searchParams.get('code') || '') === pairCode;
    res.writeHead(ok ? 200 : 403, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(pairPage(ok));
  }
  if (!authorized(req)) return sendJSON(res, 401, { error: 'wrong or missing pairing token' });
  if (url.pathname === '/info') {
    return sendJSON(res, 200, { name: os.hostname(), platform: process.platform, claude: claudeVersion(), home: HOME, projects: projectFolders() });
  }
  sendJSON(res, 404, { error: 'not found' });
});

// ---- pty sessions over websocket
const wss = new WebSocketServer({ noServer: true });
const sessions = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/pty' || !authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => openSession(ws, url.searchParams));
});

function openSession(ws, params) {
  const cmd = params.get('cmd') === 'shell' ? 'shell' : 'claude';
  const cols = Math.min(500, Math.max(10, Number(params.get('cols')) || 80));
  const rows = Math.min(200, Math.max(4, Number(params.get('rows')) || 24));
  let cwd = params.get('cwd') || HOME;
  if (!fs.existsSync(cwd)) cwd = HOME;
  const file = cmd === 'claude' ? CLAUDE : SHELL;
  const argv = cmd === 'claude' && params.get('continue') === '1' ? ['--continue'] : [];
  let term;
  try {
    term = pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
  } catch (err) {
    ws.send(JSON.stringify({ t: 'exit', code: 127, error: `could not start ${file}: ${err.message}` }));
    ws.close();
    return;
  }
  const session = { ws, term, cmd, cwd, started: Date.now() };
  sessions.add(session);
  log(`open ${cmd} pid ${term.pid} in ${cwd} (${cols}x${rows})`);
  ws.send(JSON.stringify({ t: 'hello', name: os.hostname(), cmd, file, cwd, pid: term.pid }));
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true });
  });
  term.onExit(({ exitCode }) => {
    log(`exit ${cmd} pid ${term.pid} code ${exitCode}`);
    sessions.delete(session);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit', code: exitCode }));
      ws.close();
    }
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return term.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === 'resize' && msg.cols && msg.rows) term.resize(Math.min(500, Math.max(10, msg.cols | 0)), Math.min(200, Math.max(4, msg.rows | 0)));
    else if (msg.t === 'input' && typeof msg.data === 'string') term.write(msg.data);
  });
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 20000);
  ws.on('close', () => {
    clearInterval(ping);
    if (sessions.delete(session)) {
      log(`closed ${cmd} pid ${term.pid}`);
      term.kill();
    }
  });
}

function log(s) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
}

function tailscaleName() {
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--self', '--json'], { encoding: 'utf8', timeout: 5000 }));
    return (j.Self && j.Self.DNSName || '').replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  const ts = tailscaleName();
  const base = opt('url', ts ? `ws://${ts}:${port}` : `ws://${os.hostname()}:${port}`);
  const shown = flag('show-token');
  const link = `termforge://pair?url=${encodeURIComponent(base)}&token=${TOKEN}&name=${encodeURIComponent(os.hostname())}`;
  pairLink = link;
  const pageBase = base.replace(/^ws/, 'http');
  console.log(`\nPair from the phone's browser (code valid 30 min): ${pageBase}/pair?code=${pairCode}`);
  console.log(`TermForge PC bridge on ${HOST}:${port}`);
  console.log(`  Claude Code: ${CLAUDE} (${claudeVersion()})`);
  console.log(`  shell:       ${SHELL}`);
  console.log(`  projects:    ${PROJECTS}`);
  console.log(`  address:     ${base}${ts ? '  (Tailscale)' : '  (set --url if the phone reaches this machine by another name)'}`);
  console.log('\nPair the phone: open this link on it (AirDrop/Messages/Notes), or paste the address and token in TermForge → Settings → PC bridge:');
  console.log(`  ${shown ? link : link.replace(TOKEN, TOKEN.slice(0, 6) + '…')}`);
  console.log(shown ? '' : `  (--show-token prints the full link; the token is in ${CONFIG_FILE})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of sessions) s.term.kill();
    server.close();
    process.exit(0);
  });
}
