'use strict';
// TermForge Node supervisor: the one Node instance in the app process.
// Talks to Swift over a single socket (a socketpair fd on iOS, TCP in desktop tests)
// using lib/frame.js, and runs each terminal session in its own worker thread.
// child_process calls from sessions that the Linux layer should run are relayed here
// and on to Swift as exec requests (see lib/linux-tier.js).

const bootStarted = Date.now();
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Worker, MessageChannel } = require('worker_threads');
const { T, EXEC_CHANNEL_BASE, encode, Decoder, json } = require('./lib/frame');
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

// ---- requests to Swift (exec); Swift answers with RESPONSE frames carrying our id
let nextSwiftRequestId = 1;
const swiftRequests = new Map(); // id -> { resolve, reject }

function askSwift(op, params) {
  const id = nextSwiftRequestId++;
  return new Promise((resolve, reject) => {
    swiftRequests.set(id, { resolve, reject });
    send(T.REQUEST, 0, { id, op, ...params });
  });
}

// ---- sessions
const sessions = new Map(); // channel -> { worker, kind, execPort }
let linuxAvailable = false;

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
  const { port1: execPort, port2: workerExecPort } = new MessageChannel();
  const data = {
    kind: spec.kind,
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd || os.homedir(),
    argv: spec.argv || [],
    platform: spec.platform || null,
    jitless,
    entry: spec.entry || null,
    execPort: workerExecPort,
    linuxAvailable,
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
  // the agent tab ships with the app (our own code), no install step
  if (spec.kind === 'agent') data.entry = path.join(__dirname, 'agent', 'main.mjs');
  fs.mkdirSync(data.cwd, { recursive: true });
  const opened = Date.now();
  const worker = new Worker(path.join(__dirname, 'lib', 'session-worker.js'), {
    workerData: data,
    transferList: [workerExecPort],
    env: sessionEnv(spec),
    stdout: true,
    stderr: true,
    name: `session-${channel}-${spec.kind}`,
  });
  const session = { worker, kind: spec.kind, opened, error: null, execPort, execs: new Map() };
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
  execPort.on('message', (msg) => handleExecMessage(channel, session, msg));
  worker.on('error', (err) => {
    session.error = err && err.stack ? err.stack : String(err);
    send(T.DATA, channel, `\r\n[termforge] session crashed: ${String(session.error).replace(/\n/g, '\r\n')}\r\n`);
  });
  worker.on('exit', (code) => {
    sessions.delete(channel);
    for (const exec of session.execs.values()) execsByChannel.delete(exec.channel);
    execPort.close();
    send(T.EXIT, channel, { code, error: session.error, ms: Date.now() - opened });
  });
}

function toWorker(channel, msg, transfer) {
  const s = sessions.get(channel);
  if (s) s.worker.postMessage(msg, transfer);
}

// ---- exec relay: worker <-> Swift
let nextExecChannel = EXEC_CHANNEL_BASE;
const execsByChannel = new Map(); // exec channel -> exec record

function handleExecMessage(sessionChannel, session, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  switch (msg.t) {
    case 'exec-start': {
      const channel = nextExecChannel++;
      const exec = {
        channel, execId: msg.execId, session, sync: msg.sync || null, stdout: [], stderr: [], started: Date.now(),
      };
      session.execs.set(msg.execId, exec);
      execsByChannel.set(channel, exec);
      if (!linuxAvailable) {
        finishExec(exec, { code: 127, error: 'the Linux layer is not running' });
        return;
      }
      askSwift('exec', { channel, argv: msg.argv, cwd: msg.cwd, env: msg.env }).then(
        (result) => {
          exec.pid = result.pid;
          if (!exec.sync) session.execPort.postMessage({ t: 'exec-started', execId: msg.execId, pid: result.pid });
          if (exec.pendingKill != null) askSwift('exec-kill', { channel, pid: exec.pid, signal: exec.pendingKill }).catch(() => {});
          if (msg.input && msg.input.byteLength) send(T.EXEC_IN, channel, Buffer.from(msg.input.buffer, msg.input.byteOffset, msg.input.byteLength));
          if (exec.sync) send(T.EXEC_IN, channel, Buffer.alloc(0));
        },
        (err) => finishExec(exec, { code: 127, error: err.message }),
      );
      return;
    }
    case 'exec-in': {
      const exec = session.execs.get(msg.execId);
      if (!exec) return;
      send(T.EXEC_IN, exec.channel, msg.data ? Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength) : Buffer.alloc(0));
      return;
    }
    case 'exec-kill': {
      const exec = session.execs.get(msg.execId);
      if (!exec) return;
      // a kill that arrives before Swift has answered the start is applied once it has
      if (exec.pid == null) {
        exec.pendingKill = msg.signal;
        return;
      }
      askSwift('exec-kill', { channel: exec.channel, pid: exec.pid, signal: msg.signal }).catch(() => {});
      return;
    }
    default:
      return;
  }
}

