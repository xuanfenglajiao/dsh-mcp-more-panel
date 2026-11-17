import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * Render the page's components for real, with a minimal React: function
 * components are called, hooks return their initial values, and the result is
 * flattened to text. This catches runtime errors and checks what a person
 * would read, without a browser.
 */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const FRAGMENT = Symbol('fragment');

const miniReact = {
  Fragment: FRAGMENT,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial = null) => ({ current: initial }),
  useMemo: (fn) => fn(),
};

function load() {
  let definition;
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
    document: { baseURI: 'dsh-app://app/' },
    URL,
    JSON,
    __MCP_MORE_PANEL_TEST__: true,
  });
  const { internals } = definition.factory(() => miniReact);
  const { zh } = internals.dictionaries;
  const t = (key, params = {}) => String(zh[key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''));
  return { internals, t };
}

/** Render to a flat list of text fragments and the elements met on the way. */
function render(node, out = { text: [], elements: [] }) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) render(item, out);
    return out;
  }
  const { type, props, children } = node;
  if (typeof type === 'function') return render(type({ ...props, children: children.length <= 1 ? children[0] : children }), out);
  out.elements.push(node);
  return render(children, out);
}
const textOf = (node) => render(node).text.join(' ');

const FILE_VIEW = {
  id: 'file:.mcp.json:web',
  origin: 'file',
  source: '.mcp.json',
  sourceId: 'claude',
  serverName: 'web',
  server: { serverName: 'web', transport: 'stdio', command: 'node', args: ['server.js', 'two words', 'line\nbreak'], env: { NODE_OPTIONS: '--require ./x.js', TOKEN: '${GITHUB_TOKEN}' } },
  enabled: false,
  summary: 'node server.js',
  status: 'trust-changed',
  toolCount: 0,
  trustState: 'changed',
  fingerprint: 'a'.repeat(64),
  risk: [{ code: 'repo-file', level: 'warn' }, { code: 'env-inject', level: 'high' }],
  variables: ['GITHUB_TOKEN'],
  warnings: ['name "w e b" was converted to "web"'],
  duplicateOf: { serverName: 'web', winner: '.mcp.json', entries: [{ source: '.cursor/mcp.json', sameAsWinner: false }, { source: '.mcp.json', sameAsWinner: true }] },
};

test('render: the approval dialog shows values, variables, risks and argument boundaries', () => {
  const { internals, t } = load();
  const text = textOf(miniReact.createElement(internals.components.TrustDialog, { view: FILE_VIEW, t, onClose() {}, onApprove() {}, busy: false }));
  assert.match(text, /GITHUB_TOKEN/, 'the variable it reads is named');
  assert.match(text, /NODE_OPTIONS="--require \.\/x\.js"/, 'environment values are shown, not hidden, with their boundaries');
  assert.match(text, /TOKEN=\$\{GITHUB_TOKEN\}/, 'a reference is shown as written');
  assert.match(text, /"two words"/, 'an argument with a blank is quoted');
  assert.match(text, /"line\\nbreak"/, 'a line break inside an argument is visible');
  assert.ok(text.includes(t('risk.repo-file')) && text.includes(t('risk.env-inject')), 'risk hints are listed');
  assert.ok(text.includes('.cursor/mcp.json'), 'a differing duplicate is named');
  assert.ok(text.includes(t('trust.confirmKeepOff')), 'a parked server says it stays off');
  assert.ok(text.includes('converted'), 'reading notes are shown');
});

test('render: a row stays compact and carries the override tag', () => {
  const { internals, t } = load();
  const view = { ...FILE_VIEW, origin: 'store', status: 'active', trustState: 'trusted', overrides: 'global', toolCount: 3, server: { ...FILE_VIEW.server, notes: '' } };
  const out = render(miniReact.createElement(internals.components.ServerRow, { view, t, busy: false, project: true, caps: {} }));
  const text = out.text.join(' ');
  assert.ok(text.includes(t('override.tag')));
  assert.ok(!text.includes(t('risk.repo-file')), 'risk sentences are not printed on the row (§7.5)');
  const tag = out.elements.find((element) => element.props && element.props.title === t('override.global'));
  assert.ok(tag, 'the full sentence is in the tag title');
});

test('render: a server disabled in its file offers no switch', () => {
  const { internals, t } = load();
  const view = { ...FILE_VIEW, status: 'disabled-in-file', trustState: 'approved' };
  const out = render(miniReact.createElement(internals.components.ServerRow, { view, t, busy: false, project: true, caps: { edit: true, delete: true } }));
  assert.ok(!out.elements.some((element) => element.props && element.props.role === 'switch'));
  assert.ok(out.text.join(' ').includes(t('status.disabled-in-file')));
});

test('render: forms, the import dialog and the page itself render without throwing', () => {
  const { internals, t } = load();
  const { ServerForm, ImportDialog, McpPage, LegacyRow } = internals.components;
  const form = internals.formFromServer({ serverName: 'db', transport: 'stdio', command: 'x', args: ['a'], env: { A: '1' } });
  assert.ok(textOf(miniReact.createElement(ServerForm, { title: 'x', initial: form, mode: 'new', scope: 'project', targets: [{ value: 'store', label: 's' }], t, onSubmit() {}, onCancel() {} })).includes(t('test.run')));
  const legacy = internals.formFromRow({ rowId: 'r', serverName: 'm', transport: 'stdio', config: { serverName: 'm', command: { __jsExpr: 'x' } }, expressionFields: ['command'] });
  assert.ok(!textOf(miniReact.createElement(ServerForm, { title: 'x', initial: legacy, mode: 'legacy', scope: 'legacy', t, onSubmit() {}, onCancel() {} })).includes(t('test.run')), 'no test button when the command is an expression');
  assert.ok(textOf(miniReact.createElement(ImportDialog, { t, onClose() {}, onImport: async () => ({}) })).includes(t('import.title')));
  assert.ok(textOf(miniReact.createElement(LegacyRow, { row: { rowId: 'r', serverName: 'm', transport: 'stdio', endpoint: 'x', enabled: true, active: true, toolCount: 1, expressionFields: [] }, t })).includes('m'));
  assert.ok(textOf(miniReact.createElement(McpPage, { t })).includes(t('page.title')));
});

test('quoteArg leaves plain arguments alone and quotes the rest', () => {
  const { internals } = load();
  assert.equal(internals.quoteArg('-y'), '-y');
  assert.equal(internals.quoteArg('@scope/pkg@1.2.3'), '@scope/pkg@1.2.3');
  assert.equal(internals.quoteArg('${TOKEN}'), '${TOKEN}');
  assert.equal(internals.quoteArg('a b'), '"a b"');
  assert.equal(internals.quoteArg(''), '""');
});
