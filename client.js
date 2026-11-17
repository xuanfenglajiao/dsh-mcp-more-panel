/**
 * Client half: the "MCP servers" sidebar entry and its page.
 *
 * Mounting model (as in `dshmarket` and `dsh-effort-menu`): the module exports
 * `{ inject, apply }`; the entry is a `sidebar.panellist` row at order 20, which
 * puts it directly below "Schedules", and its id addresses the `main` panel
 * registered under the same key. The page talks to the Host through one JSON
 * route, resolved against the page's own base so it works under the desktop
 * shell (`dsh-app://`) and behind a reverse proxy alike.
 *
 * The page never decides trust on its own: approving a project server sends the
 * fingerprint it displayed, and the Host refuses when the definition has since
 * changed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-more-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;

    const NS = 'dsh-mcp-more-panel';
    const PANEL_ID = 'dsh-mcp-more-panel';
    const POLL_MS = 4000;
    const SECRET_KEY_RE = /KEY|PASSWORD|PASSWD|SECRET|TOKEN|AUTH|CREDENTIAL|(^|_)PAT($|_)/i;
    /** A value made of references or the Host's placeholder is not a literal secret. */
    const isLiteralSecret = (key, value) => SECRET_KEY_RE.test(key) && value !== '' && !/\$\{[^}]*\}/.test(value) && !/^•+$/.test(value);
    /** Show where one argument starts and ends: quote anything with blanks, quotes or control characters. */
    const quoteArg = (arg) => (/^[A-Za-z0-9_@%+=:,./\\${}~-]+$/.test(arg) ? arg : JSON.stringify(arg));
    /** Passed as a parameter so no message text contains a brace sequence of its own. */
    const REF_EXAMPLE = { example: '${VARIABLE}' };

    // ------------------------------------------------------------------ text

    const zh = {
      'nav.back': '返回会话',
      'nav.label': 'MCP 服务器',
      'page.title': 'MCP 服务器',
      'page.subtitle': '管理全局与项目专属的 MCP 服务器。全局服务器对所有会话可用；项目服务器只在该项目的会话中可用。',
      'tab.global': '全局',
      'tab.project': '项目',
      'banner.clientMissing': '官方 MCP 客户端不可用，服务器无法连接：{error}',
      'banner.storeError': '配置存储读取失败，已使用空配置：{error}',
      'common.loading': '正在加载…',
      'common.cancel': '取消',
      'common.save': '保存',
      'common.close': '关闭',
      'common.edit': '编辑',
      'common.delete': '删除',
      'common.confirmDelete': '确认删除？',
      'common.reconnect': '重新连接',
      'common.enabled': '启用',
      'common.retry': '重试',
      'common.none': '无',
      'common.tools': '{count} 个工具',
      'common.readOnly': '只读',
      'status.active': '已连接',
      'status.no-tools': '已启动，尚未发现工具（服务器可能没在运行）',
      'status.connecting': '连接中',
      'status.error': '连接失败',
      'status.disabled': '已停用',
      'status.unmounted': '未挂载',
      'status.idle': '无活动会话，未挂载',
      'status.pending-trust': '待批准',
      'status.trust-changed': '内容已变更，需重新批准',
      'status.conflict': '名称冲突，未挂载',
      'status.shadowed': '已被同名的本地配置覆盖',
      'status.disabled-in-file': '文件里已停用',
      'override.tag': '覆盖同名',
      'override.global': '这个项目的会话里，它代替同名的全局服务器',
      'override.profile': '这个项目的会话里，它代替配置文件中的同名服务器',
      'banner.storeReadOnly': '配置存储是只读的，改动不会保存：{error}',
      'origin.store': '本地配置',
      'origin.file': '项目文件',
      'transport.stdio': '本地进程',
      'transport.streamable-http': 'HTTP',
      'global.add': '添加服务器',
      'global.import': '从 JSON 导入',
      'global.empty': '还没有全局服务器。点击“添加服务器”开始。',
      'global.hint': '这里添加的服务器保存在插件自己的存储中，对所有会话生效。',
      'legacy.title': '配置文件中的服务器',
      'legacy.hint': '这些行写在 profile 的 cordis.patch.yml 中。这里可以启停并修改字面量字段，不会删除，也不会改动表达式。',
      'legacy.unavailable': '当前环境无法读取配置文件中的服务器。',
      'legacy.expression': '由表达式控制：{fields}',
      'legacy.empty': '没有配置文件中的 MCP 服务器。',
      'legacy.editNote': '标有“表达式”的字段由配置文件中的 !!js 表达式控制，这里不会修改它们。',
      'legacy.skipped': '以下字段由表达式控制，未被修改：{fields}',
      'legacy.exprEntries': '由表达式控制的条目会原样保留：{fields}',
      'duplicate.same': '同一名称在 {files} 中都有定义，内容相同；采用 {winner} 的版本。',
      'duplicate.differs': '同一名称在 {files} 中定义了不同内容；采用 {winner} 的版本，其余被忽略。',
      'duplicate.inUse': '（当前使用）',
      'risk.downloads': '启动时从包仓库下载并执行',
      'risk.shell': '通过 shell 执行',
      'risk.pipe-shell': '把下载内容直接交给 shell',
      'risk.download-command': '会从网络下载内容',
      'risk.absolute': '运行本机的绝对路径程序',
      'risk.repo-file': '运行仓库里的文件；这个文件以后改了，批准不会失效',
      'risk.env-inject': '设置了会让程序加载额外代码的环境变量',
      'risk.tag.repo-file': '仓库文件',
      'risk.tag.env-inject': '注入变量',
      'risk.tag.downloads': '下载执行',
      'risk.tag.shell': 'shell 执行',
      'risk.tag.pipe-shell': '管道到 shell',
      'risk.tag.download-command': '网络下载',
      'risk.tag.absolute': '绝对路径',
      'secret.tag': '明文密钥',
      'duplicate.tag': '同名 {count} 处',
      'duplicate.detailTitle': '各文件中的定义',
      'search.placeholder': '搜索服务器名称或命令',
      'search.none': '没有匹配的服务器',
      'group.store': '页面添加',
      'group.file': '来自配置文件',
      'test.run': '测试连接',
      'test.running': '正在连接…',
      'test.ok': '连接成功，{count} 个工具',
      'test.fail': '连接失败：{error}',
      'project.pick': '项目目录',
      'project.source': '配置来源',
      'project.sourceAll': '全部来源',
      'project.sourceHint': '决定 DSH 从这个项目的哪些文件读取 MCP 服务器。「全部来源」按优先级聚合项目内的配置；选单个只读那一份。切换来源不会删除已批准记录，切回来即恢复。',
      'project.sourceFiles': '来源文件',
      'source.readOnly': '只读',
      'file.import': '导入到 DSH',
      'project.other': '其他目录…',
      'project.otherPlaceholder': '输入项目目录的绝对路径',
      'project.use': '使用',
      'project.none': '请先选择一个项目目录。',
      'project.add': '添加项目服务器',
      'project.sessions': '{count} 个活动会话',
      'project.remount': '重新挂载',
      'project.empty': '这个项目还没有服务器。',
      'project.files': '项目文件',
      'project.fileMissing': '不存在',
      'project.fileCount': '{count} 个服务器',
      'project.invalid': '无法使用的条目',
      'project.hint': '你在这里添加的服务器保存在插件自己的存储中。来自仓库文件的服务器默认不会运行，必须由你批准。',
      'trust.approve': '审阅并批准',
      'trust.revoke': '撤销批准',
      'trust.approved': '已批准',
      'trust.title': '批准运行“{name}”？',
      'trust.warn': '批准后，这个项目的会话启动时会运行下面的内容。它来自项目文件，请确认你信任这个仓库。',
      'trust.stdioHeader': '将在本机执行',
      'trust.httpHeader': '将连接到',
      'trust.command': '命令',
      'trust.args': '参数',
      'trust.cwd': '工作目录',
      'trust.envKeys': '环境变量',
      'trust.headerKeys': '请求头',
      'trust.variables': '会读取 DSH 进程里的这些环境变量，并按定义里的写法交给服务器：{names}',
      'trust.risks': '需要留意',
      'trust.notes': '读取文件时的提示',
      'trust.duplicate': '其他文件里也有这个名字，但内容不同：{files}',
      'trust.fingerprint': '指纹',
      'trust.changed': '这个定义与你上次批准的不同。',
      'trust.confirm': '批准并启用',
      'trust.confirmKeepOff': '批准（保持停用）',
      'trust.mismatch': '定义在你查看之后发生了变化，请重新审阅。',
      'form.titleNew': '添加服务器',
      'form.titleEdit': '编辑服务器',
      'form.titleLegacy': '编辑配置文件中的服务器',
      'form.serverName': '名称',
      'form.serverNameHint': '1–32 位字母、数字、下划线或连字符。工具名为 mcp__名称__工具。',
      'form.transport': '连接方式',
      'form.command': '命令',
      'form.args': '参数',
      'form.env': '环境变量',
      'form.cwd': '工作目录（可选）',
      'form.url': '地址',
      'form.headers': '请求头',
      'form.refHint': '密钥请写成 {example}，值取自 DSH 进程的环境变量，不会以明文保存。显示为圆点的值表示已保存，保持不动即可沿用。',
      'form.secretWarn': '{fields} 看起来是明文密钥，建议改成 {example} 引用。',
      'form.advanced': '高级选项',
      'form.timeout': '工具调用超时（毫秒）',
      'form.failOnStartup': '启动连接失败时视为失败',
      'form.reconnect': '断线自动重连',
      'form.initialDelay': '首次重连延迟（毫秒）',
      'form.maxDelay': '最大重连延迟（毫秒）',
      'form.maxAttempts': '最多连续重试次数',
      'form.maxInstructionBytes': '服务器说明上限（字节）',
      'form.notes': '备注',
      'form.target': '保存到',
      'form.targetStore': '插件存储（不写项目文件）',
      'form.targetHint': '写入项目文件会修改仓库里的配置，同时影响读取这份文件的其他工具。',
      'form.targetNew': '{label}（新建 {path}）',
      'source.comments': '含注释，只读',
      'form.addArg': '添加参数',
      'form.addRow': '添加一行',
      'form.argPlaceholder': '参数',
      'form.keyPlaceholder': '名称',
      'form.valuePlaceholder': '值',
      'form.remove': '移除',
      'form.literalSecret': '看起来是明文密钥',
      'project.choose': '选择项目目录',
      'trust.source': '来源',
      'form.default': '默认',
      'form.yes': '是',
      'form.no': '否',
      'form.expression': '表达式',
      'form.lineError': '第 {line} 行格式不对：{text}',
      'form.saving': '正在保存…',
      'import.title': '从 JSON 导入',
      'import.hint': '粘贴包含 mcpServers 的 JSON（Claude Desktop、Cursor、VS Code 的格式均可，允许注释）。每个服务器会作为全局服务器添加。',
      'import.run': '导入',
      'import.done': '已导入 {ok} 个，失败 {failed} 个。',
      'import.failedItem': '{key}：{error}',
      'import.bad': '无法解析：{error}',
      'err.invalid': '填写的内容有问题',
      'err.generic': '操作失败：{message}',
    };

    const en = {
      'nav.back': 'Back to conversation',
      'nav.label': 'MCP servers',
      'page.title': 'MCP servers',
      'page.subtitle': 'Manage global and project-specific MCP servers. Global servers are available to every session; project servers only to sessions in that project.',
      'tab.global': 'Global',
      'tab.project': 'Project',
      'banner.clientMissing': 'The official MCP client is unavailable, so servers cannot connect: {error}',
      'banner.storeError': 'The configuration store could not be read; an empty one is in use: {error}',
      'common.loading': 'Loading…',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.close': 'Close',
      'common.edit': 'Edit',
      'common.delete': 'Delete',
      'common.confirmDelete': 'Confirm delete?',
      'common.reconnect': 'Reconnect',
      'common.enabled': 'Enabled',
      'common.retry': 'Retry',
      'common.none': 'None',
      'common.tools': '{count} tools',
      'common.readOnly': 'read-only',
      'status.active': 'Connected',
      'status.no-tools': 'Started, no tools found (the server may not be running)',
      'status.connecting': 'Connecting',
      'status.error': 'Connection failed',
      'status.disabled': 'Disabled',
      'status.unmounted': 'Not mounted',
      'status.idle': 'No active session, not mounted',
      'status.pending-trust': 'Awaiting approval',
      'status.trust-changed': 'Changed, needs approval again',
      'status.conflict': 'Name conflict, not mounted',
      'status.shadowed': 'Overridden by a local entry of the same name',
      'status.disabled-in-file': 'Disabled in the file',
      'override.tag': 'Overrides',
      'override.global': 'In this project’s sessions it takes the place of the global server with the same name',
      'override.profile': 'In this project’s sessions it takes the place of the profile row with the same name',
      'banner.storeReadOnly': 'The configuration store is read-only; changes are not saved: {error}',
      'origin.store': 'Local',
      'origin.file': 'Project file',
      'transport.stdio': 'Local process',
      'transport.streamable-http': 'HTTP',
      'global.add': 'Add server',
      'global.import': 'Import JSON',
      'global.empty': 'No global servers yet. Choose “Add server” to start.',
      'global.hint': 'Servers added here are stored by this plugin and apply to every session.',
      'legacy.title': 'Servers in configuration files',
      'legacy.hint': 'These rows live in the profile’s cordis.patch.yml. You can switch them on and off and edit literal fields here; nothing is deleted and expressions are left alone.',
      'legacy.unavailable': 'Servers in configuration files cannot be read in this environment.',
      'legacy.expression': 'Controlled by an expression: {fields}',
      'legacy.empty': 'No MCP servers in configuration files.',
      'legacy.editNote': 'Fields marked “expression” are controlled by a !!js expression in the configuration file and are not changed here.',
      'legacy.skipped': 'These fields are controlled by an expression and were not changed: {fields}',
      'legacy.exprEntries': 'Entries controlled by an expression are kept as they are: {fields}',
      'duplicate.same': 'The same name is declared in {files} with identical content; the version from {winner} is used.',
      'duplicate.differs': 'The same name is declared with different content in {files}; the version from {winner} is used and the others are ignored.',
      'duplicate.inUse': ' (in use)',
      'risk.downloads': 'downloads and runs code from a package registry at start-up',
      'risk.shell': 'runs through a shell',
      'risk.pipe-shell': 'pipes a download straight into a shell',
      'risk.download-command': 'fetches content from the network',
      'risk.absolute': 'runs an absolute path on this machine',
      'risk.repo-file': 'runs a file from the repository; a later change to that file does not invalidate the approval',
      'risk.env-inject': 'sets a variable that makes the program load extra code',
      'risk.tag.repo-file': 'Repository file',
      'risk.tag.env-inject': 'Injects code',
      'risk.tag.downloads': 'Downloads code',
      'risk.tag.shell': 'Runs a shell',
      'risk.tag.pipe-shell': 'Pipes to shell',
      'risk.tag.download-command': 'Fetches content',
      'risk.tag.absolute': 'Absolute path',
      'secret.tag': 'Plain-text secret',
      'duplicate.tag': '{count} sources',
      'duplicate.detailTitle': 'Definition in each file',
      'search.placeholder': 'Search by name or command',
      'search.none': 'No server matches',
      'group.store': 'Added here',
      'group.file': 'From configuration files',
      'test.run': 'Test connection',
      'test.running': 'Connecting…',
      'test.ok': 'Connected, {count} tools',
      'test.fail': 'Connection failed: {error}',
      'project.pick': 'Project folder',
      'project.source': 'Configuration source',
      'project.sourceAll': 'All sources',
      'project.sourceHint': 'Which files DSH reads MCP servers from for this project. “All sources” merges the project’s files by priority; a single source reads only that file. Switching never deletes approvals — switching back restores them.',
      'project.sourceFiles': 'Source files',
      'source.readOnly': 'read-only',
      'file.import': 'Import to DSH',
      'project.other': 'Other folder…',
      'project.otherPlaceholder': 'Absolute path of a project folder',
      'project.use': 'Use',
      'project.none': 'Choose a project folder first.',
      'project.add': 'Add project server',
      'project.sessions': '{count} active sessions',
      'project.remount': 'Remount',
      'project.empty': 'This project has no servers yet.',
      'project.files': 'Project files',
      'project.fileMissing': 'not found',
      'project.fileCount': '{count} servers',
      'project.invalid': 'Entries that cannot be used',
      'project.hint': 'Servers you add here are stored by this plugin. Servers from repository files do not run until you approve them.',
      'trust.approve': 'Review and approve',
      'trust.revoke': 'Revoke approval',
      'trust.approved': 'Approved',
      'trust.title': 'Approve running “{name}”?',
      'trust.warn': 'Once approved, sessions in this project will run what is shown below. It comes from a project file; make sure you trust this repository.',
      'trust.stdioHeader': 'Will run on this machine',
      'trust.httpHeader': 'Will connect to',
      'trust.command': 'Command',
      'trust.args': 'Arguments',
      'trust.cwd': 'Working directory',
      'trust.envKeys': 'Environment variables',
      'trust.headerKeys': 'Request headers',
      'trust.variables': 'Reads these environment variables from the DSH process and hands them to the server as the definition says: {names}',
      'trust.risks': 'Worth knowing',
      'trust.notes': 'Notes from reading the file',
      'trust.duplicate': 'Other files declare this name with different content: {files}',
      'trust.fingerprint': 'Fingerprint',
      'trust.changed': 'This definition differs from the one you approved before.',
      'trust.confirm': 'Approve and enable',
      'trust.confirmKeepOff': 'Approve (stay off)',
      'trust.mismatch': 'The definition changed after you opened it. Please review it again.',
      'form.titleNew': 'Add server',
      'form.titleEdit': 'Edit server',
      'form.titleLegacy': 'Edit server in a configuration file',
      'form.serverName': 'Name',
      'form.serverNameHint': '1–32 letters, digits, underscores or hyphens. Tools are named mcp__name__tool.',
      'form.transport': 'Connection',
      'form.command': 'Command',
      'form.args': 'Arguments',
      'form.env': 'Environment variables',
      'form.cwd': 'Working directory (optional)',
      'form.url': 'URL',
      'form.headers': 'Headers',
      'form.refHint': 'Write secrets as {example}; the value comes from the DSH process environment and is not stored in plain text. A value shown as dots is already saved — leave it untouched to keep it.',
      'form.secretWarn': '{fields} look like plain-text secrets; consider a {example} reference.',
      'form.advanced': 'Advanced',
      'form.timeout': 'Tool call timeout (ms)',
      'form.failOnStartup': 'Treat a failed first connection as failure',
      'form.reconnect': 'Reconnect automatically',
      'form.initialDelay': 'First reconnect delay (ms)',
      'form.maxDelay': 'Longest reconnect delay (ms)',
      'form.maxAttempts': 'Consecutive attempts',
      'form.maxInstructionBytes': 'Server instruction limit (bytes)',
      'form.notes': 'Notes',
      'form.target': 'Save to',
      'form.targetStore': 'Plugin store (no project file)',
      'form.targetHint': 'Writing into a project file modifies a file in the repository and also affects other tools that read it.',
      'form.targetNew': '{label} (creates {path})',
      'source.comments': 'has comments, read-only',
      'form.addArg': 'Add argument',
      'form.addRow': 'Add row',
      'form.argPlaceholder': 'Argument',
      'form.keyPlaceholder': 'Name',
      'form.valuePlaceholder': 'Value',
      'form.remove': 'Remove',
      'form.literalSecret': 'Looks like a plain-text secret',
      'project.choose': 'Choose a project folder',
      'trust.source': 'Source',
      'form.default': 'Default',
      'form.yes': 'Yes',
      'form.no': 'No',
      'form.expression': 'expression',
      'form.lineError': 'Line {line} is malformed: {text}',
      'form.saving': 'Saving…',
      'import.title': 'Import JSON',
      'import.hint': 'Paste JSON containing mcpServers (Claude Desktop, Cursor and VS Code formats work; comments are fine). Each server is added as a global server.',
      'import.run': 'Import',
      'import.done': 'Imported {ok}, failed {failed}.',
      'import.failedItem': '{key}: {error}',
      'import.bad': 'Could not parse: {error}',
      'err.invalid': 'Some fields need attention',
      'err.generic': 'The operation failed: {message}',
    };

    // ------------------------------------------------------------------- api

    /** Resolve against the page base: a leading slash would escape the desktop shell's origin. */
    function endpoint() {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : 'http://dsh.internal/';
      return new URL('mcp-panel/api', base).toString();
    }

    class ApiError extends Error {
      constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
      }
    }

    async function api(op, args) {
      let response;
      try {
        response = await fetch(endpoint(), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op, ...(args ?? {}) }),
        });
      } catch (error) {
        throw new ApiError('network', String(error && error.message ? error.message : error));
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new ApiError('bad-response', `HTTP ${response.status}`);
      }
      if (!body || body.ok !== true) {
        const failure = body && body.error ? body.error : { code: 'http', message: `HTTP ${response.status}` };
        throw new ApiError(failure.code, failure.message, failure.details);
      }
      return body.value;
    }

    // ----------------------------------------------------------------- forms

    const emptyForm = () => ({
      id: undefined,
      serverName: '',
      transport: 'stdio',
      command: '',
      argsText: '',
      envText: '',
      cwd: '',
      url: '',
      headersText: '',
      toolCallTimeoutMs: '',
      failOnStartupError: '',
      reconnectEnabled: '',
      initialDelayMs: '',
      maxDelayMs: '',
      maxAttempts: '',
      maxInstructionBytes: '',
      notes: '',
      enabled: true,
      target: 'store',
    });

    const mapToLines = (map, sep) => Object.entries(map || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
    const triState = (value) => (value === true ? 'true' : value === false ? 'false' : '');

    function formFromServer(server) {
      const reconnect = server.reconnect || {};
      return {
        ...emptyForm(),
        id: server.id,
        serverName: server.serverName,
        transport: server.transport,
        command: server.command || '',
        argsText: (server.args || []).join('\n'),
        envText: mapToLines(server.env, '='),
        cwd: server.cwd || '',
        url: server.url || '',
        headersText: mapToLines(server.headers, ': '),
        toolCallTimeoutMs: server.toolCallTimeoutMs === undefined ? '' : String(server.toolCallTimeoutMs),
        failOnStartupError: triState(server.failOnStartupError),
        reconnectEnabled: triState(reconnect.enabled),
        initialDelayMs: reconnect.initialDelayMs === undefined ? '' : String(reconnect.initialDelayMs),
        maxDelayMs: reconnect.maxDelayMs === undefined ? '' : String(reconnect.maxDelayMs),
        maxAttempts: reconnect.maxAttempts === undefined ? '' : String(reconnect.maxAttempts),
        maxInstructionBytes: server.maxInstructionBytes === undefined ? '' : String(server.maxInstructionBytes),
        notes: server.notes || '',
        enabled: server.enabled !== false,
        target: 'store',
      };
    }

    /** A raw profile row: literal fields editable, expressions locked and shown as text. */
    function formFromRow(row) {
      const cfg = row.config || {};
      const locked = {};
      const isExpr = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.__jsExpr === 'string';
      const plain = (v) => (typeof v === 'string' ? v : '');
      const literalMap = (map) => {
        const out = {};
        if (map && typeof map === 'object' && !isExpr(map)) {
          for (const [k, v] of Object.entries(map)) if (typeof v === 'string') out[k] = v;
        }
        return out;
      };
      for (const field of ['command', 'url', 'cwd', 'args', 'env', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']) {
        if (isExpr(cfg[field])) locked[field] = cfg[field].__jsExpr;
      }
      const reconnect = cfg.reconnect && !isExpr(cfg.reconnect) ? cfg.reconnect : {};
      const number = (v) => (typeof v === 'number' ? String(v) : '');
      return {
        ...emptyForm(),
        id: row.rowId,
        serverName: plain(cfg.serverName) || row.serverName,
        transport: row.transport,
        command: plain(cfg.command),
        argsText: Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string').join('\n') : '',
        envText: mapToLines(literalMap(cfg.env), '='),
        cwd: plain(cfg.cwd),
        url: plain(cfg.url),
        headersText: mapToLines(literalMap(cfg.headers), ': '),
        toolCallTimeoutMs: number(cfg.toolCallTimeoutMs),
        failOnStartupError: triState(cfg.failOnStartupError),
        reconnectEnabled: triState(reconnect.enabled),
        initialDelayMs: number(reconnect.initialDelayMs),
        maxDelayMs: number(reconnect.maxDelayMs),
        maxAttempts: number(reconnect.maxAttempts),
        maxInstructionBytes: number(cfg.maxInstructionBytes),
        locked,
        exprEntries: (row.expressionFields || []).filter((name) => name.startsWith('env.') || name.startsWith('headers.')),
      };
    }

    /** `KEY=VALUE` or `Name: value` lines; returns the map or the first bad line. */
    function parseLines(text, separator) {
      const out = {};
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
        const at = raw.indexOf(separator);
        if (at <= 0) return { error: { line: index + 1, text: raw.trim() } };
        const key = raw.slice(0, at).trim();
        if (key === '') return { error: { line: index + 1, text: raw.trim() } };
        out[key] = raw.slice(at + 1).trim();
      }
      return { value: out };
    }

    const num = (text) => (text.trim() === '' ? undefined : Number(text));
    const bool = (text) => (text === 'true' ? true : text === 'false' ? false : undefined);

    /** Form -> API payload. Returns `{ error }` when a textarea cannot be parsed. */
    function payloadFromForm(form, t, { includeIdentity = true } = {}) {
      const payload = {};
      const locked = form.locked || {};
      if (includeIdentity) {
        payload.id = form.id;
        payload.serverName = form.serverName.trim();
        payload.transport = form.transport;
        payload.enabled = form.enabled;
        payload.notes = form.notes;
      }
      if (form.transport === 'stdio') {
        if (!locked.command) payload.command = form.command;
        if (!locked.args) payload.args = form.argsText.split(/\r?\n/).filter((line) => line !== '');
        if (!locked.env) {
          const env = parseLines(form.envText, '=');
          if (env.error) return { error: t('form.lineError', env.error), field: 'env' };
          payload.env = env.value;
        }
        if (!locked.cwd) payload.cwd = form.cwd;
      } else {
        if (!locked.url) payload.url = form.url;
        if (!locked.headers) {
          const headers = parseLines(form.headersText, ':');
          if (headers.error) return { error: t('form.lineError', headers.error), field: 'headers' };
          payload.headers = headers.value;
        }
      }
      if (!locked.toolCallTimeoutMs) payload.toolCallTimeoutMs = num(form.toolCallTimeoutMs);
      if (!locked.failOnStartupError) payload.failOnStartupError = bool(form.failOnStartupError);
      if (!locked.maxInstructionBytes) payload.maxInstructionBytes = num(form.maxInstructionBytes);
      if (!locked.reconnect) {
        const reconnect = {
          enabled: bool(form.reconnectEnabled),
          initialDelayMs: num(form.initialDelayMs),
          maxDelayMs: num(form.maxDelayMs),
          maxAttempts: num(form.maxAttempts),
        };
        if (Object.values(reconnect).some((v) => v !== undefined)) payload.reconnect = reconnect;
      }
      return { payload };
    }

    /** Literal-looking secrets in the text boxes, for a gentle warning. */
    function secretFields(form) {
      const hits = [];
      const scan = (text, separator, label) => {
        for (const line of text.split(/\r?\n/)) {
          const at = line.indexOf(separator);
          if (at <= 0) continue;
          const key = line.slice(0, at).trim();
          const value = line.slice(at + 1).trim();
          if (isLiteralSecret(key, value)) hits.push(`${label}.${key}`);
        }
      };
      scan(form.envText, '=', 'env');
      scan(form.headersText, ':', 'headers');
      return hits;
    }

    // ---------------------------------------------------------------- styles

    // Every colour comes from a host theme token, so the page follows the light and dark themes
    // and any appearance plugin. Never write a literal colour for text or a knob: the dark theme's
    // brand colour is nearly white, and text that is written as white vanishes on it.
    const CSS = `
.mcp-root{--mcp-r:var(--dsw-radius-sm,8px);--mcp-r-lg:var(--dsw-radius-md,12px);--mcp-ring:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);--mcp-muted:var(--dsw-alias-label-secondary);--mcp-faint:var(--dsw-alias-label-secondary);--mcp-line:var(--dsw-alias-border-l2);--mcp-line-strong:var(--dsw-alias-border-l3);--mcp-mono:var(--dsh-code-font-family,monospace);display:flex;flex-direction:column;flex:1 1 auto;min-height:0;max-height:100%;width:100%;max-width:1000px;margin:0 auto;padding:24px 0 0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,13px);line-height:1.55}
.mcp-head{flex:none;padding:0 28px}
/* The host's main panel has a fixed height; the list scrolls inside it so the title and tools stay put. */
.mcp-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 28px 40px;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l4) transparent}
.mcp-scroll::-webkit-scrollbar{width:10px}
.mcp-scroll::-webkit-scrollbar-track{background:transparent}
.mcp-scroll::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:6px;background-clip:padding-box;background-color:var(--dsw-alias-border-l4)}
.mcp-scroll:hover::-webkit-scrollbar-thumb{background-color:var(--dsw-alias-label-dimmed)}
.mcp-root,.mcp-root *{box-sizing:border-box}
.mcp-ico{flex:none;display:block}
.mcp-h1{margin:0 0 6px;font-size:21px;font-weight:600}
.mcp-headline{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:6px}
.mcp-headline .mcp-h1{margin:0}
.mcp-sub{margin:0 0 20px;max-width:72ch;color:var(--mcp-muted)}
.mcp-tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--mcp-line)}
.mcp-tab{margin-bottom:-1px;padding:9px 16px;border:0;border-radius:var(--mcp-r) var(--mcp-r) 0 0;background:none;color:var(--mcp-muted);font:inherit;font-weight:500;cursor:pointer;transition:color .12s,background-color .12s}
.mcp-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mcp-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}
.mcp-tab:focus-visible,.mcp-switch:focus-visible,.mcp-btn:focus-visible,.mcp-disc:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mcp-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
.mcp-grow{flex:1 1 200px;min-width:0}
.mcp-muted{color:var(--mcp-muted)}
.mcp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s,transform .06s}
.mcp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}
.mcp-btn:active:not(:disabled){transform:translateY(1px);background:var(--dsw-alias-interactive-bg-active)}
.mcp-btn:disabled{opacity:.5;cursor:default}
.mcp-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.mcp-btn.primary:hover:not(:disabled),.mcp-btn.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.mcp-btn.ghost{background:transparent;border-color:transparent;color:var(--mcp-muted)}
.mcp-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:transparent;color:var(--dsw-alias-label-primary)}
.mcp-btn.ghost.danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.mcp-btn.danger.armed,.mcp-btn.danger.armed:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary);font-weight:600}
.mcp-btn.sm{height:28px;padding:0 10px}
.mcp-btn.icon-only{width:32px;padding:0}
.mcp-btn.icon-only.sm{width:28px}
.mcp-input{display:block;width:100%;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;transition:border-color .12s,box-shadow .12s}
.mcp-input::placeholder{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 85%,transparent)}
.mcp-input:hover:not(:disabled):not(:focus){border-color:var(--dsw-alias-border-l4)}
.mcp-input:focus{outline:none;border-color:var(--mcp-muted);box-shadow:0 0 0 3px var(--mcp-ring)}
.mcp-input:disabled{opacity:.55;cursor:not-allowed}
.mcp-input.mono{font-family:var(--mcp-mono);font-size:12px}
.mcp-input.err,.mcp-input.err:focus{border-color:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent)}
.mcp-input.warn{border-color:var(--dsw-alias-state-warn-primary)}
textarea.mcp-input{height:auto;min-height:200px;padding:9px 10px;resize:vertical;line-height:1.55}
.mcp-field{margin-bottom:16px}
.mcp-label{display:block;margin-bottom:6px;color:var(--mcp-muted);font-size:12px;font-weight:600}
.mcp-fieldhint{margin-top:6px;color:var(--mcp-faint);font-size:12px}
.mcp-fielderr{display:flex;gap:6px;align-items:flex-start;margin-top:6px;color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-label-primary));font-size:12px}
.mcp-fielderr .mcp-ico{margin-top:2px;color:var(--dsw-alias-state-error-primary)}
.mcp-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r);background:var(--dsw-alias-interactive-bg-hover)}
.mcp-seg button{height:26px;padding:0 12px;border:0;border-radius:calc(var(--mcp-r) - 3px);background:transparent;color:var(--mcp-muted);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .12s,color .12s,box-shadow .12s}
.mcp-seg button:hover:not(:disabled):not([aria-pressed=true]){color:var(--dsw-alias-label-primary)}
.mcp-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1px var(--mcp-line-strong),0 1px 2px #0000002e}
.mcp-seg button:disabled{opacity:.55;cursor:default}
.mcp-seg button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mcp-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-interactive-bg-active);cursor:pointer;transition:background-color .15s,border-color .15s}
.mcp-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--mcp-muted);transition:transform .15s,background-color .15s}
.mcp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.mcp-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.mcp-switch:disabled{opacity:.5;cursor:default}
.mcp-card{margin-bottom:10px;padding:14px 16px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px #0000000a;transition:border-color .12s}
.mcp-card:hover{border-color:var(--mcp-line-strong)}
.mcp-row{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.mcp-main{flex:1 1 auto;min-width:0}
.mcp-titleline{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center}
.mcp-name{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.mcp-chip{display:inline-flex;gap:4px;align-items:center;height:20px;padding:0 7px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-muted);font-size:11px;line-height:1;white-space:nowrap}
.mcp-chip.mono{font-family:var(--mcp-mono)}
.mcp-chip.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.mcp-chip.ok .mcp-ico{color:var(--dsw-alias-state-success-primary)}
.mcp-sum{margin-top:6px;color:var(--mcp-muted);font-family:var(--mcp-mono);font-size:12px;overflow-wrap:anywhere}
.mcp-statusline{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:9px}
/* Compact tags replace long sentences; the full text stays in the title attribute. */
.mcp-tag{display:inline-flex;gap:4px;align-items:center;max-width:240px;height:20px;padding:0 7px;border:1px solid var(--mcp-line);border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-muted);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:default}
.mcp-tag .txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcp-tag .mcp-ico{opacity:.8}
.mcp-tag.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.mcp-tag.high{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.mcp-tag.click{cursor:pointer;transition:background-color .12s}
.mcp-tag.click:hover,.mcp-tag.active{background:var(--dsw-alias-interactive-bg-active)}
.mcp-tag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mcp-tagdetail{margin-top:8px;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-base)}
.mcp-tagdetail .mcp-label{margin-bottom:6px}
.mcp-taglist{margin:0;padding-left:16px;font-family:var(--mcp-mono);font-size:11px}
.mcp-taglist li{margin:3px 0;color:var(--mcp-muted);overflow-wrap:anywhere}
.mcp-taglist li.win{color:var(--dsw-alias-label-primary)}
.mcp-taglist .src{font-family:inherit;font-weight:600;color:var(--dsw-alias-label-primary)}
.mcp-taglist .cmd{color:var(--mcp-muted)}
.mcp-taglist .inuse{margin-left:6px;color:var(--dsw-alias-state-success-primary);font-weight:600;white-space:nowrap}
.mcp-note{color:var(--mcp-faint);font-size:12px}
.mcp-pill{--c:var(--dsw-alias-state-idle-primary);display:inline-flex;gap:7px;align-items:center;height:22px;padding:0 10px 0 9px;border-radius:999px;background:color-mix(in srgb,var(--c) 15%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;white-space:nowrap}
.mcp-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c)}
.mcp-pill.ok{--c:var(--dsw-alias-state-success-primary)}
.mcp-pill.warn{--c:var(--dsw-alias-state-warn-primary)}
.mcp-pill.err{--c:var(--dsw-alias-state-error-primary)}
.mcp-pill.busy::before{animation:mcp-pulse 1.1s ease-in-out infinite}
.mcp-detail{margin-top:9px;padding:7px 10px;border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:var(--mcp-r);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);color:var(--dsw-alias-label-primary);font-family:var(--mcp-mono);font-size:12px;overflow-wrap:anywhere}
.mcp-warnline{display:flex;gap:6px;align-items:flex-start;margin-top:8px;color:var(--dsw-alias-label-primary);font-size:12px}
.mcp-warnline .mcp-ico{margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.mcp-warnline.high .mcp-ico{color:var(--dsw-alias-state-error-primary)}
.mcp-warnline.high{color:var(--dsw-alias-label-primary)}
.mcp-actions{display:flex;flex:none;gap:2px;align-items:center}
.mcp-actions .mcp-switch{margin-right:8px}
.mcp-banner{--c:var(--dsw-alias-state-warn-primary);display:flex;gap:10px;align-items:flex-start;margin-bottom:14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--c) 38%,transparent);border-radius:var(--mcp-r);background:color-mix(in srgb,var(--c) 9%,transparent);overflow-wrap:anywhere}
.mcp-banner.error{--c:var(--dsw-alias-state-error-primary)}
.mcp-banner.info{--c:var(--dsw-alias-label-secondary)}
.mcp-banner .mcp-ico{margin-top:2px;color:var(--c)}
.mcp-banner-body{flex:1 1 auto;min-width:0}
.mcp-h2{margin:28px 0 4px;font-size:14px;font-weight:600}
.mcp-group{margin:16px 0 8px;font-size:12px;font-weight:600;color:var(--mcp-muted);letter-spacing:.02em}
.mcp-search{margin-bottom:10px}
.mcp-probe{margin-right:auto;font-size:12px;color:var(--mcp-muted);overflow-wrap:anywhere}
.mcp-probe.ok{color:var(--dsw-alias-state-success-primary)}
.mcp-probe.fail{color:var(--dsw-alias-state-error-primary)}
.mcp-hint{margin:0 0 12px;max-width:80ch;color:var(--mcp-faint);font-size:12px}
.mcp-empty{display:flex;flex-direction:column;gap:10px;align-items:center;padding:28px 18px;border:1px dashed var(--mcp-line-strong);border-radius:var(--mcp-r-lg);color:var(--mcp-muted);text-align:center}
.mcp-empty-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover)}
.mcp-select{position:relative;min-width:0}
.mcp-select-trigger{display:flex;gap:10px;align-items:center;justify-content:space-between;width:100%;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:border-color .12s,box-shadow .12s}
.mcp-select-trigger:hover:not(:disabled){border-color:var(--dsw-alias-border-l4)}
.mcp-select-trigger:focus-visible,.mcp-select-trigger[aria-expanded=true]{outline:none;border-color:var(--mcp-muted);box-shadow:0 0 0 3px var(--mcp-ring)}
.mcp-select-trigger:disabled{opacity:.55;cursor:not-allowed}
.mcp-select-trigger .mcp-ico{color:var(--mcp-muted);transition:transform .15s}
.mcp-select-trigger[aria-expanded=true] .mcp-ico{transform:rotate(180deg)}
.mcp-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcp-select-value .ph{color:color-mix(in srgb,var(--dsw-alias-label-secondary) 85%,transparent)}
.mcp-select-list{position:absolute;z-index:70;top:calc(100% + 6px);right:0;left:0;max-height:260px;margin:0;padding:4px;overflow:auto;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 30px #00000047;list-style:none;animation:mcp-pop .12s ease-out}
.mcp-select-list.up{top:auto;bottom:calc(100% + 6px)}
.mcp-select-opt{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px 9px;border-radius:calc(var(--mcp-r) - 3px);cursor:pointer}
.mcp-select-opt.active{background:var(--dsw-alias-interactive-bg-hover)}
.mcp-select-opt[aria-selected=true]{font-weight:600}
.mcp-opt-main{min-width:0}
.mcp-opt-label{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcp-opt-hint{display:block;overflow:hidden;color:var(--mcp-faint);font-family:var(--mcp-mono);font-size:11px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.mcp-picker{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px}
.mcp-picker .mcp-field{flex:1 1 320px;min-width:0;margin-bottom:0}
.mcp-rows{display:flex;flex-direction:column;gap:6px}
.mcp-rowedit{display:flex;gap:6px;align-items:center}
.mcp-rowedit .mcp-input{flex:1 1 0;min-width:0}
.mcp-rowedit .k{flex:0 1 36%}
.mcp-rows .mcp-btn.addrow{align-self:flex-start}
.mcp-disc{display:flex;gap:6px;align-items:center;margin:2px 0 12px;padding:4px 8px 4px 4px;border:0;border-radius:var(--mcp-r);background:transparent;color:var(--mcp-muted);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.mcp-disc:hover{color:var(--dsw-alias-label-primary)}
.mcp-disc .mcp-ico{transition:transform .15s}
.mcp-disc[aria-expanded=false] .mcp-ico{transform:rotate(-90deg)}
.mcp-disc-body{margin-bottom:16px;padding:14px 14px 0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg)}
.mcp-grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 14px}
.mcp-grid2.top{grid-template-columns:minmax(0,1fr) auto}
.mcp-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:4vh 16px;background:var(--dsw-alias-bg-mask-3);animation:mcp-fade .14s ease-out}
.mcp-dialog{display:flex;flex-direction:column;width:min(680px,100%);max-height:92vh;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--mcp-r-lg);background:var(--dsw-alias-bg-layer-2);box-shadow:0 24px 64px #00000066;outline:none;animation:mcp-pop .16s ease-out}
.mcp-dlg-head{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 14px 8px 20px}
.mcp-dlg-head h2{margin:0;font-size:16px;font-weight:600}
.mcp-dlg-body{min-height:0;padding:8px 20px 6px;overflow:auto}
.mcp-dlg-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--mcp-line)}
.mcp-def{margin-bottom:14px;padding:12px 14px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--dsw-alias-bg-layer-1)}
.mcp-def .mcp-label{margin-bottom:0}
.mcp-code{margin:8px 0 12px;padding:9px 11px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-base);font-family:var(--mcp-mono);font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}
.mcp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:0;font-size:12px}
.mcp-kv dt{color:var(--mcp-faint)}
.mcp-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.mcp-keys{display:flex;flex-wrap:wrap;gap:4px}
.mcp-files{display:grid;gap:6px;margin-top:8px}
.mcp-file{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r);background:var(--dsw-alias-bg-layer-1)}
.mcp-file code{font-family:var(--mcp-mono);font-size:12px}
@keyframes mcp-fade{from{opacity:0}to{opacity:1}}
@keyframes mcp-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
@keyframes mcp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.mcp-root *,.mcp-root *::before,.mcp-root *::after{animation:none!important;transition:none!important}}
@media (max-width:640px){.mcp-root{padding:16px 14px 40px}.mcp-row{flex-direction:column;gap:10px}.mcp-actions{width:100%}.mcp-grid2,.mcp-grid2.top{grid-template-columns:minmax(0,1fr)}}
`;

    // ------------------------------------------------------------- primitives

    let uidSeed = 0;
    /** An id that stays the same for the life of one mounted component, for label and aria wiring. */
    function useUid(prefix) {
      const ref = useRef(null);
      if (ref.current === null) {
        uidSeed += 1;
        ref.current = `${prefix || 'mcp'}-${uidSeed}`;
      }
      return ref.current;
    }

    const cx = (...parts) => parts.filter(Boolean).join(' ');
    /** Enter that is not the confirmation of an input-method composition (Chinese, Japanese). */
    const isEnter = (event) => event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing) && event.keyCode !== 229;

    const ICONS = {
      plus: ['M12 5v14M5 12h14'],
      x: ['M6 6l12 12M18 6L6 18'],
      check: ['M5 12.5l4.5 4.5L19 7.5'],
      chevron: ['M6 9l6 6 6-6'],
      refresh: ['M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5', 'M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5'],
      edit: ['M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4'],
      trash: ['M4.5 7h15M10 11v6M14 11v6', 'M6.5 7l.9 11.3a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M9 7V4.5h6V7'],
      upload: ['M12 15V4M7.5 8.5L12 4l4.5 4.5', 'M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15'],
      alert: ['M12 4.2l8.4 14.6H3.6L12 4.2z', 'M12 10v4M12 17v.01'],
      info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v5M12 8v.01'],
      shield: ['M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3l7-2.8z', 'M9 12l2.2 2.2L15.2 10'],
      folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V7.5z'],
      server: ['M4 5.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z', 'M4 13.5h16a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z', 'M7 8v.01M7 16v.01'],
      plug: ['M9 3v5M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0V8z', 'M12 17v4'],
      back: ['M19 12H5', 'M11 6l-6 6 6 6'],
    };

    function Icon({ name, size = 16 }) {
      return h(
        'svg',
        { className: 'mcp-ico', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        (ICONS[name] || []).map((d) => h('path', { key: d, d })),
      );
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: label,
        className: 'mcp-switch',
        disabled,
        onClick: () => onChange(!checked),
      });
    }

    /**
     * @param props.kind - space separated modifiers: primary, ghost, danger, armed.
     * @param props.iconOnly - square icon button; `title` then doubles as the accessible name.
     */
    function Btn({ children, onClick, kind, small, icon, iconOnly, disabled, title }) {
      return h(
        'button',
        {
          type: 'button',
          className: cx('mcp-btn', kind, small && 'sm', iconOnly && 'icon-only'),
          onClick,
          disabled,
          title,
          'aria-label': iconOnly ? title : undefined,
        },
        icon ? h(Icon, { name: icon, size: small ? 14 : 15 }) : null,
        iconOnly ? null : children,
      );
    }

    /** Delete asks for a second click within three seconds; the armed state names the action. */
    function DeleteButton({ onConfirm, t, disabled }) {
      const [armed, setArmed] = useState(false);
      useEffect(() => {
        if (!armed) return undefined;
        const timer = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(timer);
      }, [armed]);
      if (armed) {
        return h(Btn, { kind: 'danger armed', small: true, icon: 'trash', disabled, onClick: () => { setArmed(false); onConfirm(); } }, t('common.confirmDelete'));
      }
      return h(Btn, { kind: 'ghost danger', small: true, iconOnly: true, icon: 'trash', disabled, title: t('common.delete'), onClick: () => setArmed(true) });
    }

    function Field({ label, htmlFor, hint, error, children }) {
      return h(
        'div',
        { className: 'mcp-field' },
        label ? h(htmlFor ? 'label' : 'div', { className: 'mcp-label', htmlFor }, label) : null,
        children,
        error ? h('div', { className: 'mcp-fielderr', role: 'alert' }, h(Icon, { name: 'alert', size: 13 }), error) : null,
        hint ? h('div', { className: 'mcp-fieldhint' }, hint) : null,
      );
    }

    function Banner({ tone, children, action }) {
      return h(
        'div',
        { className: cx('mcp-banner', tone), role: tone === 'error' ? 'alert' : undefined },
        h(Icon, { name: tone === 'info' ? 'info' : 'alert', size: 16 }),
        h('div', { className: 'mcp-banner-body' }, children),
        action || null,
      );
    }

    function EmptyState({ icon, children, action }) {
      return h('div', { className: 'mcp-empty' }, h('div', { className: 'mcp-empty-icon' }, h(Icon, { name: icon, size: 20 })), h('div', null, children), action || null);
    }

    /** Segmented choice: one pressed button at a time. */
    function Seg({ value, options, onChange, disabled, label }) {
      return h(
        'div',
        { className: 'mcp-seg', role: 'group', 'aria-label': label },
        options.map((option) => h('button', { key: option.value, type: 'button', 'aria-pressed': value === option.value, disabled, onClick: () => onChange(option.value) }, option.label)),
      );
    }

    function Disclosure({ label, open, onToggle, children }) {
      const uid = useUid('mcp-disc');
      return h(
        React.Fragment,
        null,
        h('button', { type: 'button', className: 'mcp-disc', 'aria-expanded': open, 'aria-controls': uid, onClick: onToggle }, h(Icon, { name: 'chevron', size: 14 }), label),
        open ? h('div', { id: uid, className: 'mcp-disc-body' }, children) : null,
      );
    }

    // -------------------------------------------------------------- select

    /**
     * A listbox that stays inside the page (no node is added to document.body).
     * Keyboard: Up/Down/Home/End move, Enter or Space picks, Escape closes (and is not passed on to
     * a surrounding dialog), typing jumps to a matching label.
     */
    function Select({ value, options, onChange, placeholder, disabled, label, id }) {
      const [open, setOpen] = useState(false);
      const [active, setActive] = useState(-1);
      const [up, setUp] = useState(false);
      const rootRef = useRef(null);
      const listRef = useRef(null);
      const typed = useRef({ text: '', at: 0 });
      const uid = useUid('mcp-sel');
      const selectedIndex = options.findIndex((option) => option.value === value);
      const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

      const openList = () => {
        if (disabled || !rootRef.current) return;
        const rect = rootRef.current.getBoundingClientRect();
        const room = (typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800) - rect.bottom;
        setUp(room < 270 && rect.top > room);
        setActive(selectedIndex >= 0 ? selectedIndex : 0);
        setOpen(true);
      };
      const choose = (index) => {
        const option = options[index];
        if (!option) return;
        onChange(option.value);
        setOpen(false);
      };

      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open]);

      useEffect(() => {
        if (!open || !listRef.current) return;
        const node = listRef.current.children[active];
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
      }, [open, active]);

      const onKeyDown = (event) => {
        const last = options.length - 1;
        if (!open) {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openList();
          }
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((index) => Math.min(last, index + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => Math.max(0, index - 1));
        } else if (event.key === 'Home') {
          event.preventDefault();
          setActive(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          setActive(last);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose(active);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        } else if (event.key === 'Tab') {
          setOpen(false);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          typed.current.text = now - typed.current.at > 700 ? event.key.toLowerCase() : typed.current.text + event.key.toLowerCase();
          typed.current.at = now;
          const hit = options.findIndex((option) => String(option.label).toLowerCase().startsWith(typed.current.text));
          if (hit >= 0) setActive(hit);
        }
      };

      return h(
        'div',
        { className: 'mcp-select', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            id,
            className: 'mcp-select-trigger',
            role: 'combobox',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-controls': `${uid}-list`,
            'aria-activedescendant': open && active >= 0 ? `${uid}-${active}` : undefined,
            'aria-label': label,
            disabled,
            onClick: () => (open ? setOpen(false) : openList()),
            onKeyDown,
          },
          h('span', { className: 'mcp-select-value' }, selected ? selected.label : h('span', { className: 'ph' }, placeholder || '—')),
          h(Icon, { name: 'chevron', size: 15 }),
        ),
        open
          ? h(
              'ul',
              { className: cx('mcp-select-list', up && 'up'), role: 'listbox', id: `${uid}-list`, ref: listRef },
              options.map((option, index) =>
                h(
                  'li',
                  {
                    key: option.value,
                    id: `${uid}-${index}`,
                    role: 'option',
                    'aria-selected': index === selectedIndex,
                    className: cx('mcp-select-opt', index === active && 'active'),
                    onMouseEnter: () => setActive(index),
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: () => choose(index),
                  },
                  h('span', { className: 'mcp-opt-main' }, h('span', { className: 'mcp-opt-label' }, option.label), option.hint ? h('span', { className: 'mcp-opt-hint' }, option.hint) : null),
                  index === selectedIndex ? h(Icon, { name: 'check', size: 14 }) : null,
                ),
              ),
            )
          : null,
      );
    }

    // ------------------------------------------------------------- list editors

    let rowSeed = 0;
    const newRowId = () => {
      rowSeed += 1;
      return rowSeed;
    };

    /** One input per line (arguments). The value is the newline-joined text the form model already uses. */
    function ListEditor({ value, onChange, disabled, placeholder, addLabel, removeLabel, label }) {
      const [rows, setRows] = useState(() => value.split(/\r?\n/).filter((line) => line !== '').map((text) => ({ id: newRowId(), v: text })));
      const focusId = useRef(null);
      const commit = (next) => {
        setRows(next);
        onChange(next.map((row) => row.v).join('\n'));
      };
      const add = (at) => {
        const row = { id: newRowId(), v: '' };
        focusId.current = row.id;
        const next = rows.slice();
        next.splice(at === undefined ? next.length : at, 0, row);
        commit(next);
      };
      return h(
        'div',
        { className: 'mcp-rows', role: 'group', 'aria-label': label },
        rows.map((row, index) =>
          h(
            'div',
            { key: row.id, className: 'mcp-rowedit' },
            h('input', {
              className: 'mcp-input mono',
              value: row.v,
              disabled,
              placeholder,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': `${label} ${index + 1}`,
              ref: (node) => {
                if (node && focusId.current === row.id) {
                  focusId.current = null;
                  node.focus();
                }
              },
              onChange: (event) => commit(rows.map((item) => (item.id === row.id ? { ...item, v: event.target.value } : item))),
              onKeyDown: (event) => {
                if (isEnter(event)) {
                  event.preventDefault();
                  add(index + 1);
                }
              },
            }),
            h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'x', disabled, title: removeLabel, onClick: () => commit(rows.filter((item) => item.id !== row.id)) }),
          ),
        ),
        h(Btn, { kind: 'ghost addrow', small: true, icon: 'plus', disabled, onClick: () => add() }, addLabel),
      );
    }

    function parseKv(text, separator) {
      const rows = [];
      for (const line of text.split(/\r?\n/)) {
        const at = line.indexOf(separator);
        if (at <= 0) continue;
        rows.push({ id: newRowId(), k: line.slice(0, at).trim(), v: line.slice(at + 1).trim() });
      }
      return rows;
    }
    const serializeKv = (rows, separator) => rows.filter((row) => row.k !== '').map((row) => `${row.k}${separator === ':' ? ': ' : '='}${row.v}`).join('\n');

    /**
     * Name/value rows (environment variables, request headers). The separator can not occur in a
     * name, so the text the form model keeps always parses back to exactly these rows.
     */
    function KvEditor({ value, separator, onChange, disabled, keyPlaceholder, valuePlaceholder, addLabel, removeLabel, secretTitle, label }) {
      const [rows, setRows] = useState(() => parseKv(value, separator));
      const focusId = useRef(null);
      const commit = (next) => {
        setRows(next);
        onChange(serializeKv(next, separator));
      };
      const add = (at) => {
        const row = { id: newRowId(), k: '', v: '' };
        focusId.current = row.id;
        const next = rows.slice();
        next.splice(at === undefined ? next.length : at, 0, row);
        commit(next);
      };
      const patch = (id, change) => commit(rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
      return h(
        'div',
        { className: 'mcp-rows', role: 'group', 'aria-label': label },
        rows.map((row, index) => {
          const literalSecret = isLiteralSecret(row.k, row.v);
          return h(
            'div',
            { key: row.id, className: 'mcp-rowedit' },
            h('input', {
              className: 'mcp-input mono k',
              value: row.k,
              disabled,
              placeholder: keyPlaceholder,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': `${label} ${index + 1}: ${keyPlaceholder}`,
              ref: (node) => {
                if (node && focusId.current === row.id) {
                  focusId.current = null;
                  node.focus();
                }
              },
              onChange: (event) => patch(row.id, { k: event.target.value.split(separator).join('').replace(/[\r\n]/g, '') }),
            }),
            h('input', {
              className: cx('mcp-input mono', literalSecret && 'warn'),
              value: row.v,
              disabled,
              placeholder: valuePlaceholder,
              spellCheck: false,
              autoComplete: 'off',
              title: literalSecret ? secretTitle : undefined,
              'aria-label': `${label} ${index + 1}: ${valuePlaceholder}`,
              onChange: (event) => patch(row.id, { v: event.target.value.replace(/[\r\n]/g, '') }),
              onKeyDown: (event) => {
                if (isEnter(event)) {
                  event.preventDefault();
                  add(index + 1);
                }
              },
            }),
            h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'x', disabled, title: removeLabel, onClick: () => commit(rows.filter((item) => item.id !== row.id)) }),
          );
        }),
        h(Btn, { kind: 'ghost addrow', small: true, icon: 'plus', disabled, onClick: () => add() }, addLabel),
      );
    }

    // ------------------------------------------------------------------ dialog

    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

    /**
     * Modal with a focus trap: Tab cycles inside, Escape closes, focus returns to what opened it.
     * Header and footer stay put while the body scrolls, so a tall form never loses its buttons.
     */
    function Dialog({ title, onClose, closeLabel, footer, children }) {
      const ref = useRef(null);
      const uid = useUid('mcp-dlg');
      useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null;
        const root = ref.current;
        if (root) {
          const first = root.querySelector('[data-autofocus]:not(:disabled)') || root.querySelector('.mcp-dlg-body input:not(:disabled), .mcp-dlg-body textarea:not(:disabled)');
          (first || root).focus();
        }
        return () => {
          if (previous && typeof previous.focus === 'function') previous.focus();
        };
      }, []);
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== 'Tab' || !ref.current) return;
        const nodes = [...ref.current.querySelectorAll(FOCUSABLE)].filter((node) => !node.disabled && node.offsetParent !== null);
        if (nodes.length === 0) {
          event.preventDefault();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const current = document.activeElement;
        if (event.shiftKey && (current === first || current === ref.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && current === last) {
          event.preventDefault();
          first.focus();
        }
      };
      return h(
        'div',
        { className: 'mcp-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'div',
          { className: 'mcp-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': `${uid}-title`, tabIndex: -1, ref, onKeyDown },
          h('div', { className: 'mcp-dlg-head' }, h('h2', { id: `${uid}-title` }, title), h(Btn, { kind: 'ghost', iconOnly: true, icon: 'x', title: closeLabel, onClick: onClose })),
          h('div', { className: 'mcp-dlg-body' }, children),
          footer ? h('div', { className: 'mcp-dlg-foot' }, footer) : null,
        ),
      );
    }

    // -------------------------------------------------------------------- form

    const ADVANCED_FIELDS = ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnectEnabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'];
    const ADVANCED_ERRORS = /^(toolCallTimeoutMs|maxInstructionBytes|failOnStartupError|reconnect)/;
    /** Form field name -> the field name the Host reports its errors under, where they differ. */
    const ERROR_KEY = { argsText: 'args', envText: 'env', headersText: 'headers', reconnectEnabled: 'reconnect.enabled', initialDelayMs: 'reconnect.initialDelayMs', maxDelayMs: 'reconnect.maxDelayMs', maxAttempts: 'reconnect.maxAttempts' };

    /** Add/edit form for a stored server and for the literal fields of a profile row. */
    function ServerForm({ title, initial, mode, scope, targets, testRoot, t, onSubmit, onCancel, busy, serverError }) {
      const uid = useUid('mcp-f');
      const [form, setForm] = useState(initial);
      const [localError, setLocalError] = useState(null);
      const [advOpen, setAdvOpen] = useState(() => ADVANCED_FIELDS.some((name) => initial[name] !== '' && initial[name] !== undefined) || Boolean((initial.locked || {}).reconnect));
      const [probe, setProbe] = useState(null);
      const locked = form.locked || {};
      const details = serverError && Array.isArray(serverError.details) ? serverError.details : [];
      useEffect(() => {
        if (details.some((item) => ADVANCED_ERRORS.test(item.field || ''))) setAdvOpen(true);
      }, [serverError]);

      // A field the user has edited since the last submit no longer shows that submit's error.
      const [touched, setTouched] = useState({});
      useEffect(() => {
        setTouched({});
      }, [serverError]);
      const set = (patch) => {
        setForm((current) => ({ ...current, ...patch }));
        setTouched((current) => {
          const next = { ...current };
          for (const key of Object.keys(patch)) next[ERROR_KEY[key] || key] = true;
          return next;
        });
        setLocalError(null);
      };
      const fieldError = (name) => {
        if (touched[name]) return undefined;
        if (localError && localError.field === name) return localError.error;
        const hit = details.find((item) => item.field === name || (item.field || '').startsWith(`${name}.`));
        return hit ? hit.message : undefined;
      };
      const identityLocked = mode === 'legacy';
      const secrets = secretFields(form);
      const fid = (name) => `${uid}-${name}`;
      const exprNote = (field) => (locked[field] ? h('div', { className: 'mcp-fieldhint' }, `${t('form.expression')}: ${locked[field]}`) : null);
      const keptNote = (prefix) => {
        const kept = (form.exprEntries || []).filter((name) => name.startsWith(prefix));
        return kept.length > 0 ? h('div', { className: 'mcp-fieldhint' }, t('legacy.exprEntries', { fields: kept.join(', ') })) : null;
      };

      const submit = () => {
        const result = payloadFromForm(form, t, { includeIdentity: mode !== 'legacy' });
        if (result.error) {
          setLocalError(result);
          return;
        }
        setLocalError(null);
        onSubmit(result.payload, form.target);
      };

      /**
       * Start the server once under a temporary name and report whether it
       * answers. Nothing is saved; a stdio probe does launch the real process.
       */
      const testConnection = async () => {
        const result = payloadFromForm(form, t, { includeIdentity: false });
        if (result.error) {
          setLocalError(result);
          return;
        }
        setProbe({ status: 'testing' });
        try {
          const out = await api('testServer', { server: { ...result.payload, transport: form.transport, id: form.id }, root: testRoot });
          setProbe(out && out.ok === true
            ? { status: 'ok', text: t('test.ok', { count: out.toolCount }) }
            : { status: 'fail', text: t('test.fail', { error: (out && out.error) || 'unknown' }) });
        } catch (error) {
          setProbe({ status: 'fail', text: t('test.fail', { error: error.message }) });
        }
      };

      const input = (name, props = {}) => {
        const { mono, errKey, disabled: extraDisabled, ...rest } = props;
        const message = fieldError(errKey || name);
        return h('input', {
          id: fid(name),
          className: cx('mcp-input', mono && 'mono', message && 'err'),
          value: form[name],
          disabled: busy || Boolean(locked[name]) || Boolean(extraDisabled),
          'aria-invalid': message ? 'true' : undefined,
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => set({ [name]: event.target.value }),
          onKeyDown: (event) => {
            if (isEnter(event) && !busy) {
              event.preventDefault();
              submit();
            }
          },
          ...rest,
        });
      };
      const tri = [
        { value: '', label: t('form.default') },
        { value: 'true', label: t('form.yes') },
        { value: 'false', label: t('form.no') },
      ];

      const footer = [
        probe
          ? h(
              'span',
              { key: 'probe', className: cx('mcp-probe', probe.status) },
              probe.status === 'testing' ? t('test.running') : probe.text,
            )
          : null,
        // A profile row whose endpoint is an expression cannot be tried from here: the page does not know its value.
        mode === 'legacy' && ['command', 'url', 'args', 'env', 'headers'].some((field) => locked[field])
          ? null
          : h(Btn, { key: 'test', icon: 'plug', onClick: testConnection, disabled: busy || (probe && probe.status === 'testing') }, t('test.run')),
        h(Btn, { key: 'cancel', onClick: onCancel, disabled: busy }, t('common.cancel')),
        h(Btn, { key: 'save', kind: 'primary', onClick: submit, disabled: busy }, busy ? t('form.saving') : t('common.save')),
      ];

      return h(
        Dialog,
        { title, onClose: onCancel, closeLabel: t('common.close'), footer },
        mode === 'legacy' ? h(Banner, { tone: 'info' }, t('legacy.editNote')) : null,
        mode === 'new' && scope === 'project'
          ? h(
              Field,
              { label: t('form.target'), hint: t('form.targetHint') },
              h(Select, {
                value: form.target || 'store',
                label: t('form.target'),
                disabled: busy,
                onChange: (value) => set({ target: value }),
                options: (targets || []).map((item) => ({ value: item.value, label: item.label, hint: item.hint })),
              }),
            )
          : null,
        serverError && serverError.code !== 'invalid' ? h(Banner, { tone: 'error' }, serverError.message) : null,
        h(
          'div',
          { className: 'mcp-grid2 top' },
          h(Field, { label: t('form.serverName'), htmlFor: fid('serverName'), hint: t('form.serverNameHint'), error: fieldError('serverName') }, input('serverName', { mono: true, disabled: identityLocked, 'data-autofocus': '', placeholder: 'github' })),
          h(Field, { label: t('form.transport') }, h(Seg, { value: form.transport, disabled: busy || identityLocked, label: t('form.transport'), onChange: (value) => set({ transport: value }), options: [{ value: 'stdio', label: t('transport.stdio') }, { value: 'streamable-http', label: t('transport.streamable-http') }] })),
        ),
        form.transport === 'stdio'
          ? h(
              React.Fragment,
              null,
              h(Field, { label: t('form.command'), htmlFor: fid('command'), error: fieldError('command') }, input('command', { mono: true, placeholder: 'npx' }), exprNote('command')),
              h(Field, { label: t('form.args'), error: fieldError('args') }, h(ListEditor, { value: form.argsText, disabled: busy || Boolean(locked.args), onChange: (text) => set({ argsText: text }), placeholder: t('form.argPlaceholder'), addLabel: t('form.addArg'), removeLabel: t('form.remove'), label: t('form.args') }), exprNote('args')),
              h(Field, { label: t('form.env'), error: fieldError('env'), hint: t('form.refHint', REF_EXAMPLE) }, h(KvEditor, { value: form.envText, separator: '=', disabled: busy || Boolean(locked.env), onChange: (text) => set({ envText: text }), keyPlaceholder: t('form.keyPlaceholder'), valuePlaceholder: t('form.valuePlaceholder'), addLabel: t('form.addRow'), removeLabel: t('form.remove'), secretTitle: t('form.literalSecret'), label: t('form.env') }), exprNote('env'), keptNote('env.')),
              h(Field, { label: t('form.cwd'), htmlFor: fid('cwd'), error: fieldError('cwd') }, input('cwd', { mono: true }), exprNote('cwd')),
            )
          : h(
              React.Fragment,
              null,
              h(Field, { label: t('form.url'), htmlFor: fid('url'), error: fieldError('url') }, input('url', { mono: true, placeholder: 'http://127.0.0.1:3000/mcp' }), exprNote('url')),
              h(Field, { label: t('form.headers'), error: fieldError('headers'), hint: t('form.refHint', REF_EXAMPLE) }, h(KvEditor, { value: form.headersText, separator: ':', disabled: busy || Boolean(locked.headers), onChange: (text) => set({ headersText: text }), keyPlaceholder: t('form.keyPlaceholder'), valuePlaceholder: t('form.valuePlaceholder'), addLabel: t('form.addRow'), removeLabel: t('form.remove'), secretTitle: t('form.literalSecret'), label: t('form.headers') }), exprNote('headers'), keptNote('headers.')),
            ),
        secrets.length > 0 ? h(Banner, null, t('form.secretWarn', { fields: secrets.join(', '), example: REF_EXAMPLE.example })) : null,
        h(
          Disclosure,
          { label: t('form.advanced'), open: advOpen, onToggle: () => setAdvOpen((value) => !value) },
          h(
            'div',
            { className: 'mcp-grid2' },
            h(Field, { label: t('form.timeout'), htmlFor: fid('toolCallTimeoutMs'), error: fieldError('toolCallTimeoutMs') }, input('toolCallTimeoutMs', { mono: true, inputMode: 'numeric', placeholder: '60000' }), exprNote('toolCallTimeoutMs')),
            h(Field, { label: t('form.maxInstructionBytes'), htmlFor: fid('maxInstructionBytes'), error: fieldError('maxInstructionBytes') }, input('maxInstructionBytes', { mono: true, inputMode: 'numeric', placeholder: '32768' }), exprNote('maxInstructionBytes')),
            h(Field, { label: t('form.failOnStartup') }, h(Seg, { value: form.failOnStartupError, options: tri, disabled: busy || Boolean(locked.failOnStartupError), label: t('form.failOnStartup'), onChange: (value) => set({ failOnStartupError: value }) })),
            h(Field, { label: t('form.reconnect') }, h(Seg, { value: form.reconnectEnabled, options: tri, disabled: busy || Boolean(locked.reconnect), label: t('form.reconnect'), onChange: (value) => set({ reconnectEnabled: value }) })),
            h(Field, { label: t('form.initialDelay'), htmlFor: fid('initialDelayMs'), error: fieldError('reconnect.initialDelayMs') }, input('initialDelayMs', { mono: true, errKey: 'reconnect.initialDelayMs', inputMode: 'numeric', placeholder: '500', disabled: Boolean(locked.reconnect) })),
            h(Field, { label: t('form.maxDelay'), htmlFor: fid('maxDelayMs'), error: fieldError('reconnect.maxDelayMs') }, input('maxDelayMs', { mono: true, errKey: 'reconnect.maxDelayMs', inputMode: 'numeric', placeholder: '30000', disabled: Boolean(locked.reconnect) })),
            h(Field, { label: t('form.maxAttempts'), htmlFor: fid('maxAttempts'), error: fieldError('reconnect.maxAttempts') }, input('maxAttempts', { mono: true, errKey: 'reconnect.maxAttempts', inputMode: 'numeric', placeholder: '10', disabled: Boolean(locked.reconnect) })),
          ),
          locked.reconnect ? h('div', { className: 'mcp-fieldhint', style: { marginBottom: 14 } }, `${t('form.expression')}: reconnect`) : null,
        ),
        mode !== 'legacy' ? h(Field, { label: t('form.notes'), htmlFor: fid('notes'), error: fieldError('notes') }, input('notes')) : null,
      );
    }

    // ------------------------------------------------------------ other dialogs

    /**
     * The approval dialog. Everything that decides what runs is shown as written
     * in the file — values included, since the repository already holds them in
     * plain text — together with the variables it reads from the DSH process and
     * the risk hints. Rows stay compact (§7.5); this is where the detail belongs.
     */
    function TrustDialog({ view, t, onClose, onApprove, busy, error }) {
      const server = view.server;
      const isStdio = server.transport === 'stdio';
      const map = (isStdio ? server.env : server.headers) || {};
      const entries = Object.entries(map);
      const commandLine = isStdio ? [server.command, ...(server.args || [])].map(quoteArg).join(' ') : server.url;
      const variables = view.variables || [];
      const risks = view.risk || [];
      const notes = view.warnings || [];
      const differing = view.duplicateOf && !view.duplicateOf.entries.every((entry) => entry.sameAsWinner)
        ? view.duplicateOf.entries.filter((entry) => entry.source !== view.duplicateOf.winner).map((entry) => entry.source)
        : [];
      const keepOff = view.trustState === 'changed' && view.enabled === false;
      const footer = [
        h(Btn, { key: 'cancel', onClick: onClose, disabled: busy }, t('common.cancel')),
        h(Btn, { key: 'ok', kind: 'primary', icon: 'shield', disabled: busy, onClick: () => onApprove(view) }, keepOff ? t('trust.confirmKeepOff') : t('trust.confirm')),
      ];
      return h(
        Dialog,
        { title: t('trust.title', { name: view.serverName }), onClose, closeLabel: t('common.close'), footer },
        h(Banner, null, t('trust.warn')),
        view.trustState === 'changed' ? h(Banner, { tone: 'error' }, t('trust.changed')) : null,
        error ? h(Banner, { tone: 'error' }, error.code === 'fingerprint-mismatch' ? t('trust.mismatch') : error.message) : null,
        variables.length > 0 ? h(Banner, { tone: 'error' }, t('trust.variables', { names: variables.join(', ') })) : null,
        h(
          'div',
          { className: 'mcp-def' },
          h('div', { className: 'mcp-label' }, isStdio ? t('trust.stdioHeader') : t('trust.httpHeader')),
          h('div', { className: 'mcp-code' }, commandLine),
          h(
            'dl',
            { className: 'mcp-kv' },
            isStdio ? h(React.Fragment, null, h('dt', null, t('trust.command')), h('dd', null, h('span', { className: 'mcp-chip mono' }, server.command)), h('dt', null, t('trust.args')), h('dd', null, String((server.args || []).length))) : null,
            isStdio && server.cwd ? h(React.Fragment, null, h('dt', null, t('trust.cwd')), h('dd', null, server.cwd)) : null,
            h('dt', null, isStdio ? t('trust.envKeys') : t('trust.headerKeys')),
            h(
              'dd',
              null,
              entries.length === 0
                ? t('common.none')
                : h('div', { className: 'mcp-code', style: { margin: 0 } }, entries.map(([key, value]) => `${key}${isStdio ? '=' : ': '}${quoteArg(String(value))}`).join('\n')),
            ),
            view.source ? h(React.Fragment, null, h('dt', null, t('trust.source')), h('dd', null, h('span', { className: 'mcp-chip mono' }, view.source))) : null,
            h('dt', null, t('trust.fingerprint')),
            h('dd', null, h('span', { className: 'mcp-chip mono' }, `${view.fingerprint.slice(0, 16)}…`)),
          ),
        ),
        risks.length > 0 || differing.length > 0
          ? h(
              Field,
              { label: t('trust.risks') },
              risks.map((flag) => h('div', { key: flag.code, className: cx('mcp-warnline', flag.level === 'high' && 'high') }, h(Icon, { name: 'alert', size: 13 }), t(`risk.${flag.code}`))),
              differing.length > 0 ? h('div', { className: 'mcp-warnline' }, h(Icon, { name: 'alert', size: 13 }), t('trust.duplicate', { files: differing.join(' · ') })) : null,
            )
          : null,
        notes.length > 0
          ? h(Field, { label: t('trust.notes') }, notes.map((note) => h('div', { key: note, className: 'mcp-warnline' }, h(Icon, { name: 'info', size: 13 }), note)))
          : null,
      );
    }

    /** Paste a document; the Host converts it with the same reader it uses for project files. */
    function ImportDialog({ t, onClose, onImport, busy }) {
      const [text, setText] = useState('');
      const [message, setMessage] = useState(null);
      const run = async () => {
        const out = await onImport(text);
        if (out.error) {
          setMessage({ error: t('import.bad', { error: out.error }) });
          return;
        }
        const failures = out.results.filter((item) => !item.ok).map((item) => t('import.failedItem', { key: item.key, error: item.error }));
        setMessage({ info: t('import.done', { ok: out.imported, failed: out.failed }), failures });
      };
      const footer = [
        h(Btn, { key: 'close', onClick: onClose }, t('common.close')),
        h(Btn, { key: 'run', kind: 'primary', icon: 'upload', disabled: busy || text.trim() === '', onClick: run }, t('import.run')),
      ];
      return h(
        Dialog,
        { title: t('import.title'), onClose, closeLabel: t('common.close'), footer },
        h('p', { className: 'mcp-hint' }, t('import.hint')),
        h('textarea', { className: 'mcp-input mono', 'data-autofocus': '', value: text, spellCheck: false, onChange: (event) => { setText(event.target.value); setMessage(null); }, placeholder: '{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }' }),
        message && message.error ? h('div', { className: 'mcp-fielderr', style: { marginBottom: 12 } }, h(Icon, { name: 'alert', size: 13 }), message.error) : null,
        message && message.info ? h('div', { className: 'mcp-fieldhint', style: { marginBottom: 12 } }, message.info) : null,
        message && message.failures
          ? message.failures.map((line) => h('div', { key: line, className: 'mcp-warnline' }, h(Icon, { name: 'alert', size: 13 }), line))
          : null,
      );
    }

    // --------------------------------------------------------------------- rows

    const TONE = { active: 'ok', error: 'err', 'no-tools': 'warn', 'pending-trust': 'warn', 'trust-changed': 'warn', conflict: 'warn', shadowed: 'warn', connecting: 'busy' };

    function StatusPill({ status, tools, t }) {
      return h('span', { className: cx('mcp-pill', TONE[status]) }, t(`status.${status}`) + (tools > 0 ? ` · ${t('common.tools', { count: tools })}` : ''));
    }

    /** A short tag. The complete sentence stays in `title` for hover, and an
     * optional click opens the detailed list instead of printing it inline. */
    function Tag({ text, title, tone, icon, onClick, active }) {
      const element = onClick ? 'button' : 'span';
      return h(
        element,
        {
          type: onClick ? 'button' : undefined,
          className: cx('mcp-tag', tone, onClick && 'click', active && 'active'),
          title: title || text,
          'aria-expanded': onClick ? Boolean(active) : undefined,
          onClick,
        },
        icon ? h(Icon, { name: icon, size: 11 }) : null,
        h('span', { className: 'txt' }, text),
        onClick ? h(Icon, { name: 'chevron', size: 10 }) : null,
      );
    }

    /** One server of the global or project list. */
    function ServerRow({ view, t, busy, project, caps, onToggle, onEdit, onEditFile, onImport, onDelete, onDeleteFile, onReconnect, onReview, onRevoke }) {
      const [detailOpen, setDetailOpen] = useState(false);
      const fromFile = view.origin === 'file';
      const mountable = !['conflict', 'shadowed'].includes(view.status);
      // `enabled` is the switch; for a repository server it is separate from the approval.
      const enabled = view.enabled !== false;
      const canSwitch = mountable && view.status !== 'disabled-in-file' && (!fromFile || view.trustState === 'approved');
      const pending = view.status === 'pending-trust' || view.status === 'trust-changed';
      const canEditFile = fromFile && caps?.edit === true;
      const canDeleteFile = fromFile && caps?.delete === true;
      const canImport = fromFile && caps?.add === false;
      return h(
        'div',
        { className: 'mcp-card' },
        h(
          'div',
          { className: 'mcp-row' },
          h(
            'div',
            { className: 'mcp-main' },
            h(
              'div',
              { className: 'mcp-titleline' },
              h('span', { className: 'mcp-name' }, view.serverName),
              h('span', { className: 'mcp-chip' }, t(`transport.${view.server.transport}`)),
              project ? h('span', { className: 'mcp-chip' }, fromFile ? `${t('origin.file')} · ${view.source}` : t('origin.store')) : null,
              view.trustState === 'approved' ? h('span', { className: 'mcp-chip ok' }, h(Icon, { name: 'check', size: 11 }), t('trust.approved')) : null,
            ),
            h('div', { className: 'mcp-sum' }, view.summary),
            // Only the approval status and the duplicate tag stay on the row.
            // Risk, secret and warning hints are intentionally not rendered here.
            h(
              'div',
              { className: 'mcp-statusline' },
              h(StatusPill, { status: view.status, tools: view.toolCount, t }),
              view.overrides ? h(Tag, { text: t('override.tag'), title: t(`override.${view.overrides}`), icon: 'info' }) : null,
              view.server.notes ? h('span', { className: 'mcp-note' }, view.server.notes) : null,
              view.duplicateOf
                ? h(Tag, {
                    text: t('duplicate.tag', { count: view.duplicateOf.entries.length }),
                    title: (view.duplicateOf.entries.every((entry) => entry.sameAsWinner)
                      ? t('duplicate.same', { files: view.duplicateOf.entries.map((entry) => entry.source).join(' · '), winner: view.duplicateOf.winner })
                      : t('duplicate.differs', { files: view.duplicateOf.entries.map((entry) => entry.source).join(' · '), winner: view.duplicateOf.winner })),
                    tone: 'warn', icon: 'alert', active: detailOpen,
                    onClick: () => setDetailOpen((value) => !value),
                  })
                : null,
            ),
            view.detail ? h('div', { className: 'mcp-detail' }, view.detail) : null,
            detailOpen && view.duplicateOf
              ? h(
                  'div',
                  { className: 'mcp-tagdetail' },
                  h('div', { className: 'mcp-label' }, t('duplicate.detailTitle')),
                  h(
                    'ul',
                    { className: 'mcp-taglist' },
                    view.duplicateOf.entries.map((entry) => {
                      const isWinner = entry.source === view.duplicateOf.winner;
                      return h(
                        'li',
                        { key: entry.source, className: isWinner ? 'win' : undefined },
                        h('span', { className: 'src' }, entry.source),
                        ' — ',
                        h('span', { className: 'cmd' }, entry.summary),
                        isWinner ? h('span', { className: 'inuse' }, t('duplicate.inUse')) : null,
                      );
                    }),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { className: 'mcp-actions' },
            canSwitch ? h(Switch, { checked: enabled, disabled: busy, label: t('common.enabled'), onChange: (next) => onToggle(view, next) }) : null,
            pending ? h(Btn, { kind: 'primary', small: true, icon: 'shield', disabled: busy, onClick: () => onReview(view) }, t('trust.approve')) : null,
            fromFile && view.trustState === 'approved' ? h(Btn, { kind: 'ghost', small: true, disabled: busy, onClick: () => onRevoke(view) }, t('trust.revoke')) : null,
            canImport ? h(Btn, { kind: 'ghost', small: true, icon: 'upload', disabled: busy, onClick: () => onImport(view) }, t('file.import')) : null,
            !fromFile && mountable && enabled ? h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'refresh', disabled: busy, title: t('common.reconnect'), onClick: () => onReconnect(view) }) : null,
            !fromFile ? h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'edit', disabled: busy, title: t('common.edit'), onClick: () => onEdit(view) }) : null,
            canEditFile ? h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'edit', disabled: busy, title: t('common.edit'), onClick: () => onEditFile(view) }) : null,
            canDeleteFile && mountable
              ? h(DeleteButton, { t, disabled: busy, onConfirm: () => onDeleteFile(view) })
              : null,
            !fromFile ? h(DeleteButton, { t, disabled: busy, onConfirm: () => onDelete(view) }) : null,
          ),
        ),
      );
    }

    function LegacyRow({ row, t, busy, onToggle, onEdit }) {
      const status = !row.enabled ? 'disabled' : row.active ? (row.toolCount > 0 ? 'active' : 'no-tools') : 'connecting';
      return h(
        'div',
        { className: 'mcp-card' },
        h(
          'div',
          { className: 'mcp-row' },
          h(
            'div',
            { className: 'mcp-main' },
            h('div', { className: 'mcp-titleline' }, h('span', { className: 'mcp-name' }, row.serverName || row.rowId), h('span', { className: 'mcp-chip' }, t(`transport.${row.transport}`)), h('span', { className: 'mcp-chip mono' }, row.rowId)),
            h('div', { className: 'mcp-sum' }, row.endpoint),
            h('div', { className: 'mcp-statusline' }, h(StatusPill, { status, tools: row.toolCount, t })),
            row.expressionFields.length > 0 ? h('div', { className: 'mcp-warnline' }, h(Icon, { name: 'info', size: 13 }), t('legacy.expression', { fields: row.expressionFields.join(', ') })) : null,
          ),
          h(
            'div',
            { className: 'mcp-actions' },
            h(Switch, { checked: row.enabled, disabled: busy, label: t('common.enabled'), onChange: (next) => onToggle(row, next) }),
            h(Btn, { kind: 'ghost', small: true, iconOnly: true, icon: 'edit', disabled: busy, title: t('common.edit'), onClick: () => onEdit(row) }),
          ),
        ),
      );
    }

    // -------------------------------------------------------------- the page

    function useLocalStorage(key, initial) {
      const [value, setValue] = useState(() => {
        try {
          const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
          return stored === null ? initial : stored;
        } catch {
          return initial;
        }
      });
      const update = useCallback(
        (next) => {
          setValue(next);
          try {
            localStorage.setItem(key, next);
          } catch {
            // Storage is optional; the choice just does not persist.
          }
        },
        [key],
      );
      return [value, update];
    }

    function McpPage({ t, onBack }) {
      const [tab, setTab] = useLocalStorage('mcp-more-panel:tab', 'global');
      const [projectRoot, setProjectRoot] = useLocalStorage('mcp-more-panel:project', '');
      const [state, setState] = useState(null);
      const [project, setProject] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [dialog, setDialog] = useState(null);
      const [dialogError, setDialogError] = useState(null);
      const [banner, setBanner] = useState(null);
      const [query, setQuery] = useState('');
      const [typedRoot, setTypedRoot] = useState('');
      const [otherMode, setOtherMode] = useState(false);
      const alive = useRef(true);
      /** The project the page shows now; a response for another one is dropped. */
      const currentRoot = useRef(projectRoot);
      currentRoot.current = projectRoot;
      const inFlight = useRef(false);

      useEffect(() => () => { alive.current = false; }, []);

      // A different project starts empty instead of showing the previous one's servers under its name.
      useEffect(() => {
        setProject(null);
      }, [projectRoot]);

      /** Reload. A poll is skipped while one is running; a refresh after a change always runs. */
      const refresh = useCallback(async (force = false) => {
        if (inFlight.current && !force) return;
        inFlight.current = true;
        try {
          const next = await api('state');
          if (!alive.current) return;
          setState(next);
          setLoadError(null);
          if (tab === 'project' && projectRoot) {
            const proj = await api('projectState', { root: projectRoot });
            if (alive.current && currentRoot.current === projectRoot) setProject(proj);
          }
        } catch (error) {
          if (alive.current) setLoadError(error);
        } finally {
          inFlight.current = false;
        }
      }, [tab, projectRoot]);

      // Poll only while the page is visible, and catch up as soon as it is shown again.
      useEffect(() => {
        const hidden = () => typeof document !== 'undefined' && document.hidden === true;
        refresh(true);
        const timer = setInterval(() => {
          if (!hidden()) refresh();
        }, POLL_MS);
        const onVisibility = () => {
          if (!hidden()) refresh();
        };
        if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVisibility);
        return () => {
          clearInterval(timer);
          if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [refresh]);

      useEffect(() => {
        if (tab === 'project' && !projectRoot && state && state.projects.length > 0) setProjectRoot(state.projects[0].root);
      }, [tab, projectRoot, state, setProjectRoot]);

      /** Run a mutation: busy flag, error to the dialog or banner, then refresh. */
      const run = useCallback(
        async (job, { keepDialogOnError = false } = {}) => {
          setBusy(true);
          setBanner(null);
          if (!keepDialogOnError) setDialogError(null);
          try {
            const result = await job();
            if (alive.current) setDialogError(null);
            await refresh(true);
            return { ok: true, result };
          } catch (error) {
            if (alive.current) {
              if (keepDialogOnError) setDialogError(error);
              else setBanner(t('err.generic', { message: error.message }));
            }
            return { ok: false, error };
          } finally {
            if (alive.current) setBusy(false);
          }
        },
        [refresh, t],
      );

      const closeDialog = () => {
        setDialog(null);
        setDialogError(null);
      };

      // ---- global
      const saveGlobal = async (payload) => {
        const out = await run(() => api('saveGlobal', { server: payload }), { keepDialogOnError: true });
        if (out.ok) closeDialog();
      };
      const importServers = async (text) => {
        setBusy(true);
        try {
          return await api('importGlobal', { text });
        } catch (error) {
          return { error: error.message };
        } finally {
          if (alive.current) setBusy(false);
          await refresh(true);
        }
      };

      // ---- project
      const saveProject = async (payload) => {
        const out = await run(() => api('saveProject', { root: projectRoot, server: payload }), { keepDialogOnError: true });
        if (out.ok) closeDialog();
      };
      const saveProjectSource = async (sourceId, payload) => {
        const out = await run(() => api('saveProjectSource', { root: projectRoot, source: sourceId, server: payload }), { keepDialogOnError: true });
        if (out.ok) closeDialog();
      };
      const editProjectSource = async (sourceId, originalName, payload) => {
        const out = await run(() => api('editProjectSource', { root: projectRoot, source: sourceId, originalName, server: payload }), { keepDialogOnError: true });
        if (out.ok) closeDialog();
      };
      const importProjectServer = async (view) => {
        await run(() => api('importProjectServer', { root: projectRoot, source: view.sourceId, serverName: view.serverName }));
      };
      const approve = async (view) => {
        const out = await run(() => api('approveTrust', { root: projectRoot, serverName: view.serverName, fingerprint: view.fingerprint }), { keepDialogOnError: true });
        if (out.ok) closeDialog();
      };

      // ---- profile rows
      const saveLegacy = async (row, payload) => {
        const out = await run(() => api('editLegacy', { rowId: row.rowId, form: payload }), { keepDialogOnError: true });
        if (out.ok) {
          closeDialog();
          const skipped = out.result && out.result.skipped ? out.result.skipped : [];
          if (skipped.length > 0) setBanner(t('legacy.skipped', { fields: skipped.join(', ') }));
        }
      };

      const banners = [];
      if (loadError) {
        banners.push(h(Banner, { key: 'load', tone: 'error', action: h(Btn, { small: true, onClick: refresh }, t('common.retry')) }, t('err.generic', { message: loadError.message })));
      }
      if (state && state.client && state.client.available === false) banners.push(h(Banner, { key: 'client', tone: 'error' }, t('banner.clientMissing', { error: state.client.error })));
      if (state && state.storeError) {
        banners.push(state.storeReadOnly
          ? h(Banner, { key: 'store', tone: 'error' }, t('banner.storeReadOnly', { error: state.storeError }))
          : h(Banner, { key: 'store' }, t('banner.storeError', { error: state.storeError })));
      }
      if (banner) banners.push(h(Banner, { key: 'op', tone: 'error' }, banner));

      const globalPane = () =>
        !state
          ? h('div', { className: 'mcp-muted' }, t('common.loading'))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'mcp-bar' },
                h(Btn, { kind: 'primary', icon: 'plus', disabled: busy, onClick: () => setDialog({ kind: 'form', mode: 'new', scope: 'global', initial: emptyForm() }) }, t('global.add')),
                h(Btn, { icon: 'upload', disabled: busy, onClick: () => setDialog({ kind: 'import' }) }, t('global.import')),
                h('span', { className: 'mcp-hint mcp-grow', style: { margin: 0 } }, t('global.hint')),
              ),
              state.global.length === 0
                ? h(EmptyState, { icon: 'server' }, t('global.empty'))
                : state.global.map((view) =>
                    h(ServerRow, {
                      key: view.id,
                      view,
                      t,
                      busy,
                      onToggle: (v, next) => run(() => api('setGlobalEnabled', { id: v.id, enabled: next })),
                      onReconnect: (v) => run(() => api('reconnectGlobal', { id: v.id })),
                      onEdit: (v) => setDialog({ kind: 'form', mode: 'edit', scope: 'global', initial: formFromServer(v.server) }),
                      onDelete: (v) => run(() => api('deleteGlobal', { id: v.id })),
                    }),
                  ),
              h('div', { className: 'mcp-h2' }, t('legacy.title')),
              h('p', { className: 'mcp-hint' }, t('legacy.hint')),
              !state.legacyAvailable
                ? h(EmptyState, { icon: 'info' }, t('legacy.unavailable'))
                : state.legacy.length === 0
                  ? h(EmptyState, { icon: 'info' }, t('legacy.empty'))
                  : state.legacy.map((row) =>
                      h(LegacyRow, {
                        key: row.rowId,
                        row,
                        t,
                        busy,
                        onToggle: (r, next) => run(() => api('toggleLegacy', { rowId: r.rowId, enabled: next })),
                        onEdit: (r) => setDialog({ kind: 'form', mode: 'legacy', scope: 'legacy', row: r, initial: formFromRow(r) }),
                      }),
                    ),
            );

      /** What the page may do with a source file: a file with comments is never rewritten. */
      const capsOf = (sourceId) => {
        const source = project && project.sources.find((item) => item.id === sourceId);
        if (!source) return undefined;
        const caps = source.capabilities || {};
        return source.comments ? { ...caps, edit: false, delete: false } : caps;
      };

      const projectPane = () => {
        const known = state ? state.projects : [];
        const selectValue = otherMode ? '__other__' : known.some((p) => p.root === projectRoot) ? projectRoot : projectRoot ? '__other__' : '';
        const options = [
          ...known.map((p) => ({ value: p.root, label: p.label, hint: p.root })),
          ...(projectRoot && !known.some((p) => p.root === projectRoot) ? [{ value: projectRoot, label: projectRoot }] : []),
          { value: '__other__', label: t('project.other') },
        ];
        const applyTyped = () => {
          if (typedRoot.trim() === '') return;
          setProjectRoot(typedRoot.trim());
          setOtherMode(false);
        };
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'mcp-picker' },
            h(
              Field,
              { label: t('project.pick'), htmlFor: 'mcp-project-select' },
              h(Select, {
                id: 'mcp-project-select',
                value: selectValue,
                options,
                placeholder: t('project.choose'),
                label: t('project.pick'),
                onChange: (value) => {
                  if (value === '__other__') setOtherMode(true);
                  else {
                    setOtherMode(false);
                    setProjectRoot(value);
                  }
                },
              }),
            ),
          ),
          otherMode
            ? h(
                'div',
                { className: 'mcp-bar' },
                h('input', { className: 'mcp-input mono', style: { flex: '1 1 320px', width: 'auto' }, 'aria-label': t('project.otherPlaceholder'), value: typedRoot, spellCheck: false, autoComplete: 'off', placeholder: t('project.otherPlaceholder'), onChange: (event) => setTypedRoot(event.target.value), onKeyDown: (event) => { if (isEnter(event)) { event.preventDefault(); applyTyped(); } } }),
                h(Btn, { kind: 'primary', disabled: typedRoot.trim() === '', onClick: applyTyped }, t('project.use')),
              )
            : null,
          !projectRoot
            ? h(EmptyState, { icon: 'folder' }, t('project.none'))
            : !project
              ? h('div', { className: 'mcp-muted' }, t('common.loading'))
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'mcp-picker' },
                    h(
                      Field,
                      { label: t('project.source'), htmlFor: 'mcp-source-select', hint: t('project.sourceHint') },
                      h(Select, {
                        id: 'mcp-source-select',
                        value: project.selection || 'all',
                        disabled: busy,
                        label: t('project.source'),
                        onChange: (value) => run(() => api('setProjectSource', { root: projectRoot, source: value })),
                        options: [
                          { value: 'all', label: t('project.sourceAll') },
                          ...project.sources
                            .filter((source) => source.exists || source.id === project.selection)
                            .map((source) => ({
                              value: source.id,
                              label: `${source.exists ? source.label : `${source.label} (${t('project.fileMissing')})`}${source.capabilities?.add === false ? ` · ${t('source.readOnly')}` : source.comments ? ` · ${t('source.comments')}` : ''}`,
                              hint: source.path,
                            })),
                        ],
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'mcp-bar' },
                    h(Btn, { kind: 'primary', icon: 'plus', disabled: busy, onClick: () => setDialog({ kind: 'form', mode: 'new', scope: 'project', initial: emptyForm() }) }, t('project.add')),
                    h(Btn, { icon: 'refresh', disabled: busy, onClick: () => run(() => api('reconnectProject', { root: projectRoot })) }, t('project.remount')),
                    h('span', { className: cx('mcp-pill', project.liveSessions > 0 && 'ok') }, t('project.sessions', { count: project.liveSessions })),
                  ),
                  h('p', { className: 'mcp-hint' }, t('project.hint')),
                  h('input', {
                    className: 'mcp-input mcp-search',
                    type: 'search',
                    placeholder: t('search.placeholder'),
                    'aria-label': t('search.placeholder'),
                    value: query,
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  (() => {
                    const needle = query.trim().toLowerCase();
                    const visible = project.servers.filter((view) => {
                      if (needle === '') return true;
                      const notes = view.server && view.server.notes ? view.server.notes : '';
                      return [view.serverName, view.summary, notes].some((text) => String(text).toLowerCase().includes(needle));
                    });
                    const groups = [
                      { id: 'store', label: t('group.store'), items: visible.filter((view) => view.origin === 'store') },
                      { id: 'file', label: t('group.file'), items: visible.filter((view) => view.origin !== 'store') },
                    ].filter((group) => group.items.length > 0);
                    if (groups.length === 0) {
                      return h(EmptyState, { icon: 'server' }, needle === '' ? t('project.empty') : t('search.none'));
                    }
                    return groups.map((group) =>
                      h(
                        React.Fragment,
                        { key: group.id },
                        h('div', { className: 'mcp-group' }, `${group.label} · ${group.items.length}`),
                        group.items.map((view) =>
                          h(ServerRow, {
                            key: view.id,
                            view,
                            t,
                            busy,
                            project: true,
                            caps: capsOf(view.sourceId),
                            onToggle: (v, next) => run(() => api('setProjectEnabled', { root: projectRoot, id: v.id, enabled: next })),
                            onReconnect: () => run(() => api('reconnectProject', { root: projectRoot })),
                            onEdit: (v) => setDialog({ kind: 'form', mode: 'edit', scope: 'project', initial: formFromServer(v.server) }),
                            onEditFile: (v) => setDialog({
                              kind: 'form', mode: 'edit', scope: 'project',
                              editSource: v.sourceId, originalName: v.serverName,
                              initial: formFromServer(v.server),
                            }),
                            onImport: (v) => importProjectServer(v),
                            onDelete: (v) => run(() => api('deleteProject', { root: projectRoot, id: v.id })),
                            onDeleteFile: (v) => run(() => api('deleteProjectSource', { root: projectRoot, source: v.sourceId, serverName: v.serverName })),
                            onReview: (v) => { setDialogError(null); setDialog({ kind: 'trust', view: v }); },
                            onRevoke: (v) => run(() => api('revokeTrust', { root: projectRoot, serverName: v.serverName })),
                          }),
                        ),
                      ),
                    );
                  })(),
                  (() => {
                    const declared = project.files.filter((file) => file.exists && !file.error && (file.count || 0) > 0);
                    if (declared.length === 0) return null;
                    return h(
                      React.Fragment,
                      null,
                      h('div', { className: 'mcp-h2' }, t('project.sourceFiles')),
                      h(
                        'div',
                        { className: 'mcp-files' },
                        declared.map((file) =>
                          h(
                            'div',
                            { key: file.path, className: 'mcp-file' },
                            h('code', null, file.path),
                            h('span', { className: 'mcp-pill ok' }, t('project.fileCount', { count: file.count })),
                          ),
                        ),
                      ),
                    );
                  })(),
                  project.invalid.length > 0
                    ? h(
                        React.Fragment,
                        null,
                        h('div', { className: 'mcp-h2' }, t('project.invalid')),
                        project.invalid.map((item, index) => h('div', { key: index, className: 'mcp-warnline' }, h(Icon, { name: 'alert', size: 13 }), `${item.file}: ${item.field ? `${item.field} — ` : ''}${item.message}`)),
                      )
                    : null,
                ),
        );
      };

      let dialogNode = null;
      if (dialog && dialog.kind === 'form') {
        const title = dialog.mode === 'legacy' ? t('form.titleLegacy') : dialog.mode === 'edit' ? t('form.titleEdit') : t('form.titleNew');
        dialogNode = h(ServerForm, {
          key: dialog.initial.id || 'new',
          title,
          initial: dialog.initial,
          mode: dialog.mode,
          scope: dialog.scope,
          // Existing writable files without comments, plus DSH's own file, which is created on first use.
          targets: project
            ? [
                { value: 'store', label: t('form.targetStore') },
                ...project.sources
                  .filter((source) => source.capabilities?.add === true && !source.comments && (source.exists || source.id === 'dsh'))
                  .map((source) => ({ value: source.id, label: source.exists ? source.label : t('form.targetNew', { label: source.label, path: source.path }), hint: source.path })),
              ]
            : [{ value: 'store', label: t('form.targetStore') }],
          testRoot: dialog.scope === 'project' ? projectRoot : undefined,
          t,
          busy,
          serverError: dialogError,
          onCancel: closeDialog,
          onSubmit: (payload, target) => {
            if (dialog.editSource) {
              editProjectSource(dialog.editSource, dialog.originalName, payload);
            } else if (dialog.scope === 'global') saveGlobal(payload);
            else if (dialog.scope === 'project') {
              if (target && target !== 'store') saveProjectSource(target, payload);
              else saveProject(payload);
            } else saveLegacy(dialog.row, payload);
          },
        });
      } else if (dialog && dialog.kind === 'trust') {
        dialogNode = h(TrustDialog, { view: dialog.view, t, busy, error: dialogError, onClose: closeDialog, onApprove: approve });
      } else if (dialog && dialog.kind === 'import') {
        dialogNode = h(ImportDialog, { t, busy, onClose: closeDialog, onImport: importServers });
      }

      return h(
        'div',
        { className: 'mcp-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'mcp-head' },
          h(
            'div',
            { className: 'mcp-headline' },
            h('h1', { className: 'mcp-h1' }, t('page.title')),
            onBack ? h(Btn, { kind: 'ghost', small: true, icon: 'back', onClick: onBack }, t('nav.back')) : null,
          ),
          h('p', { className: 'mcp-sub' }, t('page.subtitle')),
          banners,
          h(
            'div',
            { className: 'mcp-tabs', role: 'tablist' },
            ['global', 'project'].map((name) =>
              h('button', { key: name, type: 'button', role: 'tab', className: 'mcp-tab', 'aria-selected': tab === name, onClick: () => setTab(name) }, t(`tab.${name}`)),
            ),
          ),
        ),
        h('div', { className: 'mcp-scroll', role: 'tabpanel', tabIndex: 0 }, tab === 'global' ? globalPane() : projectPane()),
        dialogNode,
      );
    }

    // ------------------------------------------------------------- sidebar bits

    /** Two stacked server blocks; stroke follows the host's text color. */
    function PanelIcon({ size = 16 } = {}) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3, y: 4, width: 18, height: 6, rx: 2 }),
        h('rect', { x: 3, y: 14, width: 18, height: 6, rx: 2 }),
        h('path', { d: 'M7 7h.01M7 17h.01' }),
      );
    }

    const inject = ['locale', 'slots', 'layout'];

    /**
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.inject(inject, (scope) => {
        scope.effect(() => scope.locale.register(NS, { zh, en }), 'mcp-more-panel: dictionaries');
        const t = scope.locale.bind(NS);

        scope.slots.inject('sidebar.panellist', () =>
          scope.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('nav.label'), locale: NS },
            (owner = {}) => h(PanelIcon, { size: owner.size ?? 16 }),
          ),
        );

        scope.slots.inject('main', () =>
          scope.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t, onBack: () => scope.layout?.selectPanel?.(null) }) },
            (props = {}) => h(McpPage, { t: props.t ?? t, onBack: props.onBack }),
          ),
        );
      });
    }

    // The helpers below are exposed only when a test harness sets the flag; production never does.
    const internals = {
      api, endpoint, ApiError, parseLines, payloadFromForm, formFromServer, formFromRow, secretFields, emptyForm, quoteArg,
      dictionaries: { zh, en },
      components: { TrustDialog, ServerRow, ServerForm, ImportDialog, LegacyRow, McpPage },
    };
    return globalThis.__MCP_MORE_PANEL_TEST__ ? { inject, apply, internals } : { inject, apply };
  },
});
