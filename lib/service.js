/**
 * Panel service: one implementation behind the page's JSON route and the
 * read-only agent tool.
 *
 * Responsibilities
 *  - own the store (global servers, project servers, trust records);
 *  - mount global servers once, in the plugin's own context;
 *  - mount each project's servers once, shared by every session working in
 *    that project, and narrow every session's tool view with
 *    `ctx.tools.restrict` so it sees only the global servers and its own
 *    project's (the host's restrict() only masks globally registered tools,
 *    which is why project servers are registered globally under a
 *    project-qualified name);
 *  - enforce the trust rule: a server that comes from a repository file is
 *    mounted only while an approval matching its current fingerprint exists,
 *    and stops as soon as the file changes (the files of mounted projects are
 *    watched);
 *  - never lose the store: a store that could not be read is not overwritten.
 *
 * Mount changes are reconciled, not rebuilt: only servers whose configuration
 * changed are restarted, and the work for one project runs in a queue so two
 * changes can never interleave.
 *
 * Everything the host provides is injected, so this module runs unchanged under
 * Node's test runner.
 */

import { canonicalize, fingerprintServer, rootKey } from './fingerprint.js';
import { assessRisk } from './risk.js';
import { emptyStore, loadStore as defaultLoad, newServerId, saveStore as defaultSave } from './store.js';
import { describeEndpoint, expandRefs, hasRef, literalSecrets, normalizeServer, referencedVariables, toClientConfig } from './schema.js';
import { convertEntry, parseDocument, readProjectFiles as defaultReadFiles, tableAt } from './project-files.js';
import { ALL_SOURCES, SOURCES, selectedSources, sourceById, sourcePath } from './sources.js';
import { emptyDocument, entryFromServer, readDocument, removeEntry, resolveEntryKey, upsertEntry, writeDocument } from './project-write.js';
import { resolveProjectRoot as defaultResolve } from './projects.js';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { stat as defaultStat } from 'node:fs/promises';

export class ServiceError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable detail.
   * @param {unknown} [details] - structured detail, for example field errors.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Placeholder returned in place of a stored value. The page shows it as the
 * current value; submitting it back means "keep the old one", so a secret never
 * has to travel to the browser to be edited. A value made of references
 * (`${TOKEN}`) is not a secret and is shown as written.
 */
export const MASKED_VALUE = '••••••••';
const MASK_FIELDS = ['env', 'headers'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const shortHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 4);

/** Replace every stored literal value with the placeholder, for anything leaving the Host. */
function maskServer(server) {
  const out = { ...server };
  for (const field of MASK_FIELDS) {
    const map = server[field];
    if (!isPlainObject(map)) continue;
    const masked = {};
    for (const [key, value] of Object.entries(map)) {
      masked[key] = typeof value === 'string' && value !== '' && !hasRef(value) ? MASKED_VALUE : value;
    }
    out[field] = masked;
  }
  return out;
}

/**
 * Put the stored value back where the page echoed the placeholder. A
 * placeholder with nothing to restore (the key was renamed) is refused, so dots
 * are never saved as a value.
 */
function restoreMasked(input, previous) {
  const out = { ...input };
  const problems = [];
  for (const field of MASK_FIELDS) {
    const map = input[field];
    if (!isPlainObject(map)) continue;
    const previousMap = previous && isPlainObject(previous[field]) ? previous[field] : {};
    const restored = { ...map };
    for (const [key, value] of Object.entries(map)) {
      if (value !== MASKED_VALUE) continue;
      if (typeof previousMap[key] === 'string') restored[key] = previousMap[key];
      else problems.push({ field: `${field}.${key}`, code: 'masked', message: `${field}.${key} was hidden and cannot be carried to a new name; enter the value again` });
    }
    out[field] = restored;
  }
  if (problems.length > 0) throw new ServiceError('invalid', 'a hidden value has to be entered again', problems);
  return out;
}

/**
 * @param {object} deps - injected host capabilities.
 * @param {string} deps.storeFile - absolute path of the store.
 * @param {object} deps.rootCtx - plugin context, used for every mount.
 * @param {{ load: () => Promise<object>, mount: (ctx: object, mod: object, config: object) => object }} deps.client
 * @param {(serverName: string) => number} [deps.toolCount]
 * @param {(serverName: string) => string[]} [deps.toolNames]
 * @param {object} [deps.legacy] - adapter from legacy.js.
 * @param {() => string[]} [deps.listWorkspaces] - workspace directories.
 * @param {Record<string, string | undefined>} [deps.env]
 * @param {() => number} [deps.now]
 * @param {number} [deps.watchIntervalMs] - how often mounted projects are checked for file changes; 0 turns it off.
 * @param {string} [deps.backupDir] - where project files are backed up before a write.
 * @param {string} [deps.homeDir]
 * @param {object} [deps.logger]
 */
