import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryFromServer, readDocument, removeEntry, resolveEntryKey, tableName, upsertEntry, writeDocument } from '../lib/project-write.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'mmp-write-'));
}

test('tableName follows the document and defaults to mcpServers', () => {
  assert.equal(tableName({ mcpServers: {} }), 'mcpServers');
  assert.equal(tableName({ servers: {} }), 'servers');
  assert.equal(tableName({ servers: {}, mcpServers: {} }), 'mcpServers', 'the portable name wins when both exist');
  assert.equal(tableName({}), 'mcpServers');
});

test('upsertEntry creates the table and replaces an existing entry', () => {
  const doc = {};
  upsertEntry(doc, 'db', { command: 'a' });
  assert.deepEqual(doc, { mcpServers: { db: { command: 'a' } } });
  upsertEntry(doc, 'db', { command: 'b' });
  assert.deepEqual(doc.mcpServers.db, { command: 'b' });
  assert.equal(Object.keys(doc.mcpServers).length, 1);
});

test('upsertEntry respects a document that uses "servers"', () => {
  const doc = { servers: { existing: { command: 'x' } }, inputs: [] };
  upsertEntry(doc, 'new', { command: 'y' });
  assert.deepEqual(doc.servers, { existing: { command: 'x' }, new: { command: 'y' } });
  assert.deepEqual(doc.inputs, [], 'other top-level keys are untouched');
  assert.equal(doc.mcpServers, undefined, 'no second table is created');
});

test('removeEntry removes from whichever table holds the name', () => {
  const doc = { servers: { a: { command: 'x' }, b: { command: 'y' } } };
  assert.equal(removeEntry(doc, 'a'), true);
  assert.deepEqual(Object.keys(doc.servers), ['b']);
  assert.equal(removeEntry(doc, 'missing'), false);
  const portable = { mcpServers: { c: {} } };
  assert.equal(removeEntry(portable, 'c'), true);
  assert.deepEqual(portable.mcpServers, {});
});

test('entryFromServer writes the portable shape and invents nothing', () => {
  assert.deepEqual(
    entryFromServer({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: 'C:\\w' }),
    { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: 'C:\\w' },
  );
  assert.deepEqual(entryFromServer({ transport: 'stdio', command: 'node', args: [], env: {} }), { command: 'node' });
  assert.deepEqual(
    entryFromServer({ transport: 'streamable-http', url: 'http://h/mcp', headers: { Authorization: 'Bearer x' } }),
    { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer x' } },
  );
});

test('writeDocument keeps the whole document, backs up outside the project and stays atomic', async () => {
  const dir = await tempDir();
  try {
    const project = join(dir, 'project');
    const backups = join(dir, 'backups');
    await mkdir(project, { recursive: true });
    const path = join(project, '.mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: { old: { command: 'x' } }, other: { keep: true } }, null, 4));
    const document = await readDocument(path);
    upsertEntry(document, 'new', { command: 'y' });
    await writeDocument(path, document, undefined, { backupDir: backups });

    const text = await readFile(path, 'utf8');
    const after = JSON.parse(text);
    assert.deepEqual(after.other, { keep: true }, 'unrelated top-level keys survive');
    assert.equal(after.mcpServers.new.command, 'y');
    assert.equal(after.mcpServers.old.command, 'x');
    assert.match(text, /\n {4}"mcpServers"/, 'the original four-space indentation is kept');

    assert.deepEqual(await readdir(project), ['.mcp.json'], 'nothing else is left in the project: no .bak, no temporary file');
    const [folder] = await readdir(backups);
    const [file] = await readdir(join(backups, folder));
    const backup = JSON.parse(await readFile(join(backups, folder, file), 'utf8'));
    assert.equal(backup.mcpServers.new, undefined, 'the backup holds the content before the write');
    assert.equal(backup.mcpServers.old.command, 'x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeDocument keeps a byte order mark and CRLF line endings', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, '.mcp.json');
    const bom = String.fromCharCode(0xfeff);
    await writeFile(path, `${bom}{\r\n  "mcpServers": {}\r\n}\r\n`);
    const document = await readDocument(path);
    upsertEntry(document, 'a', { command: 'x' });
    await writeDocument(path, document);
    const text = await readFile(path, 'utf8');
    assert.ok(text.startsWith(bom), 'the mark is kept');
    assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'every line ends with CRLF');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeDocument refuses to drop comments or to overwrite a change made meanwhile', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'mcp.json');
    await writeFile(path, '{\n  // keep me\n  "servers": {}\n}\n');
    const commented = await readDocument(path);
    await assert.rejects(() => writeDocument(path, commented), (error) => error.code === 'has-comments');

    await writeFile(path, '{"mcpServers":{}}');
    const document = await readDocument(path);
    await writeFile(path, '{"mcpServers":{"other":{"command":"y"}}}');
    upsertEntry(document, 'a', { command: 'x' });
    await assert.rejects(() => writeDocument(path, document), (error) => error.code === 'changed-on-disk');
    assert.match(await readFile(path, 'utf8'), /other/, 'the newer content is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an entry whose key had to be converted is found by its listed name', () => {
  const doc = { mcpServers: { 'my server': { command: 'x', extra: 1 } } };
  assert.equal(resolveEntryKey(doc, 'my_server'), 'my server');
  assert.equal(removeEntry(doc, 'my_server'), true);
  assert.deepEqual(doc.mcpServers, {});
});

test('writeDocument creates a missing file, including its parent directory', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, 'new', '.mcp.json');
    await writeDocument(path, { mcpServers: { a: { command: 'x' } } });
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(written.mcpServers.a.command, 'x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file that is not valid JSON is refused before anything is written', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, '.mcp.json');
    await writeFile(path, '{ "mcpServers": { broken ');
    await assert.rejects(() => readDocument(path), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
