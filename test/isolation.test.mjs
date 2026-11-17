import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';

/** An agent context that records the tool restrictions it receives. */
function agentCtx(name) {
  const restrictions = [];
  return {
    name,
    restrictions,
    tools: {
      restrict(filter) {
        restrictions.push(filter);
        return () => {};
      },
    },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-iso-'));
  const alpha = join(dir, 'alpha');
  const beta = join(dir, 'beta');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  const mounts = [];
  const service = createService({
    storeFile: join(dir, 'state', 'store.json'),
    rootCtx: { name: 'root' },
    client: {
      load: async () => ({ ok: true, mod: { Config: (config) => config } }),
      mount(_ctx, _mod, config) {
        const record = { config, disposed: false };
        mounts.push(record);
        return { settled: Promise.resolve({ ok: true }), dispose: () => { record.disposed = true; } };
      },
    },
    toolCount: () => 1,
    toolNames: (name) => [`mcp__${name}__tool`],
    listWorkspaces: () => [alpha, beta],
  });
  await service.init();
  return {
    dir, alpha, beta, mounts, service,
    async cleanup() {
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const stdio = (serverName, command) => ({ serverName, transport: 'stdio', command });

test('two projects may both declare a server named "db" without colliding', async () => {
  const h = await setup();
  try {
    await h.service.saveProjectServer(h.alpha, stdio('db', 'alpha-db'));
    await h.service.saveProjectServer(h.beta, stdio('db', 'beta-db'));
    await h.service.attachAgent({ id: 'a1', ctx: agentCtx('a') }, h.alpha);
    await h.service.attachAgent({ id: 'b1', ctx: agentCtx('b') }, h.beta);
    const names = h.mounts.map((mount) => mount.config.serverName);
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1], 'the registrations differ');
    assert.ok(names.every((name) => name.endsWith('_db')), 'both keep a readable suffix');
    assert.ok(names.every((name) => name.length <= 32), 'and respect the serverName limit');
    assert.ok(h.mounts.every((mount) => mount.ctx === h.rootCtx), 'both are registered globally');
  } finally {
    await h.cleanup();
  }
});

test('each session is denied the other project\'s tools and keeps its own', async () => {
  const h = await setup();
  try {
    await h.service.saveProjectServer(h.alpha, stdio('db', 'alpha-db'));
    await h.service.saveProjectServer(h.beta, stdio('db', 'beta-db'));
    const alphaAgent = agentCtx('alpha-agent');
    const betaAgent = agentCtx('beta-agent');
    await h.service.attachAgent({ id: 'a1', ctx: alphaAgent }, h.alpha);
    await h.service.attachAgent({ id: 'b1', ctx: betaAgent }, h.beta);

    const alphaRegistration = h.mounts[0].config.serverName;
    const betaRegistration = h.mounts[1].config.serverName;
    const denyOf = (agent) => (agent.restrictions.at(-1)?.deny ?? []);

    assert.ok(denyOf(alphaAgent).includes(`mcp__${betaRegistration}__tool`), 'alpha denies beta');
    assert.ok(!denyOf(alphaAgent).includes(`mcp__${alphaRegistration}__tool`), 'alpha keeps its own');
    assert.ok(denyOf(betaAgent).includes(`mcp__${alphaRegistration}__tool`), 'beta denies alpha');
    assert.ok(!denyOf(betaAgent).includes(`mcp__${betaRegistration}__tool`), 'beta keeps its own');
  } finally {
    await h.cleanup();
  }
});

test('two sessions in one project share a single mount and release it with the last one', async () => {
  const h = await setup();
  try {
    await h.service.saveProjectServer(h.alpha, stdio('db', 'alpha-db'));
    await h.service.attachAgent({ id: 'a1', ctx: agentCtx('one') }, h.alpha);
    await h.service.attachAgent({ id: 'a2', ctx: agentCtx('two') }, h.alpha);
    assert.equal(h.mounts.length, 1, 'one process for both sessions');
    h.service.detachAgent('a1');
    assert.equal(h.mounts[0].disposed, false, 'still mounted while a session remains');
    h.service.detachAgent('a2');
    assert.equal(h.mounts[0].disposed, true, 'released with the last session');
  } finally {
    await h.cleanup();
  }
});

test('a session outside every project sees no project tools', async () => {
  const h = await setup();
  const elsewhere = await mkdtemp(join(tmpdir(), 'mmp-iso-out-'));
  try {
    await h.service.saveProjectServer(h.alpha, stdio('db', 'alpha-db'));
    await h.service.attachAgent({ id: 'a1', ctx: agentCtx('a') }, h.alpha);
    const outsider = agentCtx('outside');
    await h.service.attachAgent({ id: 'o1', ctx: outsider }, elsewhere);
    const registration = h.mounts[0].config.serverName;
    const deny = outsider.restrictions.at(-1)?.deny ?? [];
    assert.ok(deny.includes(`mcp__${registration}__tool`), 'the outsider is denied every project tool');
  } finally {
    await h.service.cleanup?.();
    await h.cleanup();
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('a changed definition remounts once for the whole project', async () => {
  const h = await setup();
  try {
    const first = await h.service.saveProjectServer(h.alpha, stdio('db', 'v1'));
    await h.service.attachAgent({ id: 'a1', ctx: agentCtx('one') }, h.alpha);
    await h.service.attachAgent({ id: 'a2', ctx: agentCtx('two') }, h.alpha);
    assert.equal(h.mounts.length, 1);
    const id = first.servers[0].id;
    await h.service.saveProjectServer(h.alpha, { ...stdio('db', 'v2'), id });
    assert.equal(h.mounts.length, 2, 'one new mount, not one per session');
    assert.equal(h.mounts[0].disposed, true);
    assert.equal(h.mounts[1].config.command, 'v2');
  } finally {
    await h.cleanup();
  }
});
