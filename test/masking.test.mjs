import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, MASKED_VALUE } from '../lib/service.js';

function harness() {
  const mounts = [];
  return {
    mounts,
    client: {
      load: async () => ({ ok: true, mod: { Config: (config) => config } }),
      mount(_ctx, _mod, config) {
        const record = { config, disposed: false };
        mounts.push(record);
        return { settled: Promise.resolve({ ok: true }), dispose: () => { record.disposed = true; } };
      },
    },
  };
}

async function make() {
  const state = await mkdtemp(join(tmpdir(), 'mmp-mask-'));
  const h = harness();
  const service = createService({
    storeFile: join(state, 'store.json'),
    rootCtx: {},
    client: h.client,
    toolCount: () => 0,
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

const SECRETS = {
  serverName: 'web',
  transport: 'streamable-http',
  url: 'http://h/mcp',
  headers: { Authorization: 'Bearer SUPER-SECRET', 'X-Plain': 'visible' },
};

test('masking: a stored secret never leaves the Host', async () => {
  const h = await make();
  try {
    const saved = await h.service.saveGlobal(SECRETS);
    assert.equal(saved.server.headers.Authorization, MASKED_VALUE, 'the save response is masked too');
    const state = await h.service.getState();
    const view = state.global[0];
    assert.equal(view.server.headers.Authorization, MASKED_VALUE);
    assert.equal(view.server.headers['X-Plain'], MASKED_VALUE, 'every non-empty header value is masked, not only secret-looking keys');
    const text = JSON.stringify(state);
    assert.ok(!text.includes('SUPER-SECRET'), 'the plaintext never appears in the payload');
  } finally {
    await h.cleanup();
  }
});

test('masking: submitting the placeholder keeps the stored secret', async () => {
  const h = await make();
  try {
    const saved = await h.service.saveGlobal(SECRETS);
    const view = (await h.service.getState()).global[0];
    await h.service.saveGlobal({ ...view.server, id: saved.id, headers: { ...view.server.headers, 'X-Plain': 'changed' } });
    const after = (await h.service.getState()).global[0];
    assert.equal(after.server.headers.Authorization, MASKED_VALUE, 'still masked');
    // The stored value must still be the original: mount it and look at what the client received.
    const mounted = h.mounts[h.mounts.length - 1];
    assert.equal(mounted.config.headers.Authorization, 'Bearer SUPER-SECRET', 'the real secret survived an edit that echoed the placeholder');
    assert.equal(mounted.config.headers['X-Plain'], 'changed', 'an edited value is written');
  } finally {
    await h.cleanup();
  }
});

test('masking: a new value replaces the old one', async () => {
  const h = await make();
  try {
    const saved = await h.service.saveGlobal(SECRETS);
    const view = (await h.service.getState()).global[0];
    await h.service.saveGlobal({ ...view.server, id: saved.id, headers: { Authorization: 'Bearer NEW-SECRET' } });
    const mounted = h.mounts[h.mounts.length - 1];
    assert.equal(mounted.config.headers.Authorization, 'Bearer NEW-SECRET');
  } finally {
    await h.cleanup();
  }
});

test('masking: environment variables are masked the same way', async () => {
  const h = await make();
  try {
    await h.service.saveGlobal({ serverName: 'git', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_secret_value', EMPTY: '' } });
    const view = (await h.service.getState()).global[0];
    assert.equal(view.server.env.GITHUB_TOKEN, MASKED_VALUE);
    assert.equal(view.server.env.EMPTY, '', 'an empty value is not replaced by dots');
    assert.ok(!JSON.stringify(view).includes('ghp_secret_value'));
  } finally {
    await h.cleanup();
  }
});

test('masking: a probe of an existing server resolves the placeholder before connecting', async () => {
  const h = await make();
  try {
    const saved = await h.service.saveGlobal(SECRETS);
    const view = (await h.service.getState()).global[0];
    const result = await h.service.testServer({ ...view.server, id: saved.id });
    assert.equal(result.ok, true);
    const probe = h.mounts[h.mounts.length - 1];
    assert.equal(probe.config.headers.Authorization, 'Bearer SUPER-SECRET', 'the probe used the real secret');
  } finally {
    await h.cleanup();
  }
});

test('masking: project servers are masked in the project view as well', async () => {
  const h = await make();
  const root = await mkdtemp(join(tmpdir(), 'mmp-mask-proj-'));
  try {
    await h.service.saveProjectServer(root, { serverName: 'db', transport: 'stdio', command: 'db-mcp', env: { TOKEN: 'p_secret' } });
    const view = await h.service.getProjectState(root);
    assert.equal(view.servers[0].server.env.TOKEN, MASKED_VALUE);
    assert.ok(!JSON.stringify(view).includes('p_secret'));
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
