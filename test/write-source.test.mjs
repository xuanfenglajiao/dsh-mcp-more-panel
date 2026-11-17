import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-src-write-'));
  const project = join(dir, 'project');
  await mkdir(join(project, '.dsh'), { recursive: true });
  const service = createService({
    storeFile: join(dir, 'state', 'store.json'),
    rootCtx: {},
    client: { load: async () => ({ ok: true, mod: { Config: (c) => c } }), mount: () => ({ settled: Promise.resolve({ ok: true }), dispose() {} }) },
    toolCount: () => 1,
    toolNames: () => [],
    listWorkspaces: () => [project],
  });
  await service.init();
  return {
    dir, project, service,
    async cleanup() {
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const DEF = { serverName: 'db', transport: 'stdio', command: 'db-mcp', args: ['--x'] };

test('saveProjectServerToSource writes the entry into the chosen file', async () => {
  const h = await setup();
  try {
    await h.service.saveProjectServerToSource(h.project, 'dsh', DEF);
    const document = JSON.parse(await readFile(join(h.project, '.dsh', 'mcp.json'), 'utf8'));
    assert.deepEqual(document.mcpServers.db, { command: 'db-mcp', args: ['--x'] });
    const view = await h.service.getProjectState(h.project);
    assert.equal(view.servers[0].origin, 'file');
    assert.equal(view.servers[0].serverName, 'db');
    assert.equal(view.servers[0].sourceId, 'dsh');
  } finally {
    await h.cleanup();
  }
});

test('the rest of the document survives a write', async () => {
  const h = await setup();
  try {
    const path = join(h.project, '.mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: { keep: { command: 'x' } }, inputs: [{ id: 'a' }], sandbox: { filesystem: {} } }, null, 2));
    await h.service.saveProjectServerToSource(h.project, 'claude', { ...DEF, serverName: 'added' });
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(document.inputs, [{ id: 'a' }]);
    assert.deepEqual(document.sandbox, { filesystem: {} });
    assert.equal(document.mcpServers.keep.command, 'x');
    assert.equal(document.mcpServers.added.command, 'db-mcp');
    assert.equal(await readFile(`${path}.bak`, 'utf8').catch(() => null), null, 'no backup is left in the repository');
    const backups = join(h.dir, 'state', 'backups');
    const [folder] = await readdir(backups);
    const [file] = await readdir(join(backups, folder));
    const backup = JSON.parse(await readFile(join(backups, folder, file), 'utf8'));
    assert.equal(backup.mcpServers.added, undefined, 'the backup in the plugin directory predates the write');
  } finally {
    await h.cleanup();
  }
});

test('VS Code style documents keep using "servers"', async () => {
  const h = await setup();
  try {
    await mkdir(join(h.project, '.vscode'), { recursive: true });
    const path = join(h.project, '.vscode', 'mcp.json');
    await writeFile(path, JSON.stringify({ servers: { old: { command: 'x' } } }));
    await h.service.saveProjectServerToSource(h.project, 'vscode', DEF);
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(document.servers.db.command, 'db-mcp');
    assert.equal(document.mcpServers, undefined);
  } finally {
    await h.cleanup();
  }
});

test('deleteProjectServerFromSource removes only that entry', async () => {
  const h = await setup();
  try {
    const path = join(h.project, '.dsh', 'mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    await h.service.deleteProjectServerFromSource(h.project, 'dsh', 'a');
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(document.mcpServers), ['b']);
  } finally {
    await h.cleanup();
  }
});

test('deleting a missing entry or an unknown source fails cleanly', async () => {
  const h = await setup();
  try {
    await assert.rejects(() => h.service.deleteProjectServerFromSource(h.project, 'dsh', 'nope'), (error) => error.code === 'not-found');
    await assert.rejects(() => h.service.saveProjectServerToSource(h.project, 'nope', DEF), (error) => error.code === 'invalid');
    await assert.rejects(() => h.service.deleteProjectServerFromSource(h.project, 'nope', 'x'), (error) => error.code === 'invalid');
  } finally {
    await h.cleanup();
  }
});

test('a file that is not valid JSON is refused and left untouched', async () => {
  const h = await setup();
  try {
    const path = join(h.project, '.dsh', 'mcp.json');
    const broken = '{ "mcpServers": { broken ';
    await writeFile(path, broken);
    await assert.rejects(() => h.service.saveProjectServerToSource(h.project, 'dsh', DEF), (error) => error.code === 'file');
    assert.equal(await readFile(path, 'utf8'), broken, 'the file is unchanged');
  } finally {
    await h.cleanup();
  }
});

test('the source list reports which files exist', async () => {
  const h = await setup();
  try {
    const empty = await h.service.getProjectState(h.project);
    assert.equal(empty.sources.find((source) => source.id === 'dsh').exists, false);
    await h.service.saveProjectServerToSource(h.project, 'dsh', DEF);
    const after = await h.service.getProjectState(h.project);
    assert.equal(after.sources.find((source) => source.id === 'dsh').exists, true);
    assert.equal(after.sources.find((source) => source.id === 'cursor').exists, false);
  } finally {
    await h.cleanup();
  }
});

test('a server written through the panel is approved by that act', async () => {
  const h = await setup();
  try {
    const view = await h.service.saveProjectServerToSource(h.project, 'dsh', DEF);
    assert.equal(view.servers[0].trustState, 'approved', 'the user wrote it, so it is trusted');
    assert.equal(view.servers[0].status, 'idle', 'approved, but no session is mounted yet');
    assert.equal(view.servers[0].enabled, true);
  } finally {
    await h.cleanup();
  }
});
