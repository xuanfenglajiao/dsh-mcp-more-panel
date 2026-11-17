import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createService, MASKED_VALUE } from '../lib/service.js';
import { readProjectFiles } from '../lib/project-files.js';
import { resolveProjectRoot } from '../lib/projects.js';
import { expandRefs, redactArgs, referencedVariables } from '../lib/schema.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function agentCtx() {
  const restrictions = [];
  return { restrictions, tools: { restrict(filter) { restrictions.push(filter); return () => {}; } } };
}

/** Fake official client; `gate` holds every handshake until released. */
function fakeClient() {
  const mounts = [];
  return {
    mounts,
    live: () => mounts.filter((mount) => !mount.disposed),
    load: async () => ({ ok: true, mod: {} }),
    mount(_ctx, _mod, config) {
      const record = { config, disposed: false };
      mounts.push(record);
      return { settled: Promise.resolve({ ok: true }), dispose: () => { record.disposed = true; } };
    },
  };
}

async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-rob-'));
  const project = join(dir, 'project');
  await mkdir(join(project, '.dsh'), { recursive: true });
  const client = fakeClient();
  const tools = new Map();
  const deps = {
    storeFile: join(dir, 'state', 'store.json'),
    rootCtx: {},
    client,
    env: { TOKEN: 'abc' },
    toolCount: (name) => tools.get(name) ?? 0,
    toolNames: (name) => (tools.has(name) ? [`mcp__${name}__tool`] : []),
    listWorkspaces: () => [project],
    watchIntervalMs: 0,
    homeDir: join(dir, 'home'),
    ...options,
  };
  const service = createService(deps);
  await service.init();
  return {
    dir, project, client, tools, service, deps,
    write: (relative, content) => mkdir(join(project, relative, '..'), { recursive: true })
      .then(() => writeFile(join(project, relative), typeof content === 'string' ? content : JSON.stringify(content, null, 2))),
    async cleanup() {
      service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const db = { serverName: 'db', transport: 'stdio', command: 'db-mcp' };

// ------------------------------------------------------------------ store

test('store: the project source selection survives a restart', async () => {
  const h = await harness();
  try {
    await h.service.setProjectSource(h.project, 'cursor');
    const again = createService({ ...h.deps, client: fakeClient() });
    await again.init();
    assert.equal((await again.getProjectState(h.project)).selection, 'cursor');
    again.dispose();
  } finally {
    await h.cleanup();
  }
});

test('store: a damaged store is kept aside and never overwritten by the next save', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-rob-store-'));
  try {
    const storeFile = join(dir, 'store.json');
    await writeFile(storeFile, '{"global": [ broken');
    const service = createService({ storeFile, rootCtx: {}, client: fakeClient(), watchIntervalMs: 0, now: () => 42 });
    await service.init();
    const state = await service.getState();
    assert.match(state.storeError, /corrupt-42/);
    await service.saveGlobal(db);
    assert.equal(await readFile(`${storeFile}.corrupt-42`, 'utf8'), '{"global": [ broken', 'the damaged original is preserved');
    service.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store: a store written by a newer version is read-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-rob-store-'));
  try {
    const storeFile = join(dir, 'store.json');
    const text = JSON.stringify({ version: 99, global: [{ id: 's', serverName: 'a', transport: 'stdio', command: 'x', enabled: true }], projects: {}, trust: {} });
    await writeFile(storeFile, text);
    const service = createService({ storeFile, rootCtx: {}, client: fakeClient(), watchIntervalMs: 0 });
    await service.init();
    const state = await service.getState();
    assert.equal(state.storeReadOnly, true);
    assert.equal(state.global.length, 1, 'its content is still shown');
    await assert.rejects(() => service.saveGlobal(db), (error) => error.code === 'store-read-only');
    assert.equal(await readFile(storeFile, 'utf8'), text, 'nothing was written');
    service.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- mounting

test('mount: a session that ends while its project is mounting leaves nothing running', async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  let hold = false;
  const h = await harness({ readProjectFiles: async (root, options) => { if (hold) await gate; return readProjectFiles(root, options); } });
  try {
    await h.service.saveProjectServer(h.project, db);
    hold = true;
    const pending = h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    await sleep(20);
    h.service.detachAgent('a');
    release();
    await pending;
    await sleep(20);
    assert.equal(h.client.live().length, 0);
  } finally {
    await h.cleanup();
  }
});

test('mount: concurrent changes to one project never mount a server twice', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServer(h.project, db);
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    await Promise.all([
      h.service.reconnectProject(h.project),
      h.service.reconnectProject(h.project),
      h.service.saveProjectServer(h.project, { ...db, serverName: 'cache', command: 'cache-mcp' }),
    ]);
    const names = h.client.live().map((mount) => mount.config.serverName).sort();
    assert.equal(names.length, 2);
    assert.equal(new Set(names).size, 2, `no duplicates: ${names.join(', ')}`);
  } finally {
    await h.cleanup();
  }
});

test('mount: changing one server restarts only that server', async () => {
  const h = await harness();
  try {
    const first = await h.service.saveProjectServer(h.project, db);
    await h.service.saveProjectServer(h.project, { ...db, serverName: 'cache', command: 'cache-mcp' });
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    const cache = h.client.mounts.find((mount) => mount.config.command === 'cache-mcp');
    const id = first.servers.find((server) => server.serverName === 'db').id;
    await h.service.saveProjectServer(h.project, { ...db, id, command: 'db-mcp-2' });
    assert.equal(cache.disposed, false, 'the unchanged server kept running');
    assert.ok(h.client.live().some((mount) => mount.config.command === 'db-mcp-2'));
    await h.service.reconnectProject(h.project);
    assert.equal(cache.disposed, true, 'Remount restarts everything');
  } finally {
    await h.cleanup();
  }
});

test('mount: an approved repository server stops by itself when its file changes', async () => {
  const h = await harness({ watchIntervalMs: 25 });
  try {
    await h.write('.dsh/mcp.json', { mcpServers: { evil: { command: 'ok' } } });
    const view = await h.service.getProjectState(h.project);
    await h.service.approveTrust(h.project, 'evil', view.servers[0].fingerprint);
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    assert.equal(h.client.live().length, 1);
    await sleep(30);
    await h.write('.dsh/mcp.json', { mcpServers: { evil: { command: 'changed-and-longer' } } });
    for (let i = 0; i < 40 && h.client.live().length > 0; i += 1) await sleep(25);
    assert.equal(h.client.live().length, 0, 'the changed definition is no longer running');
  } finally {
    await h.cleanup();
  }
});

test('mount: a project server runs in the project directory and expands its workspace variables', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServer(h.project, { ...db, args: ['${workspaceFolder}/data', '${env:TOKEN}'] });
    await h.service.saveProjectServer(h.project, { ...db, serverName: 'sub', cwd: 'tools' });
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    const [main, sub] = ['db', 'sub'].map((name) => h.client.mounts.find((mount) => mount.config.serverName.endsWith(`_${name}`)));
    assert.equal(main.config.cwd, resolve(h.project));
    assert.deepEqual(main.config.args, [`${resolve(h.project)}/data`, 'abc']);
    assert.equal(sub.config.cwd, resolve(h.project, 'tools'));
  } finally {
    await h.cleanup();
  }
});

