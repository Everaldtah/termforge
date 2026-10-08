'use strict';
// Anthropic Messages API client for the agent tab: raw HTTP over the runtime's fetch
// (the jitless shim on the device) with server-sent-event streaming. No SDK: nothing can
// be npm-installed on the device at runtime, and the official SDK pulls in packages of
// its own, so the ~200 lines the agent needs live here instead.

const API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);

class APIError extends Error {
  constructor({ status, type, message, retryAfterMs, requestId }) {
    super(message || `API error ${status || ''}`.trim());
    this.name = 'APIError';
    this.status = status || 0;
    this.type = type || 'api_error';
    this.retryAfterMs = retryAfterMs || null;
    this.requestId = requestId || null;
  }

  get retryable() {
    return RETRYABLE_STATUS.has(this.status) || this.type === 'overloaded_error' || this.type === 'rate_limit_error';
  }
}

// Server-sent events: feed text chunks, get {event, data} records back.
class SSEParser {
  constructor() {
    this.buffer = '';
  }

  push(text) {
    this.buffer += text;
    const out = [];
    let idx;
    while ((idx = this.buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const rec = { event: 'message', data: '' };
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') rec.event = value;
        else if (field === 'data') dataLines.push(value);
      }
      rec.data = dataLines.join('\n');
      if (rec.data) out.push(rec);
    }
    return out;
  }
}

function retryAfterMs(headers) {
  const v = headers && headers.get && headers.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function abortError() {
  const err = new Error('request aborted');
  err.name = 'AbortError';
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Builds the final message from stream events; `on` receives UI-level progress.
class MessageAssembler {
  constructor(on = {}) {
    this.on = on;
    this.message = null;
    this.blocks = [];
    this.done = false;
  }

  event(type, e) {
    switch (type) {
      case 'message_start':
        this.message = { ...e.message, content: [] };
        break;
      case 'content_block_start': {
        const block = { ...e.content_block };
        if (block.type === 'tool_use') block.partialJson = '';
        if (block.type === 'text' && block.text === undefined) block.text = '';
        if (block.type === 'thinking' && block.thinking === undefined) block.thinking = '';
        this.blocks[e.index] = block;
        if (this.on.blockStart) this.on.blockStart(block, e.index);
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks[e.index];
        if (!block) break;
        const d = e.delta || {};
        if (d.type === 'text_delta') {
          block.text += d.text;
          if (this.on.text) this.on.text(d.text, e.index);
        } else if (d.type === 'thinking_delta') {
          block.thinking += d.thinking;
          if (this.on.thinking) this.on.thinking(d.thinking, e.index);
        } else if (d.type === 'signature_delta') {
          block.signature = (block.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta') {
          block.partialJson += d.partial_json;
          if (this.on.toolInput) this.on.toolInput(d.partial_json, block);
        } else if (d.type === 'citations_delta') {
          (block.citations = block.citations || []).push(d.citation);
        }
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks[e.index];
        if (!block) break;
        if (block.type === 'tool_use') {
          // eager input streaming hands over raw fragments: parse strictly, never trust a partial parse
          const raw = block.partialJson;
          delete block.partialJson;
          try {
            block.input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            block.input = {};
            block.inputError = raw;
          }
        }
        if (this.on.blockStop) this.on.blockStop(block, e.index);
        break;
      }
      case 'message_delta':
        if (this.message) {
          Object.assign(this.message, e.delta || {});
          if (e.usage) this.message.usage = { ...(this.message.usage || {}), ...e.usage };
        }
        break;
      case 'message_stop':
        this.done = true;
        break;
      default:
        break;
    }
  }

  result() {
    if (!this.message) throw new APIError({ status: 0, type: 'api_error', message: 'stream ended before message_start' });
    this.message.content = this.blocks.filter(Boolean);
    return this.message;
  }
}

async function readError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {}
  const err = (body && body.error) || {};
  return new APIError({
    status: res.status,
    type: err.type || (res.status === 401 ? 'authentication_error' : 'api_error'),
    message: err.message || `HTTP ${res.status}`,
    retryAfterMs: retryAfterMs(res.headers),
    requestId: res.headers && res.headers.get ? res.headers.get('request-id') : null,
  });
}

/**
 * One streamed POST /v1/messages. Resolves with the complete message (content blocks,
 * stop_reason, usage, model). Retries transport failures and retryable statuses until
 * the first content block has started; after that an error is the caller's to see.
 */
async function streamMessage({ apiKey, baseURL = DEFAULT_BASE_URL, body, betas = [], signal, on = {}, maxRetries = 3, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new APIError({ status: 401, type: 'authentication_error', message: 'no API key' });
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'user-agent': 'TermForge-agent',
  };
  if (betas.length) headers['anthropic-beta'] = betas.join(',');
  const payload = JSON.stringify({ ...body, stream: true });

  for (let attempt = 0; ; attempt++) {
    const assembler = new MessageAssembler(on);
    let started = false;
    try {
      const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body: payload, signal });
      if (!res.ok) throw await readError(res);
      if (on.response) on.response(res);
      const parser = new SSEParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const rec of parser.push(decoder.decode(value, { stream: true }))) {
          let e;
          try {
            e = JSON.parse(rec.data);
          } catch {
            continue;
          }
          const type = e.type || rec.event;
          if (type === 'error') {
            const err = e.error || {};
            throw new APIError({ status: err.type === 'overloaded_error' ? 529 : 0, type: err.type, message: err.message, requestId: e.request_id });
          }
          if (type === 'ping') continue;
          if (type === 'content_block_start') started = true;
          assembler.event(type, e);
        }
        if (assembler.done) break;
      }
      return assembler.result();
    } catch (err) {
      if (signal && signal.aborted) throw abortError();
      if (err.name === 'AbortError') throw err;
      const api = err instanceof APIError ? err : new APIError({ status: 0, type: 'connection_error', message: `connection failed: ${err.message}` });
      const retryable = api.retryable || api.type === 'connection_error';
      if (!retryable || started || attempt >= maxRetries) throw api;
      const wait = api.retryAfterMs != null ? Math.min(api.retryAfterMs, 30000) : Math.min(1000 * 2 ** attempt, 8000);
      if (on.retry) on.retry(api, attempt + 1, wait);
      await sleep(wait, signal);
    }
  }
}

async function listModels({ apiKey, baseURL = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/v1/models?limit=100`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'user-agent': 'TermForge-agent' },
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  return json.data || [];
}

module.exports = { APIError, SSEParser, MessageAssembler, streamMessage, listModels, DEFAULT_BASE_URL, API_VERSION };
