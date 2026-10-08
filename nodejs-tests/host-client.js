'use strict';
// Test double for the Swift side: starts nodejs-project/main.js in a child Node process,
// accepts its control connection over TCP and speaks the frame protocol. Exec requests
// (the Linux tier) run as real processes on this machine, so the protocol can be tested
// end to end without iOS.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const net = require('net');
const os = require('os');
const path = require('path');
const { T, encode, Decoder, json } = require('../nodejs-project/lib/frame');
const { toHostPath } = require('../nodejs-project/lib/linux-tier');

class Host extends EventEmitter {
  static async start({ node = process.execPath, nodeArgs = ['--jitless'], dataDir, env = {}, linux = false } = {}) {
    const host = new Host();
    host.linux = linux;
    host.hostHome = env.HOME || process.env.HOME || os.homedir();
    const server = net.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const started = process.hrtime.bigint();
    host.proc = spawn(node, [...nodeArgs, path.join(__dirname, '..', 'nodejs-project', 'main.js'),
      `--control-tcp=127.0.0.1:${port}`, `--data-dir=${dataDir}`], { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
    host.sock = await new Promise((resolve, reject) => {
      server.once('connection', resolve);
      host.proc.once('exit', (c) => reject(new Error(`main.js exited early with ${c}`)));
    });
    server.close();
    host.sock.setNoDelay(true);
    const decoder = new Decoder();
    host.sock.on('data', (chunk) => {
      for (const f of decoder.push(chunk)) host._frame(f);
    });
    host.hello = await new Promise((r) => host.once('hello', r));
    host.helloMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (linux) host.setLinuxAvailable(true);
    return host;
  }

  constructor() {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.out = new Map(); // channel -> Buffer[]
    this.execs = new Map(); // exec channel -> child
    this.execLog = [];
  }

  _frame({ type, channel, payload }) {
    switch (type) {
      case T.HELLO:
        this.emit('hello', json(payload));
        break;
      case T.DATA:
        if (!this.out.has(channel)) this.out.set(channel, []);
        this.out.get(channel).push(Buffer.from(payload));
        this.emit('data', channel, Buffer.from(payload));
        break;
      case T.EXIT:
        this.emit('exit', channel, json(payload));
        break;
      case T.RESPONSE: {
        const r = json(payload);
        const p = this.pending.get(r.id);
        if (p) {
          this.pending.delete(r.id);
          if (r.ok) p.resolve(r.result);
          else p.reject(new Error(r.error));
        }
        break;
      }
      case T.REQUEST:
        this._nodeRequest(json(payload));
        break;
      case T.EXEC_IN: {
        const child = this.execs.get(channel);
        if (!child || !child.stdin) break;
        if (payload.length === 0) child.stdin.end();
        else child.stdin.write(Buffer.from(payload));
        break;
      }
      case T.EVENT:
        this.emit('event', channel, json(payload));
        break;
      case T.LOG:
        this.emit('log', payload.toString());
        break;
      default:
        break;
    }
  }

  // Node asked us to do something (exec on the "Linux layer" = this machine).
  _nodeRequest(req) {
    const respond = (ok, body) => this.sock.write(encode(T.RESPONSE, 0, { id: req.id, ok, ...(ok ? { result: body } : { error: body }) }));
    if (req.op === 'exec') {
      this.execLog.push(req);
      let [file, ...args] = req.argv;
      // the tier wraps bare names in `/bin/sh -c 'exec "$0" "$@"' name args`; spawn the
      // program directly here (what the guest shell would do), which also keeps kill
      // semantics sane on Windows where a killed sh leaves its child running
      if (file === '/bin/sh' && args[0] === '-c' && args[1] === 'exec "$0" "$@"') [file, ...args] = args.slice(2);
      const program = file.startsWith('/') ? path.posix.basename(file) : file;
      const cwd = toHostPath(req.cwd, this.hostHome);
      const env = { ...process.env, ...req.env, HOME: this.hostHome, PATH: process.env.PATH };
      let child;
      try {
        child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        return respond(false, err.message);
      }
      this.execs.set(req.channel, child);
      child.on('error', (err) => {
        this.execs.delete(req.channel);
        this.sock.write(encode(T.EXEC_EXIT, req.channel, { code: 127, error: `${err.code}: ${program}` }));
      });
      child.stdout.on('data', (d) => this.sock.write(encode(T.EXEC_OUT, req.channel, Buffer.concat([Buffer.from([1]), d]))));
      child.stderr.on('data', (d) => this.sock.write(encode(T.EXEC_OUT, req.channel, Buffer.concat([Buffer.from([2]), d]))));
      child.on('close', (code, signal) => {
        if (!this.execs.has(req.channel)) return;
        this.execs.delete(req.channel);
        this.sock.write(encode(T.EXEC_EXIT, req.channel, { code: signal ? 128 + (os.constants.signals[signal] || 0) : code, signal }));
      });
      respond(true, { pid: child.pid || 0 });
      return;
    }
    if (req.op === 'exec-kill') {
      const child = this.execs.get(req.channel);
      if (child) child.kill(req.signal);
      return respond(true, {});
    }
    respond(false, `unknown op ${req.op}`);
  }

  setLinuxAvailable(available) {
    this.linux = available;
    this.sock.write(encode(T.EVENT, 0, { event: 'linux', available }));
  }

  request(op, extra = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(encode(T.REQUEST, 0, { id, op, ...extra }));
    });
  }

  open(channel, spec) {
    this.sock.write(encode(T.OPEN, channel, spec));
  }

  write(channel, data) {
    this.sock.write(encode(T.DATA, channel, Buffer.from(data)));
  }

  resize(channel, cols, rows) {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(cols, 0);
    b.writeUInt16BE(rows, 2);
    this.sock.write(encode(T.RESIZE, channel, b));
  }

  signal(channel, signo) {
    this.sock.write(encode(T.SIGNAL, channel, Buffer.from([signo])));
  }

  close(channel) {
    this.sock.write(encode(T.CLOSE, channel));
  }

  text(channel) {
    return Buffer.concat(this.out.get(channel) || []).toString('utf8');
  }

  waitFor(channel, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (predicate(this.text(channel))) {
          cleanup();
          resolve(this.text(channel));
        }
      };
      const onData = (ch) => ch === channel && check();
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout on channel ${channel}; output so far:\n${this.text(channel)}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('data', onData);
      };
      this.on('data', onData);
      check();
    });
  }

  waitExit(channel, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no exit on channel ${channel}`)), timeoutMs);
      const on = (ch, info) => {
        if (ch !== channel) return;
        clearTimeout(timer);
        this.off('exit', on);
        resolve(info);
      };
      this.on('exit', on);
    });
  }

  async stop() {
    this.sock.end();
    await new Promise((r) => (this.proc.exitCode !== null ? r() : this.proc.once('exit', r)));
  }
}

module.exports = { Host };
