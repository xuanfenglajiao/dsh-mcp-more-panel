import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintServer, canonicalize, rootKey } from '../lib/fingerprint.js';
import { convertEntry, parseMcpJson, readProjectFiles, slugName } from '../lib/project-files.js';
import { resolveProjectRoot } from '../lib/projects.js';
import { coerceStore, emptyStore, loadStore, saveStore } from '../lib/store.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'mmp-test-'));
}

test('canonicalize is key-order independent', () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalize({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test('fingerprint changes with anything that decides what runs', () => {
  const base = { serverName: 'a', transport: 'stdio', command: 'npx', args: ['x'], env: {}, cwd: '' };
  const root = join(tmpdir(), 'proj');
  const fp = fingerprintServer(root, base);
  assert.equal(fp, fingerprintServer(root, { ...base }));
  assert.notEqual(fp, fingerprintServer(root, { ...base, command: 'node' }));
  assert.notEqual(fp, fingerprintServer(root, { ...base, args: ['y'] }));
  assert.notEqual(fp, fingerprintServer(root, { ...base, env: { A: '1' } }));
  assert.notEqual(fp, fingerprintServer(join(tmpdir(), 'other'), base));
  assert.match(fp, /^[0-9a-f]{64}$/);
});

test('fingerprint treats variable references literally', () => {
  const server = { serverName: 'a', transport: 'stdio', command: 'x', args: [], env: { T: '${TOKEN}' } };
  process.env.TOKEN = 'one';
  const first = fingerprintServer('/p', server);
  process.env.TOKEN = 'two';
  assert.equal(first, fingerprintServer('/p', server));
  delete process.env.TOKEN;
});

test('slugName and convertEntry map foreign names and shapes', () => {
  assert.equal(slugName('my server!'), 'my_server');
  assert.equal(slugName('x'.repeat(40)).length, 32);
  const stdio = convertEntry('my server', { command: 'uvx', args: ['p'], env: { K: 'v' } });
  assert.equal(stdio.server.serverName, 'my_server');
  assert.equal(stdio.warnings.length, 1);
  const http = convertEntry('web', { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } });
  assert.equal(http.server.transport, 'streamable-http');
  assert.equal(convertEntry('legacy', { type: 'sse', url: 'https://h/sse' }).errors[0].code, 'transport');
  assert.equal(convertEntry('none', {}).errors[0].code, 'shape');
  assert.equal(convertEntry('off', { command: 'x', disabled: true }).server.enabled, false);
});

test('parseMcpJson accepts mcpServers and VS Code style servers, and reports damage', () => {
  const a = parseMcpJson(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { url: 'http://h/m' } } }));
  assert.equal(a.servers.length, 2);
  const b = parseMcpJson(JSON.stringify({ servers: { a: { command: 'x' } } }));
  assert.equal(b.servers.length, 1);
  assert.equal(parseMcpJson('{').errors[0].code, 'json');
  assert.equal(parseMcpJson('[]').errors[0].code, 'shape');
  const mixed = parseMcpJson(JSON.stringify({ mcpServers: { ok: { command: 'x' }, bad: 5 } }));
  assert.equal(mixed.servers.length, 1);
  assert.equal(mixed.errors.length, 1);
});

test('readProjectFiles merges in priority order with the later file winning', async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, '.dsh'), { recursive: true });
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'low' }, only: { command: 'o' } } }));
    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'high' } } }));
    const out = await readProjectFiles(root);
    const a = out.servers.find((s) => s.serverName === 'a');
    assert.equal(a.command, 'high');
    assert.equal(a.source, '.dsh/mcp.json');
    assert.ok(out.servers.some((s) => s.serverName === 'only'));
    assert.equal(out.files.find((f) => f.path === '.agents/mcp.json').exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveProjectRoot prefers known roots and recognised documents, else nothing', async () => {
  const root = await tempDir();
  try {
    const nested = join(root, 'a', 'b');
    await mkdir(nested, { recursive: true });
    assert.equal(await resolveProjectRoot(nested, { knownRoots: [root] }), root);
    await mkdir(join(root, 'a', '.dsh'), { recursive: true });
    await writeFile(join(root, 'a', '.dsh', 'mcp.json'), '{}');
    assert.equal(await resolveProjectRoot(nested, {}), join(root, 'a'));
    const lonely = await tempDir();
    try {
      assert.equal(await resolveProjectRoot(lonely, { exists: async () => false }), undefined);
    } finally {
      await rm(lonely, { recursive: true, force: true });
    }
    assert.equal(await resolveProjectRoot('', {}), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rootKey is stable for the same directory spelled differently', () => {
  const dir = join(tmpdir(), 'x');
  assert.equal(rootKey(dir), rootKey(join(dir, '..', 'x')));
});

test('store round trip, missing file and damaged file', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'nested', 'store.json');
    assert.deepEqual((await loadStore(file)).store, emptyStore());
    const store = emptyStore();
    store.global.push({ id: 's1', serverName: 'a' });
    store.trust.k = { a: { fingerprint: 'f', approvedAt: 1 } };
    await saveStore(file, store);
    const again = await loadStore(file);
    assert.equal(again.error, undefined);
    assert.equal(again.store.global[0].id, 's1');
    assert.equal(again.store.trust.k.a.fingerprint, 'f');
    await writeFile(file, '{not json');
    const damaged = await loadStore(file);
    assert.match(damaged.error, /not valid JSON/);
    assert.deepEqual(damaged.store, emptyStore());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('coerceStore drops malformed sections instead of throwing', () => {
  const s = coerceStore({ global: 'x', projects: { k: { root: 5 } }, trust: [] });
  assert.deepEqual(s.global, []);
  assert.deepEqual(s.projects, {});
  assert.deepEqual(coerceStore(null), emptyStore());
});
