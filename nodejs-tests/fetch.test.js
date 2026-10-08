'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const { fetch: fetchHttps, install } = require(path.join(__dirname, '..', 'nodejs-project', 'lib', 'fetch-https'));

function server() {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.headers['x-send'] || '' }).end(JSON.stringify({ method: req.method, body }));
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let n = 0;
        const t = setInterval(() => { res.write(`data: ${n++}\n\n`); if (n === 3) { clearInterval(t); res.end(); } }, 20);
        return;
      }
      if (req.url === '/redirect') return res.writeHead(302, { location: '/json' }).end();
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
      if (req.url === '/gzip') { const zlib = require('zlib'); return res.writeHead(200, { 'content-encoding': 'gzip' }).end(zlib.gzipSync('zipped body')); }
      res.writeHead(404).end('nope');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('fetch shim: status, headers, json, post body, redirect, gzip', async (t) => {
  const srv = await server();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetchHttps(`${base}/json`, { method: 'POST', headers: { 'x-send': 'hi', 'content-type': 'text/plain' }, body: 'payload' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.headers.get('x-echo'), 'hi');
  assert.deepStrictEqual(await r.json(), { method: 'POST', body: 'payload' });
  const red = await fetchHttps(`${base}/redirect`);
  assert.strictEqual(red.status, 200);
  assert.strictEqual(red.redirected, true);
  const nf = await fetchHttps(`${base}/missing`);
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(await nf.text(), 'nope');
  const gz = await fetchHttps(`${base}/gzip`);
  assert.strictEqual(await gz.text(), 'zipped body');
});

test('fetch shim: streamed body via reader, abort', async (t) => {
  const srv = await server();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const s = await fetchHttps(`${base}/stream`);
  const reader = s.body.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString();
  }
  assert.strictEqual(text, 'data: 0\n\ndata: 1\n\ndata: 2\n\n');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(fetchHttps(`${base}/slow`, { signal: ac.signal }), (e) => e.name === 'AbortError');
});

test('fetch shim: installs only where WebAssembly is missing (or forced)', () => {
  const before = globalThis.fetch;
  const did = install();
  assert.strictEqual(did, typeof WebAssembly === 'undefined' || process.execArgv.includes('--jitless'));
  if (did) assert.strictEqual(globalThis.fetch, fetchHttps);
  else assert.strictEqual(globalThis.fetch, before);
});

// The shim's reason to exist: a process without WebAssembly. (Under `node --test` the runner's
// own unhandledRejection listener would flag undici's stray wasm rejection, so this runs the
// jitless check in a plain child process, the way a session worker runs.)
test('fetch shim: works in a jitless process', async (t) => {
  const srv = await server();
  t.after(() => srv.close());
  const child = path.join(__dirname, 'fixtures', 'fetch-child.js');
  const { stdout } = await util.promisify(execFile)(process.execPath, ['--jitless', child, `http://127.0.0.1:${srv.address().port}/json`], { timeout: 20000 });
  const out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  assert.deepStrictEqual(out, { wasm: 'undefined', status: 200, echo: 'hi', bytes: JSON.stringify({ method: 'POST', body: 'payload' }).length });
});
