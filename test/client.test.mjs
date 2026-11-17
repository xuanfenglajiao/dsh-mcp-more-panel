import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** Values built inside the vm realm have different prototypes; compare their plain JSON shape. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Load client.js in an isolated context with a stub React; returns its internals. */
function load({ baseURI = 'dsh-app://app/', fetchImpl } = {}) {
  let definition;
  const stubReact = {
    createElement: () => ({}),
    Fragment: Symbol('fragment'),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useMemo: (fn) => fn(),
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
    document: { baseURI },
    fetch: fetchImpl,
    URL,
    JSON,
    __MCP_MORE_PANEL_TEST__: true,
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(definition.id, 'dsh-mcp-more-panel');
  const exported = definition.factory((name) => {
    assert.equal(name, 'react');
    return stubReact;
  });
  return { exported, internals: exported.internals };
}

const t = (key, params) => `${key}${params ? JSON.stringify(params) : ''}`;

test('the module exports the documented shape and nothing test-only without the flag', () => {
  const { exported } = load();
  assert.deepEqual(plain(exported.inject), ['locale', 'slots', 'layout']);
  assert.equal(typeof exported.apply, 'function');

  let productionDefinition;
  const sandbox = { window: { __ModuleLoader__: { load: (def) => { productionDefinition = def; } } }, URL, JSON };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const out = productionDefinition.factory(() => ({ createElement: () => ({}), useState: () => [], useEffect() {}, useCallback: (f) => f, useRef: () => ({}), useMemo: (f) => f() }));
  assert.equal(out.internals, undefined);
});

test('apply registers the panel entry below Schedules and the main panel, and no More menu row', () => {
  const { exported } = load();
  const registered = [];
  const scope = {
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (key, cb) => { registered.push({ via: 'inject', key }); return cb(); },
      register: (options, component) => { registered.push({ via: 'register', options, component }); return () => {}; },
    },
  };
  exported.apply({ inject: (_services, cb) => cb(scope) });
  const regs = registered.filter((r) => r.via === 'register').map((r) => r.options);
  assert.deepEqual(regs.map((o) => o.name).sort(), ['main', 'sidebar.panellist']);
  const entry = regs.find((o) => o.name === 'sidebar.panellist');
  assert.equal(entry.id, 'dsh-mcp-more-panel');
  assert.equal(entry.order, 20);
  assert.equal(regs.find((o) => o.name === 'main').key, 'dsh-mcp-more-panel');
  assert.ok(!registered.some((r) => r.key === 'sidebar.panellist.actions'));
});

test('the route is resolved against the page base, not the origin root', () => {
  assert.equal(load({ baseURI: 'dsh-app://app/' }).internals.endpoint(), 'dsh-app://app/mcp-panel/api');
  assert.equal(load({ baseURI: 'https://h.example/proxy/3080/' }).internals.endpoint(), 'https://h.example/proxy/3080/mcp-panel/api');
  assert.equal(load({ baseURI: 'http://127.0.0.1:3080/' }).internals.endpoint(), 'http://127.0.0.1:3080/mcp-panel/api');
});

test('api returns the value, maps errors to codes, and reports transport failures', async () => {
  const calls = [];
  const reply = (status, body, { json = true } = {}) => async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => { if (!json) throw new Error('not json'); return body; } };
  };

  let { internals } = load({ fetchImpl: reply(200, { ok: true, value: { a: 1 } }) });
  assert.deepEqual(await internals.api('state', { x: 1 }), { a: 1 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { op: 'state', x: 1 });

  ({ internals } = load({ fetchImpl: reply(400, { ok: false, error: { code: 'invalid', message: 'bad', details: [{ field: 'url' }] } }) }));
  await assert.rejects(() => internals.api('saveGlobal', {}), (e) => e.code === 'invalid' && e.message === 'bad' && e.details[0].field === 'url');

  ({ internals } = load({ fetchImpl: reply(502, null, { json: false }) }));
  await assert.rejects(() => internals.api('state'), (e) => e.code === 'bad-response' && /502/.test(e.message));

  ({ internals } = load({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }));
  await assert.rejects(() => internals.api('state'), (e) => e.code === 'network' && /Failed to fetch/.test(e.message));
});

test('parseLines handles values containing the separator, comments and blank lines', () => {
  const { internals } = load();
  assert.deepEqual(plain(internals.parseLines('A=1\n\n# note\nURL=http://h/?a=b\nB = spaced ', '=').value), { A: '1', URL: 'http://h/?a=b', B: 'spaced' });
  assert.deepEqual(plain(internals.parseLines('Authorization: Bearer a:b:c\nX-Id: 7', ':').value), { Authorization: 'Bearer a:b:c', 'X-Id': '7' });
  assert.deepEqual(plain(internals.parseLines('ok=1\nbroken line', '=').error), { line: 2, text: 'broken line' });
  assert.deepEqual(plain(internals.parseLines('=novalue', '=').error), { line: 1, text: '=novalue' });
});

