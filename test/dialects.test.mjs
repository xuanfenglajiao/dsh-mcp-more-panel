import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, sourceById } from '../lib/sources.js';
import { readProjectFiles, parseDocument, convertEntry } from '../lib/project-files.js';
import { parseToml } from '../lib/toml.js';
import { entryFromServer, upsertEntry, readDocument, writeDocument } from '../lib/project-write.js';
import { createService } from '../lib/service.js';

async function project(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-dialect-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function fakeClient() {
  return {
    load: async () => ({ ok: true, mod: { Config: (config) => config } }),
    mount: () => ({ settled: Promise.resolve({ ok: true }), dispose() {} }),
  };
}

async function serviceFor(root) {
  const state = await mkdtemp(join(tmpdir(), 'mmp-dialect-state-'));
  const service = createService({
    storeFile: join(state, 'store.json'),
    rootCtx: {},
    client: fakeClient(),
    toolCount: () => 1,
    toolNames: () => [],
    listWorkspaces: () => [root],
  });
  await service.init();
  return {
    service,
    async cleanup() {
      service.dispose();
      await rm(state, { recursive: true, force: true });
    },
  };
}

const STDIO = { serverName: 'db', transport: 'stdio', command: 'db-mcp', args: ['--x'], env: { TOKEN: '${T}' } };

// ------------------------------------------------------------------ dialects

test('dialects: every declared source has a format, table, shape and capabilities', () => {
  for (const source of SOURCES) {
    assert.ok(['json', 'toml'].includes(source.format), source.id);
    assert.ok(Array.isArray(source.table) && source.table.length > 0, source.id);
    assert.ok(['portable', 'vscode', 'gemini', 'zcode', 'codex'].includes(source.shape), source.id);
    assert.ok(source.caps && typeof source.caps.add === 'boolean', source.id);
  }
  assert.equal(SOURCES[SOURCES.length - 1].id, 'dsh', 'DSH wins on duplicate names');
});

test('dialects: Codex is the only TOML source and is read-only', () => {
  const toml = SOURCES.filter((source) => source.format === 'toml');
  assert.deepEqual(toml.map((source) => source.id), ['codex']);
  assert.deepEqual(sourceById('codex').caps, { add: false, edit: false, delete: false });
});

test('dialects: Codex TOML is parsed into a server candidate', async () => {
  const root = await project({
    '.codex/config.toml': '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n\n[mcp_servers.github.env]\nGITHUB_TOKEN = "x"\n',
  });
  try {
    const { servers, files } = await readProjectFiles(root, { source: 'codex' });
    assert.equal(files[0].exists, true);
    assert.equal(files[0].format, 'toml');
    assert.equal(servers.length, 1);
    assert.equal(servers[0].serverName, 'github');
    assert.equal(servers[0].command, 'npx');
    assert.deepEqual(servers[0].args, ['-y', '@modelcontextprotocol/server-github']);
    assert.equal(servers[0].env.GITHUB_TOKEN, 'x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: Gemini settings.json only reads the mcpServers table', async () => {
  const root = await project({
    '.gemini/settings.json': { mcpServers: { db: { command: 'db-mcp' } }, general: { vimMode: true }, model: { name: 'x' } },
  });
  try {
    const { servers } = await readProjectFiles(root, { source: 'gemini' });
    assert.deepEqual(servers.map((server) => server.serverName), ['db']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: ZCode mcp.servers nested table is read', async () => {
  const root = await project({
    '.zcode/config.json': { mcp: { servers: { db: { command: 'db-mcp', env: {} } } }, other: { keep: true } },
  });
  try {
    const { servers } = await readProjectFiles(root, { source: 'zcode' });
    assert.deepEqual(servers.map((server) => server.serverName), ['db']);
    assert.equal(servers[0].source, '.zcode/config.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: pi .pi/mcp.json is read', async () => {
  const root = await project({ '.pi/mcp.json': { mcpServers: { memory: { command: 'npx', args: ['-y', 'mem'] } } } });
  try {
    const { servers } = await readProjectFiles(root, { source: 'pi' });
    assert.deepEqual(servers.map((server) => server.serverName), ['memory']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: VS Code "servers" table with ${input:...} stays readable', async () => {
  const root = await project({
    '.vscode/mcp.json': {
      servers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { TOKEN: '${input:gh-token}' } } },
      inputs: [{ id: 'gh-token', type: 'promptString', password: true }],
    },
  });
  try {
    const { servers } = await readProjectFiles(root, { source: 'vscode' });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].transport, 'stdio');
    assert.equal(servers[0].env.TOKEN, '${input:gh-token}', 'the reference is kept verbatim, never expanded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: a disable flag in any spelling is respected', () => {
  assert.equal(convertEntry('a', { command: 'x', disabled: true }).server.enabled, false);
  assert.equal(convertEntry('b', { command: 'x', enable: false }).server.enabled, false);
  assert.equal(convertEntry('c', { command: 'x', enable: true }).server.enabled, true);
});

test('dialects: damaged documents are reported, not thrown', async () => {
  const root = await project({ '.mcp.json': '{ broken' });
  try {
    const { files } = await readProjectFiles(root, { source: 'claude' });
    assert.equal(files[0].errors[0].code, 'json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('toml: inline tables, multi-line arrays and multi-line strings are read', () => {
  const doc = parseToml([
    '[mcp_servers.github]',
    'command = "npx" # comment',
    'args = [',
    '  "-y",',
    '  "@modelcontextprotocol/server-github", # trailing comma',
    ']',
    'env = { "GITHUB_TOKEN" = "x", nested.key = 1 }',
    'note = """',
    'two',
    'lines"""',
    'startup_timeout_sec = 1_0',
  ].join('\n'));
  const github = doc.mcp_servers.github;
  assert.deepEqual(github.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(github.env, { GITHUB_TOKEN: 'x', nested: { key: 1 } });
  assert.equal(github.note, 'two\nlines');
  assert.equal(github.startup_timeout_sec, 10);
});

test('toml: unsupported or broken syntax throws with a line number', () => {
  assert.throws(() => parseToml('[[servers]]\ncommand = "x"'), /line 1: array tables/);
  assert.throws(() => parseToml('a = "x"\nb = [1, 2'), /line 2/);
  assert.throws(() => parseToml('a = "x" junk'), /unexpected text/);
});

test('dialects: Codex inline env, headers, bearer token and timeouts are understood', async () => {
  const root = await project({
    '.codex/config.toml': [
      '[mcp_servers.gh]',
      'command = "npx"',
      'args = ["-y", "gh"]',
      'env = { "GITHUB_TOKEN" = "x" }',
      'tool_timeout_sec = 30',
      '[mcp_servers.web]',
      'url = "https://h/mcp"',
      'bearer_token_env_var = "WEB_TOKEN"',
      'http_headers = { "X-Team" = "core" }',
      'env_http_headers = { "X-Key" = "WEB_KEY" }',
      '[mcp_servers.off]',
      'command = "x"',
      'enabled = false',
    ].join('\n'),
  });
  try {
    const { servers } = await readProjectFiles(root, { source: 'codex' });
    const byName = Object.fromEntries(servers.map((server) => [server.serverName, server]));
    assert.deepEqual(byName.gh.env, { GITHUB_TOKEN: 'x' });
    assert.equal(byName.gh.toolCallTimeoutMs, 30000);
    assert.equal(byName.web.transport, 'streamable-http');
    assert.deepEqual(byName.web.headers, { 'X-Team': 'core', 'X-Key': '${WEB_KEY}', Authorization: 'Bearer ${WEB_TOKEN}' });
    assert.equal(byName.off.enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: Gemini url, the older httpUrl and an explicit sse type are told apart', async () => {
  const root = await project({
    '.gemini/settings.json': { mcpServers: { plain: { url: 'https://h/a' }, older: { httpUrl: 'https://h/b' }, typed: { url: 'https://h/c', type: 'sse' } } },
  });
  try {
    const { servers, files } = await readProjectFiles(root, { source: 'gemini' });
    assert.deepEqual(servers.map((server) => [server.serverName, server.transport, server.url]), [
      ['plain', 'streamable-http', 'https://h/a'],
      ['older', 'streamable-http', 'https://h/b'],
    ]);
    assert.equal(files[0].errors[0].code, 'transport', 'the SSE entry is reported, not guessed');
    assert.deepEqual(entryFromServer(servers[1], sourceById('gemini').shape), { type: 'http', url: 'https://h/b' }, 'written back in the current spelling');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: Codex env_vars forwards the named variables', async () => {
  const root = await project({ '.codex/config.toml': '[mcp_servers.gh]\ncommand = "gh-mcp"\nenv_vars = ["GITHUB_TOKEN", { name = "GH_HOST" }]\n' });
  try {
    const { servers } = await readProjectFiles(root, { source: 'codex' });
    assert.deepEqual(servers[0].env, { GITHUB_TOKEN: '${GITHUB_TOKEN}', GH_HOST: '${GH_HOST}' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dialects: JSONC comments, trailing commas and a byte order mark are accepted', async () => {
  const bom = String.fromCharCode(0xfeff);
  const root = await project({
    '.vscode/mcp.json': `${bom}{\n  // a comment\n  "servers": {\n    "db": { "type": "stdio", "command": "db-mcp", /* inline */ },\n  },\n}\n`,
    '.mcp.json': `${bom}{"mcpServers":{"a":{"command":"x"}}}`,
  });
  try {
    const { servers, files } = await readProjectFiles(root);
    assert.deepEqual(servers.map((server) => server.serverName).sort(), ['a', 'db']);
    assert.equal(files.find((file) => file.source === 'vscode').comments, true);
    assert.equal(files.find((file) => file.source === 'claude').comments, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ writes

test('write: an entry generated for VS Code carries type: stdio', () => {
  assert.deepEqual(entryFromServer(STDIO, 'vscode'), {
    type: 'stdio', command: 'db-mcp', args: ['--x'], env: { TOKEN: '${T}' },
  });
  assert.equal(entryFromServer(STDIO, 'portable').type, undefined);
});

test('write: upsert merges onto the original entry and preserves unknown fields', () => {
  const vscode = sourceById('vscode');
  const document = {
    servers: {
      github: {
        type: 'stdio', command: 'old', args: ['-y', 'old'],
        env: { TOKEN: '${input:gh-token}' },
        dev: { watch: 'src/**/*.ts' },
        sandboxEnabled: true,
        includeTools: ['read_only'],
      },
    },
    inputs: [{ id: 'gh-token' }],
  };
  upsertEntry(document, 'github', entryFromServer({ ...STDIO, serverName: 'github' }, vscode.shape), vscode);
  const entry = document.servers.github;
  assert.equal(entry.command, 'db-mcp', 'the edited field changed');
  assert.deepEqual(entry.args, ['--x']);
  assert.equal(entry.type, 'stdio', 'VS Code still needs its type');
  assert.deepEqual(entry.dev, { watch: 'src/**/*.ts' }, 'dev survived');
  assert.equal(entry.sandboxEnabled, true, 'sandbox survived');
  assert.deepEqual(entry.includeTools, ['read_only'], 'includeTools survived');
  assert.equal(entry.env.TOKEN, '${T}', 'the managed env was replaced as a group');
  assert.deepEqual(document.inputs, [{ id: 'gh-token' }], 'top-level inputs untouched');
});

test('write: clearing a managed field removes it instead of leaving the old value', () => {
  const document = { mcpServers: { db: { command: 'x', args: ['old'], env: { K: 'v' } } } };
  upsertEntry(document, 'db', entryFromServer({ transport: 'stdio', command: 'y', args: [], env: {} }), sourceById('dsh'));
  assert.deepEqual(document.mcpServers.db, { command: 'y' }, 'args and env are gone, not stale');
});

test('write: ZCode nested table is created and other keys survive', () => {
  const zcode = sourceById('zcode');
  const document = { other: { keep: true } };
  upsertEntry(document, 'db', entryFromServer(STDIO, zcode.shape), zcode);
  assert.equal(document.mcp.servers.db.command, 'db-mcp');
  assert.deepEqual(document.other, { keep: true });
});

test('write: a read-only dialect refuses writeDocument', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mmp-ro-'));
  try {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[mcp_servers.a]\ncommand = "x"\n');
    await assert.rejects(() => writeDocument(path, {}, sourceById('codex')), /read-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ service

test('service: writing into a read-only source is refused with a clear code', async () => {
  const root = await project({ '.codex/config.toml': '[mcp_servers.a]\ncommand = "x"\n' });
  const h = await serviceFor(root);
  try {
    await assert.rejects(
      () => h.service.saveProjectServerToSource(root, 'codex', STDIO),
      (error) => error.code === 'read-only' && /read-only/.test(error.message),
    );
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('service: importing from a read-only source writes .dsh/mcp.json only', async () => {
  const root = await project({ '.codex/config.toml': '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh"]\n' });
  const h = await serviceFor(root);
  try {
    const view = await h.service.importProjectServer(root, 'codex', 'github');
    const dsh = JSON.parse(await readFile(join(root, '.dsh', 'mcp.json'), 'utf8'));
    assert.equal(dsh.mcpServers.github.command, 'npx');
    assert.equal(await readFile(join(root, '.codex', 'config.toml'), 'utf8'), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh"]\n', 'the TOML file is untouched');
    assert.equal(view.servers.find((server) => server.serverName === 'github').source, '.dsh/mcp.json');
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('service: editing a VS Code entry keeps dev/sandbox and can rename', async () => {
  const root = await project({
    '.vscode/mcp.json': {
      servers: { github: { type: 'stdio', command: 'old', args: ['-y', 'old'], dev: { watch: 'src/**' }, sandboxEnabled: true } },
      inputs: [{ id: 'x' }],
    },
  });
  const h = await serviceFor(root);
  try {
    await h.service.editProjectServerFromSource(root, 'vscode', 'github', { ...STDIO, serverName: 'git2' });
    const document = JSON.parse(await readFile(join(root, '.vscode', 'mcp.json'), 'utf8'));
    assert.equal(document.servers.github, undefined, 'the old key is gone');
    assert.equal(document.servers.git2.command, 'db-mcp');
    assert.deepEqual(document.servers.git2.dev, { watch: 'src/**' }, 'dev survived a rename+edit');
    assert.equal(document.servers.git2.sandboxEnabled, true);
    assert.deepEqual(document.inputs, [{ id: 'x' }]);
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('service: sources are reported with capabilities and existence', async () => {
  const root = await project({
    '.mcp.json': { mcpServers: {} },
    '.codex/config.toml': '[mcp_servers.a]\ncommand = "x"\n',
  });
  const h = await serviceFor(root);
  try {
    const view = await h.service.getProjectState(root);
    assert.equal(view.sources.length, 9);
    assert.equal(view.sources.find((source) => source.id === 'codex').capabilities.add, false);
    assert.equal(view.sources.find((source) => source.id === 'codex').exists, true);
    assert.equal(view.sources.find((source) => source.id === 'pi').exists, false);
    assert.equal(view.files.find((file) => file.source === 'codex').format, 'toml');
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('service: parseDocument handles both dialects without a caller-side branch', () => {
  const json = parseDocument('{"mcpServers":{"a":{"command":"x"}}}', sourceById('claude'));
  assert.equal(json.errors.length, 0);
  assert.equal(json.document.mcpServers.a.command, 'x');
  const toml = parseDocument('[mcp_servers.a]\ncommand = "x"\n', sourceById('codex'));
  assert.equal(toml.errors.length, 0);
  assert.equal(toml.document.mcp_servers.a.command, 'x');
});
