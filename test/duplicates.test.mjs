import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectFiles } from '../lib/project-files.js';
import { createService } from '../lib/service.js';

async function project(files) {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-dup-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(content));
  }
  return dir;
}

test('the same name in several files is reported with the winner and the losers', async () => {
  const root = await project({
    '.mcp.json': { mcpServers: { shared: { command: 'from-root', args: ['a'] } } },
    '.agents/mcp.json': { mcpServers: { shared: { command: 'from-agents', args: ['b'] }, only_agents: { command: 'x' } } },
    '.dsh/mcp.json': { mcpServers: { shared: { command: 'from-dsh', args: ['c'] } } },
  });
  try {
    const { servers, duplicates } = await readProjectFiles(root);
    assert.equal(servers.length, 2, 'the merged list keeps one entry per name');
    assert.equal(servers.find((s) => s.serverName === 'shared').command, 'from-dsh', 'the last file wins');
    assert.equal(duplicates.length, 1);
    const duplicate = duplicates[0];
    assert.equal(duplicate.serverName, 'shared');
    assert.equal(duplicate.winner, '.dsh/mcp.json');
    assert.deepEqual(duplicate.entries.map((entry) => entry.source), ['.mcp.json', '.agents/mcp.json', '.dsh/mcp.json']);
    assert.deepEqual(duplicate.entries.map((entry) => entry.sameAsWinner), [false, false, true]);
    for (const entry of duplicate.entries) assert.ok(entry.summary.length > 0, 'each entry has a readable summary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('identical definitions are reported as duplicates that do not differ', async () => {
  const same = { command: 'npx', args: ['-y', 'pkg'] };
  const root = await project({
    '.mcp.json': { mcpServers: { same: same } },
    '.dsh/mcp.json': { mcpServers: { same: { args: ['-y', 'pkg'], command: 'npx' } } },
  });
  try {
    const { duplicates } = await readProjectFiles(root);
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].entries.every((entry) => entry.sameAsWinner), true, 'key order does not make a definition different');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('names that appear once are not reported', async () => {
  const root = await project({
    '.mcp.json': { mcpServers: { a: { command: 'a' } } },
    '.dsh/mcp.json': { mcpServers: { b: { command: 'b' } } },
  });
  try {
    const { duplicates } = await readProjectFiles(root);
    assert.deepEqual(duplicates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project state carries the duplicates on the winning server', async () => {
  const root = await project({
    '.mcp.json': { mcpServers: { db: { command: 'old' } } },
    '.dsh/mcp.json': { mcpServers: { db: { command: 'new' } } },
  });
  const storeDir = await mkdtemp(join(tmpdir(), 'mmp-dup-store-'));
  const service = createService({
    storeFile: join(storeDir, 'store.json'),
    rootCtx: {},
    client: { load: async () => ({ ok: true, mod: { Config: (c) => c } }), mount: () => ({ settled: Promise.resolve({ ok: true }), dispose() {} }) },
    toolCount: () => 0,
    listWorkspaces: () => [root],
  });
  await service.init();
  try {
    const state = await service.getProjectState(root);
    assert.equal(state.duplicates.length, 1);
    const item = state.servers.find((server) => server.serverName === 'db');
    assert.equal(item.duplicateOf.winner, '.dsh/mcp.json');
    assert.equal(item.summary.includes('new'), true, 'the view describes the winning definition');
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test('approving the winning definition does not approve the ignored one', async () => {
  const root = await project({
    '.mcp.json': { mcpServers: { db: { command: 'old' } } },
    '.dsh/mcp.json': { mcpServers: { db: { command: 'new' } } },
  });
  const storeDir = await mkdtemp(join(tmpdir(), 'mmp-dup-approve-'));
  const service = createService({
    storeFile: join(storeDir, 'store.json'),
    rootCtx: {},
    client: { load: async () => ({ ok: true, mod: { Config: (c) => c } }), mount: () => ({ settled: Promise.resolve({ ok: true }), dispose() {} }) },
    toolCount: () => 0,
    listWorkspaces: () => [root],
  });
  await service.init();
  try {
    const state = await service.getProjectState(root);
    const item = state.servers.find((server) => server.serverName === 'db');
    await service.approveTrust(root, 'db', item.fingerprint);
    // The approval is keyed by name, so the file that is currently wins is what it covers.
    const after = await service.getProjectState(root);
    assert.equal(after.servers.find((server) => server.serverName === 'db').trustState, 'approved');
    // Replacing the winning file with the losing definition changes the fingerprint and needs a new approval.
    await writeFile(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'old' } } }));
    const changed = await service.getProjectState(root);
    assert.equal(changed.servers.find((server) => server.serverName === 'db').status, 'trust-changed');
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});
