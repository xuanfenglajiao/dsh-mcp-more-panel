import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeClient() {
  const mounts = [];
  return {
    mounts,
    load: async () => ({ ok: true, mod: { Config: (c) => c } }),
    mount(ctx, _mod, config) {
      const record = { ctx, config, disposed: false };
      mounts.push(record);
      return { settled: Promise.resolve({ ok: true }), dispose: () => { record.disposed = true; } };
    },
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-switch-'));
  const project = join(dir, 'project');
  await mkdir(join(project, '.dsh'), { recursive: true });
  const client = fakeClient();
  const service = createService({
    storeFile: join(dir, 'state', 'store.json'),
    rootCtx: { name: 'root' },
    client,
    toolCount: () => 1,
    listWorkspaces: () => [project],
    now: () => 1000,
  });
  await service.init();
  return {
    dir, project, client, service,
    async write(content) {
      await writeFile(join(project, '.dsh', 'mcp.json'), JSON.stringify(content));
    },
    async store() {
      return JSON.parse(await readFile(join(dir, 'state', 'store.json'), 'utf8'));
    },
    async cleanup() {
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const DEF = { mcpServers: { db: { command: 'db-mcp', args: ['--x'] } } };

test('an approved repository server can be switched off and on without losing the approval', async () => {
  const h = await harness();
  try {
    await h.write(DEF);
    const agent = { id: 'a1', ctx: {} };
    await h.service.attachAgent(agent, h.project);
    let view = await h.service.getProjectState(h.project);
    const item = view.servers[0];
    assert.equal(item.status, 'pending-trust');
    assert.equal(item.enabled, false, 'nothing is switched on before approval');

    view = await h.service.approveTrust(h.project, 'db', item.fingerprint);
    assert.equal(view.servers[0].status, 'active');
    assert.equal(view.servers[0].enabled, true);
    assert.equal(h.client.mounts.length, 1);

    view = await h.service.setProjectEnabled(h.project, item.id, false);
    assert.equal(view.servers[0].status, 'disabled');
    assert.equal(view.servers[0].enabled, false);
    assert.equal(h.client.mounts[0].disposed, true, 'switching off releases the mount');
    assert.equal(h.client.mounts.length, 1, 'and does not start another');

    const stored = await h.store();
    const trust = Object.values(stored.trust)[0];
    assert.equal(trust.db.enabled, false);
    assert.ok(trust.db.fingerprint, 'the approval is still there');

    view = await h.service.setProjectEnabled(h.project, item.id, true);
    assert.equal(view.servers[0].status, 'active');
    assert.equal(h.client.mounts.length, 2, 'switching on mounts again');
    assert.equal(h.client.mounts[1].disposed, false);
  } finally {
    await h.cleanup();
  }
});

test('a server that is not approved can not be switched', async () => {
  const h = await harness();
  try {
    await h.write(DEF);
    const view = await h.service.getProjectState(h.project);
    const item = view.servers[0];
    await assert.rejects(
      () => h.service.setProjectEnabled(h.project, item.id, true),
      (error) => error.code === 'not-approved',
    );
    assert.equal(h.client.mounts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('re-approving a changed definition keeps the switch where the user left it', async () => {
  const h = await harness();
  try {
    await h.write(DEF);
    const agent = { id: 'a1', ctx: {} };
    await h.service.attachAgent(agent, h.project);
    let view = await h.service.getProjectState(h.project);
    const id = view.servers[0].id;
    await h.service.approveTrust(h.project, 'db', view.servers[0].fingerprint);
    await h.service.setProjectEnabled(h.project, id, false);

    await h.write({ mcpServers: { db: { command: 'db-mcp', args: ['--changed'] } } });
    view = await h.service.getProjectState(h.project);
    assert.equal(view.servers[0].status, 'trust-changed');
    assert.equal(view.servers[0].enabled, false, 'a changed definition does not switch a parked server back on');

    view = await h.service.approveTrust(h.project, 'db', view.servers[0].fingerprint);
    assert.equal(view.servers[0].trustState, 'approved');
    assert.equal(view.servers[0].status, 'disabled', 'approval does not silently enable it');
    assert.equal(h.client.mounts.filter((m) => !m.disposed).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('a trust record written before the switch existed means on', async () => {
  const h = await harness();
  try {
    await h.write(DEF);
    // Simulate the old shape: no `enabled` field at all.
    const { readProjectFiles } = await import('../lib/project-files.js');
    const { fingerprintServer, rootKey } = await import('../lib/fingerprint.js');
    const { servers } = await readProjectFiles(h.project);
    const record = {
      version: 1,
      global: [],
      projects: {},
      trust: { [rootKey(h.project)]: { db: { fingerprint: fingerprintServer(h.project, servers[0]), approvedAt: 1 } } },
    };
    await mkdir(join(h.dir, 'state'), { recursive: true });
    await writeFile(join(h.dir, 'state', 'store.json'), JSON.stringify(record));
    const fresh = createService({
      storeFile: join(h.dir, 'state', 'store.json'),
      rootCtx: {},
      client: fakeClient(),
      toolCount: () => 1,
      listWorkspaces: () => [h.project],
    });
    await fresh.init();
    try {
      const view = await fresh.getProjectState(h.project);
      assert.equal(view.servers[0].trustState, 'approved', 'the legacy record is recognised');
      assert.equal(view.servers[0].enabled, true, 'a legacy record is on');
    } finally {
      fresh.dispose();
    }
  } finally {
    await h.cleanup();
  }
});

test('revoking removes the switch with the approval', async () => {
  const h = await harness();
  try {
    await h.write(DEF);
    let view = await h.service.getProjectState(h.project);
    await h.service.approveTrust(h.project, 'db', view.servers[0].fingerprint);
    await h.service.setProjectEnabled(h.project, view.servers[0].id, false);
    view = await h.service.revokeTrust(h.project, 'db');
    assert.equal(view.servers[0].trustState, 'pending');
    assert.equal(view.servers[0].enabled, false);
    const stored = await h.store();
    assert.equal(Object.values(stored.trust)[0].db, undefined);
  } finally {
    await h.cleanup();
  }
});
