/**
 * Project-supplied server declarations.
 *
 * A repository can ship MCP server definitions in files other tools understand.
 * Nothing read here is ever executed by this module: results are candidates that
 * need approval (see fingerprint.js and service.js) before they are mounted.
 *
 * Each source declares its own dialect in sources.js. This module reads the
 * declared table out of the document, tolerates fields it does not model, and
 * reports damage instead of guessing.
 *
 * JSON sources are read as JSONC: comments, trailing commas and a byte order
 * mark are accepted, because VS Code and Gemini CLI allow them and Windows
 * editors add the mark. What the original text looked like is kept as
 * `DOCUMENT_META` on the parsed document so a write can respect it.
 */

import { readFile } from 'node:fs/promises';
import { canonicalize } from './fingerprint.js';
import { SERVER_NAME_RE, describeEndpoint, normalizeServer } from './schema.js';
import { ALL_SOURCES, SOURCES, selectedSources, sourcePath } from './sources.js';
import { parseToml } from './toml.js';

/**
 * Project-relative files that mark a directory as a project and may declare
 * servers. Derived from the source list so a new source is picked up here too.
 */
export const PROJECT_FILES = SOURCES.map((source) => source.path);

/** Non-enumerable key under which a parsed document carries facts about its text. */
export const DOCUMENT_META = Symbol('mcp-more-panel.document');

const BOM = String.fromCharCode(0xfeff);
const HTTP_TYPES = new Set(['http', 'streamable-http', 'streamablehttp', 'streamable_http']);

/** Turn an arbitrary key into a valid serverName, reporting when it changed. */
export function slugName(key) {
  return String(key)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** The serverName an entry key is shown under. */
export function serverNameOf(key) {
  return SERVER_NAME_RE.test(key) ? key : slugName(key);
}

/** Read the table at `tablePath`, or undefined when it is not an object. */
export function tableAt(document, tablePath) {
  let current = document;
  for (const key of tablePath) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current : undefined;
}

/**
 * Remove comments and trailing commas from JSONC text, outside strings.
 * Removed characters become spaces so error positions stay meaningful.
 * @returns {{ text: string, comments: boolean }}
 */
export function stripJsonc(text) {
  let out = '';
  let comments = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      comments = true;
      while (i < text.length && text[i] !== '\n') {
        out += text[i] === '\r' ? '\r' : ' ';
        i += 1;
      }
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      comments = true;
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop;
      continue;
    }
    out += char;
    i += 1;
  }
  // Trailing commas: a comma followed only by blanks before a closing bracket.
  const cleaned = out.replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g, (match, string, closing) => (string !== undefined ? string : ` ${closing}`));
  return { text: cleaned, comments };
}

/** How the original text was laid out, so a rewrite keeps the same conventions. */
function describeText(text) {
  const indent = text.match(/\n([ \t]+)\S/);
  return {
    bom: text.startsWith(BOM),
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    indent: indent ? (indent[1].startsWith('\t') ? '\t' : Math.min(indent[1].length, 8)) : 2,
    finalNewline: /\n$/.test(text),
  };
}

/**
 * Convert one entry into the panel's server shape.
 *
 * The entry may come from any of the supported dialects. Fields the panel does
 * not model are ignored here but stay in the file, because writes merge onto
 * the original entry rather than replacing it (see project-write.js).
 *
 * @param {string} key - entry key.
 * @param {unknown} def - entry body.
 * @param {object} [source] - dialect description.
 * @returns {{ server?: object, errors: object[], warnings: string[] }}
 */
