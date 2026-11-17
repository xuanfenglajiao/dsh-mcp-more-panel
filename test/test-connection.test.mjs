import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';

function harness({ settle, toolCount } = {}) {
  const mounts = [];
  const client = {
    load: async () => ({ ok: true, mod: { Config: (config) => config } }),
    mount(_ctx, _mod, config) {
      const record = { config, disposed: false };
      mounts.push(record);
      const settled = settle ? settle() : Promise.resolve({ ok: true });
      return { settled, dispose: () => { record.disposed = true; } };
    },
  };
  return { mounts, client, toolCount };
}

async function make(options) {
  const state = await mkdtemp(join(tmpdir(), 'mmp-test-conn-'));
  const h = harness(options);
  const service = createService({
    storeFile: join(state, 'store.json'),
    rootCtx: {},
    client: h.client,
    toolCount: h.toolCount ?? ((name) => (name.startsWith('probe_') ? 7 : 0)),
    listWorkspaces: () => [],
  });
  await service.init();
  return {
    service,
    mounts: h.mounts,
    async cleanup() {
      service.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

const DEF = { serverName: 'demo', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] };

test('test connection: success reports the tools and releases the probe', async () => {
  const h = await make();
  try {
    const result = await h.service.testServer(DEF);
    assert.deepEqual(result, { ok: true, toolCount: 7 });
    assert.equal(h.mounts.length, 1);
    assert.equal(h.mounts[0].disposed, true, 'the probe is released');
    assert.match(h.mounts[0].config.serverName, /^probe_/);
    assert.equal(h.mounts[0].config.command, 'npx', 'the definition is passed through');
  } finally {
    await h.cleanup();
  }
});

test('test connection: a failed handshake returns the reason and still releases the probe', async () => {
  const h = await make({ settle: () => Promise.resolve({ ok: false, error: 'ECONNREFUSED' }) });
  try {
    const result = await h.service.testServer(DEF);
    assert.deepEqual(result, { ok: false, error: 'ECONNREFUSED' });
    assert.equal(h.mounts[0].disposed, true);
  } finally {
    await h.cleanup();
  }
});

test('test connection: a definition that cannot mount fails without throwing', async () => {
  const h = await make();
  try {
    await assert.rejects(() => h.service.testServer({ serverName: 'x', transport: 'stdio' }), (error) => error.code === 'invalid');
    await assert.rejects(() => h.service.testServer({ serverName: 'x', transport: 'streamable-http' }), (error) => error.code === 'invalid');
    assert.equal(h.mounts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('test connection: a missing environment variable is reported before anything starts', async () => {
  const h = await make();
  try {
    const result = await h.service.testServer({ ...DEF, env: { TOKEN: '${NOT_SET_ANYWHERE}' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /NOT_SET_ANYWHERE/);
    assert.equal(h.mounts.length, 0, 'no process is started');
  } finally {
    await h.cleanup();
  }
});

test('test connection: a handshake that never settles times out and releases the probe', async () => {
  const h = await make({ settle: () => new Promise(() => {}) });
  try {
    const result = await h.service.testServer({ ...DEF, toolCallTimeoutMs: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 3000 ms/);
    assert.equal(h.mounts[0].disposed, true);
  } finally {
    await h.cleanup();
  }
});
