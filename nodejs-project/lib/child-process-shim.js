'use strict';
// child_process for an iOS app: the sandbox forbids fork/exec, so every spawn is handed to
// an ordered list of execution tiers. The first tier that claims a command runs it; when no
// tier does, the call fails exactly like spawning a binary that does not exist (ENOENT).
// Every call is reported through onExec with the tier that handled it.
//
// A tier is { name, claims(file, args, opts) -> bool, spawn(spec, io) , runSync?(spec) }.
//   spawn(spec, io): io.stdout(buf), io.stderr(buf), io.onStdin(fn(buf|null)), io.exit(code, signal),
//                    io.onKill(fn(signal)); may finish asynchronously.
//   runSync(spec) -> { status, signal, stdout: Buffer, stderr: Buffer }  (optional)

const EventEmitter = require('events');
const path = require('path');
const util = require('util');
const { Readable, Writable } = require('stream');

const ENOENT = -2;
const ENOSYS = -78;

let nextPid = 1000;

function errnoError(errno, code, syscall, file, args) {
  const err = new Error(`${syscall} ${code}`);
  err.errno = errno;
  err.code = code;
  err.syscall = syscall;
  err.path = file;
  err.spawnargs = args;
  return err;
}

function normalizeStdio(stdio) {
  if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') return [stdio, stdio, stdio];
  const out = stdio.slice(0, 3);
  while (out.length < 3) out.push('pipe');
  return out.map((s) => (s === undefined || s === null ? 'pipe' : s));
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), encoding || 'utf8');
}

class ShimChildProcess extends EventEmitter {
  constructor(file, args, opts) {
    super();
    this.spawnfile = file;
    this.spawnargs = [file, ...args];
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.connected = false;
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this.stdio = [null, null, null];
    this._stdio = normalizeStdio(opts.stdio);
    this._killHandler = null;
    this._stdinHandler = null;
    this._pendingStdin = [];
    this._exited = false;
    this._closed = false;
    this._openStreams = 0;

    if (this._stdio[0] === 'pipe') {
      this.stdin = new Writable({
        write: (chunk, enc, cb) => {
          this._feedStdin(toBuffer(chunk, enc));
          cb();
        },
        final: (cb) => {
          this._feedStdin(null);
          cb();
        },
      });
    }
    for (const fd of [1, 2]) {
      if (this._stdio[fd] !== 'pipe') continue;
      const r = new Readable({ read() {} });
      this._openStreams++;
      r.once('end', () => {
        this._openStreams--;
        this._maybeClose();
      });
      if (fd === 1) this.stdout = r;
      else this.stderr = r;
    }
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }

  _feedStdin(buf) {
    if (this._stdinHandler) this._stdinHandler(buf);
    else this._pendingStdin.push(buf);
  }

  _emitOut(fd, buf) {
    if (!buf || buf.length === 0) return;
    const mode = this._stdio[fd];
    if (mode === 'pipe') (fd === 1 ? this.stdout : this.stderr).push(buf);
    else if (mode === 'inherit') (fd === 1 ? process.stdout : process.stderr).write(buf);
    else if (mode && typeof mode.write === 'function') mode.write(buf);
  }

  _finish(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this.exitCode = signal ? null : code;
    this.signalCode = signal || null;
    if (this.stdout) this.stdout.push(null);
    if (this.stderr) this.stderr.push(null);
    this.emit('exit', this.exitCode, this.signalCode);
    // streams nobody reads never emit 'end'; drain those so 'close' still follows 'exit'
    setImmediate(() => {
      for (const s of [this.stdout, this.stderr]) {
        if (s && s.readableFlowing === null && s.listenerCount('readable') === 0) s.resume();
      }
    });
    this._maybeClose();
  }

  _maybeClose() {
    if (this._exited && this._openStreams === 0 && !this._closed) {
      this._closed = true;
      process.nextTick(() => this.emit('close', this.exitCode, this.signalCode));
    }
  }

  kill(signal = 'SIGTERM') {
    if (this._exited) return false;
    this.killed = true;
    if (this._killHandler) this._killHandler(signal);
    else this._finish(null, signal);
    return true;
  }

  ref() {}
  unref() {}
  disconnect() {}
}

class ExecRouter {
  constructor({ tiers = [], onExec = () => {} } = {}) {
    this.tiers = tiers;
    this.onExec = onExec;
  }

  pick(file, args, opts) {
    return this.tiers.find((t) => t.claims(file, args, opts)) || null;
  }

