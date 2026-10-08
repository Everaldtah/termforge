'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const zlib = require('zlib');

const lib = path.join(__dirname, '..', 'nodejs-project', 'lib');
const { T, encode, Decoder } = require(path.join(lib, 'frame'));
const { VirtualTerminal, onlcr } = require(path.join(lib, 'vtty'));
const shim = require(path.join(lib, 'child-process-shim'));
const installer = require(path.join(lib, 'installer'));

test('frame: round trip survives arbitrary fragmentation', () => {
  const frames = [
    encode(T.HELLO, 0, { node: 'v18' }),
    encode(T.DATA, 7, Buffer.from([0, 1, 2, 255])),
    encode(T.RESIZE, 7, Buffer.from([0, 120, 0, 40])),
    encode(T.CLOSE, 9),
  ];
  const wire = Buffer.concat(frames);
  for (const step of [1, 2, 3, 5, 8, 13, wire.length]) {
    const d = new Decoder();
    const got = [];
    for (let i = 0; i < wire.length; i += step) got.push(...d.push(wire.subarray(i, i + step)));
    assert.strictEqual(got.length, 4, `step ${step}`);
    assert.deepStrictEqual(JSON.parse(got[0].payload), { node: 'v18' });
    assert.strictEqual(got[1].channel, 7);
    assert.deepStrictEqual([...got[1].payload], [0, 1, 2, 255]);
    assert.strictEqual(got[2].payload.readUInt16BE(0), 120);
    assert.strictEqual(got[3].type, T.CLOSE);
    assert.strictEqual(got[3].payload.length, 0);
  }
});

test('frame: oversized length is rejected', () => {
  const bad = Buffer.alloc(9);
  bad.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => new Decoder().push(bad), RangeError);
});

test('vtty: ONLCR maps LF to CRLF', () => {
  assert.strictEqual(onlcr(Buffer.from('a\nb\n')).toString(), 'a\r\nb\r\n');
  const same = Buffer.from('no newline');
  assert.strictEqual(onlcr(same), same);
});

function makeTerm(opts = {}) {
  const out = [];
  const signals = [];
  const term = new VirtualTerminal({ cols: 80, rows: 24, sink: (b) => out.push(b), signal: (s) => signals.push(s), ...opts });
  const read = [];
  term.stdin.on('data', (d) => read.push(d.toString()));
  return { term, out: () => Buffer.concat(out).toString(), signals, read };
}

test('vtty: cooked mode echoes, edits and delivers whole lines', async () => {
  const { term, out, read } = makeTerm();
  term.input(Buffer.from('helo\x7flo wor\x17world\r'));
  await new Promise(setImmediate);
  assert.deepStrictEqual(read, ['hello world\n']);
  assert.ok(out().endsWith('\r\n'));
  assert.ok(out().includes('\b \b'));
});

test('vtty: ^C in cooked mode raises SIGINT and clears the line', () => {
  const { term, signals, read } = makeTerm();
  term.input(Buffer.from('abc\x03'));
  assert.deepStrictEqual(signals, ['SIGINT']);
  assert.deepStrictEqual(read, []);
});

test('vtty: raw mode passes bytes through untouched, ^C included', async () => {
  const { term, signals, read, out } = makeTerm();
  term.stdin.setRawMode(true);
  term.input(Buffer.from('\x1b[A\x03q'));
  await new Promise(setImmediate);
  assert.deepStrictEqual(read, ['\x1b[A\x03q']);
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(out(), '');
});

test('vtty: resize updates columns, emits resize and SIGWINCH', () => {
  const { term, signals } = makeTerm();
  let resized = 0;
  term.stdout.on('resize', () => resized++);
  term.resize(132, 50);
  assert.strictEqual(term.stdout.columns, 132);
  assert.deepStrictEqual(term.stdout.getWindowSize(), [132, 50]);
  assert.strictEqual(resized, 1);
  assert.deepStrictEqual(signals, ['SIGWINCH']);
  term.resize(132, 50);
  assert.strictEqual(resized, 1, 'same size is not a resize');
});

test('vtty: ^D on an empty line is EOF', async () => {
  const { term } = makeTerm();
  const ended = new Promise((r) => term.stdin.on('end', r));
  term.stdin.resume();
  term.input(Buffer.from('\x04'));
  await ended;
});

test('vtty: write streams look like a 24-bit colour tty', () => {
  const { term } = makeTerm();
  assert.strictEqual(term.stdout.isTTY, true);
  assert.strictEqual(term.stdin.isTTY, true);
  assert.strictEqual(term.stdout.getColorDepth(), 24);
  assert.strictEqual(term.stdout.hasColors(2 ** 24), true);
});

test('shim: unknown command fails like a missing binary (error then close)', async () => {
  const records = [];
  const router = new shim.ExecRouter({ onExec: (r) => records.push(r) });
  const cp = shim.buildModule(router, require('child_process'));
  const events = [];
  const child = cp.spawn('git', ['status']);
  child.on('error', (e) => events.push(['error', e.code, e.syscall]));
  await new Promise((r) => child.on('close', (code) => { events.push(['close', code]); r(); }));
  assert.deepStrictEqual(events, [['error', 'ENOENT', 'spawn git'], ['close', -2]]);
  assert.strictEqual(child.pid, undefined);
  assert.deepStrictEqual(records.map((r) => r.tier), ['none']);

  const execErr = await util.promisify(cp.execFile)('rg', ['x']).catch((e) => e);
  assert.strictEqual(execErr.code, 'ENOENT');
  const sync = cp.spawnSync('ls');
  assert.strictEqual(sync.error.code, 'ENOENT');
  assert.strictEqual(sync.status, null);
  assert.throws(() => cp.execFileSync('ls'), (e) => e.code === 'ENOENT');
});