export function convertEntry(key, def, source) {
  const warnings = [];
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    return { errors: [{ field: key, code: 'type', message: 'entry must be an object' }], warnings };
  }
  const serverName = serverNameOf(key);
  if (serverName === '') {
    return { errors: [{ field: key, code: 'serverName', message: 'entry name cannot be converted to a valid serverName' }], warnings };
  }
  if (serverName !== key) warnings.push(`name "${key}" was converted to "${serverName}"`);

  const shape = source?.shape ?? 'portable';
  const typeText = typeof def.type === 'string' ? def.type.toLowerCase() : undefined;
  let candidate;
  if (typeof def.command === 'string' && typeText !== 'sse' && !HTTP_TYPES.has(typeText)) {
    candidate = { serverName, transport: 'stdio', command: def.command, args: def.args, env: def.env, cwd: def.cwd };
  } else if (typeof def.httpUrl === 'string') {
    // Gemini CLI's older spelling of a streamable HTTP endpoint.
    candidate = { serverName, transport: 'streamable-http', url: def.httpUrl, headers: def.headers };
  } else if (typeof def.url === 'string') {
    // Without a type every dialect (Gemini CLI included) tries streamable HTTP first.
    if (typeText === 'sse') {
      return { errors: [{ field: key, code: 'transport', message: 'SSE transport is not supported by the MCP client' }], warnings };
    }
    candidate = { serverName, transport: 'streamable-http', url: def.url, headers: def.headers };
  } else {
    return { errors: [{ field: key, code: 'shape', message: 'entry has neither command nor url' }], warnings };
  }

  if (shape === 'codex') {
    candidate.headers = codexHeaders(def, candidate.headers);
    if (candidate.transport === 'stdio') candidate.env = codexEnv(def, candidate.env);
    if (typeof def.tool_timeout_sec === 'number') candidate.toolCallTimeoutMs = Math.round(def.tool_timeout_sec * 1000);
  } else if (typeof def.timeout === 'number') {
    candidate.toolCallTimeoutMs = def.timeout;
  }
  // Dialects disagree on the disable flag; respect every spelling.
  const enabled = !(def.disabled === true || def.enable === false || def.enabled === false);
  const result = normalizeServer({ ...candidate, enabled });
  if (!result.ok) return { errors: result.errors, warnings };
  return { server: result.value, errors: [], warnings };
}

/** Codex `env_vars` forwards named variables from the parent; express each as a reference. */
function codexEnv(def, env) {
  const out = { ...(env && typeof env === 'object' && !Array.isArray(env) ? env : {}) };
  for (const item of Array.isArray(def.env_vars) ? def.env_vars : []) {
    const name = typeof item === 'string' ? item : item && typeof item.name === 'string' ? item.name : undefined;
    if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && out[name] === undefined) out[name] = `\${${name}}`;
  }
  return out;
}

/** Codex spells headers three ways; fold them into one map of references and literals. */
function codexHeaders(def, headers) {
  const out = { ...(headers && typeof headers === 'object' ? headers : {}) };
  if (def.http_headers && typeof def.http_headers === 'object') Object.assign(out, def.http_headers);
  if (def.env_http_headers && typeof def.env_http_headers === 'object') {
    for (const [name, variable] of Object.entries(def.env_http_headers)) {
      if (typeof variable === 'string' && variable !== '') out[name] = `\${${variable}}`;
    }
  }
  if (typeof def.bearer_token_env_var === 'string' && def.bearer_token_env_var !== '') {
    out.Authorization = `Bearer \${${def.bearer_token_env_var}}`;
  }
  return out;
}

/** Parse a document according to its source dialect. */
export function parseDocument(text, source) {
  if (source?.format === 'toml') {
    let doc;
    try {
      doc = parseToml(text);
    } catch (error) {
      return { document: {}, errors: [{ field: '', code: 'toml', message: String(error?.message ?? error) }] };
    }
    return { document: doc, errors: [] };
  }
  const raw = String(text);
  const body = raw.startsWith(BOM) ? raw.slice(1) : raw;
  const { text: plain, comments } = stripJsonc(body);
  let json;
  try {
    json = JSON.parse(plain);
  } catch (error) {
    return { document: {}, errors: [{ field: '', code: 'json', message: `not valid JSON: ${String(error?.message ?? error)}` }] };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { document: {}, errors: [{ field: '', code: 'shape', message: 'top level must be an object' }] };
  }
  Object.defineProperty(json, DOCUMENT_META, { value: { ...describeText(raw), comments, original: raw }, enumerable: false });
  return { document: json, errors: [] };
}