  spawn(file, args = [], opts = {}) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    const child = new ShimChildProcess(file, args, opts);
    const started = Date.now();
    const spec = { file, args, cwd: opts.cwd || process.cwd(), env: opts.env || process.env, shell: opts.shell };
    const tier = this.pick(file, args, opts);
    if (!tier) {
      this.onExec({ file, args, tier: 'none', code: ENOENT, ms: 0 });
      process.nextTick(() => {
        child._exited = true;
        child.exitCode = ENOENT;
        child.emit('error', errnoError(ENOENT, 'ENOENT', `spawn ${file}`, file, args));
        if (child.stdout) child.stdout.push(null);
        if (child.stderr) child.stderr.push(null);
        child._closed = true;
        process.nextTick(() => child.emit('close', ENOENT, null));
      });
      return child;
    }
    child.pid = nextPid++;
    child.once('exit', (code, signal) =>
      this.onExec({ file, args, tier: tier.name, code, signal, ms: Date.now() - started }),
    );
    const io = {
      stdout: (buf) => child._emitOut(1, toBuffer(buf)),
      stderr: (buf) => child._emitOut(2, toBuffer(buf)),
      exit: (code, signal) => child._finish(code, signal),
      onKill: (fn) => {
        child._killHandler = fn;
      },
      onStdin: (fn) => {
        child._stdinHandler = fn;
        for (const b of child._pendingStdin.splice(0)) fn(b);
      },
    };
    process.nextTick(() => {
      child.emit('spawn');
      try {
        tier.spawn(spec, io);
      } catch (err) {
        child.emit('error', err);
        child._finish(1, null);
      }
    });
    return child;
  }

  spawnSync(file, args = [], opts = {}) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    const started = Date.now();
    const spec = {
      file, args, cwd: opts.cwd || process.cwd(), env: opts.env || process.env,
      input: opts.input === undefined ? null : toBuffer(opts.input), shell: opts.shell,
    };
    const tier = this.pick(file, args, opts);
    const enc = opts.encoding && opts.encoding !== 'buffer' ? opts.encoding : null;
    const fmt = (b) => (enc ? b.toString(enc) : b);
    if (!tier || typeof tier.runSync !== 'function') {
      const errno = tier ? ENOSYS : ENOENT;
      const code = tier ? 'ENOSYS' : 'ENOENT';
      this.onExec({ file, args, tier: tier ? `${tier.name}(no-sync)` : 'none', code: errno, ms: 0 });
      return {
        pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null,
        error: errnoError(errno, code, `spawnSync ${file}`, file, args),
      };
    }
    const r = tier.runSync(spec);
    this.onExec({ file, args, tier: tier.name, code: r.status, signal: r.signal, ms: Date.now() - started });
    const stdout = fmt(r.stdout || Buffer.alloc(0));
    const stderr = fmt(r.stderr || Buffer.alloc(0));
    const stdio = normalizeStdio(opts.stdio);
    if (stdio[1] === 'inherit') process.stdout.write(r.stdout || '');
    if (stdio[2] === 'inherit') process.stderr.write(r.stderr || '');
    return { pid: nextPid++, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal || null };
  }
}

function shellFor(opts) {
  if (typeof opts.shell === 'string') return opts.shell;
  return (opts.env && opts.env.SHELL) || process.env.SHELL || '/bin/sh';
}

