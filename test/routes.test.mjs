import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApiHandler, createOperations } from '../lib/routes.js';
import { createTool } from '../lib/tool.js';
import { ServiceError } from '../lib/service.js';

function fakeRes() {
  const res = {
    status: undefined,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text = '') {
      this.body = text;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

function fakeReq({ method = 'POST', body, contentType = 'application/json', headers = {} } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  stream.method = method;
  stream.headers = { 'content-type': contentType, ...headers };
  return stream;
}

function fakeService(overrides = {}) {
  return {
    ServiceError,
    getState: async () => ({ global: [] }),
    getProjectState: async (root) => ({ root }),
    diagnose: async () => ({ mcpClient: { available: true } }),
    saveGlobal: async (server) => ({ saved: server }),
    summary: async (root) => ({ root: root ?? null }),
    ...overrides,
  };
}

async function call(handlerOptions, reqOptions) {
  const handler = createApiHandler({ fence: () => true, service: fakeService(), ...handlerOptions });
  const res = fakeRes();
  await handler(fakeReq(reqOptions), res);
  return res;
}

test('requests that fail the host admission check are refused before anything is read', async () => {
  let read = false;
  const res = await call({ fence: () => false, service: fakeService({ getState: async () => { read = true; } }) }, { body: { op: 'state' } });
  assert.equal(res.status, 403);
  assert.equal(read, false);
});

test('only POST with a JSON content type is accepted', async () => {
  assert.equal((await call({}, { method: 'GET' })).status, 405);
  assert.equal((await call({}, { body: { op: 'state' }, contentType: 'text/plain' })).status, 415);
  assert.equal((await call({}, { body: { op: 'state' }, contentType: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call({}, { body: { op: 'state' }, contentType: 'application/json; charset=utf-8' })).status, 200);
});

test('malformed, oversized and incomplete bodies are rejected with a code', async () => {
  assert.equal((await call({}, { body: '{nope' })).json().error.code, 'bad-json');
  assert.equal((await call({}, { body: { x: 1 } })).json().error.code, 'bad-request');
  const big = await call({}, { body: JSON.stringify({ op: 'state', pad: 'x'.repeat(1024 * 1024 + 10) }) });
  assert.equal(big.status, 413);
});

test('operation names cannot reach inherited properties', async () => {
  for (const op of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const res = await call({}, { body: { op } });
    assert.equal(res.status, 404, op);
    assert.equal(res.json().error.code, 'unknown-op');
  }
});

test('a valid operation returns ok with its value and is never cached', async () => {
  const res = await call({}, { body: { op: 'projectState', root: '/p' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, value: { root: '/p' } });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('required text arguments are validated', async () => {
  const res = await call({}, { body: { op: 'projectState' } });
  assert.equal(res.status, 400);
  assert.equal(res.json().error.code, 'invalid');
});

test('service errors keep their code and details; unexpected errors become 500 without a stack', async () => {
  const known = await call(
    { service: fakeService({ saveGlobal: async () => { throw new ServiceError('invalid', 'bad', [{ field: 'x' }]); } }) },
    { body: { op: 'saveGlobal', server: {} } },
  );
  assert.equal(known.status, 400);
  assert.deepEqual(known.json().error.details, [{ field: 'x' }]);
  const unknown = await call(
    { service: fakeService({ getState: async () => { throw new Error('kaboom'); } }), logger: { warn() {} } },
    { body: { op: 'state' } },
  );
  assert.equal(unknown.status, 500);
  assert.equal(unknown.json().error.message, 'kaboom');
  assert.ok(!unknown.body.includes('at '), 'no stack trace in the response');
});

test('operations wait for the service to be ready', async () => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let ran = false;
  const pending = call({ ready, service: fakeService({ getState: async () => { ran = true; return {}; } }) }, { body: { op: 'state' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  release();
  assert.equal((await pending).status, 200);
});

test('diagnostics merge host facts', async () => {
  const res = await call({ extras: () => ({ toolRegistered: true }) }, { body: { op: 'diagnose' } });
  assert.deepEqual(res.json().value, { mcpClient: { available: true }, toolRegistered: true });
});

test('trust approval is reachable from the route but the agent tool exposes no write path', async () => {
  const operations = createOperations(fakeService());
  assert.equal(typeof operations.approveTrust, 'function');

  let definition;
  const tool = createTool((d) => { definition = d; return d; }, fakeService());
  assert.equal(tool, definition);
  assert.deepEqual(Object.keys(definition.parameters).sort(), ['action', 'projectRoot']);
  const result = await definition.execute({ action: 'list', projectRoot: '/p' }, { signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(result.json), { root: '/p' });
  const diagnose = await definition.execute({ action: 'diagnose' }, {});
  assert.equal(JSON.parse(diagnose.json).mcpClient.available, true);
  await assert.rejects(() => definition.execute({ action: 'approveTrust' }, {}), /action must be/);
  await assert.rejects(() => definition.execute({ action: 'saveGlobal', server: {} }, {}), /action must be/);
  assert.deepEqual(definition.output.render({}, { json: 'x' }), [{ type: 'text', text: 'x' }]);
});
