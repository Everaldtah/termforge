'use strict';
// The agent's client-side tools. Files live in the app's Documents folder (Node sees host
// paths; the Linux layer sees the same files under /mnt/termforge). `bash` goes through the
// session's child_process shim, so it runs inside the Alpine root like Claude Code's tools.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { toHostPath, toGuestPath, GUEST_HOME } = require('../lib/linux-tier');

const MAX_READ_BYTES = 200 * 1024;
const MAX_TOOL_OUTPUT = 64 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 120000;
const MAX_LIST_ENTRIES = 500;

const DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a text file from the project. Paths are relative to the working directory, or absolute (host or /mnt/termforge form). Large files are cut at 200 KB; use offset/limit (line numbers, 1-based) to page.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'integer', description: 'First line to return (1-based)' },
        limit: { type: 'integer', description: 'Maximum number of lines' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file with the given contents, creating parent folders as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must occur exactly once unless replace_all is true. Include enough surrounding lines to make it unique.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        old_string: { type: 'string', description: 'Exact text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_dir',
    description: 'List a folder (names only; folders end with /). Defaults to the working directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command inside the Linux layer (Alpine Linux x86 under the iSH emulator; apk, git, python3, ripgrep are typical). The working directory is the project folder, mounted at /mnt/termforge/... Output is capped at 64 KB. Commands time out after 120 s by default.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, run with bash -c' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (max 600000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

// Enough JSON-schema checking for our own flat tool schemas (eager input streaming
// disables the server's validation, so the client owns it).
function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const key of schema.required || []) if (!(key in input)) return `missing required field "${key}"`;
  for (const [key, value] of Object.entries(input)) {
    const prop = (schema.properties || {})[key];
    if (!prop) return `unknown field "${key}"`;
    const t = prop.type;
    const ok = t === 'string' ? typeof value === 'string'
      : t === 'integer' ? Number.isInteger(value)
        : t === 'number' ? typeof value === 'number'
          : t === 'boolean' ? typeof value === 'boolean'
            : true;
    if (!ok) return `field "${key}" must be a ${t}`;
  }
  return null;
}

function truncate(text, max = MAX_TOOL_OUTPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`;
}

function createTools({ cwd, home, spawn = childProcess.spawn }) {
  const hostHome = path.resolve(home);
  const hostCwd = path.resolve(cwd);

  function resolvePath(p) {
    if (typeof p !== 'string' || !p) throw new Error('path is required');
    let host = p === GUEST_HOME || p.startsWith(`${GUEST_HOME}/`) ? toHostPath(p, hostHome) : p;
    host = path.isAbsolute(host) ? path.resolve(host) : path.resolve(hostCwd, host);
    const rel = path.relative(hostHome, host);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`${p} is outside the app's Documents folder (${GUEST_HOME}); the agent can only touch files there`);
    }
    return host;
  }

  const impl = {
    async read_file({ path: p, offset, limit }) {
      const file = resolvePath(p);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) throw new Error(`${p} is a directory; use list_dir`);
      let text = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' });
      let note = '';
      if (offset || limit) {
        const lines = text.split('\n');
        const start = Math.max(1, offset || 1) - 1;
        const end = limit ? start + limit : lines.length;
        text = lines.slice(start, end).join('\n');
        note = `\n[lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]`;
      }
      if (text.length > MAX_READ_BYTES) {
        text = `${text.slice(0, MAX_READ_BYTES)}\n… [truncated at 200 KB; use offset/limit]`;
      }
      return text + note;
    },

    async write_file({ path: p, content }) {
      const file = resolvePath(p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${toGuestPath(file, hostHome)}`;
    },

    async edit_file({ path: p, old_string: oldStr, new_string: newStr, replace_all: all }) {
      const file = resolvePath(p);
      const text = fs.readFileSync(file, 'utf8');
      if (!oldStr) throw new Error('old_string must not be empty');
      const count = text.split(oldStr).length - 1;
      if (count === 0) throw new Error('old_string not found in the file');
      if (count > 1 && !all) throw new Error(`old_string occurs ${count} times; add context to make it unique or set replace_all`);
      const out = all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
      fs.writeFileSync(file, out, 'utf8');
      return `replaced ${all ? count : 1} occurrence${all && count !== 1 ? 's' : ''} in ${toGuestPath(file, hostHome)}`;
    },

    async list_dir({ path: p }) {
      const dir = resolvePath(p || '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => a.localeCompare(b));
      const shown = entries.slice(0, MAX_LIST_ENTRIES);
      const more = entries.length > shown.length ? `\n… ${entries.length - shown.length} more` : '';
      return `${toGuestPath(dir, hostHome)}:\n${shown.join('\n')}${more}`;
    },

    bash({ command, timeout_ms: timeoutMs }, { signal } = {}) {
      const timeout = Math.min(Math.max(1000, timeoutMs || DEFAULT_BASH_TIMEOUT_MS), 600000);
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn('bash', ['-c', command], { cwd: hostCwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          return reject(err);
        }
        let out = '';
        let timedOut = false;
        const append = (chunk) => {
          if (out.length < MAX_TOOL_OUTPUT * 2) out += chunk.toString('utf8');
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeout);
        const onAbort = () => child.kill('SIGKILL');
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => {
          clearTimeout(timer);
          if (err.code === 'ENOENT') reject(new Error('the Linux layer is not running: open a Linux tab and install Alpine, then try again'));
          else reject(err);
        });
        child.on('close', (code, sig) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          let tail = '';
          if (timedOut) tail = `\n[killed after ${timeout} ms]`;
          else if (sig) tail = `\n[terminated by ${sig}]`;
          else if (code !== 0) tail = `\n[exit code ${code}]`;
          resolve(truncate(out) + tail);
        });
      });
    },
  };

  const byName = new Map(DEFINITIONS.map((d) => [d.name, d]));

  async function run(name, input, opts = {}) {
    const def = byName.get(name);
    if (!def) return { ok: false, text: `unknown tool "${name}"` };
    const invalid = validateInput(def.input_schema, input);
    if (invalid) return { ok: false, text: `invalid input: ${invalid}` };
    try {
      const text = await impl[name](input, opts);
      return { ok: true, text: text === '' ? '(no output)' : text };
    } catch (err) {
      return { ok: false, text: err && err.message ? err.message : String(err) };
    }
  }

  return { definitions: DEFINITIONS, run, resolvePath };
}

module.exports = { createTools, validateInput, DEFINITIONS };
