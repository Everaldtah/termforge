'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Host } = require('./host-client');
const { SSEParser, MessageAssembler } = require('../nodejs-project/agent/api');
const { validateInput, createTools } = require('../nodejs-project/agent/tools');

// ---- a scripted Messages API: each entry answers one POST /v1/messages
function mockAPI() {
  const requests = [];
  const script = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' }] }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ headers: req.headers, body });
      const step = script.shift();
      if (!step) return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unscripted request' } }));
      step(res, body);
    });
  });
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // split one event across two writes to exercise the parser's buffering
    for (const e of events) {
      const line = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      res.write(line.slice(0, 7));
      res.write(line.slice(7));
    }
    res.end();
  };
  const reply = (blocks, { stop = 'end_turn', usage = {}, model = 'claude-opus-5-5', stopDetails } = {}) => (res) => {
    const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 100, cache_read_input_tokens: 0, ...usage } } }];
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        for (const piece of b.text.match(/.{1,5}/gs) || []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
      } else if (b.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        const json = b.raw !== undefined ? b.raw : JSON.stringify(b.input);
        for (const piece of json.match(/.{1,9}/gs) || []) events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
      }
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 42 } });
    events.push({ type: 'message_stop' });
    sse(res, events);
  };
  const error = (status, type, message, headers = {}) => (res) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ type: 'error', error: { type, message } }));
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}`, requests, script, reply, error })));
}

test('agent: SSE parser and message assembly', () => {
  const p = new SSEParser();
  assert.deepStrictEqual(p.push('event: ping\ndata: {"type":"pi'), []);
  assert.deepStrictEqual(p.push('ng"}\n\n: comment\r\n\r\ndata: a\ndata: b\n\n'), [{ event: 'ping', data: '{"type":"ping"}' }, { event: 'message', data: 'a\nb' }]);
  const a = new MessageAssembler();
  a.event('message_start', { message: { id: 'm', model: 'x', usage: { input_tokens: 1 } } });
  a.event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } });
  a.event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "ec' } });
  a.event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'ho hi"}' } });
  a.event('content_block_stop', { index: 0 });
  a.event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't2', name: 'bash', input: {} } });
  a.event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command": "trunc' } });
  a.event('content_block_stop', { index: 1 });
  a.event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  a.event('message_stop', {});
  const m = a.result();
  assert.deepStrictEqual(m.content[0].input, { command: 'echo hi' });
  assert.strictEqual(m.content[0].partialJson, undefined);
  assert.strictEqual(m.content[1].inputError, '{"command": "trunc');
  assert.deepStrictEqual(m.usage, { input_tokens: 1, output_tokens: 7 });
  assert.strictEqual(m.stop_reason, 'tool_use');
});

test('agent: tool input validation and path confinement', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] };
  assert.strictEqual(validateInput(schema, { path: 'a' }), null);
  assert.match(validateInput(schema, {}), /missing required field "path"/);
  assert.match(validateInput(schema, { path: 'a', limit: '3' }), /must be a integer/);
  assert.match(validateInput(schema, { path: 'a', nope: 1 }), /unknown field/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-agent-home-'));
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd);
  const tools = createTools({ cwd, home });
  assert.strictEqual(tools.resolvePath('a.txt'), path.join(cwd, 'a.txt'));
  assert.strictEqual(tools.resolvePath('/mnt/termforge/proj/b.txt'), path.join(cwd, 'b.txt'));
  assert.throws(() => tools.resolvePath('../../outside'), /outside the app's Documents folder/);
  assert.throws(() => tools.resolvePath(os.tmpdir()), /outside/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agent session: streams, runs tools in one turn, replays history, caches, retries', async (t) => {
  const api = await mockAPI();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-agent-data-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-agent-'));
  const project = path.join(home, 'Projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const host = await Host.start({ dataDir, linux: true, env: { HOME: home, USERPROFILE: home } });
  t.after(async () => {
    await host.stop();
    api.srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  // turn 1: a text block, then two tool calls (one of them written through the Linux tier)
  api.script.push(api.reply([
    { type: 'thinking', signature: 'sig1' },
    { type: 'text', text: 'Let me set that up.' },
    { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'notes.md', content: '# notes\n\nhello "world"\n' } },
    { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'echo from-bash > hello.txt && cat hello.txt' } },
  ], { stop: 'tool_use' }));
  // turn 2: the API is overloaded once, then answers
  api.script.push(api.error(529, 'overloaded_error', 'Overloaded', { 'retry-after': '0' }));
  api.script.push(api.reply([{ type: 'text', text: 'Both files are in place. Done.' }], { usage: { cache_read_input_tokens: 1200 } }));

  host.open(1, { kind: 'agent', cols: 100, rows: 30, cwd: project, env: { ANTHROPIC_API_KEY: 'sk-ant-test', TERMFORGE_API_BASE: api.base, TERMFORGE_AGENT_MODEL: 'claude-opus-5-5', TERMFORGE_AGENT_EFFORT: 'high' } });
  await host.waitFor(1, (s) => s.includes('❯'), 20000);
  host.write(1, 'create notes and a hello file\r');
  await host.waitFor(1, (s) => s.includes('Done.') && s.includes('≈$'), 30000);
  const screen = host.text(1);
  assert.ok(screen.includes('Let me set that up.'), screen);
  assert.ok(screen.includes('⚙ write_file'), screen);
  assert.ok(screen.includes('⚙ bash'), screen);
  assert.ok(/overloaded_error 529: Overloaded — retry 1/.test(screen), screen);
  assert.ok(screen.includes('1.2k cached'), screen);

  assert.strictEqual(fs.readFileSync(path.join(project, 'notes.md'), 'utf8'), '# notes\n\nhello "world"\n');
  assert.strictEqual(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8').trim(), 'from-bash');
  assert.ok(host.execLog.some((r) => r.argv.join(' ').includes('echo from-bash')), 'bash went through the Linux tier');

  assert.strictEqual(api.requests.length, 3);
  const first = api.requests[0];
  assert.strictEqual(first.headers['x-api-key'], 'sk-ant-test');
  assert.strictEqual(first.headers['anthropic-version'], '2023-06-01');
  assert.ok(first.headers['anthropic-beta'].includes('server-side-fallback-2026-07-01'));
  assert.strictEqual(first.body.model, 'claude-opus-5-5');
  assert.strictEqual(first.body.stream, true);
  assert.strictEqual(first.body.max_tokens, 64000);
  assert.deepStrictEqual(first.body.thinking, { type: 'adaptive' });
  assert.deepStrictEqual(first.body.output_config, { effort: 'high' });
  assert.strictEqual(first.body.fallbacks, 'default');
  assert.deepStrictEqual(first.body.cache_control, { type: 'ephemeral' });
  assert.deepStrictEqual(first.body.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(first.body.system[0].text.includes('/mnt/termforge/Projects/demo'));
  assert.deepStrictEqual(first.body.tools.map((x) => x.name), ['read_file', 'write_file', 'edit_file', 'list_dir', 'bash']);
  assert.ok(first.body.tools.every((x) => x.eager_input_streaming === true));
  assert.deepStrictEqual(first.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'create notes and a hello file' }] }]);
  assert.strictEqual(first.body.tool_choice, undefined);

  // the second request replays the assistant turn unchanged (thinking signature included)
  // and answers both tool calls in one user message; the retry sends the same body again
  const second = api.requests[1].body;
  assert.deepStrictEqual(api.requests[2].body, second);
  assert.strictEqual(second.messages.length, 3);
  assert.deepStrictEqual(second.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig1' });
  assert.deepStrictEqual(second.messages[1].content[1], { type: 'text', text: 'Let me set that up.' });
  assert.deepStrictEqual(second.messages[1].content[2], { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'notes.md', content: '# notes\n\nhello "world"\n' } });
  const results = second.messages[2];
  assert.strictEqual(results.role, 'user');
  assert.deepStrictEqual(results.content.map((r) => [r.type, r.tool_use_id, r.is_error]), [['tool_result', 'toolu_1', false], ['tool_result', 'toolu_2', false]]);
  assert.match(results.content[0].content, /wrote 23 bytes to \/mnt\/termforge\/Projects\/demo\/notes\.md/);
  assert.strictEqual(results.content[1].content.trim(), 'from-bash');

  // invalid tool JSON (eager streaming cut off) becomes an INVALID_JSON error result; a refusal is reported
  api.script.push(api.reply([{ type: 'tool_use', id: 'toolu_3', name: 'bash', raw: '{"command": "ls' }], { stop: 'tool_use' }));
  api.script.push(api.reply([{ type: 'text', text: 'Sorry.' }], { stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: 'policy' } }));
  host.write(1, '/clear\r');
  host.write(1, 'list files\r');
  await host.waitFor(1, (s) => s.includes('declined this request (cyber)'), 30000);
  const fourth = api.requests[4].body;
  assert.strictEqual(fourth.messages.length, 3, 'cleared history starts over');
  assert.deepStrictEqual(fourth.messages[2].content, [{ type: 'tool_result', tool_use_id: 'toolu_3', is_error: true, content: JSON.stringify({ INVALID_JSON: '{"command": "ls' }) }]);
  assert.ok(host.execLog.filter((r) => r.argv.join(' ').includes('"ls')).length === 0, 'the broken call was not run');

  // slash commands
  host.write(1, '/models\r');
  await host.waitFor(1, (s) => s.includes('claude-fable-5-1') && s.includes('Claude Fable 5.1'), 10000);
  host.write(1, '/model claude-fable-5-1\r');
  host.write(1, '/cost\r');
  await host.waitFor(1, (s) => /4 requests/.test(s), 10000);
  host.write(1, '/exit\r');
  assert.strictEqual((await host.waitExit(1)).code, 0);
});

test('agent session: no API key exits with instructions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-agent-nokey-'));
  const host = await Host.start({ dataDir });
  t.after(async () => {
    await host.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  host.open(1, { kind: 'agent', cwd: dataDir, env: { ANTHROPIC_API_KEY: '' } });
  const exit = await host.waitExit(1, 20000);
  assert.strictEqual(exit.code, 2);
  assert.ok(host.text(1).includes('No Anthropic API key'));
});