test('shim: tiers run commands with stdio, exit codes and promisify', async () => {
  const echoTier = {
    name: 'test-echo',
    claims: (file) => file === 'echo' || file === 'cat' || file === 'false',
    spawn(spec, io) {
      if (spec.file === 'false') return io.exit(1, null);
      if (spec.file === 'echo') {
        io.stdout(spec.args.join(' ') + '\n');
        return io.exit(0, null);
      }
      io.onStdin((buf) => (buf ? io.stdout(buf) : io.exit(0, null)));
    },
    runSync: (spec) => ({ status: 0, signal: null, stdout: Buffer.from(`${spec.args.join(' ')}\n`), stderr: Buffer.alloc(0) }),
  };
  const records = [];
  const cp = shim.buildModule(new shim.ExecRouter({ tiers: [echoTier], onExec: (r) => records.push(r) }), require('child_process'));
  const { stdout } = await util.promisify(cp.execFile)('echo', ['hi', 'there']);
  assert.strictEqual(stdout, 'hi there\n');

  const child = cp.spawn('cat');
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stdin.write('abc');
  child.stdin.end('def');
  const [code] = await new Promise((r) => child.on('close', (...a) => r(a)));
  assert.strictEqual(code, 0);
  assert.strictEqual(Buffer.concat(chunks).toString(), 'abcdef');
  assert.strictEqual(typeof child.pid, 'number');

  const failed = await util.promisify(cp.execFile)('false', []).catch((e) => e);
  assert.strictEqual(failed.code, 1);
  assert.match(failed.message, /Command failed: false/);

  assert.strictEqual(cp.execFileSync('echo', ['sync'], { encoding: 'utf8' }), 'sync\n');
  assert.ok(records.every((r) => r.tier === 'test-echo'));
});

test('shim: browser openers become a host open-url request', async () => {
  const opened = [];
  const cp = shim.buildModule(new shim.ExecRouter({ tiers: [shim.urlOpenTier((u) => opened.push(u))] }), require('child_process'));
  await new Promise((r) => cp.spawn('xdg-open', ['https://claude.ai/oauth?x=1']).on('close', r));
  cp.spawnSync('/usr/bin/open', ['https://example.com/']);
  assert.deepStrictEqual(opened, ['https://claude.ai/oauth?x=1', 'https://example.com/']);
});

test('shim: install() patches CommonJS and ESM named exports', async () => {
  const cp = require('child_process');
  const saved = { ...cp };
  try {
    shim.install(new shim.ExecRouter());
    const esm = await import('node:child_process');
    assert.strictEqual(esm.spawn, cp.spawn);
    const err = await new Promise((r) => esm.spawn('nope').on('error', r));
    assert.strictEqual(err.code, 'ENOENT');
  } finally {
    Object.assign(cp, saved);
    require('module').syncBuiltinESMExports();
  }
});

function tarEntry(name, body, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([h, body, pad]);
}

function tgzOf(entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('installer: untar handles ustar, pax paths and GNU long names', () => {
  const long = 'package/' + 'd/'.repeat(60) + 'file.txt';
  const pax = Buffer.from(`${(' path=' + long + '\n').length + 3} path=${long}\n`);
  const tar = zlib.gunzipSync(tgzOf([
    tarEntry('package/a.js', Buffer.from('A')),
    tarEntry('PaxHeader', pax, 'x'),
    tarEntry('package/short', Buffer.from('P')),
    tarEntry('././@LongLink', Buffer.from(long + '\0'), 'L'),
    tarEntry('package/trunc', Buffer.from('L')),
  ]));
  const got = [...installer.untar(tar)].map((e) => [e.name, e.data.toString()]);
  assert.deepStrictEqual(got[0], ['package/a.js', 'A']);
  assert.strictEqual(got[1][0], long);
  assert.strictEqual(got[2][0], long);
});

test('installer: verifies integrity, filters, refuses traversal, installs atomically', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-inst-'));
  const tgz = tgzOf([
    tarEntry('package/cli.js', Buffer.from('console.log(1)')),
    tarEntry('package/vendor/rg', Buffer.from('\x7fELF')),
  ]);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64');
  const pin = { name: 'x', version: '1.0.0', tarball: 'mem://x', integrity };
  const fetchImpl = async () => tgz;

  await assert.rejects(installer.installTarball({ pin: { ...pin, integrity: 'sha512-AAAA' }, destRoot: dest, fetchImpl }), /integrity mismatch/);
  assert.deepStrictEqual(fs.readdirSync(dest), []);

  const { dir, manifest } = await installer.installTarball({
    pin, destRoot: dest, fetchImpl, accept: (rel) => (rel.startsWith('vendor/') ? 'native' : true),
  });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'cli.js'), 'utf8'), 'console.log(1)');
  assert.ok(!fs.existsSync(path.join(dir, 'vendor')));
  assert.deepStrictEqual(manifest.skipped.map((s) => [s.path, s.reason]), [['vendor/rg', 'native']]);
  assert.strictEqual(installer.installedManifest(dest, '1.0.0').version, '1.0.0');

  const evil = tgzOf([tarEntry('package/../../escape.txt', Buffer.from('x'))]);
  const evilPin = { ...pin, version: '6.6.6', integrity: 'sha512-' + crypto.createHash('sha512').update(evil).digest('base64') };
  await assert.rejects(installer.installTarball({ pin: evilPin, destRoot: dest, fetchImpl: async () => evil }), /unsafe path/);
  assert.ok(!fs.existsSync(path.join(dest, '6.6.6')));
  fs.rmSync(dest, { recursive: true, force: true });
});
