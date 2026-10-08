'use strict';
// child_process tier that runs commands in the host's Linux layer (iSH). Lives in a
// session worker; the supervisor relays to Swift over the control socket.
//
// Worker -> supervisor messages: {t:'exec-start', execId, argv, cwd, env}, {t:'exec-in', execId, data|null},
//   {t:'exec-kill', execId, signal}
// Supervisor -> worker: {t:'exec-started', execId, pid|error}, {t:'exec-out', execId, fd, data},
//   {t:'exec-exit', execId, code, signal, error}
//
// Sync spawns block the worker on a SharedArrayBuffer until the supervisor posts the
// result on a dedicated port (read with receiveMessageOnPort).

const path = require('path');
const { receiveMessageOnPort } = require('worker_threads');

const GUEST_HOME = '/mnt/termforge';
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// Host paths inside $HOME (the shared Documents folder) map to /mnt/termforge/...; other
// host paths have no guest equivalent and are passed through unchanged.
function toGuestPath(hostPath, hostHome) {
  if (typeof hostPath !== 'string' || !path.isAbsolute(hostPath)) return hostPath;
  const rel = path.relative(hostHome, hostPath);
  if (rel === '') return GUEST_HOME;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return hostPath;
  return path.posix.join(GUEST_HOME, ...rel.split(path.sep));
}

function toHostPath(guestPath, hostHome) {
  if (typeof guestPath !== 'string') return guestPath;
  if (guestPath === GUEST_HOME) return hostHome;
  if (guestPath.startsWith(`${GUEST_HOME}/`)) return path.join(hostHome, ...guestPath.slice(GUEST_HOME.length + 1).split('/'));
  return guestPath;
}

function guestEnv(env, hostHome) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    if (k === 'PATH' || k === 'Path') continue;
    out[k] = toGuestPath(v, hostHome);
  }
  out.PATH = GUEST_PATH;
  out.HOME = GUEST_HOME;
  out.TMPDIR = '/tmp';
  if (!out.TERM) out.TERM = 'xterm-256color';
  if (!out.LANG) out.LANG = 'C.UTF-8';
  return out;
}

// Commands with their own host implementations stay on earlier tiers; this tier takes
// everything else once the Linux layer is up.
class LinuxTier {
  constructor({ port, hostHome, available = false }) {
    this.name = 'linux';
    this.port = port; // MessagePort to the supervisor
    this.hostHome = hostHome;
    this.available = available;
    this.nextId = 1;
    this.live = new Map(); // execId -> io
    this.syncWaiters = new Map(); // execId -> { sab }
    port.on('message', (msg) => this._onMessage(msg));
  }

  claims(file) {
    return this.available && typeof file === 'string' && file.length > 0;
  }

  _spec(spec) {
    const file = toGuestPath(spec.file, this.hostHome);
    const args = spec.args.map((a) => toGuestPath(String(a), this.hostHome));
    return {
      argv: [file, ...args],
      cwd: toGuestPath(spec.cwd, this.hostHome) || GUEST_HOME,
      env: guestEnv(spec.env, this.hostHome),
    };
  }

  // The port is unref'd so idle sessions can end; a live exec must keep the loop alive.
  _track(execId, io) {
    if (this.live.size === 0) this.port.ref();
    this.live.set(execId, io);
  }

  _untrack(execId) {
    this.live.delete(execId);
    if (this.live.size === 0) this.port.unref();
  }

  spawn(spec, io) {
    const execId = this.nextId++;
    this._track(execId, io);
    this.port.postMessage({ t: 'exec-start', execId, ...this._spec(spec) });
    io.onStdin((buf) => this.port.postMessage({ t: 'exec-in', execId, data: buf ? new Uint8Array(buf) : null }));
    io.onKill((signal) => this.port.postMessage({ t: 'exec-kill', execId, signal: typeof signal === 'number' ? signal : SIGNALS[signal] || 15 }));
  }

  runSync(spec) {
    const execId = this.nextId++;
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    this.port.postMessage({ t: 'exec-start', execId, sync: sab, input: spec.input ? new Uint8Array(spec.input) : null, ...this._spec(spec) });
    Atomics.wait(flag, 0, 0);
    let result = null;
    for (let m = receiveMessageOnPort(this.port); m; m = receiveMessageOnPort(this.port)) {
      if (m.message && m.message.t === 'exec-sync-result' && m.message.execId === execId) result = m.message;
      else this._onMessage(m.message);
    }
    if (!result) return { status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error('exec result lost') };
    return {
      status: result.code,
      signal: result.signal || null,
      stdout: Buffer.from(result.stdout || new Uint8Array()),
      stderr: Buffer.from(result.stderr || new Uint8Array()),
    };
  }

  _onMessage(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'linux-available':
        this.available = !!msg.available;
        return;
      case 'exec-started': {
        const io = this.live.get(msg.execId);
        if (io && msg.error) {
          this._untrack(msg.execId);
          io.stderr(Buffer.from(`${msg.error}\n`));
          io.exit(127, null);
        }
        return;
      }
      case 'exec-out': {
        const io = this.live.get(msg.execId);
        if (!io) return;
        const buf = Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
        if (msg.fd === 2) io.stderr(buf);
        else io.stdout(buf);
        return;
      }
      case 'exec-exit': {
        const io = this.live.get(msg.execId);
        if (!io) return;
        this._untrack(msg.execId);
        if (msg.error) io.stderr(Buffer.from(`${msg.error}\n`));
        io.exit(msg.code == null ? 1 : msg.code, msg.signal || null);
        return;
      }
      default:
        return;
    }
  }
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12 };

module.exports = { LinuxTier, toGuestPath, toHostPath, guestEnv, GUEST_HOME, GUEST_PATH };
