'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Host } = require('./host-client');
const { toGuestPath, toHostPath, guestEnv, GUEST_HOME } = require('../nodejs-project/lib/linux-tier');

test('linux tier: path and env translation', () => {
  const home = os.platform() === 'win32' ? 'C:\\Users\\me' : '/Users/me';
  assert.strictEqual(toGuestPath(home, home), GUEST_HOME);
  assert.strictEqual(toGuestPath(path.join(home, 'Projects', 'a'), home), '/mnt/termforge/Projects/a');
  assert.strictEqual(toGuestPath('/usr/bin/git', home), '/usr/bin/git');
  assert.strictEqual(toHostPath('/mnt/termforge/Projects/a', home), path.join(home, 'Projects', 'a'));
  assert.strictEqual(toHostPath(GUEST_HOME, home), home);
  const env = guestEnv({ PATH: '/host/bin', HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), X: '1' }, home);
  assert.strictEqual(env.HOME, GUEST_HOME);
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/mnt/termforge/.claude');
  assert.ok(env.PATH.startsWith('/usr/local'));
  assert.strictEqual(env.X, '1');
});

test('exec protocol: child_process runs on the host through the Linux tier', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-exec-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-'));
  const host = await Host.start({ dataDir, linux: true, env: { HOME: home, USERPROFILE: home } });
  t.after(async () => {
    await host.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const status = await host.request('status');
  assert.strictEqual(status.linux, true);

  host.open(1, { kind: 'script', entry: path.join(__dirname, 'fixtures', 'exec-probe.mjs'), cwd: home });
  await host.waitFor(1, (s) => s.includes('"test":"done"'), 20000);
  const results = Object.fromEntries(host.text(1).split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((o) => [o.test, o]));

  assert.deepStrictEqual(results['spawn-stdin'], { test: 'spawn-stdin', out: 'round trip', code: 0, pid: 'number' });
  assert.match(results.execFile.stdout, /cwd=\S+ home=\S+ tf=yes/);
  assert.deepStrictEqual(results['exit-code'], { test: 'exit-code', code: 3, stderr: 'to-err', stdout: '' });
  assert.strictEqual(results.execSync.out, 'sync-ok');
  assert.deepStrictEqual(results.spawnSync, { test: 'spawnSync', out: 'input', status: 5 });
  assert.strictEqual(results.missing.code, 127);
  assert.ok(results.kill.signal === 'SIGTERM' || results.kill.code === 143, JSON.stringify(results.kill));

  // every exec reached the host with guest paths and a guest environment
  assert.ok(host.execLog.length >= 6);
  for (const req of host.execLog) {
    assert.ok(req.argv[0].startsWith('/'), `bare names go through /bin/sh: ${req.argv.join(' ')}`);
    assert.ok(req.cwd.startsWith(GUEST_HOME), req.cwd);
    assert.strictEqual(req.env.HOME, GUEST_HOME);
    assert.ok(req.env.PATH.startsWith('/usr/local'));
  }

  // the Linux layer going away turns the tier off: commands become ENOENT again
  host.setLinuxAvailable(false);
  await new Promise((r) => setTimeout(r, 100));
  host.open(2, { kind: 'script', entry: path.join(__dirname, 'fixtures', 'exec-off.mjs'), cwd: home });
  await host.waitFor(2, (s) => s.includes('ENOENT'), 10000);
});
