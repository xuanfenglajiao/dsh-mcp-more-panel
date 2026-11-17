/**
 * Risk hints for a server definition.
 *
 * These are hints, not verdicts: `npx -y @modelcontextprotocol/server-github` is
 * an ordinary way to run an MCP server, and it still downloads and executes
 * whatever the registry serves each time it starts. The point is to make that
 * property visible next to a command that does not have it, so the person
 * approving can weigh them differently.
 *
 * Two hints describe what an approval does not cover: a command that runs a
 * file from the repository (the file can change without changing the
 * fingerprint), and environment variables that make a runtime load extra code.
 */

import { isAbsolute } from 'node:path';

/** Runners that fetch what they run from a registry: packages, or container images. */
const DOWNLOADERS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'pipx', 'pip', 'pip3', 'docker', 'podman']);
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'fish']);
const SCRIPT_RE = /\.(m?js|cjs|ts|mts|py|rb|php|pl|sh|bash|ps1|bat|cmd|jar)$/i;
/** Variables that make a runtime or the dynamic loader execute additional code. */
const LOADER_ENV_RE = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|BASH_ENV|ENV|PATH|PATHEXT|COMSPEC)$/i;

const unquote = (text) => String(text ?? '').trim().replace(/^["']|["']$/g, '');

/** The command as written, without directories or a launcher extension, lower-cased. */
function commandName(command) {
  const parts = unquote(command).split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
}

/**
 * A relative path, as opposed to a bare program name looked up on PATH, a URL
 * or a shell command line. `scripts` also counts a bare `server.js` as a file,
 * which is right for arguments and wrong for the command itself.
 */
function isRelativePath(text, { scripts = false } = {}) {
  const value = unquote(text);
  if (value === '' || /\s/.test(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^\.\.?([\\/]|$)/.test(value) || /[\\/]/.test(value) || (scripts && SCRIPT_RE.test(value));
}

/**
 * @param {{ transport?: string, command?: string, args?: string[], env?: Record<string, string> }} server
 * @returns {{ code: string, level: 'high'|'warn'|'info' }[]} codes are translated by the page.
 */
export function assessRisk(server) {
  const flags = [];
  if (!server || server.transport !== 'stdio') return flags;
  const name = commandName(server.command);
  const args = (server.args || []).map(String);
  const joined = [server.command, ...args].map(String).join(' ');

  if (DOWNLOADERS.has(name)) flags.push({ code: 'downloads', level: 'warn' });
  if (SHELLS.has(name)) flags.push({ code: 'shell', level: 'warn' });
  if (/\|\s*(sh|bash|zsh|powershell|pwsh|cmd)(\.exe)?\b/i.test(joined)) flags.push({ code: 'pipe-shell', level: 'high' });
  if (/(^|[\s"'/\\])(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)(\s|$)/i.test(joined)) flags.push({ code: 'download-command', level: 'warn' });
  // Package runner arguments are package names, not files; everything else may point into the repository.
  if (isRelativePath(server.command) || (!DOWNLOADERS.has(name) && args.some((arg) => !arg.startsWith('-') && isRelativePath(arg, { scripts: true })))) {
    flags.push({ code: 'repo-file', level: 'warn' });
  }
  if (Object.keys(server.env || {}).some((key) => LOADER_ENV_RE.test(key))) flags.push({ code: 'env-inject', level: 'high' });
  if (server.command && isAbsolute(unquote(server.command))) flags.push({ code: 'absolute', level: 'info' });

  return flags;
}

/** The strongest level among the flags, for sorting and styling. */
export function riskLevel(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return undefined;
  if (flags.some((flag) => flag.level === 'high')) return 'high';
  if (flags.some((flag) => flag.level === 'warn')) return 'warn';
  return 'info';
}
