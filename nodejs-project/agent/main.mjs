// Entry of the "Agent" tab: a line-oriented chat with the Messages API in the terminal,
// with the model's text streamed as it arrives and its tool calls shown as they run.
// Runs in a session worker like Claude Code does, so stdin/stdout are the tab's virtual
// TTY, child_process goes to the Linux layer and fetch is the jitless shim.
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Agent, MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT } = require('./loop.js');
const { listModels } = require('./api.js');

const out = process.stdout;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const cyan = (s) => `\u001b[36m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
const nl = (s) => s.replace(/\r?\n/g, '\r\n');

const env = process.env;
const apiKey = env.ANTHROPIC_API_KEY || '';
const baseURL = env.TERMFORGE_API_BASE || env.ANTHROPIC_BASE_URL || undefined;
const home = env.HOME;
const cwd = process.cwd();

if (!apiKey) {
  out.write(nl(`${red('No Anthropic API key.')}\nAdd one in Settings (saved in the Keychain) and restart this tab.\nThe agent bills your API account, not a Claude subscription.\n`));
  process.exit(2);
}

const state = {
  model: MODELS[env.TERMFORGE_AGENT_MODEL] ? env.TERMFORGE_AGENT_MODEL : (env.TERMFORGE_AGENT_MODEL || DEFAULT_MODEL),
  effort: EFFORTS.includes(env.TERMFORGE_AGENT_EFFORT) ? env.TERMFORGE_AGENT_EFFORT : DEFAULT_EFFORT,
};

let column = 0; // what the streamed text left the cursor at, for tidy line breaks
let inThinking = false;
let thinkingShown = false;

function write(s) {
  const text = nl(s);
  out.write(text);
  const lastNl = text.lastIndexOf('\n');
  column = lastNl < 0 ? column + text.length : text.length - lastNl - 1;
}

function endLine() {
  if (column !== 0) write('\n');
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0);
}

const ui = {
  text(t) {
    if (inThinking) {
      inThinking = false;
      endLine();
    }
    write(t);
  },
  blockStart(b) {
    if (b.type === 'thinking' && !thinkingShown) {
      thinkingShown = true;
      inThinking = true;
      write(dim('thinking…'));
    }
    if (b.type === 'tool_use') {
      inThinking = false;
      endLine();
    }
  },
  blockStop(b) {
    if (b.type === 'thinking' && inThinking) {
      inThinking = false;
      write('\r\u001b[2K');
      column = 0;
    }
  },
  toolStart(use) {
    endLine();
    const i = use.input || {};
    const summary = use.name === 'bash' ? `$ ${i.command}` : use.name === 'edit_file' ? `${i.path}` : use.name === 'list_dir' ? (i.path || '.') : (i.path || JSON.stringify(i));
    write(`${cyan('⚙ ' + use.name)} ${dim(summary.length > 200 ? summary.slice(0, 200) + '…' : summary)}\n`);
  },
  toolResult(use, result) {
    endLine();
    const text = result.text || '';
    const lines = text.split('\n');
    const preview = lines.slice(0, use.name === 'bash' ? 12 : 3).map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l));
    if (!result.ok) write(red(`  ✗ ${preview.join('\n    ')}`) + '\n');
    else if (use.name === 'read_file') write(dim(`  → ${text.length} chars`) + '\n');
    else {
      write(dim('  ' + preview.join('\n  ')) + '\n');
      if (lines.length > preview.length) write(dim(`  … ${lines.length - preview.length} more lines`) + '\n');
    }
  },
  turnDone({ model, usage, cost }) {
    endLine();
    const cached = usage.cache_read_input_tokens ? `, ${fmtTokens(usage.cache_read_input_tokens)} cached` : '';
    write(dim(`· ${model || state.model} · ${fmtTokens((usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0))} in${cached} · ${fmtTokens(usage.output_tokens)} out · ≈$${cost.toFixed(4)}`) + '\n');
  },
  retry(err, n, wait) {
    endLine();
    write(yellow(`${err.type || 'error'}${err.status ? ' ' + err.status : ''}: ${err.message} — retry ${n} in ${Math.round(wait / 1000)} s`) + '\n');
  },
  note(s) {
    endLine();
    write(dim(`· ${s}`) + '\n');
  },
  refusal(category, explanation) {
    endLine();
    write(yellow(`The model declined this request${category ? ` (${category})` : ''}.`) + (explanation ? ` ${explanation}` : '') + '\n');
  },
};

const agent = new Agent({ apiKey, baseURL, model: state.model, effort: state.effort, cwd, home, ui });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: `${bold('❯')} ` });
let inflight = null; // AbortController while a request runs

function help() {
  write(`${bold('TermForge agent')} — ${MODELS[state.model] ? MODELS[state.model].label : state.model}, effort ${state.effort}, in ${agent.guestCwd}\n`);
  write(dim('Type a request. Commands: /model [id]  /models  /effort low|medium|high|xhigh|max  /clear  /cost  /help  /exit   Ctrl-C stops a running request.') + '\n');
}

async function command(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help':
    case '?':
      help();
      return;
    case 'model':
      if (!arg) {
        write(`model: ${state.model}\n`);
        for (const [id, m] of Object.entries(MODELS)) write(`  ${id === state.model ? '●' : '○'} ${id.padEnd(20)} ${dim(`${m.label} · $${m.input}/$${m.output} per MTok`)}\n`);
        return;
      }
      state.model = arg;
      agent.model = arg;
      write(`model: ${arg}${MODELS[arg] ? '' : dim(' (not in the built-in list; prices unknown)')}\n`);
      return;
    case 'models':
      try {
        const models = await listModels({ apiKey, baseURL });
        for (const m of models) write(`  ${m.id.padEnd(28)} ${dim(m.display_name || '')}\n`);
      } catch (err) {
        write(red(`could not list models: ${err.message}`) + '\n');
      }
      return;
    case 'effort':
      if (!EFFORTS.includes(arg)) {
        write(`effort: ${state.effort} ${dim(`(${EFFORTS.join('|')})`)}\n`);
        return;
      }
      state.effort = arg;
      agent.effort = arg;
      write(`effort: ${arg}\n`);
      return;
    case 'clear':
      agent.clear();
      write(dim('· conversation cleared') + '\n');
      return;
    case 'cost': {
      const u = agent.usage;
      write(`${agent.requests.length} requests · ${fmtTokens((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0))} in (${fmtTokens(u.cache_read_input_tokens)} cached) · ${fmtTokens(u.output_tokens)} out · ≈$${agent.cost.toFixed(4)} this tab\n`);
      return;
    }
    case 'exit':
    case 'quit':
      rl.close();
      return;
    default:
      write(red(`unknown command /${cmd}`) + '\n');
  }
}

async function handle(line) {
  const text = line.trim();
  if (!text) return;
  if (text.startsWith('/')) return command(text);
  inflight = new AbortController();
  thinkingShown = false;
  inThinking = false;
  column = 0;
  try {
    await agent.ask(text, { signal: inflight.signal });
  } catch (err) {
    endLine();
    if (err.name === 'AbortError') write(yellow('· stopped') + '\n');
    else if (err.type === 'authentication_error') write(red(`Authentication failed: ${err.message}\nCheck the API key in Settings.`) + '\n');
    else if (err.type === 'billing_error') write(red(`Billing: ${err.message}`) + '\n');
    else write(red(`${err.type || err.name || 'error'}${err.status ? ' ' + err.status : ''}: ${err.message}`) + (err.requestId ? dim(` (${err.requestId})`) : '') + '\n');
  } finally {
    inflight = null;
    endLine();
  }
}

let busy = false;
const queue = [];
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const line = queue.shift();
    rl.pause();
    await handle(line);
    rl.resume();
  }
  busy = false;
  rl.prompt();
}

rl.on('line', (line) => {
  queue.push(line);
  drain();
});
rl.on('SIGINT', () => {
  if (inflight) inflight.abort();
  else {
    write('\n');
    rl.prompt();
  }
});
rl.on('close', () => {
  write('\n');
  process.exit(0);
});

help();
rl.prompt();