test('a server survives the form round trip unchanged', () => {
  const { internals } = load();
  const server = {
    id: 's1', serverName: 'git', transport: 'stdio', command: 'npx', args: ['-y', '@scope/pkg'], env: { TOKEN: '${GH}', A: 'b=c' }, cwd: 'C:\\work',
    toolCallTimeoutMs: 30000, failOnStartupError: true, maxInstructionBytes: 4096, reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 2000, maxAttempts: 3 },
    notes: 'n', enabled: false,
  };
  const { payload } = internals.payloadFromForm(internals.formFromServer(server), t);
  assert.deepEqual(plain(payload), {
    id: 's1', serverName: 'git', transport: 'stdio', enabled: false, notes: 'n',
    command: 'npx', args: ['-y', '@scope/pkg'], env: { TOKEN: '${GH}', A: 'b=c' }, cwd: 'C:\\work',
    toolCallTimeoutMs: 30000, failOnStartupError: true, maxInstructionBytes: 4096,
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 2000, maxAttempts: 3 },
  });

  const http = { id: 'h1', serverName: 'web', transport: 'streamable-http', url: 'http://h/mcp', headers: { Authorization: 'Bearer ${T}' }, enabled: true };
  const out = internals.payloadFromForm(internals.formFromServer(http), t).payload;
  assert.equal(out.url, 'http://h/mcp');
  assert.deepEqual(plain(out.headers), { Authorization: 'Bearer ${T}' });
  assert.equal(out.command, undefined);
  assert.equal(out.reconnect, undefined);
});

test('a malformed line is reported with its field instead of producing a payload', () => {
  const { internals } = load();
  const form = { ...internals.emptyForm(), serverName: 'a', command: 'x', envText: 'GOOD=1\nbad' };
  const result = internals.payloadFromForm(form, t);
  assert.equal(result.payload, undefined);
  assert.equal(result.field, 'env');
  assert.match(result.error, /form\.lineError/);
});

test('blank optional numbers and default tri-state selections are left out', () => {
  const { internals } = load();
  const form = { ...internals.emptyForm(), serverName: 'a', command: 'x' };
  const { payload } = internals.payloadFromForm(form, t);
  assert.equal(payload.toolCallTimeoutMs, undefined);
  assert.equal(payload.failOnStartupError, undefined);
  assert.equal(payload.reconnect, undefined);
});

test('a profile row keeps expression entries out of the form and says they are kept', () => {
  const { internals } = load();
  const row = {
    rowId: 'memory-http', serverName: 'memory', transport: 'streamable-http',
    expressionFields: ['headers.Authorization'],
    config: {
      serverName: 'memory', transport: 'streamable-http', url: 'http://127.0.0.1:8790/mcp',
      headers: { Authorization: { __jsExpr: '`Bearer ${process.env.X}`' }, 'X-Plain': 'p' }, toolCallTimeoutMs: 10000,
    },
  };
  const form = internals.formFromRow(row);
  assert.equal(form.url, 'http://127.0.0.1:8790/mcp');
  assert.equal(form.headersText, 'X-Plain: p', 'only the literal entry is editable text');
  assert.ok(!form.headersText.includes('process.env'), 'the expression source is not put into an editable box');
  assert.deepEqual(plain(form.exprEntries), ['headers.Authorization']);
  assert.equal(form.locked.headers, undefined, 'the map as a whole is not locked');
  assert.equal(form.toolCallTimeoutMs, '10000');

  const { payload } = internals.payloadFromForm({ ...form, toolCallTimeoutMs: '20000' }, t, { includeIdentity: false });
  assert.equal(payload.toolCallTimeoutMs, 20000);
  assert.deepEqual(plain(payload.headers), { 'X-Plain': 'p' }, 'the expression entry is never sent; the Host keeps it');
  assert.equal(payload.serverName, undefined, 'identity is not sent for a profile row');
  assert.equal(payload.url, 'http://127.0.0.1:8790/mcp');
});

test('a profile row whose whole field is an expression is locked and omitted', () => {
  const { internals } = load();
  const row = { rowId: 'x', serverName: 'x', transport: 'streamable-http', expressionFields: ['url', 'headers'], config: { serverName: 'x', url: { __jsExpr: 'u' }, headers: { __jsExpr: 'h' } } };
  const form = internals.formFromRow(row);
  assert.equal(form.url, '');
  assert.equal(form.locked.url, 'u');
  assert.equal(form.locked.headers, 'h');
  const { payload } = internals.payloadFromForm(form, t, { includeIdentity: false });
  assert.equal(payload.url, undefined);
  assert.equal(payload.headers, undefined);
});