function finishExec(exec, { code, signal, error }) {
  const { session } = exec;
  session.execs.delete(exec.execId);
  execsByChannel.delete(exec.channel);
  if (exec.sync) {
    const stdout = Buffer.concat(exec.stdout);
    const stderr = Buffer.concat(exec.stderr);
    const out = new Uint8Array(stdout);
    const errb = new Uint8Array(stderr);
    session.execPort.postMessage({ t: 'exec-sync-result', execId: exec.execId, code, signal: signal || null, error: error || null, stdout: out, stderr: errb }, [out.buffer, errb.buffer]);
    Atomics.store(new Int32Array(exec.sync), 0, 1);
    Atomics.notify(new Int32Array(exec.sync), 0);
  } else {
    session.execPort.postMessage({ t: 'exec-exit', execId: exec.execId, code, signal: signal || null, error: error || null });
  }
}

function onExecOut(channel, payload) {
  const exec = execsByChannel.get(channel);
  if (!exec || payload.length < 1) return;
  const fd = payload[0];
  const data = Buffer.from(payload.subarray(1));
  if (exec.sync) (fd === 2 ? exec.stderr : exec.stdout).push(data);
  else {
    const copy = new Uint8Array(data);
    exec.session.execPort.postMessage({ t: 'exec-out', execId: exec.execId, fd, data: copy }, [copy.buffer]);
  }
}

function setLinuxAvailable(available) {
  linuxAvailable = !!available;
  for (const s of sessions.values()) s.execPort.postMessage({ t: 'linux-available', available: linuxAvailable });
}

// ---- control requests from Swift
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
        linux: linuxAvailable,
        sessions: [...sessions.entries()].map(([ch, s]) => ({ channel: ch, kind: s.kind })),
        packages: Object.fromEntries(
          Object.entries(pins).map(([key, pin]) => [key, {
            pinned: pin.version,
            installed: installer.installedManifest(path.join(packagesDir, key), pin.version) ? pin.version : null,
          }]),
        ),
      };
    case 'linux':
      setLinuxAvailable(req.available);
      return { linux: linuxAvailable };
    case 'install': {
      const key = req.package;
      if (!pins[key]) throw new Error(`unknown package ${key}`);
      if (req.pin && !allowPinOverride) throw new Error('this build only installs the pins shipped with the app');
      // a runtime pin replaces version/tarball/integrity; the entry stays the shipped one
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
      let lastPct = -1;
      const { dir, manifest } = await installer.installTarball({
        pin,
        destRoot: path.join(packagesDir, key),
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
    case T.RESPONSE: {
      let res;
      try {
        res = json(payload);
      } catch {
        return;
      }
      const waiter = swiftRequests.get(res.id);
      if (!waiter) return;
      swiftRequests.delete(res.id);
      if (res.ok) waiter.resolve(res.result || {});
      else waiter.reject(new Error(res.error || 'request failed'));
      return;
    }
    case T.EXEC_OUT:
      onExecOut(channel, payload);
      return;
    case T.EXEC_EXIT: {
      const exec = execsByChannel.get(channel);
      if (!exec) return;
      let info = {};
      try {
        info = json(payload);
      } catch {}
      finishExec(exec, { code: info.code == null ? 1 : info.code, signal: info.signal, error: info.error });
      return;
    }
    case T.EVENT: {
      let ev;
      try {
        ev = json(payload);
      } catch {
        return;
      }
      if (ev.event === 'linux') setLinuxAvailable(ev.available);
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
