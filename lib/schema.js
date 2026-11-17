/**
 * Server configuration model: validation, normalization and the projection onto
 * the official `@deepseek-ai/dsh-mcp-client` row config.
 *
 * Only fields the official schema declares reach the client. Panel-owned
 * metadata (`id`, `enabled`, `notes`) stays in the panel's store; it is never
 * written into a client config.
 */

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const TRANSPORTS = ['stdio', 'streamable-http'];

/** Names that usually carry secrets; the UI warns when such a value is literal. */
export const SECRET_KEY_RE = /KEY|PASSWORD|PASSWD|SECRET|TOKEN|AUTH|CREDENTIAL|(^|_)PAT($|_)/i;

const MAX_DELAY = 2147483647;

/**
 * @param {string} field - dotted field path the problem belongs to.
 * @param {string} code - stable machine-readable code.
 * @param {string} message - human-readable detail.
 */
function issue(field, code, message) {
  return { field, code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep only string-to-string entries; report anything else. */
function stringMap(input, field, errors) {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) {
    errors.push(issue(field, 'type', `${field} must be an object of string values`));
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.trim() === '') {
      errors.push(issue(field, 'key', `${field} contains an empty key`));
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(issue(`${field}.${key}`, 'type', `${field}.${key} must be a string`));
      continue;
    }
    out[key] = value;
  }
  return out;
}

function optionalNumber(input, field, errors, { min = 1, max = Infinity, integer = false } = {}) {
  if (input === undefined || input === null || input === '') return undefined;
  const value = typeof input === 'string' ? Number(input) : input;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(issue(field, 'type', `${field} must be a number`));
    return undefined;
  }
  if (integer && !Number.isInteger(value)) {
    errors.push(issue(field, 'integer', `${field} must be an integer`));
    return undefined;
  }
  if (value < min || value > max) {
    errors.push(issue(field, 'range', `${field} must be between ${min} and ${max === Infinity ? 'infinity' : max}`));
    return undefined;
  }
  return value;
}

function validateUrl(text, errors) {
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(issue('url', 'protocol', 'url must use http or https'));
    }
  } catch {
    errors.push(issue('url', 'format', 'url is not a valid URL'));
  }
}

/**
 * Validate and normalize one server definition.
 * @param {unknown} input - raw definition, for example a form payload.
 * @returns {{ ok: true, value: object } | { ok: false, errors: object[] }}
 */
export function normalizeServer(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: [issue('', 'type', 'server must be an object')] };

  const serverName = typeof input.serverName === 'string' ? input.serverName.trim() : '';
  if (!SERVER_NAME_RE.test(serverName)) {
    errors.push(issue('serverName', 'serverName', 'serverName must match [A-Za-z0-9_-]{1,32}'));
  }

  const transport = input.transport;
  if (!TRANSPORTS.includes(transport)) {
    errors.push(issue('transport', 'transport', 'transport must be stdio or streamable-http'));
  }

  const value = { serverName, transport };

  if (transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command === '') errors.push(issue('command', 'required', 'command is required for stdio'));
    value.command = command;
    let args = input.args ?? [];
    if (typeof args === 'string') args = args.split(/\r?\n/).filter((line) => line !== '');
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      errors.push(issue('args', 'type', 'args must be an array of strings'));
      args = [];
    }
    value.args = args;
    value.env = stringMap(input.env, 'env', errors);
    value.cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  } else if (transport === 'streamable-http') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (url === '') errors.push(issue('url', 'required', 'url is required for streamable-http'));
    else validateUrl(url, errors);
    value.url = url;
    value.headers = stringMap(input.headers, 'headers', errors);
  }

  const timeout = optionalNumber(input.toolCallTimeoutMs, 'toolCallTimeoutMs', errors, { min: 1, max: 3600000 });
  if (timeout !== undefined) value.toolCallTimeoutMs = timeout;
  if (typeof input.failOnStartupError === 'boolean') value.failOnStartupError = input.failOnStartupError;
  const instructionBytes = optionalNumber(input.maxInstructionBytes, 'maxInstructionBytes', errors, {
    min: 1,
    integer: true,
  });
  if (instructionBytes !== undefined) value.maxInstructionBytes = instructionBytes;

  if (isPlainObject(input.reconnect)) {
    const reconnect = {};
    if (typeof input.reconnect.enabled === 'boolean') reconnect.enabled = input.reconnect.enabled;
    const initial = optionalNumber(input.reconnect.initialDelayMs, 'reconnect.initialDelayMs', errors, { max: MAX_DELAY });
    if (initial !== undefined) reconnect.initialDelayMs = initial;
    const maxDelay = optionalNumber(input.reconnect.maxDelayMs, 'reconnect.maxDelayMs', errors, { max: MAX_DELAY });
    if (maxDelay !== undefined) reconnect.maxDelayMs = maxDelay;
    const attempts = optionalNumber(input.reconnect.maxAttempts, 'reconnect.maxAttempts', errors, { integer: true });
    if (attempts !== undefined) reconnect.maxAttempts = attempts;
    if (reconnect.initialDelayMs !== undefined && reconnect.maxDelayMs !== undefined && reconnect.initialDelayMs > reconnect.maxDelayMs) {
      errors.push(issue('reconnect.maxDelayMs', 'order', 'maxDelayMs must not be below initialDelayMs'));
    }
    if (Object.keys(reconnect).length > 0) value.reconnect = reconnect;
  }

  value.enabled = input.enabled === false ? false : true;
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 500) errors.push(issue('notes', 'length', 'notes must not exceed 500 characters'));
  if (notes !== '') value.notes = notes;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/**
 * Project one normalized server onto the official client row config. The
 * transport is always written explicitly, so the client never has to infer it.
 * @param {object} server - normalized server.
 * @returns {object} config for `@deepseek-ai/dsh-mcp-client`.
 */
