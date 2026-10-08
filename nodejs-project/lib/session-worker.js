'use strict';
// Runs one terminal session inside a worker thread: installs the virtual TTY as
// process.stdin/stdout/stderr, the child_process shim and a per-session cwd, then
// loads the session program (Claude Code's cli.js, a Node REPL, or a script).
// A program calling process.exit() ends only this worker, never the shared Node runtime
// (nodejs-mobile can start Node once per app process).

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const { pathToFileURL } = require('url');
const { VirtualTerminal } = require('./vtty');
const shim = require('./child-process-shim');
const virtualCwd = require('./virtual-cwd');

const spec = workerData;
const t0 = Date.now();

// ---- output: coalesce writes made in one event-loop turn into one message
let pending = [];
let pendingBytes = 0;
let flushScheduled = false;
let firstOutputReported = false;

function flush() {
  flushScheduled = false;
  if (pendingBytes === 0) return;
  const out = new Uint8Array(pendingBytes);
  let off = 0;
  for (const b of pending) {
    out.set(b, off);
    off += b.length;
  }
  pending = [];
  pendingBytes = 0;
  parentPort.postMessage({ t: 'out', data: out }, [out.buffer]);
  if (!firstOutputReported) {
    firstOutputReported = true;
    parentPort.postMessage({ t: 'metric', name: 'session.firstOutput', ms: Date.now() - t0 });
  }
}

function sink(buf) {
  pending.push(buf);
  pendingBytes += buf.length;
  if (pendingBytes >= 256 * 1024) flush();
  else if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(flush);
  }
}

const term = new VirtualTerminal({
  cols: spec.cols || 80,
  rows: spec.rows || 24,
  sink,
  keepAlive: (on) => (on ? parentPort.ref() : parentPort.unref()),
});

// ---- process identity
function defineProcessProp(name, value) {
  Object.defineProperty(process, name, { configurable: true, enumerable: true, get: () => value });
}

// Worker internals answer the parent's "stdio wants more data" messages by calling a
// symbol-keyed method on process.stdout/stderr; keep that working on the replacements.
function keepWorkerStdioHooks(original, replacement) {
  for (let o = original; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const sym of Object.getOwnPropertySymbols(o)) {
      if (/StdioWantsMoreData/.test(sym.description || '') && typeof original[sym] === 'function') {
        replacement[sym] = (...a) => original[sym](...a);
      }
    }
  }
}
keepWorkerStdioHooks(process.stdout, term.stdout);
keepWorkerStdioHooks(process.stderr, term.stderr);
defineProcessProp('stdin', term.stdin);
defineProcessProp('stdout', term.stdout);
defineProcessProp('stderr', term.stderr);
globalThis.console = new console.Console({ stdout: term.stdout, stderr: term.stderr, colorMode: true });
if (spec.platform) Object.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: spec.platform });
virtualCwd.install(spec.cwd || process.cwd());
process.on('exit', flush);

// ---- child_process
const router = new shim.ExecRouter({
  tiers: [shim.urlOpenTier((url) => parentPort.postMessage({ t: 'open-url', url }))],
  onExec: (record) => parentPort.postMessage({ t: 'exec', record }),
});
shim.install(router);

// ---- input from the host
parentPort.on('message', (msg) => {
  switch (msg.t) {
    case 'in':
      term.input(Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength));
      break;
    case 'resize':
      term.resize(msg.cols, msg.rows);
      break;
    case 'signal':
      term.kill(msg.signo);
      break;
    default:
      break;
  }
});
parentPort.unref();

// ---- the program
async function run() {
  switch (spec.kind) {
    case 'repl': {
      const repl = require('repl');
      term.stdout.write(`Welcome to Node.js ${process.version} (${process.arch}${spec.jitless ? ', jitless' : ''}).\n`);
      const server = repl.start({ prompt: '> ', input: term.stdin, output: term.stdout, terminal: true, useColors: true });
      server.on('exit', () => process.exit(0));
      return;
    }
    case 'script':
    case 'claude': {
      const entry = path.resolve(spec.entry);
      process.argv = [process.execPath, entry, ...(spec.argv || [])];
      parentPort.postMessage({ t: 'metric', name: 'session.workerReady', ms: Date.now() - t0 });
      await import(pathToFileURL(entry).href);
      parentPort.postMessage({ t: 'metric', name: 'session.entryLoaded', ms: Date.now() - t0 });
      return;
    }
    default:
      throw new Error(`unknown session kind: ${spec.kind}`);
  }
}

run().catch((err) => {
  term.stderr.write(`\n[termforge] ${spec.kind} failed to start: ${err && err.stack ? err.stack : err}\n`);
  flush();
  process.exit(1);
});
