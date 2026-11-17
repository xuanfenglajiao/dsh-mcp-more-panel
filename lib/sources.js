/**
 * Where a project's MCP servers can come from, and how each file is written.
 *
 * Only files inside the project directory are read. Every tool keeps its
 * global configuration in a different place, and a global file is shared by
 * every project — pulling it into a project's list would make projects inherit
 * servers nobody asked them to. Global servers are the user's own job, added
 * on the panel's Global tab.
 *
 * Each source declares a *dialect* instead of being handled by a chain of
 * special cases in the reader and writer:
 *
 *   format  - json | toml
 *   table   - path to the server table inside the document
 *   shape   - how one entry is read and written (portable | vscode | zcode | codex)
 *   caps    - add / edit / delete; a dialect we cannot write back losslessly
 *             stays read-only, and the page offers an import instead
 *
 * The list is ordered by priority: a later source wins when two of them
 * declare the same name. DSH's own file is last so a project can always
 * override what a foreign tool shipped.
 */

import { join } from 'node:path';

/** Selects every source, merged in priority order. */
export const ALL_SOURCES = 'all';

const PORTABLE_CAPS = { add: true, edit: true, delete: true };

export const SOURCES = [
  {
    id: 'codex', label: 'Codex', path: '.codex/config.toml',
    format: 'toml', table: ['mcp_servers'], shape: 'codex',
    caps: { add: false, edit: false, delete: false },
    note: 'Project-level TOML; read-only because TOML round-tripping could lose comments and table layout.',
  },
  {
    id: 'claude', label: 'Claude Code', path: '.mcp.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
  },
  {
    id: 'agents', label: 'Agents', path: '.agents/mcp.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
    note: 'The cross-tool compatibility layer also read by ZCode.',
  },
  {
    id: 'cursor', label: 'Cursor', path: '.cursor/mcp.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
  },
  {
    id: 'vscode', label: 'VS Code', path: '.vscode/mcp.json',
    format: 'json', table: ['servers'], shape: 'vscode',
    caps: { add: true, edit: true, delete: true },
    note: 'Uses "servers" plus inputs/dev/sandbox/oauth. Edits keep unknown fields.',
  },
  {
    id: 'gemini', label: 'Gemini CLI', path: '.gemini/settings.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
    note: 'settings.json carries other settings too; only the mcpServers table is touched. The older "httpUrl" spelling is read as well.',
  },
  {
    id: 'zcode', label: 'ZCode', path: '.zcode/config.json',
    format: 'json', table: ['mcp', 'servers'], shape: 'zcode',
    caps: { add: true, edit: true, delete: true },
    note: 'ZCode reads .zcode/config.json first and skips .agents/mcp.json entirely when it has any server.',
  },
  {
    id: 'pi', label: 'pi', path: '.pi/mcp.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
    note: 'Project-level config; pi requires project trust before loading it.',
  },
  {
    id: 'dsh', label: 'DSH', path: '.dsh/mcp.json',
    format: 'json', table: ['mcpServers'], shape: 'portable', caps: PORTABLE_CAPS,
  },
];

export function sourceById(id) {
  return SOURCES.find((source) => source.id === id);
}

/**
 * Turn a stored selection into the sources to read.
 * @param {string} [selection] - `all` or one source id.
 * @returns {object[]} sources in priority order.
 */
export function selectedSources(selection) {
  if (!selection || selection === ALL_SOURCES) return SOURCES.slice();
  const one = sourceById(selection);
  return one ? [one] : [];
}

/**
 * Absolute path of a source's file inside the project.
 * @param {object} source - entry from `SOURCES`.
 * @param {{ root: string }} where - project directory.
 */
export function sourcePath(source, where = {}) {
  return join(where.root, source.path);
}