function commandFailed(cmd, status, signal, stdout, stderr, killed) {
  const err = new Error(`Command failed: ${cmd}\n${stderr instanceof Buffer ? stderr.toString() : stderr}`);
  err.code = status;
  err.killed = !!killed;
  err.signal = signal || null;
  err.cmd = cmd;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

function buildModule(router, original) {
  function spawn(file, args, opts) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    opts = opts || {};
    if (opts.shell) {
      const cmd = [file, ...args].join(' ');
      return router.spawn(shellFor(opts), ['-c', cmd], { ...opts, shell: undefined });
    }
    return router.spawn(file, args, opts);
  }

  function execFile(file, args, opts, cb) {
    if (typeof args === 'function') [cb, args, opts] = [args, [], {}];
    else if (!Array.isArray(args)) [cb, opts, args] = [opts, args, []];
    if (typeof opts === 'function') [cb, opts] = [opts, {}];
    opts = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 0, killSignal: 'SIGTERM', ...(opts || {}) };
    const child = spawn(file, args, opts);
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let done = false;
    let killedForLimit = null;
    let timer = null;
    const enc = opts.encoding && opts.encoding !== 'buffer' ? opts.encoding : null;
    const fmt = (parts) => (enc ? Buffer.concat(parts).toString(enc) : Buffer.concat(parts));
    const cmd = [file, ...args].join(' ');
    const finish = (error, code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const stdout = fmt(out);
      const stderr = fmt(err);
      if (!error && (code !== 0 || signal)) error = commandFailed(cmd, code, signal, stdout, stderr, child.killed);
      if (error && killedForLimit) error = killedForLimit;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
      }
      if (cb) cb(error || null, stdout, stderr);
    };
    const collect = (arr, which) => (chunk) => {
      const n = which === 'out' ? (outLen += chunk.length) : (errLen += chunk.length);
      if (n > opts.maxBuffer) {
        killedForLimit = new RangeError(`std${which} maxBuffer length exceeded`);
        killedForLimit.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        child.kill(opts.killSignal);
        return;
      }
      arr.push(chunk);
    };
    if (child.stdout) child.stdout.on('data', collect(out, 'out'));
    if (child.stderr) child.stderr.on('data', collect(err, 'err'));
    child.on('error', (e) => finish(e));
    child.on('close', (code, signal) => finish(null, code, signal));
    if (opts.timeout > 0) timer = setTimeout(() => child.kill(opts.killSignal), opts.timeout);
    return child;
  }

  execFile[util.promisify.custom] = (file, args, opts) =>
    new Promise((resolve, reject) => {
      execFile(file, args, opts, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });

  function exec(command, opts, cb) {
    if (typeof opts === 'function') [cb, opts] = [opts, {}];
    opts = opts || {};
    return execFile(shellFor(opts), ['-c', command], { ...opts, shell: undefined }, cb);
  }

  exec[util.promisify.custom] = (command, opts) =>
    new Promise((resolve, reject) => {
      exec(command, opts, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });

  function spawnSync(file, args, opts) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    opts = opts || {};
    if (opts.shell) return router.spawnSync(shellFor(opts), ['-c', [file, ...args].join(' ')], opts);
    return router.spawnSync(file, args, opts);
  }

  function execFileSync(file, args, opts) {
    if (!Array.isArray(args)) {
      opts = args || {};
      args = [];
    }
    opts = { stdio: ['pipe', 'pipe', 'inherit'], ...(opts || {}) };
    const r = spawnSync(file, args, opts);
    if (r.error) throw r.error;
    if (r.status !== 0 || r.signal) {
      throw Object.assign(commandFailed([file, ...args].join(' '), r.status, r.signal, r.stdout, r.stderr), {
        status: r.status, output: r.output, pid: r.pid,
      });
    }
    return r.stdout;
  }

  function execSync(command, opts) {
    opts = opts || {};
    return execFileSync(shellFor(opts), ['-c', command], { ...opts, shell: undefined });
  }

  function fork(modulePath) {
    const child = new ShimChildProcess(process.execPath, [modulePath], {});
    process.nextTick(() => {
      child.emit('error', errnoError(ENOSYS, 'ENOSYS', 'fork', modulePath, [modulePath]));
      child._finish(1, null);
    });
    return child;
  }

  return { spawn, spawnSync, exec, execSync, execFile, execFileSync, fork, ChildProcess: original.ChildProcess };
}

// Replace the live child_process module (CommonJS exports and ESM named exports).
function install(router) {
  const cp = require('child_process');
  const replacement = buildModule(router, cp);
  for (const [k, v] of Object.entries(replacement)) cp[k] = v;
  require('module').syncBuiltinESMExports();
  return cp;
}

const URL_OPENERS = new Set(['open', 'xdg-open', 'wslview', 'sensible-browser', 'www-browser', 'x-www-browser']);

// Tier: "open this URL in a browser" becomes a request to the host app.
function urlOpenTier(openUrl) {
  const urlOf = (args) => args.find((a) => /^https?:\/\//i.test(String(a)));
  return {
    name: 'host-url',
    claims: (file, args) => URL_OPENERS.has(path.posix.basename(String(file))) && !!urlOf(args),
    spawn(spec, io) {
      openUrl(urlOf(spec.args));
      io.exit(0, null);
    },
    runSync(spec) {
      openUrl(urlOf(spec.args));
      return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

module.exports = { ExecRouter, ShimChildProcess, buildModule, install, urlOpenTier, ENOENT, ENOSYS };