/** Kept for callers that parse a standalone portable JSON document. */
export function parseMcpJson(text) {
  const { document, errors } = parseDocument(text, { format: 'json', table: ['mcpServers'] });
  if (errors.length > 0) return { servers: [], errors };
  const table = tableAt(document, ['mcpServers']) ?? tableAt(document, ['servers']);
  if (!table) return { servers: [], errors: [{ field: '', code: 'shape', message: 'expected an "mcpServers" object' }] };
  const servers = [];
  const collected = [];
  for (const [key, def] of Object.entries(table)) {
    const converted = convertEntry(key, def);
    if (converted.server) servers.push({ ...converted.server, warnings: converted.warnings });
    for (const error of converted.errors) collected.push({ ...error, key });
  }
  return { servers, errors: collected };
}

/**
 * Read the selected sources of a project.
 *
 * A name declared in several files is resolved the way the sources are ordered:
 * the last one wins. That precedence is deliberate, but it must not be silent —
 * every name that appears more than once is reported in `duplicates`.
 *
 * Each server carries `fileKey`, the key it has in its file, which differs from
 * `serverName` when the key had to be converted.
 *
 * @param {string} root - project directory.
 * @param {{ readFile?: typeof readFile, source?: string }} [deps]
 *   `source` is `all` or one source id.
 * @returns {Promise<{ files: object[], servers: object[], duplicates: object[], selection: string }>}
 */
export async function readProjectFiles(root, deps = {}) {
  const read = deps.readFile ?? readFile;
  const selection = deps.source ?? ALL_SOURCES;
  const files = [];
  const merged = new Map();
  const seen = new Map();
  for (const source of selectedSources(selection)) {
    const path = sourcePath(source, { root });
    const meta = {
      path: source.path, source: source.id, label: source.label,
      format: source.format, capabilities: source.caps, note: source.note,
    };
    let text;
    try {
      text = await read(path, 'utf8');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        files.push({ ...meta, exists: false });
        continue;
      }
      files.push({ ...meta, exists: true, error: String(error?.message ?? error) });
      continue;
    }
    const { document, errors: parseErrors } = parseDocument(text, source);
    const table = tableAt(document, source.table);
    const errors = [...parseErrors];
    if (!table && parseErrors.length === 0) {
      errors.push({ field: '', code: 'shape', message: `expected a "${source.table.join('.')}" object` });
    }
    const entries = table ? Object.entries(table) : [];
    files.push({ ...meta, exists: true, count: entries.length, comments: document[DOCUMENT_META]?.comments === true, errors });
    for (const [key, def] of entries) {
      const converted = convertEntry(key, def, source);
      for (const error of converted.errors) errors.push(error);
      if (!converted.server) continue;
      const server = { ...converted.server, warnings: converted.warnings };
      if (!seen.has(server.serverName)) seen.set(server.serverName, []);
      seen.get(server.serverName).push({ source: source.path, sourceId: source.id, server });
      merged.set(server.serverName, { ...server, source: source.path, sourceId: source.id, fileKey: key });
    }
  }
  const duplicates = [];
  for (const [serverName, records] of seen) {
    if (records.length < 2) continue;
    const winner = records[records.length - 1];
    const winnerKey = canonicalize(stripBookkeeping(winner.server));
    duplicates.push({
      serverName,
      winner: winner.source,
      entries: records.map((entry) => ({
        source: entry.source,
        sourceId: entry.sourceId,
        summary: describeEndpoint(entry.server),
        sameAsWinner: canonicalize(stripBookkeeping(entry.server)) === winnerKey,
      })),
    });
  }
  return { files, servers: [...merged.values()], duplicates, selection };
}

/** Drop the fields added while reading, so two definitions can be compared on their content. */
function stripBookkeeping(server) {
  const { warnings, source, sourceId, fileKey, ...rest } = server;
  return rest;
}
