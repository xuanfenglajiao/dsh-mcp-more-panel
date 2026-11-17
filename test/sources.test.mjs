import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, selectedSources, sourcePath } from '../lib/sources.js';
import { readProjectFiles } from '../lib/project-files.js';
import { createService } from '../lib/service.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'mmp-src-'));
}

test('sources: every source lives inside the project, none is global', () => {
  assert.deepEqual(SOURCES.map((source) => source.id), ['codex', 'claude', 'agents', 'cursor', 'vscode', 'gemini', 'zcode', 'pi', 'dsh']);
  for (const source of SOURCES) {
    assert.equal(source.path.startsWith('/') || source.path.includes(':'), false, `${source.id} must be project-relative`);
    assert.equal(source.path.includes('~'), false, `${source.id} must not point at a home directory`);
  }
});

test('sources: all means every source, in priority order with DSH last', () => {
  const expected = ['codex', 'claude', 'agents', 'cursor', 'vscode', 'gemini', 'zcode', 'pi', 'dsh'];
  assert.deepEqual(selectedSources('all').map((source) => source.id), expected);
  assert.deepEqual(selectedSources(undefined).map((source) => source.id), expected);
  assert.equal(expected[expected.length - 1], 'dsh', 'DSH has the highest priority');
});

test('sources: one id selects exactly that source; an unknown one selects nothing', () => {
  assert.deepEqual(selectedSources('cursor').map((source) => source.id), ['cursor']);
  assert.deepEqual(selectedSources('codex').map((source) => source.id), ['codex'], 'Codex is a project-level TOML source');
  assert.deepEqual(selectedSources('nope'), []);
});

test('sources: paths are joined onto the project root', () => {
  assert.equal(sourcePath(SOURCES.find((source) => source.id === 'dsh'), { root: 'C:\\p' }), join('C:\\p', '.dsh', 'mcp.json'));
  assert.equal(sourcePath(SOURCES.find((source) => source.id === 'cursor'), { root: 'C:\\p' }), join('C:\\p', '.cursor', 'mcp.json'));
});

test('reading one source ignores the others', async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, '.dsh'), { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { fromClaude: { command: 'c' } } }));
    await writeFile(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { fromCursor: { command: 's' } } }));
    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { fromDsh: { command: 'd' } } }));
    const cursor = await readProjectFiles(root, { source: 'cursor' });
    assert.deepEqual(cursor.servers.map((server) => server.serverName), ['fromCursor']);
    assert.equal(cursor.files.length, 1, 'only the chosen source is read');
    assert.equal(cursor.files[0].source, 'cursor');
    const all = await readProjectFiles(root, { source: 'all' });
    assert.deepEqual(all.servers.map((server) => server.serverName).sort(), ['fromClaude', 'fromCursor', 'fromDsh']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('VS Code format and Cursor format are read from their own files', async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, '.vscode'), { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.vscode', 'mcp.json'), JSON.stringify({ servers: { vsc: { type: 'stdio', command: 'npx', args: ['-y', 'x'] } } }));
    await writeFile(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cur: { type: 'http', url: 'http://h/mcp' } } }));
    const vscode = await readProjectFiles(root, { source: 'vscode' });
    assert.equal(vscode.servers[0].serverName, 'vsc');
    assert.equal(vscode.servers[0].transport, 'stdio');
    const cursor = await readProjectFiles(root, { source: 'cursor' });
    assert.equal(cursor.servers[0].transport, 'streamable-http');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the source selection is remembered per project and remounts', async () => {
  const root = await tempDir();
  const state = await tempDir();
  const mounts = [];
  const service = createService({
    storeFile: join(state, 'store.json'),
    rootCtx: {},
    client: {
      load: async () => ({ ok: true, mod: { Config: (config) => config } }),
      mount: (_ctx, _mod, config) => {
        const record = { config, disposed: false };
        mounts.push(record);
        return { settled: Promise.resolve({ ok: true }), dispose: () => { record.disposed = true; } };
      },
    },
    toolCount: () => 1,
    listWorkspaces: () => [root],
  });
  await service.init();
  try {
    await mkdir(join(root, '.dsh'), { recursive: true });
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { dshOnly: { command: 'd' } } }));
    await writeFile(join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cursorOnly: { command: 'c' } } }));
    await service.attachAgent({ id: 'a1', ctx: {} }, root);

    let view = await service.getProjectState(root);
    assert.equal(view.selection, 'all');
    assert.deepEqual(view.servers.map((server) => server.serverName).sort(), ['cursorOnly', 'dshOnly']);
    assert.equal(view.sources.length, 9);

    view = await service.setProjectSource(root, 'cursor');
    assert.equal(view.selection, 'cursor');
    assert.deepEqual(view.servers.map((server) => server.serverName), ['cursorOnly']);

    const stored = JSON.parse(await readFile(join(state, 'store.json'), 'utf8'));
    assert.equal(Object.values(stored.projects)[0].source, 'cursor');

    await assert.rejects(() => service.setProjectSource(root, 'not-a-source'), (error) => error.code === 'invalid');
    view = await service.setProjectSource(root, 'all');
    assert.deepEqual(view.servers.map((server) => server.serverName).sort(), ['cursorOnly', 'dshOnly']);
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('approvals survive a source switch and come back with it', async () => {
  const root = await tempDir();
  const state = await tempDir();
  const service = createService({
    storeFile: join(state, 'store.json'),
    rootCtx: {},
    client: { load: async () => ({ ok: true, mod: { Config: (c) => c } }), mount: () => ({ settled: Promise.resolve({ ok: true }), dispose() {} }) },
    toolCount: () => 1,
    listWorkspaces: () => [root],
  });
  await service.init();
  try {
    await mkdir(join(root, '.dsh'), { recursive: true });
    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { kept: { command: 'x' } } }));
    let view = await service.getProjectState(root);
    const fingerprint = view.servers[0].fingerprint;
    await service.approveTrust(root, 'kept', fingerprint);

    view = await service.setProjectSource(root, 'cursor');
    assert.equal(view.servers.length, 0, 'the other source does not declare it');
    view = await service.setProjectSource(root, 'dsh');
    assert.equal(view.servers[0].trustState, 'approved', 'the approval is still there');
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
