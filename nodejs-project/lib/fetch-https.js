'use strict';
// A `fetch` for jitless V8. Node 18's built-in fetch (undici) parses HTTP with a
// WebAssembly module, and V8 without JIT has no WebAssembly: every fetch() fails with
// "fetch failed". This implementation uses Node's http/https client (C++ llhttp) and
// returns the runtime's own Response/Headers objects, so callers see standard fetch
// semantics: streaming bodies, redirects, AbortSignal, json()/text()/body reader.

const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const zlib = require('zlib');

const MAX_REDIRECTS = 10;
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
};

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  const headers = h instanceof Headers ? h : new Headers(h);
  for (const [k, v] of headers) out[k] = v;
  return out;
}

async function bodyToBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer()); // Blob
  if (typeof body.getReader === 'function') {
    const chunks = [];
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body), 'utf8');
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

function decodeBody(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

function fetchHttps(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  const method = (init.method || (request && request.method) || 'GET').toUpperCase();
  const headers = headersToObject(init.headers || (request && request.headers));
  const signal = init.signal || (request && request.signal) || null;
  const redirect = init.redirect || (request && request.redirect) || 'follow';
  const bodySource = init.body !== undefined ? init.body : request && request.body;

  return new Promise(async (resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal));
    let body;
    try {
      body = await bodyToBuffer(bodySource);
    } catch (err) {
      return reject(err);
    }
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['content-length'] = String(body.length);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) headers['accept-encoding'] = 'gzip, deflate';

    const go = (target, hops) => {
      const mod = target.protocol === 'https:' ? https : http;
      const req = mod.request(target, { method, headers, agent: agents[target.protocol] }, (res) => {
        const status = res.statusCode || 0;
        if (redirect === 'follow' && [301, 302, 303, 307, 308].includes(status) && res.headers.location && hops < MAX_REDIRECTS) {
          res.resume();
          const next = new URL(res.headers.location, target);
          if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
            // the redirected request is a GET without a body
            return go2(next, hops + 1, 'GET', null);
          }
          return go(next, hops + 1);
        }
        if (redirect === 'error' && [301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          return reject(new TypeError('fetch failed: redirect'));
        }
        const stream = decodeBody(res);
        const onAbort = () => {
          req.destroy(abortError(signal));
          stream.destroy(abortError(signal));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        stream.once('close', () => signal && signal.removeEventListener('abort', onAbort));
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'content-encoding' || k === 'content-length') continue;
          if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
          else if (v !== undefined) responseHeaders.set(k, v);
        }
        const webBody = status === 204 || status === 304 || method === 'HEAD' ? null : Readable.toWeb(stream);
        const response = new Response(webBody, { status, statusText: res.statusMessage || '', headers: responseHeaders });
        Object.defineProperty(response, 'url', { value: target.href, configurable: true });
        Object.defineProperty(response, 'redirected', { value: hops > 0, configurable: true });
        resolve(response);
      });
      req.on('error', (err) => {
        if (signal && signal.aborted) return reject(abortError(signal));
        const wrapped = new TypeError('fetch failed');
        wrapped.cause = err;
        reject(wrapped);
      });
      if (signal) {
        const onAbort = () => req.destroy(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      if (body) req.write(body);
      req.end();
    };
    // redirect that changes the method
    const go2 = (target, hops, newMethod, newBody) => {
      const mod = target.protocol === 'https:' ? https : http;
      const h = { ...headers };
      delete h['content-length'];
      delete h['content-type'];
      const req = mod.request(target, { method: newMethod, headers: h, agent: agents[target.protocol] }, (res) => {
        const stream = decodeBody(res);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'content-encoding' || k === 'content-length') continue;
          if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
          else if (v !== undefined) responseHeaders.set(k, v);
        }
        const response = new Response(Readable.toWeb(stream), { status: res.statusCode || 0, statusText: res.statusMessage || '', headers: responseHeaders });
        Object.defineProperty(response, 'url', { value: target.href, configurable: true });
        Object.defineProperty(response, 'redirected', { value: true, configurable: true });
        resolve(response);
      });
      req.on('error', (err) => {
        const wrapped = new TypeError('fetch failed');
        wrapped.cause = err;
        reject(wrapped);
      });
      if (newBody) req.write(newBody);
      req.end();
    };
    go(url, 0);
  });
}

// Loading undici's Response/Headers classes also loads its HTTP client, whose module
// body starts `WebAssembly.compile(...)` and leaves a rejected promise behind under
// jitless V8. Nothing ever awaits it; swallow exactly that one and keep Node's default
// (raise as an uncaught exception) for everything else.
function isUndiciWasmRejection(reason) {
  return reason instanceof ReferenceError && /WebAssembly is not defined/.test(reason.message)
    && /undici/.test(reason.stack || '');
}

const JITLESS = typeof WebAssembly === 'undefined' || process.execArgv.includes('--jitless');

let hooked = false;
function hookRejections() {
  if (hooked) return;
  hooked = true;
  process.on('unhandledRejection', (reason) => {
    if (isUndiciWasmRejection(reason)) return;
    throw reason;
  });
}
// The classes this file uses trigger that rejection, so hook as soon as it is loaded.
if (JITLESS) hookRejections();

// Replace the global fetch only where the built-in one cannot work.
function install({ force = false } = {}) {
  if (!JITLESS && !force) return false;
  hookRejections();
  Object.defineProperty(globalThis, 'fetch', { value: fetchHttps, writable: true, configurable: true, enumerable: true });
  return true;
}

module.exports = { fetch: fetchHttps, install };
