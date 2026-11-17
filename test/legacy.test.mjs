import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLegacyEdit, createLegacyAdapter, entryIdOf, isExpression, mergeMap, viewOfRow } from '../lib/legacy.js';

const memory = {
  serverName: 'memory',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8790/mcp',
  headers: { Authorization: { __jsExpr: '`Bearer ${process.env.MEMORY_TOKEN_DSH}`' } },
  failOnStartupError: false,
  toolCallTimeoutMs: 10000,
};

test('isExpression recognises the loader marker only', () => {
  assert.equal(isExpression({ __jsExpr: 'x' }), true);
  assert.equal(isExpression({ __jsExpr: 5 }), false);
  assert.equal(isExpression('x'), false);
  assert.equal(isExpression(null), false);
});

test('viewOfRow lists expression fields and keeps the endpoint readable', () => {
  const view = viewOfRow('memory-http', memory, { active: true });
  assert.equal(view.serverName, 'memory');
  assert.equal(view.endpoint, 'http://127.0.0.1:8790/mcp');
  assert.deepEqual(view.expressionFields, ['headers.Authorization']);
  assert.equal(view.entryId, 'include:memory-http');
  assert.equal(view.enabled, true);
  assert.equal(view.active, true);
  assert.equal(viewOfRow('x', { serverName: { __jsExpr: 'n' }, url: { __jsExpr: 'u' } }).serverName, '(expression)');
});

test('mergeMap keeps expressions and follows literal edits', () => {
  const merged = mergeMap(
    { Authorization: { __jsExpr: 'e' }, Old: 'x', Keep: 'k' },
    { Keep: 'k2', New: 'n', Authorization: 'overwrite attempt' },
  );
  assert.deepEqual(merged, { Authorization: { __jsExpr: 'e' }, Keep: 'k2', New: 'n' });
});

test('applyLegacyEdit preserves the expression header and changes only literals', () => {
  const { config, skipped } = applyLegacyEdit(memory, { toolCallTimeoutMs: 20000, headers: { 'X-Extra': '1' } });
  assert.equal(config.toolCallTimeoutMs, 20000);
  assert.deepEqual(config.headers.Authorization, memory.headers.Authorization);
  assert.equal(config.headers['X-Extra'], '1');
  assert.equal(config.serverName, 'memory');
  assert.equal(config.transport, 'streamable-http');
  assert.deepEqual(skipped, []);
});

test('applyLegacyEdit refuses to overwrite a field that is an expression', () => {
  const current = { serverName: 's', transport: 'streamable-http', url: { __jsExpr: 'u' }, headers: {} };
  const { config, skipped } = applyLegacyEdit(current, { url: 'http://elsewhere/mcp' });
  assert.deepEqual(config.url, { __jsExpr: 'u' });
  assert.deepEqual(skipped, ['url']);
});

test('applyLegacyEdit never changes the identity of the row', () => {
  const { config } = applyLegacyEdit({ serverName: 'a', transport: 'stdio', command: 'x' }, { command: 'y', serverName: 'hacked' });
  assert.equal(config.serverName, 'a');
  assert.equal(config.command, 'y');
});

function fakeServices({ rows, editorLog = [] } = {}) {
  const entries = rows.map((options, index) => ({ options, fiber: { state: index === 0 ? 2 : 0 } }));
  const configEditor = {
    entries: () => entries,
    configuration: () => entries.map((entry) => ({ entry, inherited: {}, override: entry.options.config })),
    async edit(entry, change) {
      const next = change(entry.options.config, {});
      editorLog.push({ id: entry.options.id, next });
      entry.options.config = next;
    },
  };
  const toggles = [];
  const pluginManager = { setPluginEnabled: async (id, enabled) => toggles.push([id, enabled]) };
  return { services: () => ({ configEditor, pluginManager }), toggles, editorLog };
}

test('adapter lists only official client rows and reports their state', () => {
  const { services } = fakeServices({
    rows: [
      { id: 'memory-http', name: '@deepseek-ai/dsh-mcp-client', config: memory },
      { id: 'something-else', name: 'dshmarket', config: {} },
      { id: 'calc', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'calc', transport: 'streamable-http', url: 'http://h/m' }, disabled: true },
    ],
  });
  const adapter = createLegacyAdapter(services);
  const rows = adapter.list();
  assert.deepEqual(rows.map((r) => r.rowId), ['memory-http', 'calc']);
  assert.equal(rows[0].active, true);
  assert.equal(rows[1].enabled, false);
  assert.deepEqual(adapter.serverNames(), ['memory', 'calc']);
  assert.equal(adapter.available(), true);
});

test('adapter toggles through the plugin manager and edits through the config editor', async () => {
  const log = [];
  const { services, toggles } = fakeServices({
    rows: [{ id: 'memory-http', name: '@deepseek-ai/dsh-mcp-client', config: structuredClone(memory) }],
    editorLog: log,
  });
  const adapter = createLegacyAdapter(services);
  await adapter.toggle('memory-http', false);
  assert.deepEqual(toggles, [['include:memory-http', false]]);
  const result = await adapter.edit('memory-http', { toolCallTimeoutMs: 15000 });
  assert.deepEqual(result.skipped, []);
  assert.equal(log[0].next.toolCallTimeoutMs, 15000);
  assert.deepEqual(log[0].next.headers.Authorization, memory.headers.Authorization);
  await assert.rejects(() => adapter.edit('missing', {}), /not found/);
});

test('adapter degrades cleanly when the host services are missing', async () => {
  const adapter = createLegacyAdapter(() => ({}));
  assert.equal(adapter.available(), false);
  assert.deepEqual(adapter.list(), []);
  await assert.rejects(() => adapter.toggle('x', true), /not available/);
});

test('entryIdOf is idempotent', () => {
  assert.equal(entryIdOf('a'), 'include:a');
  assert.equal(entryIdOf('include:a'), 'include:a');
});
