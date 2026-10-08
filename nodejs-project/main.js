'use strict';
// TermForge Node supervisor: the one Node instance in the app process.
// Talks to Swift over a single socket (a socketpair fd on iOS, TCP in desktop tests)
// using lib/frame.js, and runs each terminal session in its own worker thread.

const bootStarted = Date.now();
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { T, encode, Decoder, json } = require('./lib/frame');
const installer = require('./lib/installer');
const pins = require('./pins.json');

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const jitless = process.execArgv.includes('--jitless');
const allowPinOverride = process.argv.includes('--allow-pin-override');
const dataDir = path.resolve(arg('data-dir') || process.env.TERMFORGE_DATA_DIR || path.join(os.homedir(), '.termforge'));
const packagesDir = path.join(dataDir, 'packages');
const overridesFile = path.join(dataDir, 'pin-overrides.json');

// SIDELOAD builds may install other versions than the shipped pins; those choices persist.
if (allowPinOverride) {
  try {
    for (const [key, pin] of Object.entries(JSON.parse(fs.readFileSync(overridesFile, 'utf8')))) {
      if (pins[key]) pins[key] = { ...pins[key], ...pin };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') process.stderr.write(`[termforge] ignoring ${overridesFile}: ${err.message}\n`);
  }
}

// ---- control socket
function connect() {
  const fd = arg('control-fd');
  if (fd !== null) return new net.Socket({ fd: Number(fd), readable: true, writable: true });
  const tcp = arg('control-tcp');
  if (tcp !== null) {
    const i = tcp.lastIndexOf(':');
    return net.connect(Number(tcp.slice(i + 1)), tcp.slice(0, i) || '127.0.0.1');
  }
  throw new Error('main.js needs --control-fd=<fd> or --control-tcp=<host:port>');
}

const sock = connect();
sock.setNoDelay && sock.setNoDelay(true);
let corked = false;

function send(type, channel, payload) {
  if (sock.destroyed) return;
  if (!corked) {
    corked = true;
    sock.cork();
    process.nextTick(() => {
      corked = false;
      sock.uncork();
    });
  }
  sock.write(encode(type, channel, payload));
}

function log(...parts) {
  send(T.LOG, 0, parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
}

// ---- sessions
const sessions = new Map(); // channel -> { worker, kind }

function packageDir(key) {
  const pin = pins[key];
  return pin ? path.join(packagesDir, key, pin.version) : null;
}

function sessionEnv(spec) {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    PATH: '/usr/local/bin:/usr/bin:/bin',
    ...(spec.kind === 'claude' ? { DISABLE_AUTOUPDATER: '1', USE_BUILTIN_RIPGREP: '0' } : {}),
    ...(spec.env || {}),
  };
}

function openSession(channel, spec) {
  if (sessions.has(channel)) throw new Error(`channel ${channel} is already open`);
  const data = {
    kind: spec.kind,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd || os.homedir(),
    argv: spec.argv || [],
    platform: spec.platform || null,
    jitless,
    entry: spec.entry || null,
  };
  if (spec.kind === 'claude') {
    const dir = packageDir('claude-code');
    if (!installer.installedManifest(path.dirname(dir), pins['claude-code'].version)) {
      const err = new Error('Claude Code is not installed');
      err.code = 'NOT_INSTALLED';
      throw err;
    }
    data.entry = path.join(dir, pins['claude-code'].entry);
  }
  fs.mkdirSync(data.cwd, { recursive: true });
  const opened = Date.now();
  const worker = new Worker(path.join(__dirname, 'lib', 'session-worker.js'), {
    workerData: data,
    env: sessionEnv(spec),
    stdout: true,
    stderr: true,
    name: `session-${channel}-${spec.kind}`,
  });
  const session = { worker, kind: spec.kind, opened, error: null };
  sessions.set(channel, session);
  const forward = (chunk) => send(T.DATA, channel, chunk);
  worker.stdout.on('data', forward);
  worker.stderr.on('data', forward);
  worker.on('online', () => send(T.EVENT, channel, { event: 'metric', name: 'session.online', ms: Date.now() - opened }));
  worker.on('message', (msg) => {
    switch (msg.t) {
      case 'out':
        send(T.DATA, channel, msg.data);
        break;
      case 'exec':
        send(T.EVENT, channel, { event: 'exec', ...msg.record });
        break;
      case 'open-url':
        send(T.EVENT, channel, { event: 'open-url', url: msg.url });
        break;
      case 'metric':
        send(T.EVENT, channel, { event: 'metric', name: msg.name, ms: msg.ms });
        break;
      default:
        break;
    }
  });
  worker.on('error', (err) => {
    session.error = err && err.stack ? err.stack : String(err);
    send(T.DATA, channel, `\r\n[termforge] session crashed: ${String(session.error).replace(/\n/g, '\r\n')}\r\n`);
  });
  worker.on('exit', (code) => {
    sessions.delete(channel);
    send(T.EXIT, channel, { code, error: session.error, ms: Date.now() - opened });
  });
}

function toWorker(channel, msg, transfer) {
  const s = sessions.get(channel);
  if (s) s.worker.postMessage(msg, transfer);
}

// ---- control requests
async function handleRequest(req) {
  switch (req.op) {
    case 'ping':
      return { t: req.t, now: Date.now() };
    case 'status':
      return {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        jitless,
        dataDir,
        sessions: [...sessions.entries()].map(([ch, s]) => ({ channel: ch, kind: s.kind })),
        packages: Object.fromEntries(
          Object.entries(pins).map(([key, pin]) => [key, {
            pinned: pin.version,
            installed: installer.installedManifest(path.join(packagesDir, key), pin.version) ? pin.version : null,
          }]),
        ),
      };
    case 'install': {
      const key = req.package;
      if (!pins[key]) throw new Error(`unknown package ${key}`);
      if (req.pin && !allowPinOverride) throw new Error('this build only installs the pins shipped with the app');
      // a runtime pin replaces version/tarball/integrity; the entry and skip rules stay the shipped ones
      const pin = req.pin ? { ...pins[key], ...req.pin } : pins[key];
      if (req.pin) {
        pins[key] = pin;
        let saved = {};
        try {
          saved = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
        } catch {}
        saved[key] = req.pin;
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(overridesFile, JSON.stringify(saved, null, 2));
      }
      const skip = Object.entries(pin.skip || {});
      let lastPct = -1;
      const { dir, manifest } = await installer.installTarball({
        pin,
        destRoot: path.join(packagesDir, key),
        accept: (rel) => {
          const hit = skip.find(([prefix]) => rel.startsWith(prefix));
          return hit ? hit[1] : true;
        },
        onProgress: (p) => {
          if (p.phase === 'download' && p.total) {
            const pct = Math.floor((p.got / p.total) * 100);
            if (pct === lastPct) return;
            lastPct = pct;
          }
          send(T.EVENT, 0, { event: 'install-progress', package: key, ...p });
        },
      });
      return { dir, version: manifest.version, ms: manifest.ms, written: manifest.written.length, skipped: manifest.skipped };
    }
    case 'uninstall': {
      const pin = pins[req.package];
      if (!pin) throw new Error(`unknown package ${req.package}`);
      fs.rmSync(path.join(packagesDir, req.package), { recursive: true, force: true });
      return { removed: req.package };
    }
    default:
      throw new Error(`unknown op ${req.op}`);
  }
}

// ---- frame dispatch
const decoder = new Decoder();
sock.on('data', (chunk) => {
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch (err) {
    log('protocol error:', err.message);
    sock.destroy();
    return;
  }
  for (const f of frames) dispatch(f);
});

function dispatch({ type, channel, payload }) {
  switch (type) {
    case T.OPEN: {
      try {
        openSession(channel, json(payload));
      } catch (err) {
        send(T.EXIT, channel, { code: -1, error: err.message, reason: err.code || 'OPEN_FAILED' });
      }
      return;
    }
    case T.DATA: {
      const copy = new Uint8Array(payload);
      toWorker(channel, { t: 'in', data: copy }, [copy.buffer]);
      return;
    }
    case T.RESIZE:
      if (payload.length >= 4) toWorker(channel, { t: 'resize', cols: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) });
      return;
    case T.SIGNAL:
      if (payload.length >= 1) toWorker(channel, { t: 'signal', signo: payload[0] });
      return;
    case T.CLOSE: {
      const s = sessions.get(channel);
      if (s) s.worker.terminate();
      return;
    }
    case T.REQUEST: {
      let req;
      try {
        req = json(payload);
      } catch (err) {
        log('bad request payload:', err.message);
        return;
      }
      handleRequest(req).then(
        (result) => send(T.RESPONSE, 0, { id: req.id, ok: true, result }),
        (err) => send(T.RESPONSE, 0, { id: req.id, ok: false, error: err.message }),
      );
      return;
    }
    default:
      log('unknown frame type', type);
  }
}

function shutdown() {
  for (const s of sessions.values()) s.worker.terminate();
  setTimeout(() => process.exit(0), 50).unref();
}

sock.on('error', (err) => {
  process.stderr.write(`[termforge] control socket error: ${err.message}\n`);
  shutdown();
});
sock.on('close', shutdown);

function hello() {
  fs.mkdirSync(packagesDir, { recursive: true });
  send(T.HELLO, 0, {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    jitless,
    pid: process.pid,
    supervisorMs: Date.now() - bootStarted,
    processUptimeMs: Math.round(process.uptime() * 1000),
  });
}

if (sock.connecting) sock.once('connect', hello);
else hello();
