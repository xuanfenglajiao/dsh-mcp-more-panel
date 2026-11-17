/**
 * Profile rows of the official MCP client that already exist, for example the
 * ones written by hand in `cordis.patch.yml`.
 *
 * These rows are never rewritten wholesale and never deleted by this panel. The
 * panel can show them, switch them on and off through the plugin manager, and
 * edit literal fields through the config editor. A `!!js` expression is
 * represented in a raw config as `{ "__jsExpr": "<source>" }`; such a value is
 * shown as read-only and written back untouched.
 */

import { describeEndpoint } from './schema.js';

export const CLIENT_ENTRY_NAMES = new Set(['@deepseek-ai/dsh-mcp-client', 'dsh-mcp-client']);

/** Cordis fiber state value for an active plugin (mirrors `@deepseek-ai/cordis`). */
const FIBER_ACTIVE = 2;

export function isExpression(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string';
}

function plainString(value) {
  return typeof value === 'string' ? value : undefined;
}

/** Loader entry ids are addressed as `include:<row id>` by the plugin manager. */
export function entryIdOf(rowId) {
  return rowId.startsWith('include:') ? rowId : `include:${rowId}`;
}

/**
 * Build the read-only view of one row's raw config.
 * @param {string} rowId - row id as declared in the patch.
 * @param {object} config - raw config, expressions as markers.
 * @param {{ disabled?: boolean, active?: boolean }} state - row state.
 */
export function viewOfRow(rowId, config, state = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const expressionFields = [];
  const scan = (value, path) => {
    if (isExpression(value)) {
      expressionFields.push(path);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) scan(inner, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(cfg)) scan(value, key);

  const serverName = plainString(cfg.serverName);
  const transport = plainString(cfg.transport) ?? (cfg.url !== undefined ? 'streamable-http' : 'stdio');
  const endpoint = describeEndpoint({
    transport,
    url: plainString(cfg.url),
    command: plainString(cfg.command),
    args: Array.isArray(cfg.args) ? cfg.args.filter((item) => typeof item === 'string') : [],
  });
  return {
    rowId,
    entryId: entryIdOf(rowId),
    serverName: serverName ?? (isExpression(cfg.serverName) ? '(expression)' : ''),
    transport,
    endpoint: endpoint || (isExpression(cfg.url) || isExpression(cfg.command) ? '(expression)' : ''),
    enabled: state.disabled !== true,
    active: state.active === true,
    expressionFields,
    config: cfg,
  };
}

/**
 * Merge a user-edited string map into a raw one. Literal entries follow the
 * edit (added, changed, removed); expression entries are always kept.
 * @param {object | undefined} current - raw map, may contain markers.
 * @param {Record<string, string>} next - map from the form (literals only).
 */
export function mergeMap(current, next) {
  const out = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (isExpression(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(next ?? {})) {
    if (isExpression(out[key])) continue;
    out[key] = value;
  }
  return out;
}

const SIMPLE_FIELDS = ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes'];
const STRING_FIELDS = ['command', 'url', 'cwd'];

/**
 * Compute the complete new raw config for an edit. Fields whose current value
 * is an expression are not changed, and the caller learns which were skipped.
 * @param {object} current - complete raw config of the row.
 * @param {object} form - normalized server from the edit form.
 * @returns {{ config: object, skipped: string[] }}
 */
export function applyLegacyEdit(current, form) {
  const config = { ...current };
  const skipped = [];
  const set = (key, value) => {
    if (isExpression(current[key])) {
      skipped.push(key);
      return;
    }
    if (value === undefined) delete config[key];
    else config[key] = value;
  };
  for (const key of STRING_FIELDS) if (form[key] !== undefined && form[key] !== '') set(key, form[key]);
  for (const key of SIMPLE_FIELDS) set(key, form[key]);
  if (form.args !== undefined) {
    if (Array.isArray(current.args) && current.args.some(isExpression)) skipped.push('args');
    else if (isExpression(current.args)) skipped.push('args');
    else config.args = form.args;
  }
  if (form.env !== undefined && !isExpression(current.env)) config.env = mergeMap(current.env, form.env);
  else if (isExpression(current.env)) skipped.push('env');
  if (form.headers !== undefined && !isExpression(current.headers)) config.headers = mergeMap(current.headers, form.headers);
  else if (isExpression(current.headers)) skipped.push('headers');
  if (form.reconnect !== undefined) {
    if (isExpression(current.reconnect)) skipped.push('reconnect');
    else config.reconnect = { ...(current.reconnect ?? {}), ...form.reconnect };
  }
  // The server name and transport identify the row; they are never edited here.
  config.serverName = current.serverName;
  if (current.transport !== undefined) config.transport = current.transport;
  return { config, skipped };
}

/**
 * Adapter over the host's config editor and plugin manager. Every call is
 * defensive: the shapes below follow the host's declared contracts and the
 * installed community plugins, and are confirmed on the first run.
 * @param {() => { configEditor?: object, pluginManager?: object }} services - lazy lookup.
 */
export function createLegacyAdapter(services) {
  const clientEntries = () => {
    const { configEditor } = services();
    if (!configEditor || typeof configEditor.entries !== 'function') return [];
    return configEditor.entries().filter((entry) => CLIENT_ENTRY_NAMES.has(entry?.options?.name));
  };

  const rawConfigOf = (entry) => {
    const { configEditor } = services();
    try {
      const table = configEditor.configuration?.() ?? [];
      const found = table.find((item) => item.entry === entry);
      if (found) return { ...(found.inherited ?? {}), ...(found.override ?? {}) };
    } catch {
      // Fall back to the entry's own options below.
    }
    return entry.options?.config ?? {};
  };

  return {
    available() {
      const { configEditor } = services();
      return Boolean(configEditor && typeof configEditor.entries === 'function');
    },
    list() {
      return clientEntries().map((entry) => {
        const rowId = String(entry.options?.id ?? '');
        return viewOfRow(rowId, rawConfigOf(entry), {
          disabled: entry.options?.disabled === true,
          active: entry.fiber?.state === FIBER_ACTIVE,
        });
      });
    },
    serverNames() {
      return this.list().map((row) => row.serverName).filter((name) => name !== '' && name !== '(expression)');
    },
    async toggle(rowId, enabled) {
      const { pluginManager } = services();
      if (!pluginManager || typeof pluginManager.setPluginEnabled !== 'function') {
        throw new Error('plugin manager is not available');
      }
      return pluginManager.setPluginEnabled(entryIdOf(rowId), enabled);
    },
    async edit(rowId, form) {
      const { configEditor } = services();
      const entry = clientEntries().find((item) => String(item.options?.id ?? '') === rowId);
      if (!entry) throw new Error(`row ${rowId} was not found`);
      let skipped = [];
      await configEditor.edit(entry, (current) => {
        const result = applyLegacyEdit(current, form);
        skipped = result.skipped;
        return result.config;
      });
      return { skipped };
    },
  };
}
