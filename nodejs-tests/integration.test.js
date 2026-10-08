'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Host } = require('./host-client');

const fixtures = path.join(__dirname, 'fixtures');

test('supervisor: hello, ping, sessions, resize, signals, exit codes', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-int-'));
  const host = await Host.start({ dataDir });
  t.after(async () => {
    await host.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.match(host.hello.node, /^v\d+/);
  assert.strictEqual(host.hello.jitless, true);

  const pings = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    await host.request('ping', { t: i });
    pings.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  pings.sort((a, b) => a - b);
  t.diagnostic(`control round trip median ${pings[10].toFixed(3)} ms, p95 ${pings[18].toFixed(3)} ms`);

  const status = await host.request('status');
  assert.strictEqual(status.packages['claude-code'].installed, null);

  // a program that uses raw mode, resize events, SIGINT handling and process.exit
  host.open(1, { kind: 'script', entry: path.join(fixtures, 'tty-probe.mjs'), cols: 100, rows: 30, cwd: dataDir, argv: ['x', 'y'] });
  await host.waitFor(1, (s) => s.includes('READY'));
  const ready = host.text(1);
  assert.match(ready, /isTTY=true\/true raw=false cols=100 rows=30/);
  assert.match(ready, /argv=x,y/);
  assert.match(ready, new RegExp(`cwd=${dataDir.replace(/\\/g, '\\\\')}`));
  assert.ok(ready.includes('\r\n'), 'ONLCR applied');

  const t0 = process.hrtime.bigint();
  host.write(1, 'k');
  await host.waitFor(1, (s) => s.includes('KEY:6b'));
  t.diagnostic(`keystroke -> program -> echo round trip ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(3)} ms`);

  host.resize(1, 120, 40);
  await host.waitFor(1, (s) => s.includes('RESIZE 120x40'));
  host.signal(1, 2);
  await host.waitFor(1, (s) => s.includes('GOT SIGINT'));
  host.write(1, 'q');
  const exit = await host.waitExit(1);
  assert.strictEqual(exit.code, 7);

  // a Node REPL session in cooked/readline mode
  host.open(2, { kind: 'repl', cols: 80, rows: 24 });
  await host.waitFor(2, (s) => s.includes('> '));
  host.write(2, '6*7\r');
  await host.waitFor(2, (s) => s.includes('42'));
  host.write(2, '.exit\r');
  assert.strictEqual((await host.waitExit(2)).code, 0);

  // two sessions keep separate working directories
  const a = fs.mkdtempSync(path.join(dataDir, 'a-'));
  const b = fs.mkdtempSync(path.join(dataDir, 'b-'));
  host.open(3, { kind: 'script', entry: path.join(fixtures, 'cwd-probe.mjs'), cwd: a });
  host.open(4, { kind: 'script', entry: path.join(fixtures, 'cwd-probe.mjs'), cwd: b });
  await Promise.all([host.waitExit(3), host.waitExit(4)]);
  assert.strictEqual(fs.readFileSync(path.join(a, 'where.txt'), 'utf8'), a);
  assert.strictEqual(fs.readFileSync(path.join(b, 'where.txt'), 'utf8'), b);

  // claude without an install reports NOT_INSTALLED instead of crashing
  host.open(5, { kind: 'claude' });
  const notInstalled = await host.waitExit(5);
  assert.strictEqual(notInstalled.reason, 'NOT_INSTALLED');
});
