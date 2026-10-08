// Runs under `node --jitless` as a plain process (no test runner): installs the fetch shim,
// fetches the URL given as argv[2] with a streamed read and prints a JSON summary.
'use strict';
const path = require('path');
require(path.join(__dirname, '..', '..', 'nodejs-project', 'lib', 'fetch-https')).install();
(async () => {
  const r = await fetch(process.argv[2], { method: 'POST', headers: { 'x-send': 'hi' }, body: 'payload' });
  const reader = r.body.getReader();
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  process.stdout.write(JSON.stringify({ wasm: typeof WebAssembly, status: r.status, echo: r.headers.get('x-echo'), bytes }) + '\n');
})().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String(e), cause: e && e.cause ? String(e.cause) : null }) + '\n');
  process.exit(1);
});
