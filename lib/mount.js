/**
 * Mounting servers through the official `@deepseek-ai/dsh-mcp-client` plugin.
 *
 * The panel never speaks MCP itself. Each server is one fiber of the official
 * client, created with the client's own `Config` schema exactly as the in-box
 * precedent does (`ctx.plugin(McpClient, McpClient.Config({...}))`), so
 * discovery, naming, reconnection, timeouts and instructions are the client's.
 */

export const CLIENT_SPECIFIER = '@deepseek-ai/dsh-mcp-client';

/**
 * Resolve the official client module. Failure is reported, not thrown: the
 * module is resolved by the host, and a plugin loaded from a linked directory
 * may not be able to see it (verified at runtime, see `diagnose`).
 * @param {(specifier: string) => Promise<object>} [importer] - injectable for tests.
 * @returns {Promise<{ ok: true, mod: object } | { ok: false, error: string }>}
 */
export async function loadMcpClient(importer = (specifier) => import(specifier)) {
  try {
    const mod = await importer(CLIENT_SPECIFIER);
    if (mod === null || typeof mod !== 'object') return { ok: false, error: 'module has no exports' };
    return { ok: true, mod };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Mount one server in a context. The service always mounts in the plugin's own
 * context, so the tools are registered globally; per-session visibility is
 * handled with `ctx.tools.restrict` (see service.js).
 *
 * `settled` reflects the first outcome only: it resolves when the client's
 * fiber finished starting. Later disconnects are handled by the client's own
 * reconnect logic and are not reported here.
 * @param {object} ctx - cordis context to mount in.
 * @param {object} mod - official client module.
 * @param {object} config - client row config (already variable-expanded).
 * @returns {{ dispose: () => void, settled: Promise<{ ok: boolean, error?: string }> }}
 */
export function mountClient(ctx, mod, config) {
  const value = typeof mod.Config === 'function' ? mod.Config(config) : config;
  // Called through the receiver: `ctx.plugin` is context-bound.
  const fiber = ctx.plugin(mod, value);
  const settled = (async () => {
    try {
      if (fiber && typeof fiber.await === 'function') await fiber.await();
      else await Promise.resolve(fiber);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  })();
  return {
    settled,
    dispose() {
      try {
        const result = fiber?.dispose?.();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {
        // Disposal is best effort: the owning context tears the fiber down too.
      }
    },
  };
}
