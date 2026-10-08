import { execFile } from 'node:child_process';
execFile('bash', ['-c', 'echo should-not-run'], (err) => process.stdout.write(`result: ${err ? err.code : 'ran'}\n`));
