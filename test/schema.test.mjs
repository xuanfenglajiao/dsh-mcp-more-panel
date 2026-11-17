import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeEndpoint,
  expandRefs,
  literalSecrets,
  normalizeServer,
  toClientConfig,
} from '../lib/schema.js';

const stdio = { serverName: 'git', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } };
const http = { serverName: 'web', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', headers: { X: 'y' } };

test('normalizeServer accepts valid stdio and http definitions', () => {
  const a = normalizeServer(stdio);
  assert.equal(a.ok, true);
  assert.deepEqual(a.value.args, ['-y', 'x']);
  assert.equal(a.value.enabled, true);
  const b = normalizeServer(http);
  assert.equal(b.ok, true);
  assert.equal(b.value.url, 'http://127.0.0.1:3000/mcp');
});

test('normalizeServer rejects bad names, transports and missing fields', () => {
  const bad = normalizeServer({ serverName: 'has space', transport: 'ws' });
  assert.equal(bad.ok, false);
  const fields = bad.errors.map((e) => e.field);
  assert.ok(fields.includes('serverName'));
  assert.ok(fields.includes('transport'));
  assert.equal(normalizeServer({ serverName: 'a', transport: 'stdio' }).ok, false);
  assert.equal(normalizeServer({ serverName: 'a', transport: 'streamable-http', url: 'ftp://x' }).ok, false);
  assert.equal(normalizeServer({ serverName: 'a'.repeat(33), transport: 'stdio', command: 'x' }).ok, false);
});

test('args may arrive as newline separated text from a form', () => {
  const r = normalizeServer({ ...stdio, args: '-y\n@scope/pkg\n' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.args, ['-y', '@scope/pkg']);
});

test('env values must be strings', () => {
  const r = normalizeServer({ ...stdio, env: { N: 5 } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'env.N');
});

test('numeric options are range checked and reconnect delays are ordered', () => {
  assert.equal(normalizeServer({ ...stdio, toolCallTimeoutMs: 0 }).ok, false);
  assert.equal(normalizeServer({ ...stdio, maxInstructionBytes: 1.5 }).ok, false);
  const order = normalizeServer({ ...stdio, reconnect: { initialDelayMs: 5000, maxDelayMs: 100 } });
  assert.equal(order.ok, false);
  assert.equal(order.errors[0].code, 'order');
  const ok = normalizeServer({ ...stdio, toolCallTimeoutMs: '30000', reconnect: { enabled: false, maxAttempts: 3 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.toolCallTimeoutMs, 30000);
  assert.deepEqual(ok.value.reconnect, { enabled: false, maxAttempts: 3 });
});

test('toClientConfig writes only official fields and always sets transport', () => {
  const { value } = normalizeServer({ ...stdio, notes: 'private', toolCallTimeoutMs: 1000 });
  const config = toClientConfig({ ...value, id: 'srv_1' });
  assert.deepEqual(Object.keys(config).sort(), ['args', 'command', 'env', 'serverName', 'toolCallTimeoutMs', 'transport']);
  assert.equal(config.transport, 'stdio');
  const httpConfig = toClientConfig(normalizeServer(http).value);
  assert.deepEqual(Object.keys(httpConfig).sort(), ['headers', 'serverName', 'transport', 'url']);
});

test('expandRefs substitutes, uses defaults and reports missing variables', () => {
  const out = expandRefs({ a: 'Bearer ${TOKEN}', b: ['${X:-fallback}'], c: { d: '${MISSING}' } }, { TOKEN: 't0k' });
  assert.equal(out.value.a, 'Bearer t0k');
  assert.deepEqual(out.value.b, ['fallback']);
  assert.deepEqual(out.missing, ['MISSING']);
  assert.equal(expandRefs('plain', {}).value, 'plain');
});

test('literalSecrets flags literal values but not references', () => {
  const server = normalizeServer({
    ...http,
    headers: { Authorization: 'Bearer abc', 'X-Token': '${TOKEN}', Accept: 'json' },
  }).value;
  assert.deepEqual(literalSecrets(server), ['headers.Authorization']);
});

test('describeEndpoint hides query strings and arguments beyond a cap', () => {
  assert.equal(describeEndpoint({ transport: 'streamable-http', url: 'http://h:1/mcp?token=secret' }), 'http://h:1/mcp');
  assert.equal(describeEndpoint({ transport: 'stdio', command: 'npx', args: ['-y', 'p'] }), 'npx -y p');
  assert.ok(describeEndpoint({ transport: 'stdio', command: 'x', args: ['a'.repeat(300)] }).length <= 160);
});
