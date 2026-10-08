// Desktop stand-in for the iOS app: boots nodejs-project/main.js (by default on Node with
// --jitless, like nodejs-mobile on a device), optionally installs a pinned package, opens one
// session, renders its output in a headless xterm and prints the screen plus timings.
//
//   node run-session.mjs --node <node binary> --home <isolated dir> [--install claude-code]
//        [--kind claude|repl|script] [--argv "..."] [--type "text\r"] [--wait-ms 20000]
//        [--until "text on screen"] [--steps '[{"until":"..","type":"\r"}]'] [--no-jitless] [--report out.json]
//
// --home becomes HOME/USERPROFILE for the Node process, so nothing touches the real profile.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';

const require = createRequire(import.meta.url);
const { Host } = require('../../nodejs-tests/host-client.js');
const { Terminal } = xtermHeadless;
const here = path.dirname(fileURLToPath(import.meta.url));

function opt(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const home = path.resolve(opt('home') || fs.mkdtempSync(path.join(here, '.home-')));
const kind = opt('kind', 'claude');
const cols = Number(opt('cols', 100));
const rows = Number(opt('rows', 32));
const waitMs = Number(opt('wait-ms', 20000));
const until = opt('until');
const typed = opt('type');
fs.mkdirSync(home, { recursive: true });

// Only what a fresh device would have: no inherited API keys or Claude Code session variables.
const KEEP = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.includes(k)));
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
});
fs.mkdirSync(env.TEMP, { recursive: true });

const spawnEnv = {};
for (const k of Object.keys(process.env)) spawnEnv[k] = undefined;
const host = await Host.start({
  node: opt('node', process.execPath),
  nodeArgs: flag('no-jitless') ? [] : ['--jitless'],
  dataDir: path.join(home, '.termforge'),
  env: { ...spawnEnv, ...env },
});
const report = { node: host.hello.node, jitless: host.hello.jitless, helloMs: +host.helloMs.toFixed(1), metrics: {}, execs: [], urls: [] };
console.error(`[harness] supervisor up in ${report.helloMs} ms (node ${report.node}, jitless=${report.jitless})`);

host.on('log', (l) => console.error('[node]', l));
host.on('event', (ch, e) => {
  if (e.event === 'metric') report.metrics[e.name] = e.ms;
  else if (e.event === 'exec') report.execs.push(`${e.tier}: ${[e.file, ...(e.args || [])].join(' ').slice(0, 120)}`);
  else if (e.event === 'open-url') report.urls.push(e.url);
  else if (e.event === 'install-progress' && e.phase !== 'download') console.error('[install]', JSON.stringify(e));
});

const pkg = opt('install');
if (pkg) {
  const t = Date.now();
  const r = await host.request('install', { package: pkg });
  report.install = { ms: Date.now() - t, written: r.written, skipped: r.skipped.length };
  console.error(`[harness] installed ${pkg} ${r.version} in ${report.install.ms} ms (${r.written} files, ${r.skipped.length} skipped)`);
}

const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
const opened = Date.now();
let firstByteMs = null;
host.on('data', (ch, buf) => {
  if (ch !== 1) return;
  if (firstByteMs === null) firstByteMs = Date.now() - opened;
  term.write(buf);
});

const spec = { kind, cols, rows, cwd: path.join(home, 'project'), argv: opt('argv') ? opt('argv').split(' ') : [] };
if (kind === 'script') spec.entry = path.resolve(opt('entry'));
host.open(1, spec);
let exitInfo = null;
host.on('exit', (ch, info) => {
  if (ch === 1) exitInfo = info;
});

const screen = () => {
  const b = term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
};

const steps = opt('steps-file')
  ? JSON.parse(fs.readFileSync(opt('steps-file'), 'utf8'))
  : opt('steps') ? JSON.parse(opt('steps')) : until ? [{ until, type: typed }] : [];
const unescape = (t) => t.replace(/\\r/g, '\r').replace(/\\x1b/g, '\x1b').replace(/\\n/g, '\n');
const deadline = Date.now() + waitMs;
let sawUntil = null;
report.steps = [];
while (Date.now() < deadline && !exitInfo) {
  await new Promise((r) => setTimeout(r, 50));
  const step = steps[report.steps.length];
  if (!step) {
    if (steps.length) break;
    continue;
  }
  if (screen().includes(step.until)) {
    const at = Date.now() - opened;
    if (sawUntil === null) sawUntil = at;
    report.steps.push({ until: step.until, atMs: at });
    if (step.type) {
      await new Promise((r) => setTimeout(r, step.delayMs || 150));
      host.write(1, unescape(step.type));
    }
  }
}
await new Promise((r) => setTimeout(r, 300));

report.firstByteMs = firstByteMs;
report.untilMs = sawUntil;
report.exit = exitInfo;
console.log('==================== screen ====================');
console.log(screen());
console.log('================================================');
console.log(JSON.stringify(report, null, 2));
if (opt('report')) fs.writeFileSync(opt('report'), JSON.stringify({ ...report, screen: screen() }, null, 2));
if (!exitInfo) host.close(1);
await host.stop();
if (report.steps.length < steps.length) {
  console.error(`[harness] reached ${report.steps.length} of ${steps.length} steps`);
  process.exitCode = 1;
}