export function toClientConfig(server) {
  const config = { serverName: server.serverName, transport: server.transport };
  if (server.transport === 'stdio') {
    config.command = server.command;
    config.args = server.args ?? [];
    config.env = server.env ?? {};
    if (server.cwd) config.cwd = server.cwd;
  } else {
    config.url = server.url;
    config.headers = server.headers ?? {};
  }
  for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) {
    if (server[key] !== undefined) config[key] = server[key];
  }
  return config;
}

/** Any `${...}` sequence; the body decides what it means (see `resolveRef`). */
const REF_RE = /\$\{([^{}]*)\}/g;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a string contains at least one `${...}` reference. */
export function hasRef(text) {
  return typeof text === 'string' && /\$\{[^{}]*\}/.test(text);
}

/**
 * Resolve one reference body.
 *
 * Supported spellings, so a definition copied from another tool keeps working:
 *  - `NAME`, `NAME:-default` (Claude Code, shell style);
 *  - `env:NAME` (VS Code, Cursor);
 *  - `workspaceFolder`, `workspaceRoot`, `workspaceFolderBasename`, `userHome`,
 *    `pathSeparator` or `/` (VS Code, Cursor), from `context`;
 *  - `input:id` (VS Code prompt) cannot be answered here and is reported missing.
 *
 * As in Claude Code and the shell, a variable set to an empty string is set;
 * `:-default` applies to an unset or empty variable.
 *
 * @returns {{ value: string } | { missing: string } | undefined} undefined leaves the text as written.
 */
function resolveRef(body, env, context) {
  const fromContext = {
    workspaceFolder: context.workspaceFolder,
    workspaceRoot: context.workspaceFolder,
    workspaceFolderBasename: context.workspaceFolderBasename,
    userHome: context.userHome,
    pathSeparator: context.pathSeparator,
    '/': context.pathSeparator,
  };
  if (Object.hasOwn(fromContext, body)) {
    const value = fromContext[body];
    return typeof value === 'string' ? { value } : { missing: body };
  }
  if (body.startsWith('input:')) return { missing: body };
  let name = body;
  let fallback;
  if (body.startsWith('env:')) name = body.slice(4);
  else {
    const at = body.indexOf(':-');
    if (at >= 0) {
      name = body.slice(0, at);
      fallback = body.slice(at + 2);
    }
  }
  if (!NAME_RE.test(name)) return undefined;
  const found = env[name];
  if (fallback !== undefined) return { value: found !== undefined && found !== '' ? found : fallback };
  if (found !== undefined) return { value: found };
  return { missing: name };
}

