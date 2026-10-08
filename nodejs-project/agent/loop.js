'use strict';
// The agent loop: one conversation on the Messages API with client-side tools.
// Append-only history (assistant content goes back unchanged, thinking blocks included),
// all of a turn's tool results in a single user message, a stable cached prefix
// (tools, then the system prompt) and the volatile part after it.

const { streamMessage, APIError } = require('./api');
const { createTools } = require('./tools');
const { toGuestPath } = require('../lib/linux-tier');

// Model table: prices are USD per million tokens (Anthropic first-party API, 2026-10).
// `fallbacks`: the server re-runs a safety-classifier decline on a substitute model.
const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, fallbacks: true, default: true },
  'claude-fable-5-1': { label: 'Claude Fable 5.1', input: 10, output: 50, cacheRead: 0.25, fallbacks: true },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2, fallbacks: true },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-opus-5': { label: 'Claude Opus 5', input: 5, output: 25, cacheRead: 0.5, fallbacks: true },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', input: 2, output: 10, cacheRead: 0.2 },
};
const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'high';
const MAX_TOKENS = 64000;
const MAX_TOOL_TURNS = 50;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function systemPrompt({ guestCwd }) {
  return [
    'You are the TermForge agent: a coding assistant running inside TermForge, an iOS terminal app, talking to a user on a phone or tablet.',
    `The project folder is ${guestCwd}. It lives in the app's Documents folder, which the Linux layer mounts at /mnt/termforge; read_file, write_file, edit_file and list_dir take host-relative or /mnt/termforge paths, and the bash tool runs inside that Linux layer (Alpine Linux x86 under the iSH emulator, so no JIT and modest speed; apk add installs packages).`,
    'Use the tools to look before you answer, make changes with edit_file when the change is local and write_file for new files, and verify with bash when a check is cheap. Several independent tool calls can go in one turn.',
    'The screen is narrow: keep replies short, prefer plain sentences over headings and tables, and show code only when it is the answer.',
  ].join('\n\n');
}

function estimateCost(model, usage) {
  const price = MODELS[model] || { input: 5, output: 25, cacheRead: 0.5 };
  const input = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  return (input * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.cacheRead + output * price.output) / 1e6;
}

function addUsage(total, usage) {
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[k] = (total[k] || 0) + (usage[k] || 0);
  }
  return total;
}

// Strip client-only fields before a block goes back to the API.
function replayable(block) {
  const { partialJson, inputError, ...rest } = block;
  return rest;
}

class Agent {
  constructor({ apiKey, baseURL, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, cwd, home, ui = {}, fetchImpl, spawn }) {
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
    this.effort = effort;
    this.cwd = cwd;
    this.home = home;
    this.guestCwd = toGuestPath(cwd, home);
    this.ui = ui;
    this.fetchImpl = fetchImpl;
    this.tools = createTools({ cwd, home, spawn });
    this.messages = [];
    this.usage = {};
    this.cost = 0;
    this.requests = [];
  }

  clear() {
    this.messages = [];
  }

  body() {
    const b = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt({ guestCwd: this.guestCwd }), cache_control: { type: 'ephemeral' } }],
      tools: this.tools.definitions,
      messages: this.messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      cache_control: { type: 'ephemeral' },
    };
    const betas = [];
    if ((MODELS[this.model] || {}).fallbacks) {
      b.fallbacks = 'default';
      betas.push(FALLBACK_BETA);
    }
    return { body: b, betas };
  }

  /** One user turn: streams the reply and runs tools until the model stops. */
  async ask(text, { signal } = {}) {
    const ui = this.ui;
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const { body, betas } = this.body();
      let message;
      try {
        message = await streamMessage({
          apiKey: this.apiKey, baseURL: this.baseURL, body, betas, signal, fetchImpl: this.fetchImpl,
          on: {
            text: (t) => ui.text && ui.text(t),
            blockStart: (b) => ui.blockStart && ui.blockStart(b),
            blockStop: (b) => ui.blockStop && ui.blockStop(b),
            retry: (err, n, wait) => ui.retry && ui.retry(err, n, wait),
          },
        });
      } catch (err) {
        // the user message stays so a retry of the same question continues the thread
        if (err.name === 'AbortError') {
          this.messages.pop();
          throw err;
        }
        if (turn === 0 || this.messages[this.messages.length - 1].role === 'user') {
          // never leave a dangling user message or orphaned tool results
          this.messages.pop();
          if (this.messages.length && this.messages[this.messages.length - 1].role === 'assistant') this.messages.pop();
        }
        throw err;
      }
      this.messages.push({ role: 'assistant', content: message.content.map(replayable) });
      const usage = message.usage || {};
      addUsage(this.usage, usage);
      const cost = estimateCost(message.model || this.model, usage);
      this.cost += cost;
      this.requests.push({ model: message.model, usage, cost, stop: message.stop_reason });
      if (ui.turnDone) ui.turnDone({ model: message.model, usage, cost, stop: message.stop_reason });
      for (const block of message.content) {
        if (block.type === 'fallback' && ui.note) ui.note(`${block.from && block.from.model} declined this turn; ${block.to && block.to.model} continued`);
      }

      if (message.stop_reason === 'refusal') {
        const d = message.stop_details || {};
        if (ui.refusal) ui.refusal(d.category || null, d.explanation || null);
        return message;
      }
      const uses = message.content.filter((b) => b.type === 'tool_use');
      if (message.stop_reason === 'max_tokens') {
        if (ui.note) ui.note('the reply hit the output limit' + (uses.length ? '; its tool calls were not run' : ''));
        if (uses.length) {
          this.messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'not run: the response was cut off at max_tokens' })) });
        }
        return message;
      }
      if (!uses.length || message.stop_reason !== 'tool_use') return message;

      const results = await Promise.all(uses.map(async (use) => {
        if (use.inputError !== undefined) {
          if (ui.toolResult) ui.toolResult(use, { ok: false, text: 'invalid JSON input' });
          return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ INVALID_JSON: use.inputError }) };
        }
        if (ui.toolStart) ui.toolStart(use);
        const result = await this.tools.run(use.name, use.input, { signal });
        if (ui.toolResult) ui.toolResult(use, result);
        return { type: 'tool_result', tool_use_id: use.id, is_error: !result.ok, content: result.text };
      }));
      this.messages.push({ role: 'user', content: results });
      if (signal && signal.aborted) {
        const err = new Error('request aborted');
        err.name = 'AbortError';
        throw err;
      }
    }
    if (ui.note) ui.note(`stopped after ${MAX_TOOL_TURNS} tool turns`);
    return null;
  }
}

module.exports = { Agent, MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT, estimateCost, systemPrompt, APIError };
