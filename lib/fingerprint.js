/**
 * Trust fingerprints for project-supplied servers.
 *
 * A fingerprint binds an approval to the exact thing that will run: project
 * path, name, transport and every field that decides what is executed or
 * contacted. Any change produces a different fingerprint, so an approval can
 * never silently carry over to a modified definition.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Normalize a directory into a comparison key. Windows paths compare
 * case-insensitively and without trailing separators.
 * @param {string} path - absolute or relative directory.
 */
export function rootKey(path) {
  let key = resolve(path);
  if (process.platform === 'win32') key = key.toLowerCase();
  return key;
}

/** Stable JSON: object keys sorted at every depth. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint one server definition for one project. Variable references are
 * hashed as written, not as expanded: a changed environment variable does not
 * change the fingerprint (documented limitation of the trust model).
 * @param {string} projectRoot - project directory.
 * @param {object} server - normalized server.
 * @returns {string} lowercase hex SHA-256.
 */
export function fingerprintServer(projectRoot, server) {
  const material = {
    root: rootKey(projectRoot),
    serverName: server.serverName,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? null,
    cwd: server.cwd ?? null,
    env: server.env ?? null,
    url: server.url ?? null,
    headers: server.headers ?? null,
  };
  return createHash('sha256').update(canonicalize(material)).digest('hex');
}
