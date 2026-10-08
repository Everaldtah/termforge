#!/usr/bin/env node
// Fetches the pinned Claude Code package exactly the way the app does on a device
// (npm registry tarball + SHA-512 check, complete and unmodified), writes it to an output
// directory for inspection, and reports what cannot work on iOS.
//
//   node scripts/vendor-claude-code.mjs [--out build/claude-code] [--probe-report run.json]
//
// --probe-report takes the JSON written by tools/desktop-harness/run-session.mjs --report,
// and adds every command Claude Code tried to spawn to the report.
//
// The package is © Anthropic PBC ("All rights reserved"): it is downloaded by each device
// from the registry and never committed to this repository or embedded in the app.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = require(path.join(root, 'nodejs-project', 'lib', 'installer.js'));
const pins = require(path.join(root, 'nodejs-project', 'pins.json'));

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const out = path.resolve(opt('out', path.join(root, 'build', 'claude-code')));
const probe = opt('probe-report', null);
const pin = pins['claude-code'];

const { dir, manifest } = await installer.installTarball({ pin, destRoot: out });

// Executables and addons built for desktop OSes, recognised by their magic bytes.
function nativeKind(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const hex = head.toString('hex');
  if (hex === '7f454c46') return 'ELF (Linux)';
  if (['cffaedfe', 'feedfacf', 'cafebabe'].includes(hex)) return 'Mach-O (macOS)';
  if (head.subarray(0, 2).toString('latin1') === 'MZ') return 'PE (Windows)';
  return null;
}
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));

const lines = [];
lines.push(`# Claude Code ${pin.version} on iOS: vendoring report`, '');
lines.push(`- Tarball: ${pin.tarball}`);
lines.push(`- Integrity: ${pin.integrity} (verified)`);
lines.push(`- engines.node: ${pkg.engines && pkg.engines.node} (nodejs-mobile ships Node 18.20.4)`);
lines.push(`- Entry: ${pin.entry}; license: ${pkg.license}`);
lines.push(`- Unpacked to: ${dir}`, '');
const native = manifest.written.filter((f) => nativeKind(path.join(dir, f.path)));
const runnable = manifest.written.filter((f) => !native.includes(f));
lines.push(`Installed complete and unmodified: ${manifest.written.length} files, ${manifest.skipped.length} skipped.`);
lines.push('', '## JavaScript and data (what runs)', '');
for (const f of runnable) lines.push(`- \`${f.path}\` (${(f.bytes / 1024).toFixed(0)} KiB)`);
lines.push('', '## Desktop binaries: kept on disk, never run (iOS cannot exec)', '');
for (const f of native) lines.push(`- \`${f.path}\` (${(f.bytes / 1024).toFixed(0)} KiB): ${nativeKind(path.join(dir, f.path))}`);
const optional = Object.keys(pkg.optionalDependencies || {});
if (optional.length) {
  lines.push('', '## Optional native dependencies (never installed)', '');
  lines.push(`${optional.map((d) => `\`${d}\``).join(', ')}: prebuilt platform binaries (image processing); Claude Code runs without them.`);
}
if (probe) {
  const report = JSON.parse(fs.readFileSync(probe, 'utf8'));
  lines.push('', `## Commands spawned during a probe run (Node ${report.node}, jitless=${report.jitless})`, '');
  lines.push('Each one went through the child_process shim; `none` = no tier claimed it (ENOENT).', '');
  const counts = new Map();
  for (const e of report.execs) counts.set(e, (counts.get(e) || 0) + 1);
  for (const [e, n] of counts) lines.push(`- ${n > 1 ? `${n}× ` : ''}\`${e}\``);
}
lines.push('', '## Needs from the host', '');
lines.push('- A POSIX shell, git and ripgrep for the Bash, Grep and Glob tools: routed to the Linux layer (phase 3).');
lines.push('- `xdg-open <url>` for sign-in: handled by the host-url tier (ASWebAuthenticationSession).');
lines.push('- No WebAssembly was needed to reach the first screen; jitless V8 has none.');

const report = lines.join('\n') + '\n';
fs.writeFileSync(path.join(out, `report-${pin.version}.md`), report);
process.stdout.write(report);
