'use strict';
// A virtual terminal for code running in a worker thread: process.stdin/stdout/stderr
// stand-ins that behave like tty.ReadStream / tty.WriteStream, plus the small part of
// the kernel line discipline programs rely on (ICANON, ECHO, ISIG, ONLCR).
// iOS gives sandboxed apps no pty devices, so this is the pty.

const { Readable, Writable } = require('stream');
const readline = require('readline');

const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 15: 'SIGTERM', 28: 'SIGWINCH' };

// ONLCR: the kernel turns every "\n" written to a tty into "\r\n" unless OPOST is off.
// libuv's raw mode leaves OPOST alone, so this applies in raw and cooked mode alike.
function onlcr(buf) {
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
  if (count === 0) return buf;
  const out = Buffer.allocUnsafe(buf.length + count);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) out[j++] = 0x0d;
    out[j++] = buf[i];
  }
  return out;
}

// Bytes of the last UTF-8 code point in buf (for backspace in cooked mode).
function lastCodePointLength(buf) {
  let n = 1;
  while (n < buf.length && n < 4 && (buf[buf.length - n] & 0xc0) === 0x80) n++;
  return n;
}

class TTYReadStream extends Readable {
  constructor(term) {
    super({ highWaterMark: 64 * 1024 });
    this._term = term;
    this.isTTY = true;
    this.isRaw = false;
    this.fd = 0;
  }

  setRawMode(flag) {
    this.isRaw = !!flag;
    return this;
  }

  _read() {
    this._term._wantInput(true);
  }

  ref() {
    this._term._refInput(true);
    return this;
  }

  unref() {
    this._term._refInput(false);
    return this;
  }
}

class TTYWriteStream extends Writable {
  constructor(term, fd) {
    super({ decodeStrings: true, highWaterMark: 64 * 1024 });
    this._term = term;
    this.isTTY = true;
    this.fd = fd;
    this.columns = term.cols;
    this.rows = term.rows;
  }

  _write(chunk, _enc, cb) {
    this._term._output(onlcr(chunk));
    cb();
  }

  _writev(chunks, cb) {
    for (const { chunk } of chunks) this._term._output(onlcr(chunk));
    cb();
  }

  getWindowSize() {
    return [this.columns, this.rows];
  }

  hasColors(count = 16, env) {
    if (typeof count === 'object') count = 16;
    return count <= 2 ** this.getColorDepth(env);
  }

  getColorDepth() {
    return 24;
  }

  cursorTo(x, y, cb) {
    return readline.cursorTo(this, x, y, cb);
  }

  moveCursor(dx, dy, cb) {
    return readline.moveCursor(this, dx, dy, cb);
  }

  clearLine(dir, cb) {
    return readline.clearLine(this, dir, cb);
  }

  clearScreenDown(cb) {
    return readline.clearScreenDown(this, cb);
  }
}

// sink(buf): called with terminal-ready output bytes.
// keepAlive(on): called when stdin starts/stops holding the event loop open.
// signal(name): deliver a signal to the program (defaults to process signal semantics).
class VirtualTerminal {
  constructor({ cols = 80, rows = 24, sink, keepAlive = () => {}, signal } = {}) {
    if (typeof sink !== 'function') throw new TypeError('sink is required');
    this.cols = cols;
    this.rows = rows;
    this._sink = sink;
    this._keepAlive = keepAlive;
    this._signal = signal || defaultSignal;
    this._line = Buffer.alloc(0);
    this._eof = false;
    this._explicitRef = null;
    this.stdin = new TTYReadStream(this);
    this.stdout = new TTYWriteStream(this, 1);
    this.stderr = new TTYWriteStream(this, 2);
    this.stdin.on('pause', () => this._wantInput(false));
    this.stdin.on('resume', () => this._wantInput(true));
  }

  // Bytes typed at the terminal.
  input(bytes) {
    if (this._eof) return;
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (this.stdin.isRaw) {
      this.stdin.push(buf);
      return;
    }
    for (let i = 0; i < buf.length; i++) this._cooked(buf[i]);
  }

  resize(cols, rows) {
    if (!(cols > 0 && rows > 0)) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    for (const s of [this.stdout, this.stderr]) {
      s.columns = cols;
      s.rows = rows;
      s.emit('resize');
    }
    this._signal('SIGWINCH');
  }

  kill(signo) {
    const name = SIGNALS[signo];
    if (name) this._signal(name);
  }

  _output(buf) {
    if (buf.length) this._sink(buf);
  }

  _echo(text) {
    this._output(onlcr(Buffer.from(text, 'utf8')));
  }

  _cooked(b) {
    switch (b) {
      case 0x03: // ^C  (ISIG)
        this._line = Buffer.alloc(0);
        this._echo('^C\n');
        this._signal('SIGINT');
        return;
      case 0x1c: // ^\  (ISIG)
        this._line = Buffer.alloc(0);
        this._echo('^\\\n');
        this._signal('SIGQUIT');
        return;
      case 0x1a: // ^Z: no job control in here; discard like a shell with job control off
        return;
      case 0x04: // ^D
        if (this._line.length === 0) {
          this._eof = true;
          this.stdin.push(null);
        } else {
          this._deliver(this._line);
        }
        return;
      case 0x7f:
      case 0x08: { // erase
        if (this._line.length === 0) return;
        const n = lastCodePointLength(this._line);
        this._line = this._line.subarray(0, this._line.length - n);
        this._echo('\b \b');
        return;
      }
      case 0x15: { // ^U kill line
        const chars = Buffer.from(this._line).toString('utf8').length;
        this._line = Buffer.alloc(0);
        this._echo('\b \b'.repeat(chars));
        return;
      }
      case 0x17: { // ^W erase word
        const text = this._line.toString('utf8');
        const kept = text.replace(/\S+\s*$/, '');
        const erased = text.length - kept.length;
        this._line = Buffer.from(kept, 'utf8');
        this._echo('\b \b'.repeat(erased));
        return;
      }
      case 0x0d: // ICRNL
      case 0x0a:
        this._echo('\n');
        this._deliver(Buffer.concat([this._line, Buffer.from([0x0a])]));
        return;
      default:
        this._line = Buffer.concat([this._line, Buffer.from([b])]);
        // ECHOCTL: show other control characters in caret notation
        if (b < 0x20 && b !== 0x09) this._echo('^' + String.fromCharCode(b + 0x40));
        else this._output(Buffer.from([b]));
    }
  }

  _deliver(buf) {
    this._line = Buffer.alloc(0);
    this.stdin.push(buf);
  }

  _wantInput(on) {
    if (this._explicitRef === null) this._keepAlive(on);
  }

  _refInput(on) {
    this._explicitRef = on;
    this._keepAlive(on);
  }
}

// Same outcome as an unhandled signal in a real process: handlers run if installed,
// otherwise the default action (terminate, except SIGWINCH which is ignored).
function defaultSignal(name) {
  if (process.listenerCount(name) > 0) {
    process.emit(name, name);
    return;
  }
  if (name === 'SIGWINCH') return;
  const signo = Number(Object.keys(SIGNALS).find((k) => SIGNALS[k] === name));
  process.exit(128 + signo);
}

module.exports = { VirtualTerminal, onlcr, SIGNALS };
