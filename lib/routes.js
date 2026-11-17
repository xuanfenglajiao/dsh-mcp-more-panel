/**
 * The page's JSON route.
 *
 * One exact path, POST only, `{ op, ...args }` in and `{ ok, value }` or
 * `{ ok: false, error }` out. Every request passes the host's own admission
 * check first, exactly as the shipped plugins do, and must be JSON so a plain
 * cross-site form post cannot reach a state-changing operation.
 */

export const API_PATH = '/mcp-panel/api';
const MAX_BODY_BYTES = 1024 * 1024;

/** HTTP status for a service error code; anything not listed is a bad request. */
const STATUS_OF = {
  'not-found': 404,
  'name-conflict': 409,
  'fingerprint-mismatch': 409,
  'changed-on-disk': 409,
  'has-comments': 409,
  'read-only': 409,
  'not-approved': 409,
  'store-read-only': 503,
  unavailable: 503,
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function fail(res, status, code, message, details) {
  sendJson(res, status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.code = 'too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Build the operation table. Trust approval lives here and only here: the agent
 * tool is read-only by construction.
 * @param {object} service - panel service.
 * @param {() => object} extras - host facts merged into diagnostics.
 */
export function createOperations(service, extras = () => ({})) {
  const text = (value, name) => {
    if (typeof value !== 'string' || value === '') throw new service.ServiceError('invalid', `${name} is required`);
    return value;
  };
  return {
    state: () => service.getState(),
    projectState: (a) => service.getProjectState(text(a.root, 'root')),
    diagnose: async () => ({ ...(await service.diagnose()), ...extras() }),

    saveGlobal: (a) => service.saveGlobal(a.server),
    importGlobal: (a) => service.importGlobal(text(a.text, 'text')),
    deleteGlobal: (a) => service.deleteGlobal(text(a.id, 'id')),
    setGlobalEnabled: (a) => service.setGlobalEnabled(text(a.id, 'id'), a.enabled === true),
    reconnectGlobal: (a) => service.reconnectGlobal(text(a.id, 'id')),

    saveProject: (a) => service.saveProjectServer(text(a.root, 'root'), a.server),
    saveProjectSource: (a) => service.saveProjectServerToSource(text(a.root, 'root'), text(a.source, 'source'), a.server),
    editProjectSource: (a) => service.editProjectServerFromSource(text(a.root, 'root'), text(a.source, 'source'), text(a.originalName, 'originalName'), a.server),
    importProjectServer: (a) => service.importProjectServer(text(a.root, 'root'), text(a.source, 'source'), text(a.serverName, 'serverName')),
    deleteProjectSource: (a) => service.deleteProjectServerFromSource(text(a.root, 'root'), text(a.source, 'source'), text(a.serverName, 'serverName')),
    deleteProject: (a) => service.deleteProjectServer(text(a.root, 'root'), text(a.id, 'id')),
    setProjectEnabled: (a) => service.setProjectEnabled(text(a.root, 'root'), text(a.id, 'id'), a.enabled === true),
    reconnectProject: (a) => service.reconnectProject(text(a.root, 'root')),
    setProjectSource: (a) => service.setProjectSource(text(a.root, 'root'), text(a.source, 'source')),
    testServer: (a) => service.testServer(a.server, typeof a.root === 'string' && a.root !== '' ? a.root : undefined),

    approveTrust: (a) => service.approveTrust(text(a.root, 'root'), text(a.serverName, 'serverName'), text(a.fingerprint, 'fingerprint')),
    revokeTrust: (a) => service.revokeTrust(text(a.root, 'root'), text(a.serverName, 'serverName')),

    toggleLegacy: (a) => service.toggleLegacy(text(a.rowId, 'rowId'), a.enabled === true),
    editLegacy: (a) => service.editLegacy(text(a.rowId, 'rowId'), a.form),
  };
}

/**
 * @param {object} options
 * @param {object} options.service - panel service.
 * @param {(req: object) => boolean} options.fence - host admission check.
 * @param {Promise<unknown>} [options.ready] - awaited before every operation.
 * @param {() => object} [options.extras] - host facts for diagnostics.
 * @param {object} [options.logger]
 * @returns {(req: object, res: object) => Promise<void>} route handler.
 */
export function createApiHandler({ service, fence, ready = Promise.resolve(), extras, logger = {} }) {
  const operations = createOperations(service, extras);
  return async function handler(req, res) {
    if (!fence(req)) return fail(res, 403, 'forbidden', 'forbidden');
    if (req.method !== 'POST') {
      res.setHeader?.('allow', 'POST');
      return fail(res, 405, 'method', 'method not allowed');
    }
    const type = String(req.headers?.['content-type'] ?? '');
    if (!/^application\/json\b/i.test(type)) return fail(res, 415, 'content-type', 'content-type must be application/json');
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error?.code === 'too-large') return fail(res, 413, 'too-large', error.message);
      return fail(res, 400, 'bad-json', 'request body is not valid JSON');
    }
    if (body === null || typeof body !== 'object' || typeof body.op !== 'string') {
      return fail(res, 400, 'bad-request', 'op is required');
    }
    const operation = Object.hasOwn(operations, body.op) ? operations[body.op] : undefined;
    if (!operation) return fail(res, 404, 'unknown-op', `unknown operation "${body.op}"`);
    try {
      await ready;
      const value = await operation(body);
      return sendJson(res, 200, { ok: true, value });
    } catch (error) {
      if (error && error.name === 'ServiceError') {
        return fail(res, STATUS_OF[error.code] ?? 400, error.code, error.message, error.details);
      }
      logger.warn?.(`mcp-more-panel: ${body.op} failed: ${error?.stack ?? error}`);
      return fail(res, 500, 'internal', String(error?.message ?? error));
    }
  };
}
