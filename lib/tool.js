/**
 * Read-only agent tool.
 *
 * The model can look at what is configured and why a server is not connected.
 * It cannot add, change, enable, approve or remove anything: those operations
 * hand out authority (they decide which commands run) and stay with the user's
 * page. Keep this tool free of any write path.
 */

export const TOOL_NAME = 'mcp_servers';

const DESCRIPTION =
  'Read-only overview of the MCP servers managed by the "MCP servers" panel. ' +
  'Use action "list" to see global servers, profile rows and, when projectRoot is given, that project\'s servers with their ' +
  'connection status, tool counts and trust state. Use action "diagnose" to see why servers are unavailable ' +
  '(official client availability, store location). This tool cannot change anything; configuration and trust approval are done by the user in the panel.';

/**
 * @param {Function} defineTool - `defineTool` from `@deepseek-ai/dsh-tools`.
 * @param {object} service - panel service.
 * @param {() => object} [extras] - host facts merged into diagnostics.
 */
export function createTool(defineTool, service, extras = () => ({})) {
  return defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', required: true, description: 'Either "list" or "diagnose".' },
      projectRoot: {
        type: 'string',
        description: 'Absolute path of a project directory whose servers should be included in "list".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          json: { type: 'string', required: true, description: 'The result as a JSON document.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted?.();
      if (args.action === 'list') {
        const root = typeof args.projectRoot === 'string' && args.projectRoot !== '' ? args.projectRoot : undefined;
        return { json: JSON.stringify(await service.summary(root), null, 2) };
      }
      if (args.action === 'diagnose') {
        return { json: JSON.stringify({ ...(await service.diagnose()), ...extras() }, null, 2) };
      }
      throw new Error('action must be "list" or "diagnose"');
    },
  });
}