/**
 * Expand references in every string of a value. Unset variables without a
 * default are collected, not silently blanked.
 * @param {unknown} value - config value, any depth.
 * @param {Record<string, string | undefined>} env - variable source.
 * @param {{ workspaceFolder?: string, workspaceFolderBasename?: string, userHome?: string, pathSeparator?: string }} [context]
 * @returns {{ value: unknown, missing: string[] }}
 */
export function expandRefs(value, env, context = {}) {
  const missing = new Set();
  const walk = (item) => {
    if (typeof item === 'string') {
      return item.replace(REF_RE, (match, body) => {
        const resolved = resolveRef(body, env, context);
        if (!resolved) return match;
        if ('value' in resolved) return resolved.value;
        missing.add(resolved.missing);
        return '';
      });
    }
    if (Array.isArray(item)) return item.map(walk);
    if (isPlainObject(item)) return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return { value: walk(value), missing: [...missing] };
}

/**
 * The environment variables a definition reads from the DSH process, in every
 * field that is sent to the server. A repository-declared server can name any
 * variable here, so the approval dialog lists them explicitly.
 * @param {object} server - normalized server.
 * @returns {string[]} variable names, sorted, without duplicates.
 */
export function referencedVariables(server) {
  const names = new Set();
  const walk = (item) => {
    if (typeof item === 'string') {
      for (const [, body] of item.matchAll(REF_RE)) {
        const name = body.startsWith('env:') ? body.slice(4) : body.split(':-')[0];
        if (NAME_RE.test(name) && !['workspaceFolder', 'workspaceRoot', 'workspaceFolderBasename', 'userHome', 'pathSeparator'].includes(name)) names.add(name);
      }
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (isPlainObject(item)) Object.values(item).forEach(walk);
  };
  walk([server.command, server.args, server.cwd, server.env, server.url, server.headers]);
  return [...names].sort();
}

/**
 * Whether a configuration carries a literal secret rather than a reference.
 * @param {object} server - normalized server.
 * @returns {string[]} dotted names of suspicious literal values.
 */
export function literalSecrets(server) {
  const hits = [];
  const scan = (map, prefix) => {
    for (const [key, value] of Object.entries(map ?? {})) {
      if (SECRET_KEY_RE.test(key) && typeof value === 'string' && value !== '' && !hasRef(value)) hits.push(`${prefix}.${key}`);
    }
  };
  scan(server.env, 'env');
  scan(server.headers, 'headers');
  return hits;
}

export const REDACTED = '••••';
const SECRET_FLAG_RE = /^--?[A-Za-z0-9_-]*(key|token|secret|password|passwd|auth|credential|bearer)[A-Za-z0-9_-]*$/i;

/**
 * Hide values that command lines commonly carry secrets in: `--api-key x`,
 * `--token=x`, `API_KEY=x`. References are kept, they are not secrets.
 * @param {string[]} args
 * @returns {string[]}
 */
export function redactArgs(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    const assigned = arg.match(/^(--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (assigned) {
      const secret = assigned[1].startsWith('-') ? SECRET_FLAG_RE.test(assigned[1]) : SECRET_KEY_RE.test(assigned[1]);
      out.push(secret && assigned[2] !== '' && !hasRef(assigned[2]) ? `${assigned[1]}=${REDACTED}` : arg);
      continue;
    }
    out.push(arg);
    const next = args[index + 1];
    if (SECRET_FLAG_RE.test(arg) && typeof next === 'string' && next !== '' && !next.startsWith('-')) {
      out.push(hasRef(next) ? next : REDACTED);
      index += 1;
    }
  }
  return out;
}

/**
 * Short, secret-free description of where a server connects or what it runs.
 * Query strings and secret-looking arguments are left out.
 * @param {object} server - normalized server.
 */
export function describeEndpoint(server) {
  if (server.transport === 'streamable-http') {
    try {
      const url = new URL(server.url);
      return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
    } catch {
      return server.url ?? '';
    }
  }
  const args = redactArgs(server.args ?? []).join(' ');
  const line = args === '' ? server.command : `${server.command} ${args}`;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
