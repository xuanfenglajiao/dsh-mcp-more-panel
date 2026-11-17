/**
 * Host half of the MCP servers panel.
 *
 * Wires the panel service to the host: the page's JSON route, the read-only
 * agent tool, and the session events that mount a project's servers into the
 * sessions working inside it. All decisions live in `lib/service.js`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLegacyAdapter } from './lib/legacy.js';
import { loadMcpClient, mountClient } from './lib/mount.js';
import { API_PATH, createApiHandler } from './lib/routes.js';
import { createService } from './lib/service.js';
import { TOOL_NAME, createTool } from './lib/tool.js';

export const inject = ['webServer', 'connection', 'tools'];

/** Names of the tools the official client registers for one server. */
const toolPrefix = (serverName) => `mcp__${serverName}__`;

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const storeFile = join(dshHome, 'dsh-mcp-more-panel', 'store.json');
  const logger = ctx.logger ?? {};
  const facts = { toolRegistered: false, toolError: null, apiPath: API_PATH };

  const legacy = createLegacyAdapter(() => ({
    configEditor: ctx.get('configEditor'),
    pluginManager: ctx.get('pluginManager'),
  }));

  /** How many tools one server currently exposes in the global view. */
  const toolCount = (serverName) => toolNames(serverName).length;

  const listWorkspaces = () => {
    try {
      const registry = ctx.get('workspaceRegistry');
      return (registry?.list?.() ?? [])
        .map((workspace) => workspace?.path ?? workspace?.directory ?? workspace?.root)
        .filter((path) => typeof path === 'string' && path !== '');
    } catch {
      return [];
    }
  };

  /** The names the host registered for one server, used to mask other projects' tools per session. */
  const toolNames = (serverName) => {
    const definitions = ctx.tools.definitions();
    const prefix = toolPrefix(serverName);
    return definitions.filter((definition) => definition.name.startsWith(prefix)).map((definition) => definition.name);
  };

  const service = createService({
    storeFile,
    rootCtx: ctx,
    client: { load: () => loadMcpClient(), mount: (target, mod, config) => mountClient(target, mod, config) },
    toolCount,
    toolNames,
    legacy,
    listWorkspaces,
    logger,
  });

  const ready = service.init().catch((error) => {
    logger.warn?.(`mcp-more-panel: start-up failed: ${error?.stack ?? error}`);
  });

  ctx.effect(() => () => service.dispose(), 'mcp-more-panel: service');

  // Page route. The host's admission check is the same one the shipped plugins use.
  const fence = (req) => ctx.connection.requestRejection(req) === undefined;
  const handler = createApiHandler({ service, fence, ready, extras: () => facts, logger });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PATH, handler }), 'mcp-more-panel: api route');

  // Read-only agent tool. `defineTool` comes from the host; without it the tool is skipped, not the plugin.
  import('@deepseek-ai/dsh-tools').then(
    ({ defineTool }) => {
      try {
        ctx.effect(() => ctx.tools.register(createTool(defineTool, service, () => facts)), `mcp-more-panel: ${TOOL_NAME} tool`);
        facts.toolRegistered = true;
      } catch (error) {
        facts.toolError = String(error?.message ?? error);
        logger.warn?.(`mcp-more-panel: registering ${TOOL_NAME} failed: ${facts.toolError}`);
      }
    },
    (error) => {
      facts.toolError = String(error?.message ?? error);
      logger.warn?.(`mcp-more-panel: the ${TOOL_NAME} tool is unavailable: ${facts.toolError}`);
    },
  );

  // Sessions: mount the servers of the project each one works in, and release them with it.
  const workingDirectory = async (agent) => {
    try {
      return await ctx.get('workingDirectory')?.ensure(agent);
    } catch {
      return undefined;
    }
  };

  const track = (agent) => {
    if (!agent || typeof agent.id !== 'string') return;
    agent.ctx?.effect?.(() => () => service.detachAgent(agent.id), 'mcp-more-panel: session');
    void (async () => {
      await ready;
      const cwd = await workingDirectory(agent);
      if (typeof cwd === 'string') await service.attachAgent(agent, cwd);
    })().catch((error) => logger.warn?.(`mcp-more-panel: tracking a session failed: ${error?.message ?? error}`));
  };

  // Not awaited: the host holds a session's first input until `agent/created` listeners finish.
  ctx.on('agent/created', ({ agent }) => {
    track(agent);
  });
  for (const agent of ctx.get('agents')?.list?.() ?? []) track(agent);
}
