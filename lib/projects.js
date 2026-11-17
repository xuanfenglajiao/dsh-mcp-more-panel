/**
 * Project resolution: which project a working directory belongs to.
 *
 * Walking up from the working directory, the first directory that matches wins:
 *  1. a directory the user or the workspace registry already named;
 *  2. a directory that carries a recognised MCP document;
 *  3. a repository root (it contains `.git`), which bounds the search so a
 *     repository never inherits a parent folder's configuration.
 *
 * The home directory is never picked up by rule 2 or 3: `~/.cursor/mcp.json`,
 * `~/.gemini/settings.json` and `~/.codex/config.toml` are those tools' global
 * configuration, not a project's. The walk stops there unless the user named
 * the home directory explicitly. No match means "no project": such a session
 * mounts no project servers.
 */

import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_FILES } from './project-files.js';
import { rootKey } from './fingerprint.js';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd - session working directory.
 * @param {{ knownRoots?: Iterable<string>, exists?: (path: string) => Promise<boolean>, home?: string }} [deps]
 * @returns {Promise<string | undefined>} project root as written by the caller's
 * source (not lower-cased), or undefined.
 */
export async function resolveProjectRoot(cwd, deps = {}) {
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  const probe = deps.exists ?? exists;
  const homeKey = rootKey(deps.home ?? homedir());
  const known = new Map();
  for (const root of deps.knownRoots ?? []) known.set(rootKey(root), root);

  let dir = resolve(cwd);
  for (;;) {
    const key = rootKey(dir);
    if (known.has(key)) return known.get(key);
    if (key === homeKey) return undefined;
    for (const relative of PROJECT_FILES) {
      if (await probe(join(dir, relative))) return dir;
    }
    if (await probe(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
