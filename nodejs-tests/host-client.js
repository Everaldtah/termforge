'use strict';
// Test double for the Swift side: starts nodejs-project/main.js in a child Node process,
// accepts its control connection over TCP and speaks the frame protocol.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const net = require('net');
const path = require('path');
const { T, encode, Decoder, json } = require('../nodejs-project/lib/frame');

class Host extends EventEmitter {
  static async start({ node = process.execPath, nodeArgs = ['--jitless'], dataDir, env = {} } = {}) {
    const host = new Host();
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
    return host;
  }

  constructor() {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.out = new Map(); // channel -> Buffer[]
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
