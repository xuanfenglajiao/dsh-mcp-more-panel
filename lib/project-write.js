/**
 * Reading and writing a project's MCP configuration files.
 *
 * The panel edits these files only when the user explicitly adds, edits or
 * removes a server in a named source. Writes are dialect-aware: they keep the
 * table name the file already uses, preserve every field the panel does not
 * model, and never touch a source declared read-only (Codex TOML).
 *
 * A write is refused rather than allowed to lose something:
 *  - a file with comments (JSONC) is not rewritten, because JSON serialisation
 *    would drop them;
 *  - a file that changed on disk after it was read is not overwritten.
 *
 * The layout of the original text is kept: byte order mark, line endings,
 * indentation and the final newline. Key order follows the parsed document.
 *
 * A backup of the previous content goes to the plugin's own directory, never
 * into the repository, and the write is atomic (temporary file + rename).
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DOCUMENT_META, parseDocument, serverNameOf, tableAt } from './project-files.js';

/** Fields the panel's form owns. Everything else in an entry is preserved. */
export const MANAGED_KEYS = ['type', 'command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'headers'];

const BOM = String.fromCharCode(0xfeff);

/** Error with a stable code the service maps onto its own. */
function writeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Read (and, when writing, create) the table at `tablePath`. */
function ensureTable(document, tablePath) {
  let current = document;
  for (const key of tablePath) {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  return current;
}

/** Pick the table a document already uses; default to the source's declared path. */
export function tableName(document, source) {
  if (source?.table) return source.table.join('.');
  for (const name of ['mcpServers', 'servers']) {
    const table = document[name];
    if (table && typeof table === 'object' && !Array.isArray(table)) return name;
  }
  return 'mcpServers';
}

/** A document for a file that does not exist yet; writing it fails if the file appears meanwhile. */
export function emptyDocument() {
  const document = {};
  Object.defineProperty(document, DOCUMENT_META, { value: { missing: true }, enumerable: false });
  return document;
}

/**
 * Read a document.
 * @param {string} path - absolute path.
 * @param {object} [source] - dialect description from sources.js.
 * @returns {Promise<object>}
 */
export async function readDocument(path, source) {
  const text = await readFile(path, 'utf8');
  const { document, errors } = parseDocument(text, source);
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('; '));
  return document;
}

/** Serialise with the conventions of the text the document was read from. */
function serialise(document, meta = {}) {
  const eol = meta.eol ?? '\n';
  let text = JSON.stringify(document, null, meta.indent ?? 2);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  if (meta.finalNewline !== false) text += eol;
  return meta.bom ? BOM + text : text;
}

/** Copy the current content into the backup directory, keeping the newest few per file. */
async function backup(path, backupDir, keep) {
  const folder = join(backupDir, `${createHash('sha1').update(path).digest('hex').slice(0, 10)}-${basename(path)}`);
  await mkdir(folder, { recursive: true });
  await copyFile(path, join(folder, `${Date.now()}.bak`));
  const old = (await readdir(folder)).filter((name) => name.endsWith('.bak')).sort();
  for (const name of old.slice(0, Math.max(0, old.length - keep))) await rm(join(folder, name), { force: true });
  return folder;
}

/**
 * Write a document atomically.
 *
 * @param {string} path - absolute path.
 * @param {object} document - the whole document, as returned by `readDocument` or `emptyDocument`.
 * @param {object} [source] - dialect description.
 * @param {{ backupDir?: string, keepBackups?: number }} [options]
 *   Without `backupDir` no backup is made.
 */
export async function writeDocument(path, document, source, options = {}) {
  if (source?.format === 'toml') throw writeError('read-only', 'this source is read-only (TOML)');
  const meta = document?.[DOCUMENT_META] ?? {};
  if (meta.comments) {
    throw writeError('has-comments', 'the file contains comments, which rewriting it would remove; edit it by hand or import the server into .dsh/mcp.json');
  }
  let current;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const changed = meta.missing ? current !== undefined : meta.original !== undefined && current !== meta.original;
  if (changed) throw writeError('changed-on-disk', 'the file changed on disk after it was read; reload and try again');

  // A newly created source often lives in a directory that does not exist yet.
  await mkdir(dirname(path), { recursive: true });
  if (current !== undefined && options.backupDir) await backup(path, options.backupDir, options.keepBackups ?? 5);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, serialise(document, meta), 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Turn a normalised server into the entry shape a file expects.
 *
 * Only the fields the form owns are produced. VS Code's `servers` format needs
 * an explicit `type` on stdio entries; the portable formats need `type` on HTTP
 * entries (Claude Code treats a bare `url` as a malformed stdio server). Gemini
 * CLI's older `httpUrl` is replaced by `type` + `url`, the spelling it prefers.
 *
 * @param {object} server - normalised server.
 * @param {string} [shape] - dialect shape from sources.js.
 */
export function entryFromServer(server, shape = 'portable') {
  const entry = {};
  if (server.transport === 'stdio') {
    if (shape === 'vscode') entry.type = 'stdio';
    entry.command = server.command;
    if (server.args && server.args.length > 0) entry.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
    if (server.cwd) entry.cwd = server.cwd;
    return entry;
  }
  entry.type = 'http';
  entry.url = server.url;
  if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
  return entry;
}

const tablePaths = (source) => (source?.table ? [source.table] : [['mcpServers'], ['servers']]);

/**
 * The key an entry has in its file. A key that is not a valid serverName is
 * listed under a converted name; this maps the listed name back.
 */
export function resolveEntryKey(document, name, source) {
  for (const tablePath of tablePaths(source)) {
    const table = tableAt(document, tablePath);
    if (!table) continue;
    if (Object.hasOwn(table, name)) return name;
    const converted = Object.keys(table).find((key) => serverNameOf(key) === name);
    if (converted !== undefined) return converted;
  }
  return undefined;
}

/** Read one entry as written in the file, including fields the panel does not model. */
export function getEntry(document, name, source) {
  const key = resolveEntryKey(document, name, source);
  if (key === undefined) return undefined;
  for (const tablePath of tablePaths(source)) {
    const table = tableAt(document, tablePath);
    if (table && Object.hasOwn(table, key)) return table[key];
  }
  return undefined;
}

/**
 * Add or replace one entry, preserving every unmodelled field of the original.
 *
 * This is the key difference from "just write what the form produced": an
 * entry from VS Code carrying `dev`, `sandbox`, `oauth` or `${input:...}`
 * keeps those fields after the user edits only the command. Clearing a field
 * in the form removes it, because all managed keys are replaced as a group.
 *
 * When a server is renamed, `originalOverride` carries the previous entry's
 * unknown fields into the new key.
 *
 * @param {object} document - mutated in place and returned.
 * @param {string} name - entry key.
 * @param {object} definition - generated entry body.
 * @param {object} [source] - dialect description.
 * @param {object} [originalOverride] - entry object to merge onto (rename case).
 */
export function upsertEntry(document, name, definition, source, originalOverride) {
  const table = ensureTable(document, source?.table ?? [tableName(document, source)]);
  const existing = table[name] && typeof table[name] === 'object' && !Array.isArray(table[name]) ? table[name] : {};
  const base = originalOverride && typeof originalOverride === 'object' && !Array.isArray(originalOverride)
    ? { ...existing, ...originalOverride }
    : existing;
  const merged = { ...base };
  for (const key of MANAGED_KEYS) delete merged[key];
  Object.assign(merged, definition);
  table[name] = merged;
  return document;
}

/**
 * Remove one entry from the declared table, by its key or its listed name.
 * @param {object} document - mutated in place and returned.
 * @param {string} name - entry key or converted serverName.
 * @param {object} [source] - dialect description.
 * @returns {boolean} whether an entry was removed.
 */
export function removeEntry(document, name, source) {
  const key = resolveEntryKey(document, name, source);
  if (key === undefined) return false;
  for (const tablePath of tablePaths(source)) {
    const table = tableAt(document, tablePath);
    if (table && Object.hasOwn(table, key)) {
      delete table[key];
      return true;
    }
  }
  return false;
}