test('mount: a session outside every project is denied project tools at once', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServer(h.project, db);
    await h.service.attachAgent({ id: 'in', ctx: agentCtx() }, h.project);
    const registration = h.client.mounts[0].config.serverName;
    h.tools.set(registration, 1);
    const outside = agentCtx();
    await h.service.attachAgent({ id: 'out', ctx: outside }, join(h.dir, 'home', 'notes'));
    assert.deepEqual(outside.restrictions.at(-1).deny, [`mcp__${registration}__tool`]);
  } finally {
    await h.cleanup();
  }
});

test('mount: a connection test is hidden from every session while it runs', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServer(h.project, db);
    const session = agentCtx();
    await h.service.attachAgent({ id: 'a', ctx: session }, h.project);
    h.client.mount = (ctx, mod, config) => {
      if (config.serverName.startsWith('probe_')) h.tools.set(config.serverName, 2);
      return fakeClient().mount(ctx, mod, config);
    };
    const result = await h.service.testServer(db);
    assert.equal(result.ok, true);
    assert.ok(session.restrictions.some((filter) => filter.deny.some((name) => name.startsWith('mcp__probe_'))), 'the probe tools were denied');
  } finally {
    await h.cleanup();
  }
});

test('mount: long server names get a stable registration name within 32 characters', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServer(h.project, { ...db, serverName: 'github-enterprise-alpha' });
    await h.service.saveProjectServer(h.project, { ...db, serverName: 'github-enterprise-beta' });
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    const first = h.client.mounts.map((mount) => mount.config.serverName).sort();
    assert.ok(first.every((name) => name.length <= 32));
    assert.equal(new Set(first).size, 2);
    await h.service.reconnectProject(h.project);
    assert.deepEqual(h.client.live().map((mount) => mount.config.serverName).sort(), first, 'the same names after a remount');
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------ project files

test('files: a disable flag in the file keeps an approved server from running', async () => {
  const h = await harness();
  try {
    await h.write('.dsh/mcp.json', { mcpServers: { off: { command: 'x', disabled: true } } });
    const view = await h.service.getProjectState(h.project);
    await h.service.approveTrust(h.project, 'off', view.servers[0].fingerprint);
    await h.service.attachAgent({ id: 'a', ctx: agentCtx() }, h.project);
    assert.equal(h.client.live().length, 0);
    assert.equal((await h.service.getProjectState(h.project)).servers[0].status, 'disabled-in-file');
  } finally {
    await h.cleanup();
  }
});

test('files: an entry whose key was converted can be edited and deleted without duplicating it', async () => {
  const h = await harness();
  try {
    await h.write('.dsh/mcp.json', { mcpServers: { 'my server': { command: 'x', custom: true } } });
    await h.service.editProjectServerFromSource(h.project, 'dsh', 'my_server', { serverName: 'my_server', transport: 'stdio', command: 'y' });
    let document = JSON.parse(await readFile(join(h.project, '.dsh', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(document.mcpServers), ['my server'], 'the original key is kept');
    assert.deepEqual(document.mcpServers['my server'], { custom: true, command: 'y' });
    await h.service.deleteProjectServerFromSource(h.project, 'dsh', 'my_server');
    document = JSON.parse(await readFile(join(h.project, '.dsh', 'mcp.json'), 'utf8'));
    assert.deepEqual(document.mcpServers, {});
  } finally {
    await h.cleanup();
  }
});

test('files: adding a name the file already has is refused instead of overwriting it', async () => {
  const h = await harness();
  try {
    await h.write('.dsh/mcp.json', { mcpServers: { db: { command: 'theirs' } } });
    await assert.rejects(() => h.service.saveProjectServerToSource(h.project, 'dsh', db), (error) => error.code === 'name-conflict');
  } finally {
    await h.cleanup();
  }
});

test('files: a file with comments is listed but never rewritten', async () => {
  const h = await harness();
  try {
    await h.write('.vscode/mcp.json', '{\n  // team servers\n  "servers": { "db": { "type": "stdio", "command": "x" } }\n}\n');
    const view = await h.service.getProjectState(h.project);
    assert.equal(view.servers[0].serverName, 'db');
    assert.equal(view.sources.find((source) => source.id === 'vscode').comments, true);
    await assert.rejects(() => h.service.deleteProjectServerFromSource(h.project, 'vscode', 'db'), (error) => error.code === 'has-comments');
  } finally {
    await h.cleanup();
  }
});

test('files: editing a parked repository server keeps it parked', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServerToSource(h.project, 'dsh', db);
    const id = (await h.service.getProjectState(h.project)).servers[0].id;
    await h.service.setProjectEnabled(h.project, id, false);
    const view = await h.service.editProjectServerFromSource(h.project, 'dsh', 'db', { ...db, command: 'db-mcp-2' });
    assert.equal(view.servers[0].trustState, 'approved');
    assert.equal(view.servers[0].enabled, false);
  } finally {
    await h.cleanup();
  }
});

test('files: the approval view lists every variable a repository server reads', async () => {
  const h = await harness();
  try {
    await h.write('.dsh/mcp.json', { mcpServers: { web: { type: 'http', url: 'https://h/mcp?u=${USER}', headers: { 'X-Trace': '${AWS_SECRET_ACCESS_KEY}' } } } });
    const [server] = (await h.service.getProjectState(h.project)).servers;
    assert.deepEqual(server.variables, ['AWS_SECRET_ACCESS_KEY', 'USER']);
    assert.equal(server.server.headers['X-Trace'], '${AWS_SECRET_ACCESS_KEY}', 'file values are shown as written');
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------------ masking

test('masking: references are shown, literals are hidden, and a renamed hidden value is refused', async () => {
  const h = await harness();
  try {
    const saved = await h.service.saveGlobal({ ...db, env: { TOKEN: '${TOKEN}', SECRET: 'literal' } });
    assert.equal(saved.server.env.TOKEN, '${TOKEN}');
    assert.equal(saved.server.env.SECRET, MASKED_VALUE);
    await assert.rejects(
      () => h.service.saveGlobal({ ...saved.server, id: saved.id, env: { RENAMED: MASKED_VALUE } }),
      (error) => error.code === 'invalid' && error.details[0].field === 'env.RENAMED',
    );
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------------- import

test('import: a pasted document is converted on the Host, entry by entry', async () => {
  const h = await harness();
  try {
    const text = `{
      // pasted from an editor
      "mcpServers": {
        "git": { "command": "npx", "args": ["-y", "git-mcp"] },
        "web": { "type": "http", "url": "https://h/mcp" },
        "old": { "type": "sse", "url": "https://h/sse" },
        "broken": null,
      }
    }`;
    const out = await h.service.importGlobal(text);
    assert.equal(out.imported, 2);
    assert.equal(out.failed, 2);
    assert.match(out.results.find((item) => item.key === 'old').error, /SSE/);
    assert.deepEqual((await h.service.getState()).global.map((server) => server.serverName).sort(), ['git', 'web']);
  } finally {
    await h.cleanup();
  }
});

// --------------------------------------------------------------- resolution

test('resolution: the home directory is not a project, and a repository root bounds the search', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-rob-home-'));
  try {
    const home = join(dir, 'home');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
    await mkdir(join(home, 'notes', 'a'), { recursive: true });
    assert.equal(await resolveProjectRoot(join(home, 'notes', 'a'), { home }), undefined, 'global tool config in ~ is not a project');
    assert.equal(await resolveProjectRoot(join(home, 'notes'), { home, knownRoots: [home] }), home, 'unless the user named it');

    await writeFile(join(home, 'notes', '.mcp.json'), '{"mcpServers":{}}');
    await mkdir(join(home, 'notes', 'repo', '.git'), { recursive: true });
    await mkdir(join(home, 'notes', 'repo', 'src'), { recursive: true });
    assert.equal(await resolveProjectRoot(join(home, 'notes', 'repo', 'src'), { home }), join(home, 'notes', 'repo'), 'the parent folder config is not inherited');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ schema

test('schema: references in other tools\' spellings are expanded', () => {
  const out = expandRefs(['${env:TOKEN}', '${workspaceFolder}/x', '${userHome}', '${input:key}', '${A:-d}', '${not valid}', '${EMPTY}', '${EMPTY:-d}'], { TOKEN: 't', EMPTY: '' }, { workspaceFolder: '/p', userHome: '/h' });
  assert.deepEqual(out.value, ['t', '/p/x', '/h', '', 'd', '${not valid}', '', 'd'], 'an empty variable is set; a default covers it');
  assert.deepEqual(out.missing, ['input:key']);
  assert.deepEqual(referencedVariables({ command: 'x', args: ['${env:A}', '${workspaceFolder}'], headers: { h: 'Bearer ${B:-x}' } }), ['A', 'B']);
});

test('schema: secret-looking arguments are hidden from summaries', () => {
  assert.deepEqual(redactArgs(['--api-key', 'sk-1', '--token=abc', 'API_KEY=x', '--port', '1', '--key', '${K}']), ['--api-key', '••••', '--token=••••', 'API_KEY=••••', '--port', '1', '--key', '${K}']);
});

test('files: nothing is ever written next to a project file but the file itself', async () => {
  const h = await harness();
  try {
    await h.service.saveProjectServerToSource(h.project, 'dsh', db);
    await h.service.editProjectServerFromSource(h.project, 'dsh', 'db', { ...db, command: 'v2' });
    assert.deepEqual(await readdir(join(h.project, '.dsh')), ['mcp.json']);
  } finally {
    await h.cleanup();
  }
});
