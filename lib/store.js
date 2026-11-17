/**
 * Plugin-owned persistent state, one JSON file outside every project.
 *
 * It lives outside project directories on purpose: trust records and the
 * user's own server definitions must not be editable by a repository.
 *
 * Shape (version 1):
 *   global:   Server[]
 *   projects: { [rootKey]: { root: string, servers: Server[], source?: string } }
 *   trust:    { [rootKey]: { [serverName]: { fingerprint, approvedAt, enabled? } } }
 *
 * `source` is the project's source selection (`all` or one source id).
 *
 * `enabled` in a trust record is the user's day-to-day switch for a server that
 * a repository declares. It is absent in records written before the switch
 * existed and defaults to on. Approval (the fingerprint) and enablement are
 * separate on purpose: revoking the switch must not throw away the approval,
 * and a changed definition must not silently re-enable a server the user parked.
 *
 * A store that cannot be used as-is is never overwritten silently:
 *  - damaged JSON is copied aside (`store.json.corrupt-<time>`) before the
 *    service starts with an empty store, so the next save cannot destroy it;
 *  - a file that cannot be read at all, or was written by a newer version,
 *    makes the store read-only until the cause is fixed and DSH restarts.
 */

import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STORE_VERSION = 1;

export function emptyStore() {
  return { version: STORE_VERSION, global: [], projects: {}, trust: {} };
}

/**
 * Coerce whatever was read into the current shape without throwing, so a
 * damaged section degrades to empty instead of blocking startup.
 * @param {unknown} raw - parsed JSON.
 */
export function coerceStore(raw) {
  const store = emptyStore();
  if (raw === null || typeof raw !== 'object') return store;
  if (Array.isArray(raw.global)) store.global = raw.global.filter((item) => item && typeof item === 'object');
  if (raw.projects && typeof raw.projects === 'object') {
    for (const [key, value] of Object.entries(raw.projects)) {
      if (value && typeof value === 'object' && Array.isArray(value.servers) && typeof value.root === 'string') {
        const project = { root: value.root, servers: value.servers.filter((item) => item && typeof item === 'object') };
        if (typeof value.source === 'string' && value.source !== '') project.source = value.source;
        store.projects[key] = project;
      }
    }
  }
  if (raw.trust && typeof raw.trust === 'object' && !Array.isArray(raw.trust)) {
    for (const [key, value] of Object.entries(raw.trust)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) store.trust[key] = { ...value };
    }
  }
  return store;
}

/**
 * Read the store. A missing file is an empty store.
 * @param {string} file - absolute path.
 * @param {{ now?: () => number }} [options]
 * @returns {Promise<{ store: object, error?: string, readOnly?: boolean, preserved?: string }>}
 *   `readOnly` means the caller must not write; `preserved` is where a damaged file was copied.
 */
export async function loadStore(file, { now = Date.now } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { store: emptyStore() };
    return { store: emptyStore(), readOnly: true, error: `cannot read the store: ${String(error?.message ?? error)}` };
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    const preserved = `${file}.corrupt-${now()}`;
    try {
      await copyFile(file, preserved);
    } catch (copyError) {
      return {
        store: emptyStore(),
        readOnly: true,
        error: `store is not valid JSON and could not be copied aside (${String(copyError?.message ?? copyError)}): ${String(error?.message ?? error)}`,
      };
    }
    return { store: emptyStore(), preserved, error: `store is not valid JSON: ${String(error?.message ?? error)}; the damaged file was kept as ${preserved}` };
  }
  if (raw && typeof raw === 'object' && typeof raw.version === 'number' && raw.version > STORE_VERSION) {
    return {
      store: coerceStore(raw),
      readOnly: true,
      error: `the store was written by a newer version (format ${raw.version}); it is shown read-only so it is not downgraded`,
    };
  }
  return { store: coerceStore(raw) };
}

/**
 * Write atomically: a temporary sibling is written and renamed over the target,
 * so a crash never leaves a truncated store.
 * @param {string} file - absolute path.
 * @param {object} store - store to persist.
 */
export async function saveStore(file, store) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ ...store, version: STORE_VERSION }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Generate a short stable id for a stored server. */
export function newServerId() {
  return `srv_${randomBytes(5).toString('hex')}`;
}