test('secretFields flags literal secrets in env and headers but not references', () => {
  const { internals } = load();
  const form = { ...internals.emptyForm(), envText: 'API_KEY=abc\nTOKEN=${T}\nMODE=dev', headersText: 'Authorization: Bearer abc\nX-Api-Key: ${K}' };
  assert.deepEqual(plain(internals.secretFields(form)), ['env.API_KEY', 'headers.Authorization']);
});

test('every message key the page uses exists in both languages, including the dynamic families', () => {
  const { internals } = load();
  const { zh, en } = internals.dictionaries;
  assert.deepEqual(plain(Object.keys(zh).sort()), plain(Object.keys(en).sort()), 'zh and en define the same keys');

  const used = new Set();
  for (const match of source.matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) used.add(match[1]);
  for (const key of used) assert.ok(key in zh, `missing key: ${key}`);

  const statuses = ['active', 'no-tools', 'connecting', 'error', 'disabled', 'unmounted', 'idle', 'pending-trust', 'trust-changed', 'conflict', 'shadowed'];
  for (const status of statuses) assert.ok(`status.${status}` in zh, `status.${status}`);
  for (const key of ['transport.stdio', 'transport.streamable-http', 'tab.global', 'tab.project', 'origin.store', 'origin.file']) assert.ok(key in zh, key);
});

test('the duplicate tag, its detail title and the in-use suffix exist in both languages', () => {
  // These keys are used by the compact row tags. The risk/secret tag wording is
  // still kept in the dictionaries but is intentionally not rendered (§7.5).
  const { internals } = load();
  const { zh, en } = internals.dictionaries;
  for (const key of ['duplicate.tag', 'duplicate.detailTitle', 'duplicate.inUse', 'duplicate.same', 'duplicate.differs']) {
    assert.ok(key in zh, key);
    assert.ok(key in en, `${key} (en)`);
  }
  assert.ok(!('duplicate.winner' in zh), 'the old (adopted) label is gone');
  assert.ok(!('duplicate.winner' in en), 'the old (adopted) label is gone (en)');
  for (const code of ['downloads', 'shell', 'pipe-shell', 'download-command', 'absolute']) {
    assert.ok(`risk.${code}` in zh, `risk.${code}`);
    assert.ok(`risk.tag.${code}` in en, `risk.tag.${code} (en)`);
  }
});

test('placeholders in messages are the same in both languages', () => {
  const { internals } = load();
  const { zh, en } = internals.dictionaries;
  const names = (text) => [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(zh)) assert.deepEqual(plain(names(zh[key])), plain(names(en[key])), key);
});

test('no message text contains a dollar-brace sequence that a translator could treat as a placeholder', () => {
  const { internals } = load();
  for (const [language, dictionary] of Object.entries(internals.dictionaries)) {
    for (const [key, text] of Object.entries(dictionary)) assert.ok(!text.includes('${'), language + ':' + key);
  }
});

test('the stylesheet takes every colour from theme tokens, so text on the brand colour stays readable', () => {
  // The dark theme's brand colour is nearly white; a literal white label or knob on it is invisible.
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`;', source.indexOf('const CSS = `')));
  assert.ok(css.length > 500, 'the stylesheet was found');
  assert.ok(!/#fff(fff)?\b/i.test(css), 'no literal white anywhere in the stylesheet');
  assert.ok(!/:\s*white\b(?!-)/i.test(css), 'no named white (white-space is a different property)');
  for (const [selector, rule] of css.matchAll(/([^{}]+)\{([^{}]*brand-primary[^{}]*)\}/g).map((m) => [m[1].trim(), m[2]])) {
    // A hover rule inherits its text colour from the base rule, and a switch track carries no text.
    if (/:hover/.test(selector) || /^\.mcp-switch\[/.test(selector)) continue;
    if (/background:\s*var\(--dsw-alias-brand-primary\)/.test(rule)) {
      assert.match(rule, /color:\s*var\(--dsw-alias-bg-base\)/, `${selector} sets a brand background and must set a contrasting text colour`);
    }
  }
  // The rule may also carry the slide animation; what matters is that the knob is painted with the contrasting token.
  assert.match(css, /\.mcp-switch\[aria-checked=true\]::after\{[^}]*background:var\(--dsw-alias-bg-base\)/, 'the checked knob contrasts with the brand track');
});

test('an active row without tools is not described as connected', () => {
  const { internals } = load();
  for (const [language, dictionary] of Object.entries(internals.dictionaries)) {
    assert.ok(!/已连接|Connected/.test(dictionary['status.no-tools']), `${language}: no-tools must not claim a connection`);
  }
});
