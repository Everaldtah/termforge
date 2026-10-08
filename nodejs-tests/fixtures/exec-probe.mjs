// Exercises child_process through the Linux tier: async spawn with stdin, execFile,
// execSync, a missing command, and a kill. Prints one JSON line per result.
import { spawn, execFile, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// 1. spawn + stdin round trip through bash
const cat = spawn('bash', ['-c', 'cat']);
let out = '';
cat.stdout.on('data', (d) => (out += d));
cat.stdin.end('round trip');
await new Promise((r) => cat.on('close', (code) => { say({ test: 'spawn-stdin', out, code, pid: typeof cat.pid }); r(); }));

// 2. execFile with cwd (guest path) and env passthrough
const { stdout } = await promisify(execFile)('bash', ['-c', 'echo "cwd=$PWD home=$HOME tf=$TF_MARK"'], { cwd: process.env.HOME, env: { ...process.env, TF_MARK: 'yes' } });
say({ test: 'execFile', stdout: stdout.trim() });

// 3. stderr separate, non-zero exit
await new Promise((r) => execFile('bash', ['-c', 'echo to-err >&2; exit 3'], (err, so, se) => { say({ test: 'exit-code', code: err && err.code, stderr: se.trim(), stdout: so }); r(); }));

// 4. sync
say({ test: 'execSync', out: execSync('bash -c "echo sync-ok"', { encoding: 'utf8' }).trim() });
const r = spawnSync('bash', ['-c', 'printf in; cat; exit 5'], { input: 'put' });
say({ test: 'spawnSync', out: String(r.stdout), status: r.status });

// 5. missing command
await new Promise((r) => execFile('definitely-not-a-command-xyz', [], (err) => { say({ test: 'missing', code: err && err.code }); r(); }));

// 6. kill
const sl = spawn('sleep', ['30']);
setTimeout(() => sl.kill('SIGTERM'), 200);
await new Promise((r) => sl.on('close', (code, signal) => { say({ test: 'kill', code, signal }); r(); }));
say({ test: 'done' });