export function createService(deps) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const load = deps.loadStore ?? defaultLoad;
  const save = deps.saveStore ?? defaultSave;
  const readFiles = deps.readProjectFiles ?? defaultReadFiles;
  const resolveRoot = deps.resolveProjectRoot ?? defaultResolve;
  const statFile = deps.stat ?? defaultStat;
  const homeDir = deps.homeDir ?? homedir();
  const backupDir = deps.backupDir ?? join(dirname(deps.storeFile), 'backups');
  const watchIntervalMs = deps.watchIntervalMs ?? 2000;
  const logger = deps.logger ?? {};
  const toolCount = (name) => {
    try {
      return deps.toolCount?.(name) ?? 0;
    } catch {
      return 0;
    }
  };

  let store = emptyStore();
  let storeError;
  let storeReadOnly = false;
  let disposed = false;
  let writeQueue = Promise.resolve();
  let clientResult;
  let ticker;
  let ticking = false;

  /** id -> live record of a global server */
  const globalMounts = new Map();
  /** id -> tail of that server's mount queue */
  const globalQueues = new Map();
  /** agent id -> { agent, cwd, root?, restriction?, denyKey } */
  const agents = new Map();
  /**
   * rootKey -> {
   *   key, root, refs: Set<agentId>, queue: Promise,
   *   servers: Map<registration, record>, byServer: Map<serverName, registration>,
   *   signature?: string,
   * }
   */
  const projectMounts = new Map();
  /** Registration names of connection tests that are running. */
  const probes = new Set();

  // ------------------------------------------------------------------ store

  function guardWrite() {
    if (storeReadOnly) throw new ServiceError('store-read-only', `the configuration store is read-only: ${storeError}`);
  }

  const persist = () => {
    const next = writeQueue.then(() => save(deps.storeFile, store));
    writeQueue = next.catch(() => {});
    return next;
  };

  async function client() {
    if (clientResult?.ok) return clientResult;
    clientResult = await deps.client.load();
    return clientResult;
  }

  const profileNames = () => {
    try {
      return deps.legacy?.serverNames?.() ?? [];
    } catch {
      return [];
    }
  };

  const knownRoots = () => [
    ...(deps.listWorkspaces?.() ?? []),
    ...Object.values(store.projects).map((project) => project.root),
  ];

  // ---------------------------------------------------------------- mounting

  /** What `${workspaceFolder}`-style references resolve to for one project. */
  function projectContext(root) {
    return root ? { workspaceFolder: resolve(root), workspaceFolderBasename: basename(resolve(root)) } : {};
  }

  /**
   * The config handed to the official client. A project server runs in the
   * project directory unless it names one, and a relative cwd is relative to it.
   */
  function expand(server, context) {
    const { value, missing } = expandRefs(toClientConfig(server), env, { userHome: homeDir, pathSeparator: sep, ...context });
    if (context.workspaceFolder && value.transport === 'stdio') value.cwd = resolve(context.workspaceFolder, value.cwd || '.');
    return { config: value, missing };
  }

  /** Identity of a configuration: a record whose hash is unchanged keeps running. */
  const configHash = (server, context) => createHash('sha1').update(canonicalize({ config: toClientConfig(server), context })).digest('hex');

  function describeMissing(missing) {
    const inputs = missing.filter((name) => name.startsWith('input:'));
    const others = missing.filter((name) => !name.startsWith('input:'));
    const parts = [];
    if (others.length > 0) parts.push(`environment variable not set: ${others.join(', ')}`);
    if (inputs.length > 0) parts.push(`VS Code input variables are not supported: ${inputs.join(', ')}`);
    return parts.join('; ');
  }

  /**
   * Mount one server into a context and track its settling.
   * @returns {Promise<{ handle?: object, state: string, detail?: string }>} the live record.
   */
  async function mountInto(ctx, server, context = {}) {
    const record = { state: 'connecting' };
    const loaded = await client();
    if (!loaded.ok) {
      record.state = 'error';
      record.detail = `official MCP client is not available: ${loaded.error}`;
      return record;
    }
    const { config, missing } = expand(server, context);
    if (missing.length > 0) {
      record.state = 'error';
      record.detail = describeMissing(missing);
      return record;
    }
    if (!ctx) {
      record.state = 'error';
      record.detail = 'no context to mount in';
      return record;
    }
    try {
      record.handle = deps.client.mount(ctx, loaded.mod, config);
    } catch (error) {
      record.state = 'error';
      record.detail = String(error?.message ?? error);
      return record;
    }
    record.handle.settled.then((outcome) => {
      if (record.disposed) return;
      record.state = outcome.ok ? 'active' : 'error';
      if (!outcome.ok) record.detail = outcome.error;
    });
    return record;
  }

  function disposeRecord(record) {
    if (!record || record.disposed) return;
    record.disposed = true;
    record.handle?.dispose();
  }

  /** Run `job` after every earlier job of the same queue; the queue never rejects. */
  function enqueue(queues, id, job) {
    const next = (queues.get(id) ?? Promise.resolve()).then(job, job);
    queues.set(id, next.catch(() => {}));
    return next;
  }

  /** Bring one global server's mount in line with the store. */
  function syncGlobal(id) {
    return enqueue(globalQueues, id, async () => {
      const server = store.global.find((item) => item.id === id);
      disposeRecord(globalMounts.get(id));
      globalMounts.delete(id);
      if (!server || !server.enabled || disposed) return;
      const record = await mountInto(deps.rootCtx, server);
      // The definition may have been replaced, switched off or deleted meanwhile; a later job handles that one.
      if (disposed || store.global.find((item) => item.id === id) !== server || !server.enabled) {
        disposeRecord(record);
        return;
      }
      record.serverName = server.serverName;
      globalMounts.set(id, record);
    });
  }

  /** A short, readable prefix so two projects can both declare a server named "db". */
  function projectSlug(root) {
    const base = basename(root) || 'project';
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return (slug || 'project').slice(0, 10);
  }

  /**
   * Globally unique registration name for a project's server, the same every
   * time: `<folder>_<root hash>_<name>`, with a long name shortened to a prefix
   * plus its own hash so it still fits the 32-character limit.
   */
  function registrationName(root, serverName, taken) {
    const prefix = `${projectSlug(root)}_${shortHash(rootKey(root))}_`;
    const room = 32 - prefix.length;
    const name = serverName.length <= room ? serverName : `${serverName.slice(0, room - 5)}_${shortHash(serverName)}`;
    const base = prefix + name;
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      const tail = `_${suffix}`;
      candidate = base.slice(0, 32 - tail.length) + tail;
      suffix += 1;
    }
    return candidate;
  }

  /** Tool names the host has registered for one server, in the global view. */
  function toolNamesFor(registration) {
    try {
      return deps.toolNames?.(registration) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Recompute every tracked session's mask. A session may see the global
   * servers and the servers of its own project; it is denied every other
   * project's servers, running connection tests, and any global or profile
   * server its own project overrides with one of the same name. Only names that
   * are registered can be denied, so this runs again whenever tools settle and
   * on every watch tick; a session's restriction is only replaced when its
   * deny list actually changed.
   */
  function reapplyRestrictions() {
    const byProject = new Map();
    for (const [key, mount] of projectMounts) {
      const names = [];
      for (const registration of mount.servers.keys()) names.push(...toolNamesFor(registration));
      byProject.set(key, names);
    }
    const probeNames = [...probes].flatMap(toolNamesFor);
    let shadowable;
    for (const state of agents.values()) {
      const ownKey = state.root ? rootKey(state.root) : undefined;
      const deny = [...probeNames];
      for (const [key, names] of byProject) if (key !== ownKey) deny.push(...names);
      const own = ownKey ? projectMounts.get(ownKey) : undefined;
      if (own && own.byServer.size > 0) {
        shadowable ??= new Set([...store.global.filter((server) => server.enabled).map((server) => server.serverName), ...profileNames()]);
        for (const serverName of own.byServer.keys()) if (shadowable.has(serverName)) deny.push(...toolNamesFor(serverName));
      }
      const denyKey = [...new Set(deny)].sort().join('\n');
      if (denyKey === state.denyKey) continue;
      try {
        state.restriction?.();
      } catch {
        // A restriction whose scope is already gone needs no cleanup.
      }
      state.restriction = undefined;
      state.denyKey = denyKey;
      if (denyKey === '') continue;
      const restrict = state.agent?.ctx?.tools?.restrict;
      if (typeof restrict !== 'function') continue;
      try {
        state.restriction = restrict.call(state.agent.ctx.tools, { deny: denyKey.split('\n') });
      } catch (error) {
        state.denyKey = undefined;
        logger.warn?.(`mcp-more-panel: restricting tools for ${state.agent.id} failed: ${error?.message ?? error}`);
      }
    }
  }

  /** Stat signature of a project's selected source files, to notice edits. */
  async function sourceSignature(root) {
    const parts = [projectSelection(root)];
    for (const source of selectedSources(projectSelection(root))) {
      try {
        const info = await statFile(sourcePath(source, { root }));
        parts.push(`${info.mtimeMs}:${info.size}`);
      } catch {
        parts.push('-');
      }
    }
    return parts.join('|');
  }

  function releaseMount(mount) {
    for (const record of mount.servers.values()) disposeRecord(record);
    mount.servers.clear();
    mount.byServer.clear();
  }

  /**
   * Bring one project's mount in line with its store entries, files and
   * approvals. `force` restarts every server (the Remount button).
   */
  async function reconcileProject(mount, force) {
    const live = () => !disposed && projectMounts.get(mount.key) === mount && mount.refs.size > 0;
    if (!live()) return;
    mount.signature = await sourceSignature(mount.root);
    const effective = await effectiveProject(mount.root);
    if (!live()) return;
    const context = projectContext(mount.root);
    const desired = new Map();
    for (const item of effective.items) {
      if (item.mountable) desired.set(item.server.serverName, { server: item.server, hash: configHash(item.server, context) });
    }
    for (const [serverName, registration] of [...mount.byServer]) {
      const record = mount.servers.get(registration);
      const want = desired.get(serverName);
      if (force || !want || !record || record.hash !== want.hash) {
        disposeRecord(record);
        mount.servers.delete(registration);
        mount.byServer.delete(serverName);
      }
    }
    const taken = new Set([...store.global.map((server) => server.serverName), ...profileNames(), ...probes]);
    for (const other of projectMounts.values()) for (const name of other.servers.keys()) taken.add(name);
    for (const [serverName, want] of desired) {
      if (mount.byServer.has(serverName)) continue;
      const registration = registrationName(mount.root, serverName, taken);
      taken.add(registration);
      const record = await mountInto(deps.rootCtx, { ...want.server, serverName: registration }, context);
      if (!live()) {
        disposeRecord(record);
        return;
      }
      Object.assign(record, { hash: want.hash, registration, serverName });
      // Tool registration settles asynchronously; recompute the masks once this server's tools exist.
      record.handle?.settled?.then(() => reapplyRestrictions()).catch(() => {});
      mount.servers.set(registration, record);
      mount.byServer.set(serverName, registration);
    }
    reapplyRestrictions();
  }

  /** Queue a reconcile of one project. Resolves when it ran; never rejects. */
  function syncProject(key, { force = false } = {}) {
    const mount = projectMounts.get(key);
    if (!mount) return Promise.resolve();
    return enqueue(mount.queues, 'mount', () => reconcileProject(mount, force).catch((error) => {
      logger.warn?.(`mcp-more-panel: mounting ${mount.root} failed: ${error?.message ?? error}`);
    }));
  }

  /** Watch tick: remount projects whose files changed, and catch tools that registered late. */
  async function tick() {
    if (ticking || disposed) return;
    ticking = true;
    try {
      for (const mount of [...projectMounts.values()]) {
        if (mount.signature === undefined) continue;
        const signature = await sourceSignature(mount.root);
        if (signature !== mount.signature) {
          mount.signature = signature;
          syncProject(mount.key);
        }
      }
      reapplyRestrictions();
    } catch (error) {
      logger.warn?.(`mcp-more-panel: watching project files failed: ${error?.message ?? error}`);
    } finally {
      ticking = false;
    }
  }

  function startWatching() {
    if (ticker || watchIntervalMs <= 0 || disposed) return;
    ticker = setInterval(() => void tick(), watchIntervalMs);
    ticker.unref?.();
  }

  // ---------------------------------------------------------------- projects

  /** The source selection remembered for one project; unknown values fall back to every source. */
  function projectSelection(root) {
    return store.projects[rootKey(root)]?.source ?? ALL_SOURCES;
  }

  /**
   * Everything the panel knows about one project: stored servers, servers the
   * selected source files declare, and for each whether it may be mounted.
   */
  async function effectiveProject(root) {
    const key = rootKey(root);
    const stored = store.projects[key]?.servers ?? [];
    const trusts = store.trust[key] ?? {};
    const selection = projectSelection(root);
    const { files, servers: fileServers, duplicates = [] } = await readFiles(root, { source: selection });
    const duplicateOf = new Map(duplicates.map((entry) => [entry.serverName, entry]));
    const globalNames = new Set(store.global.filter((server) => server.enabled).map((server) => server.serverName));
    const profile = new Set(profileNames());
    const items = [];
    for (const server of stored) {
      items.push({ id: server.id, origin: 'store', source: 'store', server, trustState: 'trusted', enabled: server.enabled !== false, warnings: [] });
    }
    const storedNames = new Set(stored.map((server) => server.serverName));
    for (const candidate of fileServers) {
      const { warnings = [], source, ...server } = candidate;
      const id = `file:${source}:${server.serverName}`;
      if (storedNames.has(server.serverName)) {
        items.push({ id, origin: 'file', source, server, shadowed: true, trustState: 'shadowed', enabled: false, warnings });
        continue;
      }
      const fingerprint = fingerprintServer(root, server);
      const approved = trusts[server.serverName];
      const trustState = !approved ? 'pending' : approved.fingerprint === fingerprint ? 'approved' : 'changed';
      items.push({
        id,
        origin: 'file',
        source,
        server,
        fingerprint,
        previousFingerprint: approved?.fingerprint,
        trustState,
        // A record written before the switch existed has no `enabled` and means on.
        enabled: approved ? approved.enabled !== false : false,
        disabledInFile: server.enabled === false,
        duplicateOf: duplicateOf.get(server.serverName),
        warnings,
      });
    }
    for (const item of items) {
      const name = item.server.serverName;
      item.overrides = globalNames.has(name) ? 'global' : profile.has(name) ? 'profile' : undefined;
      item.mountable =
        item.enabled !== false &&
        !item.shadowed &&
        !item.disabledInFile &&
        (item.origin === 'store' || item.trustState === 'approved');
    }
    return { root, key, files, items, duplicates, selection };
  }

  /** The live record of one server in a project's shared mount. */
  function liveProjectRecord(key, serverName) {
    const mount = projectMounts.get(key);
    if (!mount) return undefined;
    const registration = mount.byServer.get(serverName);
    const record = registration ? mount.servers.get(registration) : undefined;
    return record ? { record, registration } : undefined;
  }

  function projectItemView(effective, item) {
    const { server } = item;
    let status;
    let detail;
    let tools = 0;
    if (item.shadowed) status = 'shadowed';
    else if (item.disabledInFile) status = 'disabled-in-file';
    else if (item.origin === 'file' && item.trustState === 'pending') status = 'pending-trust';
    else if (item.origin === 'file' && item.trustState === 'changed') status = 'trust-changed';
    else if (item.enabled === false) status = 'disabled';
    else {
      const live = liveProjectRecord(effective.key, server.serverName);
      if (!live) status = 'idle';
      else {
        status = live.record.state;
        detail = live.record.detail;
        tools = toolCount(live.registration);
        if (status === 'active' && tools === 0) status = 'no-tools';
      }
    }
    const { fileKey, sourceId, ...definition } = server;
    return {
      id: item.id,
      scope: 'project',
      origin: item.origin,
      source: item.source,
      sourceId,
      fileKey,
      serverName: server.serverName,
      registration: liveProjectRecord(effective.key, server.serverName)?.registration,
      // A repository file already contains the value in plain text and the edit
      // form needs the original; masking it would write dots back into the file.
      // Servers held in the plugin's own store are masked instead.
      server: item.origin === 'file' ? definition : maskServer(definition),
      enabled: item.enabled !== false,
      summary: describeEndpoint(server),
      status,
      detail,
      toolCount: tools,
      trustState: item.trustState,
      fingerprint: item.fingerprint,
      previousFingerprint: item.previousFingerprint,
      duplicateOf: item.duplicateOf,
      overrides: item.overrides,
      risk: assessRisk(server),
      variables: referencedVariables(server),
      warnings: item.warnings,
      secrets: literalSecrets(server),
    };
  }

  // ------------------------------------------------------------------- views

  function globalView(server) {
    const record = globalMounts.get(server.id);
    let status = !server.enabled ? 'disabled' : !record ? 'unmounted' : record.state;
    const tools = server.enabled ? toolCount(server.serverName) : 0;
    if (status === 'active' && tools === 0) status = 'no-tools';
    return {
      id: server.id,
      scope: 'global',
      origin: 'store',
      serverName: server.serverName,
      server: maskServer(server),
      enabled: server.enabled !== false,
      summary: describeEndpoint(server),
      status,
      detail: record?.detail,
      toolCount: tools,
      risk: assessRisk(server),
      variables: referencedVariables(server),
      secrets: literalSecrets(server),
    };
  }

  function workspaceList() {
    const out = new Map();
    for (const root of deps.listWorkspaces?.() ?? []) out.set(rootKey(root), { root, label: basename(root) || root, source: 'workspace' });
    for (const project of Object.values(store.projects)) {
      const key = rootKey(project.root);
      if (!out.has(key)) out.set(key, { root: project.root, label: basename(project.root) || project.root, source: 'store' });
    }
    return [...out.values()];
  }

  // --------------------------------------------------------------- validation

  function validate(input) {
    const result = normalizeServer(input);
    if (!result.ok) throw new ServiceError('invalid', 'the server definition is not valid', result.errors);
    return result.value;
  }

  function requireRoot(root) {
    if (typeof root !== 'string' || root.trim() === '') throw new ServiceError('invalid', 'projectRoot is required');
    return root;
  }

  function assertGlobalName(server, excludeId) {
    const taken = store.global.some((other) => other.id !== excludeId && other.serverName === server.serverName);
    if (taken) throw new ServiceError('name-conflict', `a global server named "${server.serverName}" already exists`);
    if (profileNames().includes(server.serverName)) {
      throw new ServiceError('name-conflict', `a profile row already provides "${server.serverName}"`);
    }
  }

  function assertProjectName(key, server, excludeId) {
    const others = store.projects[key]?.servers ?? [];
    if (others.some((other) => other.id !== excludeId && other.serverName === server.serverName)) {
      throw new ServiceError('name-conflict', `this project already has a server named "${server.serverName}"`);
    }
  }

  function ensureProject(root) {
    const key = rootKey(root);
    if (!store.projects[key]) store.projects[key] = { root, servers: [] };
    if (!store.projects[key].source) store.projects[key].source = ALL_SOURCES;
    return key;
  }

  // ---------------------------------------------------------------- file writes

  /** A read-only dialect may be listed but never written. */
  function assertWritable(source, action) {
    if (!source.caps?.[action]) {
      throw new ServiceError('read-only', `${source.label} (${source.path}) is read-only; import it into a writable source instead`);
    }
  }

  async function readSourceDocument(source, path, { allowMissing = false } = {}) {
    try {
      return await readDocument(path, source);
    } catch (error) {
      if (allowMissing && error && error.code === 'ENOENT') return emptyDocument();
      if (error && error.code === 'ENOENT') throw new ServiceError('not-found', `${source.path} does not exist`);
      throw new ServiceError('file', `cannot read ${source.path}: ${String(error?.message ?? error)}`);
    }
  }

  async function writeSourceDocument(source, path, document) {
    try {
      await writeDocument(path, document, source, { backupDir });
    } catch (error) {
      if (['has-comments', 'changed-on-disk', 'read-only'].includes(error?.code)) {
        throw new ServiceError(error.code, `${source.path}: ${error.message}`);
      }
      throw new ServiceError('file', `cannot write ${source.path}: ${String(error?.message ?? error)}`);
    }
  }

  function findStoredServer(id) {
    if (typeof id !== 'string') return undefined;
    return [...store.global, ...Object.values(store.projects).flatMap((project) => project.servers)].find((server) => server.id === id);
  }

  /**
   * Add or replace one entry inside a named project file. Editing keeps every
   * field the form does not model (dev, sandbox, oauth, ${input:...}, ...) and
   * the key the entry already has, unless the user renamed it.
   * Writing is the user's own act, so the result counts as approved; the
   * on/off switch stays where it was.
   */
  async function writeEntry(root, sourceId, input, originalName) {
    requireRoot(root);
    guardWrite();
    const source = sourceById(sourceId);
    if (!source) throw new ServiceError('invalid', 'unknown source');
    assertWritable(source, originalName ? 'edit' : 'add');
    const server = validate(restoreMasked(input ?? {}, findStoredServer(input?.id)));
    const path = sourcePath(source, { root });
    const document = await readSourceDocument(source, path, { allowMissing: !originalName });
    const renamed = originalName !== undefined && originalName !== server.serverName;
    let targetKey = server.serverName;
    let carried;
    if (originalName !== undefined) {
      const originalKey = resolveEntryKey(document, originalName, source);
      if (originalKey === undefined) throw new ServiceError('not-found', `"${originalName}" is no longer in ${source.path}`);
      if (renamed) {
        if (resolveEntryKey(document, server.serverName, source) !== undefined) {
          throw new ServiceError('name-conflict', `${source.path} already has a server named "${server.serverName}"`);
        }
        carried = tableAt(document, source.table)?.[originalKey];
        removeEntry(document, originalKey, source);
      } else {
        targetKey = originalKey;
      }
    } else if (resolveEntryKey(document, server.serverName, source) !== undefined) {
      throw new ServiceError('name-conflict', `${source.path} already has a server named "${server.serverName}"`);
    }
    upsertEntry(document, targetKey, entryFromServer(server, source.shape), source, carried);
    await writeSourceDocument(source, path, document);

    // A project the user acted on is remembered, so sessions inside it find it.
    const key = ensureProject(root);
    const reread = await effectiveProject(root);
    const written = reread.items.find((item) => item.origin === 'file' && item.server.serverName === server.serverName && item.source === source.path);
    if (written?.fingerprint) {
      store.trust[key] ??= {};
      const previous = store.trust[key][originalName ?? server.serverName] ?? store.trust[key][server.serverName];
      store.trust[key][server.serverName] = { fingerprint: written.fingerprint, approvedAt: now(), enabled: previous?.enabled !== false };
      if (renamed) delete store.trust[key][originalName];
      await persist();
    }
    await syncProject(key);
  }

  // ---------------------------------------------------------------- operations

  return {
    ServiceError,

    /** Load the store and mount every enabled global server. */
    async init() {
      const loaded = await load(deps.storeFile, { now });
      store = loaded.store;
      storeError = loaded.error;
      storeReadOnly = loaded.readOnly === true;
      if (storeError) logger.warn?.(`mcp-more-panel: ${storeError}`);
      await Promise.all(store.global.map((server) => syncGlobal(server.id)));
    },

    async getState() {
      const loaded = await client();
      let legacy = [];
      try {
        legacy = deps.legacy?.list?.() ?? [];
      } catch (error) {
        logger.warn?.(`mcp-more-panel: listing profile rows failed: ${error?.message ?? error}`);
      }
      return {
        client: loaded.ok ? { available: true } : { available: false, error: loaded.error },
        storeFile: deps.storeFile,
        storeError,
        storeReadOnly,
        global: store.global.map(globalView),
        legacy: legacy.map((row) => ({ ...row, toolCount: row.serverName ? toolCount(row.serverName) : 0 })),
        legacyAvailable: deps.legacy?.available?.() === true,
        projects: workspaceList(),
      };
    },

    async getProjectState(root) {
      requireRoot(root);
      const effective = await effectiveProject(root);
      const invalid = effective.files.flatMap((file) => (file.errors ?? []).map((error) => ({ file: file.path, ...error })));
      const presence = await this.sourcePresence(root);
      const comments = new Map(effective.files.map((file) => [file.source, file.comments === true]));
      return {
        root,
        selection: effective.selection,
        sources: SOURCES.map((source) => ({
          id: source.id, label: source.label, path: source.path,
          format: source.format, capabilities: source.caps, note: source.note,
          exists: presence[source.id] === true,
          comments: comments.get(source.id) === true,
        })),
        files: effective.files.map(({ errors: _errors, ...file }) => file),
        invalid,
        duplicates: effective.duplicates,
        servers: effective.items.map((item) => projectItemView(effective, item)),
        liveSessions: [...agents.values()].filter((state) => state.root && rootKey(state.root) === effective.key).length,
      };
    },

    // ---- global
    async saveGlobal(input) {
      guardWrite();
      const previous = typeof input?.id === 'string' ? store.global.find((other) => other.id === input.id) : undefined;
      const server = { ...validate(restoreMasked(input ?? {}, previous)), id: previous ? previous.id : newServerId() };
      const index = store.global.findIndex((other) => other.id === server.id);
      assertGlobalName(server, index >= 0 ? server.id : undefined);
      if (index >= 0) store.global[index] = server;
      else store.global.push(server);
      await persist();
      await syncGlobal(server.id);
      reapplyRestrictions();
      return globalView(server);
    },

    /**
     * Add every server of a pasted `mcpServers` (or VS Code `servers`)
     * document as a global server. Each entry succeeds or fails on its own.
     */
    async importGlobal(text) {
      guardWrite();
      if (typeof text !== 'string' || text.trim() === '') throw new ServiceError('invalid', 'nothing to import');
      const { document, errors } = parseDocument(text, { format: 'json' });
      if (errors.length > 0) throw new ServiceError('invalid', errors[0].message);
      const table = tableAt(document, ['mcpServers']) ?? tableAt(document, ['servers']) ?? tableAt(document, ['mcp', 'servers']);
      if (!table) throw new ServiceError('invalid', 'expected an "mcpServers" object');
      const results = [];
      for (const [key, def] of Object.entries(table)) {
        const converted = convertEntry(key, def);
        if (!converted.server) {
          results.push({ key, ok: false, error: converted.errors.map((error) => error.message).join('; ') });
          continue;
        }
        try {
          const view = await this.saveGlobal(converted.server);
          results.push({ key, ok: true, serverName: view.serverName, warnings: converted.warnings });
        } catch (error) {
          results.push({ key, ok: false, error: String(error?.message ?? error) });
        }
      }
      return { results, imported: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
    },

    async deleteGlobal(id) {
      guardWrite();
      const index = store.global.findIndex((server) => server.id === id);
      if (index < 0) throw new ServiceError('not-found', 'server not found');
      store.global.splice(index, 1);
      await persist();
      await syncGlobal(id);
      reapplyRestrictions();
      return { id };
    },

    async setGlobalEnabled(id, enabled) {
      guardWrite();
      const server = store.global.find((item) => item.id === id);
      if (!server) throw new ServiceError('not-found', 'server not found');
      server.enabled = enabled === true;
      await persist();
      await syncGlobal(id);
      reapplyRestrictions();
      return globalView(server);
    },

    async reconnectGlobal(id) {
      const server = store.global.find((item) => item.id === id);
      if (!server) throw new ServiceError('not-found', 'server not found');
      await syncGlobal(id);
      return globalView(server);
    },

    // ---- project
    /** Which source files exist for a project, for the picker. */
    async sourcePresence(root) {
      const out = {};
      await Promise.all(SOURCES.map(async (source) => {
        try {
          out[source.id] = (await statFile(sourcePath(source, { root }))).isFile();
        } catch {
          out[source.id] = false;
        }
      }));
      return out;
    },

    /** Add one server to a named project file. */
    async saveProjectServerToSource(root, sourceId, input) {
      await writeEntry(root, sourceId, input, undefined);
      return this.getProjectState(root);
    },

    /** Edit one server in the file it came from, preserving unmodelled fields. */
    async editProjectServerFromSource(root, sourceId, originalName, input) {
      if (typeof originalName !== 'string' || originalName === '') throw new ServiceError('invalid', 'originalName is required');
      await writeEntry(root, sourceId, input, originalName);
      return this.getProjectState(root);
    },

    /** Remove one server from the file it was read from. */
    async deleteProjectServerFromSource(root, sourceId, serverName) {
      requireRoot(root);
      guardWrite();
      const source = sourceById(sourceId);
      if (!source) throw new ServiceError('invalid', 'unknown source');
      assertWritable(source, 'delete');
      const path = sourcePath(source, { root });
      const document = await readSourceDocument(source, path);
      if (!removeEntry(document, serverName, source)) throw new ServiceError('not-found', `"${serverName}" is not in ${source.path}`);
      await writeSourceDocument(source, path, document);
      const key = rootKey(root);
      if (store.trust[key]) delete store.trust[key][serverName];
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    /** Copy one server from a source (typically read-only) into .dsh/mcp.json. */
    async importProjectServer(root, sourceId, serverName) {
      requireRoot(root);
      const source = sourceById(sourceId);
      if (!source) throw new ServiceError('invalid', 'unknown source');
      const effective = await effectiveProject(root);
      const item = effective.items.find((entry) => entry.origin === 'file' && entry.source === source.path && entry.server.serverName === serverName);
      if (!item) throw new ServiceError('not-found', `"${serverName}" is not declared in ${source.path}`);
      const { fileKey: _key, sourceId: _source, ...definition } = item.server;
      await writeEntry(root, 'dsh', { ...definition, id: undefined }, undefined);
      return this.getProjectState(root);
    },

    async saveProjectServer(root, input) {
      requireRoot(root);
      guardWrite();
      const key = ensureProject(root);
      const list = store.projects[key].servers;
      const previous = typeof input?.id === 'string' ? list.find((other) => other.id === input.id) : undefined;
      const server = { ...validate(restoreMasked(input ?? {}, previous)), id: previous ? previous.id : newServerId() };
      const index = list.findIndex((other) => other.id === server.id);
      assertProjectName(key, server, index >= 0 ? server.id : undefined);
      if (index >= 0) list[index] = server;
      else list.push(server);
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    async deleteProjectServer(root, id) {
      requireRoot(root);
      guardWrite();
      const key = rootKey(root);
      const list = store.projects[key]?.servers ?? [];
      const index = list.findIndex((server) => server.id === id);
      if (index < 0) throw new ServiceError('not-found', 'server not found');
      list.splice(index, 1);
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    /**
     * Switch one project server on or off. Works for servers the user added and,
     * once approved, for servers a repository declares: approval and enablement
     * are separate decisions, so parking a server keeps its approval.
     */
    async setProjectEnabled(root, id, enabled) {
      requireRoot(root);
      guardWrite();
      const key = rootKey(root);
      const storeServer = (store.projects[key]?.servers ?? []).find((item) => item.id === id);
      if (storeServer) {
        storeServer.enabled = enabled === true;
        await persist();
        await syncProject(key);
        return this.getProjectState(root);
      }
      const effective = await effectiveProject(root);
      const item = effective.items.find((entry) => entry.id === id);
      if (!item || item.origin !== 'file') throw new ServiceError('not-found', 'server not found');
      if (item.trustState !== 'approved') throw new ServiceError('not-approved', 'approve this server before switching it');
      const record = store.trust[key]?.[item.server.serverName];
      if (!record) throw new ServiceError('not-found', 'trust record not found');
      record.enabled = enabled === true;
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    /** Restart every server of the project, for the sessions working in it. */
    async reconnectProject(root) {
      requireRoot(root);
      await syncProject(rootKey(root), { force: true });
      return this.getProjectState(root);
    },

    /**
     * Try a definition without saving it. The probe mounts under a temporary
     * name (the host keeps one server per name per scope), waits for the
     * handshake, counts the tools that appeared, and releases it again. While
     * it runs, every session is denied its tools. A stdio probe does start the
     * real process — that is the only honest test.
     * @param {object} input - the definition, possibly with masked values and an `id`.
     * @param {string} [root] - project the definition belongs to, for its cwd and variables.
     */
    async testServer(input, root) {
      const probeName = `probe_${Math.random().toString(36).slice(2, 10)}`;
      const server = validate({ ...restoreMasked(input ?? {}, findStoredServer(input?.id)), serverName: probeName });
      probes.add(probeName);
      let record;
      try {
        record = await mountInto(deps.rootCtx, server, typeof root === 'string' && root !== '' ? projectContext(root) : {});
        if (!record.handle) return { ok: false, error: record.detail ?? 'the connection could not start' };
        reapplyRestrictions();
        const timeoutMs = Math.min(Math.max(Number(server.toolCallTimeoutMs) || 15000, 3000), 60000);
        let timer;
        const outcome = await Promise.race([
          record.handle.settled,
          new Promise((done) => { timer = setTimeout(() => done(undefined), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (outcome === undefined) return { ok: false, error: `timed out after ${timeoutMs} ms` };
        if (!outcome.ok) return { ok: false, error: outcome.error };
        // The tool registrations settle just after the handshake; one turn is enough.
        await new Promise((done) => setImmediate(done));
        reapplyRestrictions();
        return { ok: true, toolCount: toolCount(probeName) };
      } finally {
        disposeRecord(record);
        probes.delete(probeName);
        reapplyRestrictions();
      }
    },

    /**
     * Choose where this project's servers are read from: every known source
     * merged by priority, or exactly one of them. The selection is per project
     * and survives restarts. Switching sources remounts the project's sessions;
     * trust records are kept, so switching back restores them.
     */
    async setProjectSource(root, source) {
      requireRoot(root);
      guardWrite();
      if (source !== ALL_SOURCES && !SOURCES.some((item) => item.id === source)) {
        throw new ServiceError('invalid', 'unknown source');
      }
      const key = ensureProject(root);
      store.projects[key].source = source;
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    // ---- trust (user only: never exposed through the agent tool)
    async approveTrust(root, serverName, fingerprint) {
      requireRoot(root);
      guardWrite();
      const effective = await effectiveProject(root);
      const item = effective.items.find((entry) => entry.origin === 'file' && entry.server.serverName === serverName && !entry.shadowed);
      if (!item) throw new ServiceError('not-found', 'no such server in the project files');
      if (item.fingerprint !== fingerprint) {
        throw new ServiceError('fingerprint-mismatch', 'the definition changed after it was shown; review it again');
      }
      ensureProject(root);
      store.trust[effective.key] ??= {};
      // Re-approving keeps the switch where the user left it; approval is about trust, not usage.
      const previous = store.trust[effective.key][serverName];
      store.trust[effective.key][serverName] = {
        fingerprint,
        approvedAt: now(),
        ...(previous && typeof previous.enabled === 'boolean' ? { enabled: previous.enabled } : {}),
      };
      await persist();
      await syncProject(effective.key);
      return this.getProjectState(root);
    },

    async revokeTrust(root, serverName) {
      requireRoot(root);
      guardWrite();
      const key = rootKey(root);
      if (store.trust[key]) delete store.trust[key][serverName];
      await persist();
      await syncProject(key);
      return this.getProjectState(root);
    },

    // ---- profile rows
    async toggleLegacy(rowId, enabled) {
      if (!deps.legacy) throw new ServiceError('unavailable', 'profile rows cannot be managed here');
      try {
        await deps.legacy.toggle(rowId, enabled === true);
      } catch (error) {
        throw new ServiceError('legacy-failed', String(error?.message ?? error));
      }
      return { rowId };
    },

    async editLegacy(rowId, input) {
      if (!deps.legacy) throw new ServiceError('unavailable', 'profile rows cannot be managed here');
      const partial = normalizeLegacyForm(input);
      try {
        return await deps.legacy.edit(rowId, partial);
      } catch (error) {
        throw new ServiceError('legacy-failed', String(error?.message ?? error));
      }
    },

    // ---- sessions
    /**
     * Start tracking a session and mount the servers of the project it works in.
     * Until its project is known the session is denied every project's tools.
     * @param {{ id: string, ctx?: object }} agent - the session's agent.
     * @param {string} cwd - its working directory.
     */
    async attachAgent(agent, cwd) {
      if (disposed) return;
      const state = { agent, cwd, root: undefined, restriction: undefined, denyKey: '' };
      agents.set(agent.id, state);
      reapplyRestrictions();
      const root = await resolveRoot(cwd, { knownRoots: knownRoots(), home: homeDir });
      if (agents.get(agent.id) !== state || disposed) return;
      state.root = root;
      if (!root) {
        reapplyRestrictions();
        return;
      }
      const key = rootKey(root);
      let mount = projectMounts.get(key);
      const created = !mount;
      if (created) {
        mount = { key, root, refs: new Set(), servers: new Map(), byServer: new Map(), queues: new Map(), signature: undefined };
        projectMounts.set(key, mount);
      }
      mount.refs.add(agent.id);
      startWatching();
      if (created) await syncProject(key);
      else reapplyRestrictions();
    },

    detachAgent(agentId) {
      const state = agents.get(agentId);
      if (!state) return;
      agents.delete(agentId);
      try {
        state.restriction?.();
      } catch {
        // The session context is already gone; nothing to lift.
      }
      if (state.root) {
        const key = rootKey(state.root);
        const mount = projectMounts.get(key);
        if (mount) {
          mount.refs.delete(agentId);
          if (mount.refs.size === 0) {
            releaseMount(mount);
            projectMounts.delete(key);
          }
        }
      }
      reapplyRestrictions();
    },

    /** Read-only summary for the agent tool. */
    async summary(root) {
      const state = await this.getState();
      const out = {
        client: state.client,
        global: state.global.map(({ id, serverName, summary, status, toolCount: tools, detail }) => ({ id, serverName, summary, status, toolCount: tools, detail })),
        profileRows: state.legacy.map(({ rowId, serverName, endpoint, enabled, active, toolCount: tools }) => ({ rowId, serverName, endpoint, enabled, active, toolCount: tools })),
      };
      if (root) {
        const project = await this.getProjectState(root);
        out.project = {
          root,
          servers: project.servers.map(({ serverName, registration, origin, summary, status, trustState, toolCount: tools, detail }) => ({ serverName, registration, origin, summary, status, trustState, toolCount: tools, detail })),
        };
      }
      return out;
    },

    async diagnose() {
      const loaded = await client();
      return {
        mcpClient: loaded.ok ? { available: true } : { available: false, error: loaded.error },
        storeFile: deps.storeFile,
        storeError: storeError ?? null,
        storeReadOnly,
        globalServers: store.global.length,
        projectsWithServers: Object.keys(store.projects).length,
        trackedSessions: agents.size,
        sessionsInProjects: [...agents.values()].filter((state) => state.root).length,
        mountedProjects: projectMounts.size,
        watchIntervalMs,
        profileRowsAvailable: deps.legacy?.available?.() === true,
      };
    },

    dispose() {
      disposed = true;
      if (ticker) clearInterval(ticker);
      ticker = undefined;
      for (const record of globalMounts.values()) disposeRecord(record);
      globalMounts.clear();
      for (const state of agents.values()) {
        try {
          state.restriction?.();
        } catch {
          // Ignore a restriction whose scope has already been torn down.
        }
      }
      agents.clear();
      for (const mount of projectMounts.values()) releaseMount(mount);
      projectMounts.clear();
    },
  };
}

/**
 * Turn a loose edit payload for a profile row into the partial form
 * `applyLegacyEdit` expects. Identity fields are never accepted.
 * @param {object} input - payload from the page.
 */
export function normalizeLegacyForm(input) {
  if (input === null || typeof input !== 'object') throw new ServiceError('invalid', 'edit payload must be an object');
  const probe = normalizeServer({ transport: 'stdio', command: 'x', ...input, serverName: 'x', ...(input.url ? { transport: 'streamable-http' } : {}) });
  if (!probe.ok) throw new ServiceError('invalid', 'the edit is not valid', probe.errors);
  const form = {};
  for (const key of ['command', 'url', 'cwd', 'args', 'env', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) {
    if (input[key] !== undefined) form[key] = probe.value[key] ?? input[key];
  }
  return form;
}
