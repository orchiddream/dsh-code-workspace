/**
 * dsh-code-workspace — client half.
 *
 * A hand-maintained DSH `client-modules` factory bundle: no build step, no JSX
 * transform (the platform exposes React without one), CJS-style body inside a
 * `window.__ModuleLoader__.load({ id, factory })` registration. `id` MUST equal
 * the package name.
 *
 * Surfaces:
 *
 * - `conversation.view` — the panel's page, one tab beside the shipped Chat /
 *   Trajectory / Git tabs. The header button selects it and toggles back.
 * - `sidebar.panellist` + `main` under ONE id — the left column's "Code
 *   Workspace" row and the page it opens: the manager. That page is a list of
 *   the workspace files this app knows, plus the two ways to add one; it is
 *   sessionless, so it draws no per-session detail card (the Conversation view
 *   is where that lives).
 * - `conversation.session.header.actions` — that toggle, beside the session title.
 * - `conversation.hero.options` — the session-creation page entry, at the right
 *   end of the New Session row that also carries the workspace picker and the
 *   agent-preset control, so it shares their line. It renders only in the hero
 *   phase, so the session header entry and this one never appear together.
 * - `shell.overlay` — the floating panel, now only the creation page's popover:
 *   it is the one place a `.code-workspace` file can be picked before a session
 *   exists. A fixed-position element that opts back into pointer events (that
 *   layer is click-through by design).
 * - The shipped "Open In…" cell (`conversation.session.header.utilities` and
 *   `sidebar.right.tab.files.actions`, id `open-in-app`) — taken over at priority
 *   -2 so the VS Code family (VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae)
 *   opens the `.code-workspace` FILE the shipped control can never reach, while
 *   every other shipped application keeps its own name, icon, route and
 *   behaviour. Skipped entirely when the shell's UI primitives are unavailable.
 * - A companion `@` menu group fed by `codeWorkspace/listFiles`, because DSH's
 *   own `@` provider is single-root by construction and can never offer a file
 *   from another workspace folder.
 *
 * All host traffic goes through one of two channels: `remote.commands.execute`
 * while a session exists (so the conversation shows the change and the agent is
 * notified at its next message boundary), and the sessionless shared RPC channel
 * (`connection.rpc.call('/api', 'codeWorkspace/…', { args })`) on the
 * session-creation page, where no session exists yet. Read-only helpers that
 * touch no session state (`browse`, `makeDir`, `reveal`, `editors`, `editorIcon`,
 * `openInEditor`, `recent`, `pick`) always use the RPC channel. The one exception
 * is the shipped menu's own traffic (`open-in-app/apps`, `open-in-app/open`),
 * which stays on the shipped HTTP routes because they are the shipped host's.
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-workspace',
  factory: function (require) {
    var React = require('react')

    /**
     * A platform seed module, loaded only if the shell publishes it.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is what the shipped "Open In…"
     * control is drawn with, and the takeover below draws with the same widgets so
     * the header keeps one visual language. It is optional on purpose: without it
     * this bundle leaves the shipped control alone and every other surface (the
     * panel, the hero-row chip, the `@` group) keeps working. A hard `require` would
     * turn a missing seed module into a dead plugin.
     */
    function optionalRequire(specifier) {
      try {
        return require(specifier)
      } catch (e) {
        return null
      }
    }

    var primitives = optionalRequire('@deepseek-ai/dsh-client-ui-primitives')

    var name = 'dsh-code-workspace'
    /** Bundle-level prerequisite packages (dsh.client.inject). */
    var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale']

    var NS = 'code-workspace'
    /** Marker line the host command result carries the structured state on. */
    var JSON_MARK = '[CWS:JSON]'
    var PANEL_ID = 'code-workspace-panel'
    var ENTRY_ID = 'code-workspace'
    /** Hero-row options order: sit after any shipped entry that claims the row. */
    var HERO_ORDER = 120
    /** `shell.overlay` order. */
    var PANEL_ORDER = 110

    /**
     * The Conversation view this bundle owns.
     *
     * `conversation.view` is the list slot behind the Conversation's own tab
     * strip (Chat / Trajectory / Git): the owner builds its tabs by walking that
     * slot's entries, and it renders one entry at a time by id. So one
     * registration puts this panel beside those tabs — full width, one click
     * from the conversation, and no second column of its own.
     */
    var VIEW_ID = 'code-workspace'
    /** After the shipped Chat (0) and Trajectory (10); Git is contributed upstream. */
    var VIEW_ORDER = 30

    /**
     * The id shared by the sidebar entry and the central panel it opens.
     *
     * Deliberately the same string as `VIEW_ID`: `sidebar.panellist` ids ARE the
     * `main` panel keys, and this bundle's Conversation view already answers to
     * `code-workspace`. So the sidebar button, `layout.selectPanel('code-workspace')`
     * and the Conversation tab all address one page instead of two that would
     * have to be kept in step — and `selectPanel` cannot be ambiguous about which
     * of them it means.
     */
    var PANEL_KEY = VIEW_ID
    /** The sidebar list runs plugins at 0 and schedules at 10; sit between them. */
    var SIDEBAR_ORDER = 5

    /**
     * How long a non-forced read of the recorded workspace list stays authoritative.
     *
     * Several surfaces can ask for that list as they mount, and answering every
     * request with a round trip would turn a few renders into a burst of calls.
     * Matches the host-side model TTL, past which a read is not the freshest
     * answer anyway. A deliberate refresh passes `force`.
     */
    var MODEL_TTL_MS = 2000

    /**
     * Browser-stored shell bindings, keyed `(sessionId, pathKey) -> contentId`.
     *
     * `contentId` is the durable identity the terminal provider itself persists
     * its layout associations under; a sidebar tab id is only valid for one page
     * life, so reload-recovery must match on contentId and read the current tab
     * id back from the inventory.
     */
    var SHELL_STORE_KEY = 'dsh.code-workspace.project-shells.v1'
    var SHELL_STORE_LIMIT = 64
    /** How long `openTab` may take to surface the new tab in the inventory. */
    var SHELL_TAB_APPEAR_MS = 3000
    /** How long the shell may take to attach and accept input. */
    var SHELL_WRITABLE_MS = 10000

    // ------------------------------------------------------------ dictionaries
    // `locale.register` enforces BCP 47 tags and rejects a duplicate
    // (namespace, locale) pair; bilingual key balance is our own discipline.

    var zh = {
      label: '代码工作区',
      'label.panel': '代码工作区',
      'label.hero': '代码工作区',
      'title': '代码工作区',
      'title.none': '未关联 .code-workspace 文件',
      'title.tab': '代码工作区',
      'label.monaco': 'VS Code 代码预览',
      'hint.monacoLoading': '正在加载 VS Code 编辑器…',
      'error.monaco': 'VS Code 编辑器加载失败，已退回内置代码预览。',
      'hint.view': '工作区是「对话 / 轨迹 / Git」旁边的一个页签；点回「对话」即可继续聊天。',
      'hint.noWorkspace': '这个会话还没有关联 .code-workspace 文件。可以直接挑一个：',
      'hint.noFile': '该目录下没有 .code-workspace 文件。',
      'hint.pickFile': '选择一个 .code-workspace 文件：',
      'action.open': '打开工作区文件',
      'action.openOther': '切换文件',
      'action.nativePick': '从资源管理器选择…',
      'hint.noNativePicker': '这台主机打不开系统文件对话框，请用下面的目录浏览器选：',
      'action.create': '新建工作区文件',
      'action.createConfirm': '创建',
      'field.workspaceName.hint': '例如 my-app（自动补 .code-workspace）',
      'action.recent': '最近使用',
      'action.refresh': '刷新',
      'action.reveal': '在资源管理器中显示',
      'action.editor': '在编辑器中打开',
      'label.editors': '在编辑器中打开',
      'hint.noEditor': '未检测到 VS Code 系列编辑器（VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae）。',
      'hint.editorSsh': '该 Harness 是通过 SSH 访问的：浏览器这一端不是主机，无法在主机上打开编辑器。',
      'notice.opened': '已用 {app} 打开：{target}',
      'action.add': '添加文件夹',
      'action.addRoot': '新增文件夹',
      'action.more': '更多操作',
      'action.expand': '展开',
      'action.collapse': '收起',
      'action.remove': '移除',
      'action.rename': '重命名',
      'action.forget': '取消关联',
      'confirm.forget': '从列表里移除这条记录？工作区文件本身不会被删除。',
      'confirm.removeFolder': '从工作区文件里移除「{name}」？其它文件夹不受影响，之后可以重新添加。',
      'confirm.unlink': '取消关联后，本会话不再使用这个工作区文件（文件本身不会被删除）。',
      'action.up': '上移',
      'action.down': '下移',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.confirm': '确定',
      'action.parent': '上级',
      'action.newFolder': '新建文件夹',
      'action.useWorkspace': '打开该工作区',
      'action.copyPath': '复制路径',
      'action.copied': '已复制',
      'action.dragFolder': '拖动排序',
      'action.collapseDetails': '收起详情',
      'action.expandDetails': '展开详情',
      'action.quote': '引用到对话',
      'notice.quoteBusy': '草稿正在发送中，稍后再插入引用。',
      'notice.quoteUnsupported': '这个路径里有无法写进引用的字符，请先改名。',
      'field.folderPath': '文件夹路径（相对或绝对）',
      'field.folderPath.hint': '例如 D:/projects/my-app',
      'field.folderName': '显示名称（可选）',
      'field.folderName.hint': '留空则显示目录名',
      'field.workspaceName': '工作区文件名',
      'label.roots': '工作区文件夹',
      'hint.treeLoading': '加载中…',
      'hint.treeEmpty': '（空目录）',
      'hint.treeTruncated': '条目过多，已截断。',
      'error.tree': '无法读取该目录',
      'hint.treeNoSession': '需要先在对话页的「代码工作区」页签里打开，才能点开文件预览。',
      'label.folderCount': '{count} 个文件夹',
      'label.workspaces': '代码工作区',
      'label.workspaceCount': '{count} 个文件',
      'empty.workspaces': '还没有记录过任何 .code-workspace 文件。用上面的按钮挑一个：',
      'badge.open': '已注册',
      'badge.workspaceFile': '工作区文件',
      'label.file': '工作区文件',
      'label.browse': '浏览目录',
      'badge.primary': '主目录',
      'badge.missing': '不存在',
      'status.loading': '加载中…',
      'status.working': '处理中…',
      'empty.recent': '暂无记录',
      'empty.roots': '该工作区文件里还没有 folders。',
      'label.fileDir': '文件所在目录',
      'label.rootDir': '工作区根目录',
      'label.conflict': '同一主目录的其它工作区文件',
      'hint.conflict': 'DSH 按主目录的规范路径识别工作区，所以下面这些文件与当前文件属于同一个 DSH 工作区。点一个可把本会话切到它。',
      'workspace.registered': '已注册为 DSH 工作区：',
      'warning.parse': '无法解析该工作区文件，请先在编辑器中修复。',
      'error.noWorkspace': '请先选择一个工作区目录。',
      'error.noFile': '没有关联的 .code-workspace 文件。',
      // The shipped "Open In…" control's copy, as a fallback for the cell this
      // bundle takes over: the shipped namespace is read first and normally wins.
      'open.title': '用 {app} 打开',
      'path.appDefault': '{app}（默认）',
      'path.more': '更多打开方式',
      'path.appsError': '无法获取应用列表',
      'path.openError': '打开失败，请重试',
      // The project terminal shortcut on each folder row.
      'action.openTerminal': '在 DSH 终端中打开',
      'action.openTerminalBusy': '正在打开终端…',
      'hint.terminalNoDir': '目录不存在，无法打开终端。',
      'notice.terminalOpened': '已在 DSH 终端中打开「{name}」。',
      'notice.terminalFocused': '已切换到「{name}」的终端。',
      'error.terminalUnavailable': '这个组合没有可用的 DSH 终端。',
      'error.terminalNoSession': '需要先在对话页打开「代码工作区」页签，才能为项目打开终端。',
      'error.terminalLimit': '终端数量已达上限，请先关闭不用的终端（已退出的终端也占配额）。',
      'error.terminalFailed': '终端打开失败：{message}',
      'error.terminalNoTab': '终端打开失败：终端标签没有出现，可能被侧栏设置隐藏了。请再试一次；仍然失败就刷新页面。',
      'error.terminalNotWritable': '终端打开失败：终端已创建，但一直没有进入可输入状态。请关闭该标签后再试。',
      'error.terminalOtherSession': '终端打开失败：终端开到了另一个会话，已关闭。请回到那个会话的「代码工作区」页签再试。',
    }

    var en = {
      label: 'Code Workspace',
      'label.panel': 'Code Workspace',
      'label.hero': 'Code Workspace',
      'title': 'Code Workspace',
      'title.none': 'No .code-workspace file',
      'title.tab': 'Code Workspace',
      'label.monaco': 'VS Code preview',
      'hint.monacoLoading': 'Loading the VS Code editor…',
      'error.monaco': 'The VS Code editor could not load; showing the built-in code preview.',
      'hint.view': 'The workspace is a tab beside Chat / Trajectory / Git; click Chat to go back.',
      'hint.noWorkspace': 'This session has no .code-workspace file yet. Pick one directly:',
      'hint.noFile': 'This directory has no .code-workspace file.',
      'hint.pickFile': 'Pick a .code-workspace file:',
      'action.open': 'Open workspace file',
      'action.openOther': 'Switch file',
      'action.nativePick': 'Choose in Explorer…',
      'hint.noNativePicker': 'This host cannot show a system file dialog — use the browser below:',
      'action.create': 'New workspace file',
      'action.createConfirm': 'Create',
      'field.workspaceName.hint': 'e.g. my-app (adds .code-workspace)',
      'action.recent': 'Recent',
      'action.refresh': 'Refresh',
      'action.reveal': 'Show in file manager',
      'action.editor': 'Open in editor',
      'label.editors': 'Open in editor',
      'hint.noEditor': 'No VS Code family editor was found (VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae).',
      'hint.editorSsh': 'This Harness was reached over SSH: the browser is not on the host, so no editor can be opened there.',
      'notice.opened': 'Opened in {app}: {target}',
      'action.add': 'Add folder',
      'action.addRoot': 'Add root folder',
      'action.more': 'More actions',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'action.remove': 'Remove',
      'action.rename': 'Rename',
      'action.forget': 'Unlink',
      'confirm.forget': 'Remove this record from the list? The workspace file itself is not deleted.',
      'confirm.removeFolder': 'Remove “{name}” from the workspace file? Other folders are unaffected, and you can add it back later.',
      'confirm.unlink': 'The session will stop using this workspace file. The file itself is not deleted.',
      'action.up': 'Move up',
      'action.down': 'Move down',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.confirm': 'OK',
      'action.parent': 'Up',
      'action.newFolder': 'New folder',
      'action.useWorkspace': 'Open this workspace',
      'action.copyPath': 'Copy path',
      'action.copied': 'Copied',
      'action.dragFolder': 'Drag to reorder',
      'action.collapseDetails': 'Collapse details',
      'action.expandDetails': 'Expand details',
      'action.quote': 'Quote in chat',
      'notice.quoteBusy': 'The draft is being sent; try the quote again in a moment.',
      'notice.quoteUnsupported': 'This path holds characters a quote cannot carry; rename it first.',
      'field.folderPath': 'Folder path (relative or absolute)',
      'field.folderPath.hint': 'e.g. D:/projects/my-app',
      'field.folderName': 'Display name (optional)',
      'field.folderName.hint': 'Leave empty to show the directory name',
      'field.workspaceName': 'Workspace file name',
      'label.roots': 'Workspace folders',
      'hint.treeLoading': 'Loading…',
      'hint.treeEmpty': '(empty directory)',
      'hint.treeTruncated': 'Too many entries; the list is truncated.',
      'error.tree': 'Cannot read this directory',
      'hint.treeNoSession': 'Open this page from the Code Workspace tab in the conversation to open file previews.',
      'label.folderCount': '{count} folders',
      'label.workspaces': 'Code workspaces',
      'label.workspaceCount': '{count} files',
      'empty.workspaces': 'No .code-workspace file has been recorded yet. Pick one with the buttons above:',
      'badge.open': 'registered',
      'badge.workspaceFile': 'workspace file',
      'label.file': 'Workspace file',
      'label.browse': 'Browse',
      'badge.primary': 'primary',
      'badge.missing': 'missing',
      'status.loading': 'Loading…',
      'status.working': 'Working…',
      'empty.recent': 'Nothing yet',
      'empty.roots': 'This workspace file has no folders yet.',
      'label.fileDir': 'File lives in',
      'label.rootDir': 'Workspace root',
      'label.conflict': 'Other workspace files naming the same root',
      'hint.conflict': 'DSH identifies a workspace by its root\'s canonical path, so the files below belong to the SAME DSH workspace as the current one. Click one to switch this session to it.',
      'workspace.registered': 'Registered as a DSH workspace:',
      'warning.parse': 'This workspace file cannot be parsed — fix it in your editor first.',
      'error.noWorkspace': 'Select a workspace directory first.',
      'error.noFile': 'No .code-workspace file is associated.',
      // The shipped "Open In…" control's copy, as a fallback for the cell this
      // bundle takes over: the shipped namespace is read first and normally wins.
      'open.title': 'Open in {app}',
      'path.appDefault': '{app} (default)',
      'path.more': 'More ways to open',
      'path.appsError': 'Could not load applications',
      'path.openError': 'Could not open. Try again.',
      // The project terminal shortcut on each folder row.
      'action.openTerminal': 'Open in DSH terminal',
      'action.openTerminalBusy': 'Opening terminal…',
      'hint.terminalNoDir': 'The directory does not exist, so no terminal can be opened.',
      'notice.terminalOpened': 'Opened “{name}” in a DSH terminal.',
      'notice.terminalFocused': 'Focused the “{name}” terminal.',
      'error.terminalUnavailable': 'This composition has no usable DSH terminal.',
      'error.terminalNoSession': 'Open the Code Workspace tab in a conversation before opening a project terminal.',
      'error.terminalLimit': 'The terminal limit is reached; close unused terminals first (exited terminals count too).',
      'error.terminalFailed': 'Could not open the terminal: {message}',
      'error.terminalNoTab': 'Could not open the terminal: the terminal tab did not appear. It may be hidden by your sidebar settings. Try again, and refresh the page if it keeps failing.',
      'error.terminalNotWritable': 'Could not open the terminal: it was created but never became writable. Close that tab and try again.',
      'error.terminalOtherSession': 'Could not open the terminal: it opened in another session and was closed. Open the Code Workspace tab for the right session and try again.',
    }

    // ------------------------------------------------------------------ tokens
    // Only `--dsw-alias-*` semantic tokens, each with an inert fallback, so the
    // panel restyles with every theme without any light/dark branching.

    var TOKEN = {
      // Surfaces. `card` falls back to the layer-2 surface on shells older than
      // the one that introduced `card-fill`, so a card is still distinguishable
      // there; `overlay` is the floating popover's own material.
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
      card: 'var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-2, #ffffff))',
      field: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      skeleton: 'var(--dsw-alias-bg-skeleton, rgba(0,0,0,0.04))',
      // Interaction.
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))',
      pressed: 'var(--dsw-alias-interactive-bg-active, rgba(38,49,72,0.10))',
      hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,0.05))',
      // Lines.
      line: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
      lineStrong: 'var(--dsw-alias-border-l4, rgba(0,0,0,0.16))',
      lineFaint: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.04))',
      border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.10))',
      borderSoft: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.10))',
      // Text.
      label: 'var(--dsw-alias-label-primary, #1a1a1a)',
      labelDim: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      labelFaint: 'var(--dsw-alias-label-tertiary, #6b6b6b)',
      labelCaption: 'var(--dsw-alias-label-caption, #8a8a8a)',
      labelDimmed: 'var(--dsw-alias-label-dimmed, #b8b8b8)',
      onPrimary: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
      // Accents / state.
      primary: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1a1a1a))',
      primaryHover: 'var(--dsw-alias-button-primary-hover, #3a3a3a)',
      accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
      link: 'var(--dsw-alias-link, #4d6bfe)',
      success: 'var(--dsw-alias-state-success-primary, #1f9d55)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      danger: 'var(--dsw-alias-state-error-primary, #d93f3f)',
      // Banner tints. Built from the state token above so the fallback travels
      // with it: a theme that lacks the alias still paints the tint.
      tintError: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93f3f) 8%, transparent)',
      tintWarn: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b7791f) 8%, transparent)',
      tintInfo: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent)',
      tintSuccess: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #1f9d55) 8%, transparent)',
      // Geometry.
      radiusXs: 'var(--dsw-radius-xs, 4px)',
      radiusSm: 'var(--dsw-radius-sm, 8px)',
      radiusMd: 'var(--dsw-radius-md, 12px)',
      radiusLg: 'var(--dsw-radius-lg, 16px)',
      radius: 'var(--dsw-radius-lg, 16px)',
      // Type / effects.
      mono: 'var(--dsw-font-markdown-code-font-family, var(--ds-font-family-code, "SF Mono", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace))',
      focus: 'var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe))',
      shadow: 'var(--dsw-elevation-prominent, 0 0 0 0.5px rgba(0,0,0,0.16), 0 3px 8px rgba(0,0,0,0.04))',
    }

    function apply(ctx) {
      var slots = ctx.slots
      var locale = ctx.locale
      var sessions = ctx.sessions
      var workspaces = ctx.workspaces
      var remote = ctx.remote
      var connection = ctx.connection

      if (locale) {
        ctx.effect(function () {
          return locale.register(NS, { zh: zh, en: en })
        }, 'dsh-code-workspace: client dictionaries')
      }

      var t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : function (key) { return key }

      function h(type, props, children) {
        return React.createElement.apply(null, [type, props].concat(children === undefined ? [] : children))
      }

      // ------------------------------------------------------ VS Code viewer
      // The shipped code preview paints a highlighted <pre>. This registers a
      // higher-priority document renderer for the same extensions, so a code
      // file opened in the right Sidebar previews in a READ-ONLY Monaco editor —
      // the editor VS Code itself runs: syntax highlighting for every bundled
      // language, folding, find, bracket matching, sticky scroll, minimap, and
      // the current-line highlight. Nothing is editable and nothing is saved.
      //
      // The vendored build is fetched lazily on first use from the route the host
      // half serves, so a session that never previews code pays nothing. Any
      // failure (no route, a blocked script, a broken bundle) falls back to a
      // plain text body instead of leaving the pane blank.

      /** Document-renderer id, also the key its `sidebar.right.tab.document` body registers under. */
      var MONACO_ID = 'dsh-code-workspace/monaco'

      /** Extensions used only when the shell does not expose the shipped code list. */
      var MONACO_EXTENSIONS_FALLBACK = [
        'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc',
        'md', 'markdown', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml',
        'toml', 'ini', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'py',
        'rb', 'php', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
        'fs', 'vb', 'swift', 'm', 'mm', 'lua', 'r', 'sql', 'graphql', 'gql', 'proto',
        'cmake', 'gradle', 'vue', 'svelte', 'astro', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl',
        'clj', 'cljs', 'dart', 'groovy', 'julia', 'tex', 'diff', 'patch', 'log', 'txt',
      ]

      var monacoLoad = { promise: null, workerUrl: null }
      var monacoLanguages = null

      /**
       * Fetch one vendored asset as text.
       *
       * The path is document-relative on purpose: it is the same convention the
       * shipped client uses for its own routes (`fetch('open-in-app/apps')`), so
       * it rides the page's normal same-origin transport — the Web server's
       * route in a browser, and the IPC fetch bridge in the desktop shell.
       */
      function assetText(file) {
        var path = 'code-workspace-assets/' + file
        return fetch(path, { credentials: 'same-origin' }).then(function (response) {
          if (!response.ok) throw new Error('GET ' + path + ' -> ' + response.status)
          return response.text()
        })
      }

      /** The app's own style-injection convention: one `<style>` owned by this plugin. */
      function injectMonacoStyle(text) {
        if (typeof document === 'undefined') return
        var style = document.createElement('style')
        style.setAttribute('data-dsh-code-workspace', 'monaco')
        style.textContent = text
        document.head.appendChild(style)
      }

      function installMonacoEnvironment() {
        if (typeof window === 'undefined') return
        var env = window.MonacoEnvironment
        if (!env || typeof env !== 'object') env = {}
        env.globalAPI = true
        if (monacoLoad.workerUrl !== null && typeof env.getWorker !== 'function') {
          var workerUrl = monacoLoad.workerUrl
          env.getWorker = function () { return new Worker(workerUrl) }
        }
        window.MonacoEnvironment = env
      }

      function appendMonacoScript(source) {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
          var script = document.createElement('script')
          script.src = url
          script.async = true
          script.setAttribute('data-dsh-code-workspace', 'monaco')
          script.onload = function () {
            URL.revokeObjectURL(url)
            if (window.monaco) resolve(window.monaco)
            else reject(new Error('monaco global missing after load'))
          }
          script.onerror = function () {
            URL.revokeObjectURL(url)
            reject(new Error('monaco bundle failed to execute'))
          }
          document.head.appendChild(script)
        })
      }

      function loadMonaco() {
        if (monacoLoad.promise !== null) return monacoLoad.promise
        // The stylesheet and the worker are best-effort: a viewer without them
        // still highlights and scrolls, so only the main bundle may fail the load.
        monacoLoad.promise = Promise.allSettled([
          assetText('monaco.css'),
          assetText('monaco.worker.js'),
        ]).then(function (extra) {
          if (extra[0].status === 'fulfilled') injectMonacoStyle(extra[0].value)
          if (extra[1].status === 'fulfilled') {
            monacoLoad.workerUrl = URL.createObjectURL(new Blob([extra[1].value], { type: 'text/javascript' }))
          }
          installMonacoEnvironment()
          return assetText('monaco.js')
        }).then(appendMonacoScript)
        return monacoLoad.promise
      }

      /** Whether the app is in its dark palette (the boot script marks `body`). */
      function isDarkTheme() {
        try {
          if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true
          var scheme = getComputedStyle(document.documentElement).colorScheme || ''
          if (scheme.indexOf('dark') >= 0) return true
        } catch (error) {
          /* no DOM: the light palette is the safe answer */
        }
        return false
      }

      /** The first painted background around `node`, so the editor blends into its pane. */
      function sampleBackground(node) {
        try {
          var element = node
          while (element && element.nodeType === 1) {
            var color = getComputedStyle(element).backgroundColor
            if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
            element = element.parentElement
          }
        } catch (error) {
          /* ignore */
        }
        return null
      }

      /** The app's configured code font, or a VS Code-like monospace stack. */
      function codeFontFamily() {
        try {
          var value = getComputedStyle(document.body).getPropertyValue('--dsh-font-family-code')
          if (value && value.trim() !== '') return value.trim()
        } catch (error) {
          /* ignore */
        }
        return "'SF Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', 'Courier New', monospace"
      }

      /** The lower-cased extension of a file address, without the dot. */
      function extensionOf(address) {
        var name = String(address)
        var slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
        name = name.slice(slash + 1)
        var dot = name.lastIndexOf('.')
        if (dot < 0) return ''
        try {
          return decodeURIComponent(name.slice(dot + 1)).toLowerCase()
        } catch (error) {
          return name.slice(dot + 1).toLowerCase()
        }
      }

      /** Monaco's registered language id for a file address, `plaintext` when unknown. */
      function monacoLanguageFor(address) {
        try {
          var monaco = window.monaco
          if (!monaco || !monaco.languages) return 'plaintext'
          if (monacoLanguages === null) {
            monacoLanguages = {}
            var registered = monaco.languages.getLanguages()
            for (var i = 0; i < registered.length; i += 1) {
              var extensions = registered[i].extensions || []
              for (var j = 0; j < extensions.length; j += 1) {
                var key = String(extensions[j]).replace(/^\./, '').toLowerCase()
                if (key !== '' && !Object.prototype.hasOwnProperty.call(monacoLanguages, key)) {
                  monacoLanguages[key] = registered[i].id
                }
              }
            }
          }
          var extension = extensionOf(address)
          if (extension === '') return 'plaintext'
          return monacoLanguages[extension] || 'plaintext'
        } catch (error) {
          return 'plaintext'
        }
      }

      function MonacoCodeBody(props) {
        var containerRef = React.useRef(null)
        var editorRef = React.useRef(null)
        var modelRef = React.useRef(null)
        var latest = React.useRef(null)
        var failedState = React.useState(false)
        var failed = failedState[0]
        var setFailed = failedState[1]

        var content = props.content
        var text = content && content.kind === 'text' ? content.text : ''
        var wrap = props.wrap === true
        var address = props.resourceAddress
        latest.current = { text: text, wrap: wrap, address: address }

        React.useEffect(function () {
          var container = containerRef.current
          if (container === null) return
          var disposed = false
          var editor = null
          var model = null
          var observer = null
          var media = null

          function refreshTheme() {
            if (disposed || editor === null || !window.monaco) return
            try {
              var dark = isDarkTheme()
              var id = 'dsh-code-workspace-' + (dark ? 'dark' : 'light')
              var colors = {}
              var background = sampleBackground(container)
              if (background !== null) colors['editor.background'] = background
              window.monaco.editor.defineTheme(id, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: colors })
              window.monaco.editor.setTheme(id)
            } catch (error) {
              /* the previous theme stays */
            }
          }

          loadMonaco().then(function (monaco) {
            if (disposed || containerRef.current === null) return
            var state = latest.current
            container.innerHTML = ''
            model = monaco.editor.createModel(state.text, monacoLanguageFor(state.address))
            modelRef.current = model
            editor = monaco.editor.create(container, {
              model: model,
              readOnly: true,
              domReadOnly: true,
              automaticLayout: true,
              minimap: { enabled: container.clientWidth >= 640, renderCharacters: false },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'line',
              folding: true,
              lineNumbers: 'on',
              wordWrap: state.wrap ? 'on' : 'off',
              fontFamily: codeFontFamily(),
              fontSize: 13,
              lineHeight: 20,
              padding: { top: 8, bottom: 8 },
              glyphMargin: false,
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
              contextmenu: true,
              fixedOverflowWidgets: true,
              stickyScroll: { enabled: true },
            })
            editorRef.current = editor
            refreshTheme()
            if (typeof MutationObserver === 'function') {
              observer = new MutationObserver(refreshTheme)
              observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
              observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
            }
            if (typeof matchMedia === 'function') {
              media = matchMedia('(prefers-color-scheme: dark)')
              if (typeof media.addEventListener === 'function') media.addEventListener('change', refreshTheme)
            }
          }).catch(function () {
            if (!disposed) setFailed(true)
          })

          return function () {
            disposed = true
            if (observer !== null) observer.disconnect()
            if (media !== null && typeof media.removeEventListener === 'function') media.removeEventListener('change', refreshTheme)
            if (editor !== null) {
              try { editor.dispose() } catch (error) { /* already gone */ }
            }
            if (model !== null) {
              try { model.dispose() } catch (error) { /* already gone */ }
            }
            editorRef.current = null
            modelRef.current = null
          }
        }, [])

        // The document owner accumulates text pages until eof; push the latest
        // text into the model, keeping the scroll position a reader had.
        React.useEffect(function () {
          var model = modelRef.current
          if (model === null) return
          var value = latest.current.text
          try {
            if (model.getValue() === value) return
            var top = editorRef.current === null ? 0 : editorRef.current.getScrollTop()
            model.setValue(value)
            if (editorRef.current !== null) editorRef.current.setScrollTop(top)
          } catch (error) {
            /* the model was disposed with its editor */
          }
        }, [text])

        React.useEffect(function () {
          var model = modelRef.current
          if (model === null || !window.monaco) return
          try {
            window.monaco.editor.setModelLanguage(model, monacoLanguageFor(address))
          } catch (error) {
            /* disposed */
          }
        }, [address])

        React.useEffect(function () {
          if (editorRef.current === null) return
          try {
            editorRef.current.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
          } catch (error) {
            /* disposed */
          }
        }, [wrap])

        if (failed) {
          return h('pre', {
            className: 'dsh-code-workspace-monaco-fallback',
            style: { margin: 0, padding: '16px', height: '100%', overflow: 'auto', fontFamily: codeFontFamily(), fontSize: '12px', whiteSpace: 'pre' },
          }, text)
        }
        if (content && content.kind !== 'text') return null
        return h('div', {
          className: 'dsh-code-workspace-monaco',
          style: { display: 'flex', flex: '1 1 auto', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' },
        }, [
          h('div', { key: 'editor', ref: containerRef, style: { flex: '1 1 auto', minHeight: 0 } }),
        ])
      }

      /**
       * Register the Monaco renderer and its body. Both ride the document
       * preview seam: the definition selects the extensions, and the keyed
       * `sidebar.right.tab.document` body draws the file. Without the document
       * preview plugin there is nothing to extend, so the shipped preview stays.
       */
      function registerMonacoPreview() {
        if (typeof ctx.inject !== 'function') return
        ctx.inject(['documentPreviews'], function (scope) {
          var previews = scope && scope.documentPreviews
          if (!previews || typeof previews.register !== 'function') return
          var extensions = null
          try {
            if (primitives && Array.isArray(primitives.CODE_HIGHLIGHT_EXTENSIONS) && primitives.CODE_HIGHLIGHT_EXTENSIONS.length > 0) {
              extensions = primitives.CODE_HIGHLIGHT_EXTENSIONS.slice()
            }
          } catch (error) {
            extensions = null
          }
          if (extensions === null) extensions = MONACO_EXTENSIONS_FALLBACK.slice()

          var register = function () {
            return previews.register({
              id: MONACO_ID,
              extensions: extensions,
              priority: 'extension',
              title: function () { return t('label.monaco') },
              loading: 'text-pages',
              wrap: true,
              sourceLines: false,
            })
          }
          if (typeof scope.effect === 'function') scope.effect(register, 'dsh-code-workspace: monaco code preview')
          else if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-code-workspace: monaco code preview')

          try {
            slots.inject('sidebar.right.tab.document', function () {
              return slots.register({ name: 'sidebar.right.tab.document', key: MONACO_ID, locale: NS }, MonacoCodeBody)
            })
          } catch (error) {
            if (typeof console !== 'undefined') console.warn('[dsh-code-workspace] cannot register the Monaco document body', error)
          }
        })
      }

      registerMonacoPreview()

      // --------------------------------------------------------- store
      // One module-level snapshot shared by every surface. Components subscribe
      // to the whole snapshot (its reference changes only on a real patch), which
      // keeps `useSyncExternalStore` from looping on a fresh selector result.

      var listeners = []
      /** When the recorded-file list was last read, for {@link loadRecent}'s window. */
      var recentReadAt = 0
      var state = {
        open: false,
        anchor: null,
        mode: 'session',
        sessionId: null,
        rootDir: null,
        snapshot: null,
        recent: [],
        showRecent: false,
        showBrowse: false,
        browse: null,
        addPath: '',
        addName: '',
        newName: '',
        /** The inline "new workspace file" form: open, and the name typed into it. */
        creating: false,
        createName: '',
        /**
         * The identity card's details (paths, actions, pickers) folded away.
         *
         * Opening a file preview means the user is reading, not managing: the
         * paths and the action row above the tree then cost height for nothing,
         * so a preview collapses them. The card keeps its title row and the folder
         * tree, and the chevron in that row brings the details back.
         */
        compact: false,
        renameIndex: -1,
        renameValue: '',
        /** The open folder context menu: `{ x, y, index }`, or null. Store-held so a row can open it. */
        menu: null,
        busy: false,
        error: null,
        notice: null,
        /** What `notice` means: a completed action is `success`, a hint is `info`. */
        noticeTone: 'info',
        editors: null,
        editorsSsh: false,
        /** Project keys whose terminal is being opened right now, so a click cannot double-open. */
        shellOpening: {},
      }

      function subscribe(fn) {
        listeners.push(fn)
        return function () {
          var i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
        }
      }

      function getSnapshot() {
        return state
      }

      /**
       * The DSH workspaces this app already has, keyed by the spelling identity
       * used to join them with the plugin's own recorded files.
       *
       * Synchronous and cached: the workspace list is a local snapshot store, so
       * this is a read rather than a request, and a cached answer keeps the render
       * path free of a state write (an asynchronous "load then setState" would
       * also lose the marks in any host that cannot re-render for that write).
       * With no workspace service the list simply has no "already registered"
       * marks, which is the honest answer rather than an empty one.
       */
      var openWorkspacesCache = null
      var openWorkspacesSnapshot = null
      function readOpenWorkspaces() {
        var list = workspaces && workspaces.list
        if (!list || typeof list.getSnapshot !== 'function') return {}
        try {
          var snapshot = list.getSnapshot()
          // The cache is keyed by the snapshot REFERENCE, not by the plugin's
          // life: a workspace registered or removed elsewhere changes that
          // reference, and the WorkspaceList subscription re-renders so this
          // re-reads. The old cache-for-life left the "registered" marks stale.
          if (openWorkspacesCache !== null && openWorkspacesSnapshot === snapshot) return openWorkspacesCache
          var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          var out = {}
          for (var i = 0; i < items.length; i += 1) {
            var path = items[i] && items[i].path
            if (typeof path === 'string' && path !== '') out[pathKey(path)] = path
          }
          openWorkspacesCache = out
          openWorkspacesSnapshot = snapshot
          return out
        } catch (error) {
          return {}
        }
      }

      /**
       * Switch to a DSH workspace the plugin has no `.code-workspace` file for.
       *
       * `openWorkspace` is the documented "connect a workspace and open its
       * session" face; without it there is nothing to navigate with, so the row
       * does nothing rather than lying.
       */
      function openWorkspaceDirectory(path) {
        var nav = ctx.get('uiWorkspace')
        if (!nav || typeof nav.openWorkspace !== 'function') return
        var list = workspaces && workspaces.list
        var items = list && typeof list.getSnapshot === 'function' ? (list.getSnapshot().items || []) : []
        for (var i = 0; i < items.length; i += 1) {
          if (pathKey(items[i] && items[i].path) === pathKey(path) && items[i].id) {
            Promise.resolve(nav.openWorkspace(items[i].id)).catch(function () {})
            return
          }
        }
      }

      function patch(next) {
        var changed = false
        for (var key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key) && state[key] !== next[key]) {
            changed = true
            break
          }
        }
        if (!changed) return
        var copy = {}
        for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) copy[k] = state[k]
        for (var k2 in next) if (Object.prototype.hasOwnProperty.call(next, k2)) copy[k2] = next[k2]
        state = copy
        for (var i = 0; i < listeners.length; i += 1) {
          try {
            listeners[i]()
          } catch (e) {
            /* a listener failure must never break the others */
          }
        }
      }

      function useSnapshot() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        }
        // Very old React without the hook: a coarse subscription keeps the
        // panel working, it just re-renders a little more than needed.
        var pair = React.useState(0)
        var bump = pair[1]
        React.useEffect(function () {
          return subscribe(function () { bump(function (n) { return n + 1 }) })
        }, [])
        return getSnapshot()
      }

      // ------------------------------------------------------- transport

      function rpc(endpoint, args, signal) {
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('code-workspace: the shared RPC channel is unavailable'))
        }
        return connection.rpc.call('/api', endpoint, { args: args || {} }, signal).then(
          function (envelope) {
            if (!envelope || envelope.ok !== true) {
              var failure = envelope && envelope.error !== undefined ? envelope.error : undefined
              var message = failure && failure.message !== undefined ? String(failure.message) : 'remote call failed'
              throw new Error(message.replace(/^code-workspace:\s*/, ''))
            }
            return envelope.value
          },
        )
      }

      function call(endpoint, args) {
        return rpc('codeWorkspace/' + endpoint, args)
      }

      function parseJsonLine(text) {
        if (typeof text !== 'string') return null
        var match = /\[CWS:JSON\]\s*(\{[\s\S]*\})\s*$/.exec(text)
        if (!match) return null
        try {
          return JSON.parse(match[1])
        } catch (e) {
          return null
        }
      }

      /** Run `/code-workspace <line>` and return the structured state it carries. */
      function runCommand(sessionId, line) {
        if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') {
          return Promise.reject(new Error('code-workspace: the command channel is unavailable'))
        }
        return remote.commands.execute(sessionId, '/code-workspace ' + line, []).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            throw new Error('code-workspace: remote call failed')
          }
          var execution = envelope.value
          if (execution === undefined || execution === null) {
            throw new Error('code-workspace: the host plugin is not loaded')
          }
          var result = execution.result
          if (!result) throw new Error('code-workspace: the command returned no result')
          if (result.kind === 'error') throw new Error(String(result.text || 'command failed').replace(/^code-workspace:\s*/, ''))
          return parseJsonLine(result.text)
        })
      }

      // -------------------------------------------------- panel operations

      function refresh() {
        var snapshot = state
        if (!snapshot.rootDir) {
          patch({ snapshot: null, error: null })
          return Promise.resolve()
        }
        patch({ busy: true, error: null })
        var load
        if (snapshot.mode === 'session' && snapshot.sessionId) {
          load = runCommand(snapshot.sessionId, 'list')
        } else {
          load = call('state', { rootDir: snapshot.rootDir })
        }
        return load.then(
          function (value) {
            if (state.rootDir !== snapshot.rootDir) return
            patch({ snapshot: value, busy: false })
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      /**
       * Read the recorded workspace files.
       *
       * `force` is for a deliberate refresh (the ⟳ button, a change the user just
       * made); without it a read inside the window is skipped, because every
       * surface can ask for this and answering each request with a round trip
       * would turn a few renders into a burst of calls. The window matches the
       * host-side model TTL, past which a read is not the freshest answer anyway.
       */
      function loadRecent(force) {
        if (force !== true && Date.now() - recentReadAt < MODEL_TTL_MS) return Promise.resolve(state.recent)
        recentReadAt = Date.now()
        return call('recent', {}).then(
          function (value) {
            patch({ recent: value && Array.isArray(value.files) ? value.files : [] })
          },
          function () {
            patch({ recent: [] })
          },
        )
      }

      function mutate(line, endpoint, args) {
        var snapshot = state
        if (!snapshot.rootDir) {
          patch({ error: t('error.noWorkspace') })
          return Promise.resolve()
        }
        patch({ busy: true, error: null, notice: null, noticeTone: 'info' })
        var action
        if (snapshot.mode === 'session' && snapshot.sessionId) {
          action = runCommand(snapshot.sessionId, line)
        } else {
          action = call(endpoint, Object.assign({ rootDir: snapshot.rootDir }, args))
        }
        return action.then(
          function (value) {
            patch({ busy: false, error: null })
            return refresh().then(function () {
              if (value && value.state !== undefined) patch({ snapshot: value.state })
            })
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
            // Read back so the UI shows the host's real state after a failure.
            return refresh()
          },
        )
      }

      /**
       * Open the panel.
       * @param anchor - the surface that opened it (`header` | `hero`).
       * @param rootDir - the workspace directory the panel addresses.
       * @param sessionId - the addressed session, when there is one.
       * @param mode - `session` drives the `/code-workspace` command so the
       *   conversation shows the change and the agent is notified at its next
       *   message boundary; `workspace` uses the sessionless channel, which is
       *   the only one available before any session exists. The hero-phase chip
       *   is the session-creation page, so it always opens in `workspace` mode
       *   even though the shell already has a blank session bound to it.
       */
      function openPanel(anchor, rootDir, sessionId, mode) {
        var dir = rootDir || state.rootDir || null
        patch({
          open: true,
          anchor: anchor,
          rootDir: dir,
          sessionId: sessionId || null,
          mode: mode || (sessionId ? 'session' : 'workspace'),
          showBrowse: false,
          showRecent: false,
          browse: null,
          error: null,
          notice: null,
          noticeTone: 'info',
        })
        if (dir) refresh()
        loadRecent(true)
        loadEditors()
      }

      function closePanel() {
        patch({ open: false, anchor: null, showBrowse: false, showRecent: false, browse: null })
      }

      function messageOf(error) {
        var text = error && error.message !== undefined ? String(error.message) : String(error)
        return text.replace(/^code-workspace:\s*/, '')
      }

      /**
       * Open one `.code-workspace` file, register its ROOT, and enter it.
       *
       * Inside a session this rides the command channel even though the
       * sessionless one could serve it: the host must attribute the choice to
       * the session that made it, because two sessions can be rooted at the
       * same directory and each may want a different workspace file. Before any
       * session exists (the creation page) the sessionless channel is the only
       * one there is, and there the choice pins the root for whoever comes next.
       */
      function openFile(file) {
        patch({ busy: true, error: null, notice: null, noticeTone: 'info' })
        var action =
          state.mode === 'session' && state.sessionId
            ? runCommand(state.sessionId, 'use "' + String(file) + '"')
            : call('open', { file: file })
        return action.then(
          function (value) {
            patch({
              busy: false,
              showBrowse: false,
              showRecent: false,
              rootDir: value && value.rootDir ? value.rootDir : state.rootDir,
              mode: 'workspace',
              snapshot: value,
            })
            return enterWorkspace(value)
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      /**
       * Select the freshly registered DSH workspace and open its session, when
       * the client composition exposes the navigation service. Its absence is a
       * soft failure: the workspace is registered either way, the user just
       * picks it in the workspace picker themselves.
       */
      function enterWorkspace(value) {
        var workspace = value && value.workspace
        if (!workspace || !workspace.id) return Promise.resolve()
        var nav = ctx.get('uiWorkspace')
        if (!nav || typeof nav.openWorkspace !== 'function') {
          patch({ notice: t('workspace.registered') + ' ' + String(workspace.path || ''), noticeTone: 'success' })
          return Promise.resolve()
        }
        return Promise.resolve(nav.openWorkspace(workspace.id)).catch(function (error) {
          patch({ notice: t('workspace.registered') + ' ' + String(workspace.path || ''), error: messageOf(error), noticeTone: 'success' })
        })
      }

      /**
       * Where a workspace-file browser starts when nothing is associated yet.
       *
       * The panel is no longer only a detail view of the session's own
       * directory: with no `.code-workspace` file to show, opening one IS the
       * task, and a session directory somewhere under a repository is the worst
       * place to start looking. So that flow starts at the host's home — the
       * closest thing to "somewhere to browse from" that a host can name — and
       * falls back to the session directory when the host does not publish one.
       */
      function browseStart() {
        var home = remote && remote.$host ? remote.$host.home : undefined
        return home || state.rootDir || ''
      }

      /**
       * Where a "pick another `.code-workspace` file" flow starts.
       *
       * The file's own directory wins whenever the panel knows it: users who
       * keep their workspace files together in one folder (which is exactly the
       * layout that used to break this plugin) would otherwise have to navigate
       * back there from the session root on every switch. The session root is
       * the next-best answer, and the host home the last.
       */
      function fileBrowseStart() {
        var current = state.snapshot
        var fileDir = current && typeof current.fileDir === 'string' ? current.fileDir : ''
        return fileDir || state.rootDir || browseStart()
      }

      function browseTo(path) {
        patch({ busy: true, error: null })
        return call('browse', { path: path || '' }).then(
          function (value) {
            patch({ busy: false, browse: value, showBrowse: true })
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      function reveal(path) {
        return call('reveal', { path: path }).catch(function (error) {
          patch({ error: messageOf(error) })
        })
      }

      /**
       * The host's VS Code family, read once per panel open. Read-only, so it
       * rides the sessionless channel in both modes.
       */
      function loadEditors() {
        return call('editors', {}).then(
          function (value) {
            patch({
              editors: value && Array.isArray(value.editors) ? value.editors : [],
              editorsSsh: value && value.ssh === true,
            })
          },
          function () {
            patch({ editors: [], editorsSsh: false })
          },
        )
      }

      /**
       * Open the addressed workspace in one family editor.
       *
       * The host picks the target, not this half: with a `.code-workspace` file
       * associated it launches `<editor> <file.code-workspace>`, which is what
       * makes the editor's window show this session's folders; without one it
       * opens the root itself. Either way the answer states which was used, and
       * the panel says so.
       */
      function openInEditor(editorId) {
        var dir = state.rootDir
        if (!dir) {
          patch({ error: t('error.noWorkspace') })
          return Promise.resolve()
        }
        patch({ busy: true, error: null, notice: null, noticeTone: 'info' })
        // The session id travels along because this endpoint is on the
        // sessionless channel: the host would otherwise have to guess which of
        // several files naming this root the session is actually on. It is
        // omitted (not sent as undefined) when there is no session.
        var args = { rootDir: dir, editorId: editorId }
        if (state.sessionId) args.sessionId = state.sessionId
        return call('openInEditor', args).then(
          function (value) {
            var result = value || {}
            patch({
              busy: false,
              notice: t('notice.opened', { app: result.label || String(editorId), target: result.target || dir }),
              noticeTone: 'success',
            })
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      function makeDir() {
        var browse = state.browse
        if (!browse) return Promise.resolve()
        var name = window.prompt(t('action.newFolder'))
        if (!name) return Promise.resolve()
        return call('makeDir', { parent: browse.path, name: name }).then(
          function () {
            return browseTo(browse.path)
          },
          function (error) {
            patch({ error: messageOf(error) })
          },
        )
      }

      // ------------------------------------------------------- components
      // The page is drawn with `h(...)` plus inline styles — no primitives, no
      // build step. Inline styles cannot express `:hover` / `:focus-visible`, so
      // each interactive atom owns its hover/pressed/focus state locally; the
      // geometry is literal (the design spec's px values) and every colour is a
      // `--dsw-*` alias with an inert fallback.

      /** One `color-mix` tint of a token at `percent` opacity. */
      function tint(color, percent) {
        return 'color-mix(in srgb, ' + color + ' ' + percent + '%, transparent)'
      }

      /** The one focus ring, drawn only for a keyboard focus. */
      var focusRing = { outline: TOKEN.focus, outlineOffset: -2 }

      /**
       * Hover / pressed / focus state for one control.
       *
       * `focus` turns true only when the browser reports `:focus-visible`, so a
       * mouse click never paints the ring while Tab does.
       */
      function useInteractive() {
        var hoverPair = React.useState(false)
        var pressPair = React.useState(false)
        var focusPair = React.useState(false)
        return {
          hover: hoverPair[0],
          pressed: pressPair[0],
          focus: focusPair[0],
          handlers: {
            onMouseEnter: function () { hoverPair[1](true) },
            onMouseLeave: function () { hoverPair[1](false); pressPair[1](false) },
            onMouseDown: function () { pressPair[1](true) },
            onMouseUp: function () { pressPair[1](false) },
            onFocus: function (event) {
              var target = event && event.currentTarget
              focusPair[1](Boolean(target && typeof target.matches === 'function' && target.matches(':focus-visible')))
            },
            onBlur: function () { focusPair[1](false) },
          },
        }
      }

      /** Hover only, for a row: a surface that reacts but is not a control. */
      function useHover() {
        var pair = React.useState(false)
        return {
          hovered: pair[0],
          handlers: {
            onMouseEnter: function () { pair[1](true) },
            onMouseLeave: function () { pair[1](false) },
          },
        }
      }

      /**
       * One text button.
       *
       * `primary` is the single solid button of a view, `outline` the secondary
       * one, `ghost` (the default) the tertiary one. `danger` restyles the text
       * only — this page never draws a solid danger button. A disabled button
       * drops its `onClick` entirely, so the native `disabled` is the whole story.
       */
      function Button(props) {
        var state = useInteractive()
        var disabled = props.disabled === true
        var variant = props.variant || 'ghost'
        var danger = props.danger === true
        var color = danger ? TOKEN.danger : TOKEN.label
        var background = 'transparent'
        var border = '0.5px solid transparent'
        if (variant === 'primary') {
          color = TOKEN.onPrimary
          background = disabled || !state.hover ? TOKEN.primary : TOKEN.primaryHover
        } else if (variant === 'outline') {
          border = '0.5px solid ' + TOKEN.lineStrong
          if (!disabled && state.hover) background = TOKEN.hover
        } else if (!disabled) {
          if (state.pressed) background = TOKEN.pressed
          else if (state.hover) background = danger ? TOKEN.hoverDanger : TOKEN.hover
        }
        var style = Object.assign(
          {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            height: 28,
            padding: '0 10px',
            boxSizing: 'border-box',
            fontSize: 12,
            lineHeight: '18px',
            fontWeight: 400,
            whiteSpace: 'nowrap',
            borderRadius: TOKEN.radiusSm,
            color: color,
            background: background,
            border: border,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
          },
          state.focus && !disabled ? focusRing : null,
          props.style || {},
        )
        return h(
          'button',
          Object.assign(
            {
              type: 'button',
              title: props.title || undefined,
              'aria-label': props.ariaLabel || undefined,
              'aria-pressed': props.ariaPressed === undefined ? undefined : props.ariaPressed,
              disabled: disabled,
              onClick: disabled ? undefined : props.onClick,
            },
            state.handlers,
            { style: style },
          ),
          [props.children],
        )
      }

      /**
       * One icon-only control: 28×28, or 24×24 for the weak inline actions.
       *
       * `title` doubles as the accessible name, and the glyph is a text
       * character (or an inline SVG) so no icon dependency is introduced. The
       * terminal prompt `>_` is wrapped in a mono span by its caller.
       */
      function IconButton(props) {
        var state = useInteractive()
        var disabled = props.disabled === true
        var size = props.small === true ? 24 : 28
        var danger = props.danger === true
        var color = danger ? TOKEN.danger : state.hover ? TOKEN.label : TOKEN.labelDim
        var background = 'transparent'
        if (!disabled) {
          if (state.pressed) background = TOKEN.pressed
          else if (state.hover) background = danger ? TOKEN.hoverDanger : TOKEN.hover
        }
        var style = Object.assign(
          {
            width: size,
            height: size,
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            flex: 'none',
            border: 'none',
            borderRadius: TOKEN.radiusSm,
            background: background,
            color: color,
            fontSize: 13,
            lineHeight: 1,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
          },
          state.focus && !disabled ? focusRing : null,
          props.style || {},
        )
        return h(
          'button',
          Object.assign(
            {
              type: 'button',
              title: props.title || undefined,
              'aria-label': props.title || props.ariaLabel || undefined,
              disabled: disabled,
              onClick: disabled ? undefined : props.onClick,
            },
            state.handlers,
            { style: style },
          ),
          [props.children],
        )
      }

      /**
       * One pill tag, in five tones (the shipped `Tag` geometry: 11/17, 500).
       *
       * `warn` is accepted as the legacy spelling of `warning`; nothing renders
       * it any more, it just keeps an old call site honest.
       */
      function Badge(props) {
        var tone = props.tone || 'neutral'
        var color = TOKEN.labelDim
        var background = 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.08))'
        var border = '0.5px solid transparent'
        if (tone === 'info') {
          color = TOKEN.accent
          background = tint(TOKEN.accent, 10)
        } else if (tone === 'success') {
          color = TOKEN.success
          background = tint(TOKEN.success, 10)
        } else if (tone === 'warning' || tone === 'warn') {
          color = TOKEN.warn
          background = tint(TOKEN.warn, 12)
        } else if (tone === 'outline') {
          color = TOKEN.labelFaint
          background = 'transparent'
          border = '0.5px solid ' + TOKEN.lineStrong
        }
        return h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: 999,
              padding: '1px 8px',
              fontSize: 11,
              lineHeight: '17px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              color: color,
              background: background,
              border: border,
            },
          },
          [props.children],
        )
      }

      /**
       * One text field: 32px tall, 12px corner, accent border while focused.
       *
       * `dataField` is the test-facing `data-field` hook; `ariaLabel` names the
       * field for a screen reader, because the visible label is a sibling `div`
       * rather than a `<label for>`.
       */
      function TextInput(props) {
        var focusPair = React.useState(false)
        var focused = focusPair[0]
        var attrs = {
          type: 'text',
          value: props.value,
          placeholder: props.placeholder,
          spellCheck: false,
          disabled: props.disabled === true,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && props.onEnter) props.onEnter()
          },
          onFocus: function () { focusPair[1](true) },
          onBlur: function () { focusPair[1](false) },
          style: Object.assign(
            {
              flex: 1,
              minWidth: 0,
              boxSizing: 'border-box',
              height: 32,
              padding: '0 8px',
              fontSize: 14,
              lineHeight: '22px',
              color: TOKEN.label,
              background: TOKEN.field,
              border: '0.5px solid ' + (focused ? TOKEN.accent : TOKEN.lineStrong),
              borderRadius: TOKEN.radiusMd,
              outline: 'none',
            },
            props.style || {},
          ),
        }
        if (props.dataField !== undefined) attrs['data-field'] = props.dataField
        if (props.ariaLabel !== undefined) attrs['aria-label'] = props.ariaLabel
        return h('input', attrs)
      }

      // ------------------------------------------------------------ layout atoms

      /**
       * A section title: 32px line, an `h2`, an optional count and one action.
       *
       * The row may wrap instead of clipping: the manager page puts its whole
       * action group here, and a narrow window must be able to drop it to a second
       * line rather than run it off the card. `minHeight` (not `height`) keeps the
       * usual 28px line without forbidding that second line.
       */
      function SectionHeader(props) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              rowGap: 6,
              flexWrap: 'wrap',
              minHeight: 28,
              marginBottom: 6,
            },
          },
          [
            h('h2', { key: 'title', style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 500, color: TOKEN.label } }, [props.title]),
            props.count === undefined || props.count === null
              ? null
              : h('span', { key: 'count', style: { marginLeft: 2, fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint } }, [String(props.count)]),
            h('div', { key: 'spacer', style: { flex: 1 } }),
            props.action || null,
          ],
        )
      }

      /** One card surface: the only container that draws a material. */
      function Card(props) {
        return h(
          'div',
          {
            style: Object.assign(
              {
                background: TOKEN.card,
                border: '0.5px solid ' + TOKEN.lineStrong,
                borderRadius: TOKEN.radiusMd,
                boxSizing: 'border-box',
                padding: props.padding === undefined ? 16 : props.padding,
              },
              props.style || {},
            ),
          },
          props.children,
        )
      }

      /**
       * One state banner: a colour dot, the message, and an optional dismiss.
       *
       * The dot IS the state icon (the same shape language as the shell's own
       * state dots), so no icon dependency is introduced. `error` / `warning`
       * announce as `alert`, `info` / `success` as `status`.
       */
      function Banner(props) {
        var tone = props.tone || 'info'
        var color = tone === 'error' ? TOKEN.danger : tone === 'warning' ? TOKEN.warn : tone === 'success' ? TOKEN.success : TOKEN.accent
        var text = tone === 'error' ? TOKEN.danger : tone === 'warning' ? TOKEN.warn : TOKEN.label
        var surface = tone === 'error' ? TOKEN.tintError : tone === 'warning' ? TOKEN.tintWarn : tone === 'success' ? TOKEN.tintSuccess : TOKEN.tintInfo
        return h(
          'div',
          {
            role: tone === 'error' || tone === 'warning' ? 'alert' : 'status',
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 8px 8px 12px',
              borderRadius: TOKEN.radiusSm,
              boxSizing: 'border-box',
              border: '0.5px solid ' + tint(color, 30),
              background: surface,
              fontSize: 12,
              lineHeight: '18px',
            },
          },
          [
            h('span', { key: 'dot', style: { width: 8, height: 8, borderRadius: 999, background: color, flex: 'none', marginTop: 5 } }),
            h('div', { key: 'text', style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: text } }, [props.children]),
            props.dismissible === true
              ? h(IconButton, { key: 'close', small: true, title: t('action.close'), onClick: props.onDismiss }, ['✕'])
              : null,
          ],
        )
      }

      /** A card-content empty state: a heading, one explanation, one next step. */
      function EmptyState(props) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 24 } }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: TOKEN.label } }, [props.title]),
          h('div', { key: 'body', style: { fontSize: 13, lineHeight: '20px', color: TOKEN.labelDim } }, [props.body]),
          props.actions ? h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } }, props.actions) : null,
        ])
      }

      /**
       * The 1.2s "copied" acknowledgement behind {@link CopyPath}.
       *
       * Clipboard absence is a silent no-op on purpose: a browser that refuses
       * the API must never break the render, so the button simply does nothing.
       * The acknowledgement is reset by a timer held in a ref (no effect): a
       * copy has no cleanup to run, and a late `setState` on an unmounted button
       * is a no-op.
       */
      function useCopyText() {
        var pair = React.useState(false)
        var copied = pair[0]
        var setCopied = pair[1]
        var timerRef = React.useRef(null)
        function copy(text) {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return
          try {
            var written = navigator.clipboard.writeText(String(text === undefined || text === null ? '' : text))
            if (written && typeof written.then === 'function') written.then(function () { setCopied(true) }, function () {})
            else setCopied(true)
            if (timerRef && timerRef.current !== null && typeof clearTimeout === 'function') clearTimeout(timerRef.current)
            if (timerRef) timerRef.current = setTimeout(function () { setCopied(false) }, 1200)
          } catch (error) {
            /* a browser that refuses the clipboard simply copies nothing */
          }
        }
        return { copied: copied, copy: copy }
      }

      /** The copy affordance after a path value. */
      function CopyPath(props) {
        var state = useCopyText()
        return h(
          IconButton,
          {
            small: true,
            title: state.copied ? t('action.copied') : t('action.copyPath'),
            onClick: function () { state.copy(props.text) },
          },
          [state.copied ? '✓' : '⧉'],
        )
      }

      /** A 16px folder outline, drawn here so no icon name has to exist upstream. */
      function FolderGlyph() {
        return h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
          [
            h('path', {
              key: 'folder',
              d: 'M1.75 3.25h4.1l1.4 1.6h7v7.9h-12.5z',
              stroke: 'currentColor',
              strokeWidth: '1.2',
              strokeLinejoin: 'round',
            }),
          ],
        )
      }

      /**
       * A 16px document outline, the folder glyph's counterpart in the file tree.
       *
       * Without it a tree row was a caret and a word, so a directory and a file
       * read as the same kind of thing and the nesting had nothing to hang on.
       */
      function FileGlyph() {
        return h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
          [
            h('path', {
              key: 'sheet',
              d: 'M4 1.75h5l3.25 3.25v9.25H4z',
              stroke: 'currentColor',
              strokeWidth: '1.2',
              strokeLinejoin: 'round',
            }),
            h('path', {
              key: 'fold',
              d: 'M9 1.75V5h3.25',
              stroke: 'currentColor',
              strokeWidth: '1.2',
              strokeLinejoin: 'round',
            }),
          ],
        )
      }

      /**
       * The glyph for one file in the tree: the platform's file-type artwork.
       *
       * `@deepseek-ai/dsh-client-ui-primitives` owns the shipped mapping — exact
       * filenames first (package.json, Dockerfile), then prefixes/suffixes, then
       * extension — so a `.ts`, `.json`, `.md`, `.java`, `.xml` or `.png` file
       * reads at a glance instead of every file sharing one sheet. The primitives
       * are an optional seed module (the same one the "Open In…" takeover uses),
       * so a composition without them keeps the plain {@link FileGlyph} rather
       * than losing the row's icon column.
       */
      function FileTypeGlyph(props) {
        var icon = primitives && typeof primitives.FileTypeIcon === 'function' ? primitives.FileTypeIcon : null
        if (icon === null) return h(FileGlyph, null)
        return h(icon, { path: String(props.name || ''), size: 16 })
      }

      /**
       * The drag handle of one folder row: six dots, revealed on row hover.
       *
       * Only this element is `draggable`, so a click on the row's text cannot
       * start a drag by accident.
       */
      function DragGrip(props) {
        var dots = []
        for (var row = 0; row < 3; row += 1) {
          for (var col = 0; col < 2; col += 1) {
            dots.push(h('circle', { key: row + '-' + col, cx: 2 + col * 4, cy: 2 + row * 4, r: 1, fill: 'currentColor' }))
          }
        }
        return h(
          'span',
          {
            title: t('action.dragFolder'),
            draggable: props.draggable === true,
            onDragStart: props.onDragStart,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 12,
              flex: 'none',
              color: TOKEN.labelFaint,
              cursor: 'grab',
              opacity: props.visible === true ? 1 : 0,
            },
          },
          [h('svg', { key: 'dots', width: 8, height: 12, viewBox: '0 0 8 12', 'aria-hidden': 'true' }, dots)],
        )
      }

      /**
       * Confirm a destructive row action.
       *
       * The list has no undo, so the removal of a folder is asked first. A host
       * without `window.confirm` (a bare test renderer) proceeds: the confirm is
       * a courtesy, not the transport.
       */
      function confirmThen(message, run) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return
        run()
      }

      /**
       * One workspace folder entry: 48px tall, a grip, an icon, two lines of
       * text, and three groups of actions (terminal · order/edit · danger).
       *
       * Renaming swaps the text column for an input and the actions for
       * confirm/cancel, and keeps the row height so the list does not jump.
       */
      function FolderRow(props) {
        var root = props.root
        var renaming = props.renaming === true
        var hover = useHover()
        var name = String(root.label || '')
        var path = String(root.resolvedPath || '')

        var textColumn = renaming
          ? h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
              h(TextInput, {
                value: props.renameValue,
                placeholder: t('field.folderName'),
                ariaLabel: t('field.folderName'),
                dataField: 'rename-folder',
                onChange: props.onRenameChange,
                onEnter: props.onRenameCommit,
              }),
            ])
          : h('div', { key: 'text', 'data-root-toggle': String(root.resolvedPath || ''), onClick: props.onToggle, style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } }, [
              h('div', { key: 'name', style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none', maxWidth: '52%', minWidth: 0 } }, [
                h(
                  'span',
                  { key: 'label', title: name, style: { fontSize: 13.5, lineHeight: '20px', fontWeight: 500, color: TOKEN.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  [name],
                ),
                root.isPrimary ? h(Badge, { key: 'primary', tone: 'info' }, [t('badge.primary')]) : null,
                root.exists === false ? h(Badge, { key: 'missing', tone: 'warning' }, [t('badge.missing')]) : null,
              ]),
              h(
                'div',
                { key: 'path', title: path, style: { flex: 1, minWidth: 0, fontFamily: TOKEN.mono, fontSize: 11.5, lineHeight: '18px', color: TOKEN.labelFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                [path],
              ),
            ])

        var actions
        if (renaming) {
          actions = h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } }, [
            h(Button, { key: 'confirm', variant: 'primary', onClick: props.onRenameCommit }, [t('action.confirm')]),
            h(Button, { key: 'cancel', onClick: props.onRenameCancel }, [t('action.cancel')]),
          ])
        } else {
          var items = []
          if (props.canOpenTerminal) {
            items.push(
              h(
                IconButton,
                {
                  key: 'terminal',
                  title: props.terminalTitle || t('action.openTerminal'),
                  disabled: props.terminalBusy === true || props.terminalDisabled === true,
                  onClick: props.onOpenTerminal,
                },
                [h('span', { style: { fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px' } }, ['>_'])],
              ),
            )
          }
          // Quote the folder into the conversation's draft. Not a drag: a page
          // drag carries text, not files, so the composer would ignore it — this
          // writes the same `@path/` reference an Explorer drop would produce.
          if (typeof props.onQuote === 'function') {
            items.push(h(IconButton, { key: 'quote', title: t('action.quote'), onClick: props.onQuote }, ['⤴']))
          }
          // The management actions moved into the row's context menu. On a narrow
          // panel five icon buttons per row were the widest thing there and the
          // least used; the terminal stays because it is a daily action.
          items.push(h(IconButton, { key: 'more', title: t('action.more'), onClick: props.onMenu }, ['⋯']))
          actions = h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 2, flex: 'none' } }, items)
        }

        return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [
          h(
            'div',
            Object.assign(
              {
                role: 'listitem',
                'data-root-path': String(root.resolvedPath || ''),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  // 6px, not 8: with the 12px grip and the 10px inset this puts the
                  // caret at x=28, the column the tree's first guide line and its
                  // first-level carets are measured from (see {@link TreeNode}).
                  gap: 6,
                  boxSizing: 'border-box',
                  minHeight: 36,
                  padding: '4px 10px',
                  borderRadius: TOKEN.radiusSm,
                  flexWrap: 'nowrap',
                  background: root.isPrimary ? TOKEN.pressed : hover.hovered ? TOKEN.hover : 'transparent',
                  boxShadow:
                    props.dropEdge === 'before'
                      ? 'inset 0 2px 0 ' + TOKEN.accent
                      : props.dropEdge === 'after'
                        ? 'inset 0 -2px 0 ' + TOKEN.accent
                        : undefined,
                },
                onDragOver: props.onDragOver,
                onDrop: props.onDrop,
                onContextMenu: props.onContextMenu,
              },
              hover.handlers,
            ),
            [
              renaming || props.editable === false ? null : h(DragGrip, { key: 'grip', draggable: props.draggable === true, onDragStart: props.onDragStart, visible: hover.hovered }),
              h(
                'span',
                {
                  key: 'caret',
                  title: props.expanded ? t('action.collapse') : t('action.expand'),
                  style: { width: 12, flex: 'none', textAlign: 'center', fontSize: 10, lineHeight: '12px', color: TOKEN.labelFaint, cursor: 'pointer' },
                  onClick: function (event) {
                    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                    props.onToggle()
                  },
                },
                [props.expanded ? '▾' : '▸'],
              ),
              renaming
                ? null
                : h('span', { key: 'icon', style: { display: 'inline-flex', alignItems: 'center', flex: 'none', color: TOKEN.labelFaint } }, [h(FolderGlyph, null)]),
              textColumn,
              actions,
            ],
          ),
          // 22px puts the first tree row's content column at x=28 as well; the
          // tree then starts one 16px step inside the folder's own columns instead
          // of hanging out to the left of them.
          props.expanded && props.children ? h('div', { key: 'children', style: { paddingLeft: 22 } }, props.children) : null,
        ])
      }

      /**
       * The workspace's one folder when it has no `.code-workspace` file.
       *
       * A workspace file is what DECLARES several folders; it is not what makes a
       * directory browsable. A session rooted at one directory is a one-folder
       * workspace, and this page is where its code is looked at — so the tree gets
       * this synthetic top-level row instead of an empty card body. Read-only by
       * construction: every folder edit writes the file, and there is no file.
       */
      function singleFolderRoot(rootDir) {
        var path = String(rootDir)
        return {
          index: 0,
          path: '.',
          name: null,
          label: lastSegment(path) || path,
          resolvedPath: path,
          exists: true,
          isPrimary: true,
          relative: '.',
        }
      }

      /**
       * The workspace explorer: one list of roots, each expanding to its files.
       *
       * The page used to draw the roots twice — once as a management list, once
       * as the file tree's top level — and they are the same names. They are one
       * list here: a root expands in place, and the row's five management buttons
       * moved into a context menu (right-click, or the `⋯` button).
       *
       * Reordering stays drag-and-drop through `moveFolder`; the drag state is
       * local (the store must not see it), and the menu carries the
       * keyboard-equivalent up/down.
       */
      function FolderList(props) {
        var roots = Array.isArray(props.roots) ? props.roots : []
        var snapshot = props.snapshot
        var onQuote = typeof props.onQuote === 'function' ? props.onQuote : null
        var sessionId = props.sessionId === undefined ? null : props.sessionId
        var terminalEnabled = props.terminalEnabled === true
        var busy = props.busy === true
        var rootDir = props.rootDir === undefined ? '' : String(props.rootDir)
        // Folders are DECLARED by the `.code-workspace` file, so every management
        // action (move / rename / remove) writes that file. A single-folder
        // workspace has no file: its one row is the session root, and the tree is
        // read-only there rather than offering actions that cannot work.
        var workspaceValue = snapshot && snapshot.snapshot
        var editable = Boolean(workspaceValue && workspaceValue.file)
        var dragPair = React.useState({ from: -1, over: -1, edge: null })
        var drag = dragPair[0] || { from: -1, over: -1, edge: null }
        var setDrag = dragPair[1]
        var dragFrom = typeof drag.from === 'number' ? drag.from : -1

        // Which roots are open, and what each listing returned.
        var treePair = React.useState({ open: {}, data: {} })
        var tree = treePair[0] && typeof treePair[0] === 'object' ? treePair[0] : { open: {}, data: {} }
        var setTree = treePair[1]
        var requested = React.useRef({})

        // The context menu lives in the panel store, not in local state: a store
        // write re-renders the page, which is what makes the menu's items
        // reachable from a plain render pass as well as from a real browser.
        var menu = snapshot.menu && typeof snapshot.menu === 'object' ? snapshot.menu : null

        function loadTree(path) {
          if (requested.current[path] === true) return
          requested.current[path] = true
          setTree(function (current) {
            if (current.data[path] !== undefined) return current
            var data = Object.assign({}, current.data)
            data[path] = { loading: true, entries: [] }
            return { open: current.open, data: data }
          })
          call('tree', { path: path }).then(
            function (value) {
              setTree(function (current) {
                var data = Object.assign({}, current.data)
                data[path] = {
                  loading: false,
                  entries: value && Array.isArray(value.entries) ? value.entries : [],
                  truncated: value && value.truncated === true,
                }
                return { open: current.open, data: data }
              })
            },
            function (error) {
              requested.current[path] = false
              setTree(function (current) {
                var data = Object.assign({}, current.data)
                data[path] = { loading: false, entries: [], error: String((error && error.message) || error) }
                return { open: current.open, data: data }
              })
            },
          )
        }

        function togglePath(path) {
          var wasOpen = tree.open[path] === true
          setTree(function (current) {
            var open = Object.assign({}, current.open)
            open[path] = !wasOpen
            return { open: open, data: current.data }
          })
          if (!wasOpen) loadTree(path)
        }

        function activateEntry(entry) {
          if (entry.kind === 'directory') {
            togglePath(entry.path)
            return
          }
          openWorkspaceFile(sessionId === null ? currentSessionId() : sessionId, rootDir, entry.path)
        }

        /** A note under a folder stands in the name column of the entries it replaces (x=84). */
        function noteStyle(tone) {
          return { paddingLeft: 62, fontSize: 11.5, lineHeight: '20px', color: tone === 'danger' ? TOKEN.danger : TOKEN.labelFaint }
        }

        function rootChildren(path) {
          var data = tree.data[path]
          if (data === undefined || data.loading === true) return [h('div', { key: 'loading', style: noteStyle() }, [t('hint.treeLoading')])]
          if (data.error) return [h('div', { key: 'error', title: data.error, style: noteStyle('danger') }, [t('error.tree')])]
          if (data.entries.length === 0) return [h('div', { key: 'empty', style: noteStyle() }, [t('hint.treeEmpty')])]
          var out = []
          for (var index = 0; index < data.entries.length; index += 1) {
            out.push(h(TreeNode, {
              key: data.entries[index].path,
              entry: data.entries[index],
              depth: 0,
              open: tree.open,
              data: tree.data,
              onActivate: activateEntry,
              onQuote: onQuote,
            }))
          }
          if (data.truncated === true) out.push(h('div', { key: 'truncated', style: noteStyle() }, [t('hint.treeTruncated')]))
          return out
        }

        function closeMenu() {
          if (menu !== null) patch({ menu: null })
        }

        function openMenu(root, index, event) {
          var x = 0
          var y = 0
          if (event) {
            if (event.type === 'contextmenu' && typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.clientX === 'number' && (event.clientX !== 0 || event.clientY !== 0)) {
              x = event.clientX
              y = event.clientY
            } else if (event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
              var rect = event.currentTarget.getBoundingClientRect()
              x = rect.left
              y = rect.bottom
            }
          }
          patch({ menu: { x: x, y: y, index: index } })
        }

        React.useEffect(function () {
          if (menu === null || typeof document === 'undefined') return
          var dismiss = function (event) {
            var target = event && event.target
            if (target && typeof target.closest === 'function' && target.closest('[data-cws-menu]') !== null) return
            patch({ menu: null })
          }
          var onKey = function (event) {
            if (event.key === 'Escape') patch({ menu: null })
          }
          document.addEventListener('mousedown', dismiss)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', dismiss)
            document.removeEventListener('keydown', onKey)
          }
        }, [menu])

        function menuItem(key, label, disabled, run, danger) {
          return h('button', {
            key: key,
            type: 'button',
            role: 'menuitem',
            disabled: disabled === true,
            onClick: disabled === true ? undefined : run,
            style: {
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              boxSizing: 'border-box',
              border: 0,
              background: 'transparent',
              borderRadius: TOKEN.radiusXs,
              padding: '6px 10px',
              fontSize: 12.5,
              lineHeight: '18px',
              textAlign: 'left',
              color: danger === true ? TOKEN.danger : TOKEN.label,
              cursor: disabled === true ? 'not-allowed' : 'pointer',
              opacity: disabled === true ? 0.4 : 1,
            },
          }, [label])
        }

        function renderMenu(root, index) {
          var x = typeof menu.x === 'number' ? menu.x : 0
          var y = typeof menu.y === 'number' ? menu.y : 0
          var width = 190
          try {
            if (typeof window !== 'undefined') {
              x = Math.max(4, Math.min(x, window.innerWidth - width - 4))
              y = Math.max(4, Math.min(y, window.innerHeight - 240))
            }
          } catch (error) {
            /* keep the raw position */
          }
          var items = []
          if (terminalEnabled) {
            items.push(menuItem('terminal', t('action.openTerminal'), root.exists === false, function () {
              patch({ menu: null })
              openProjectTerminal(root)
            }))
          }
          if (editable) {
            items.push(menuItem('up', t('action.up'), index === 0 || busy, function () {
              patch({ menu: null })
              mutate('move ' + index + ' ' + (index - 1), 'moveFolder', { address: String(index), toIndex: index - 1 })
            }))
            items.push(menuItem('down', t('action.down'), index === roots.length - 1 || busy, function () {
              patch({ menu: null })
              mutate('move ' + index + ' ' + (index + 1), 'moveFolder', { address: String(index), toIndex: index + 1 })
            }))
            items.push(menuItem('rename', t('action.rename'), busy, function () {
              patch({ menu: null, renameIndex: index, renameValue: String(root.name || '') })
            }))
          }
          items.push(menuItem('reveal', t('action.reveal'), false, function () {
            patch({ menu: null })
            reveal(root.resolvedPath)
          }))
          if (editable) {
            items.push(h('div', { key: 'sep', style: { height: 0, borderTop: '0.5px solid ' + TOKEN.line, margin: '4px 2px' } }))
            items.push(menuItem('remove', t('action.remove'), busy, function () {
              var label = String(root.label || root.name || root.resolvedPath || '')
              patch({ menu: null })
              confirmThen(t('confirm.removeFolder', { name: label }), function () {
                mutate('remove ' + index, 'removeFolder', { address: String(index) })
              })
            }, true))
          }
          return h('div', {
            key: 'menu',
            'data-cws-menu': 'true',
            role: 'menu',
            style: {
              position: 'fixed',
              left: x,
              top: y,
              zIndex: 400,
              width: width,
              padding: 4,
              background: TOKEN.surface,
              border: '0.5px solid ' + TOKEN.line,
              borderRadius: TOKEN.radiusMd,
              boxShadow: TOKEN.shadow,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            },
          }, items)
        }

        function buildRow(root, index) {
          var path = String(root.resolvedPath || '')
          var expanded = tree.open[path] === true
          var terminalKey = sessionId === null ? '' : shellKey(sessionId, root.resolvedPath)
          var terminalBusy = terminalEnabled && terminalKey !== '' && Boolean(snapshot.shellOpening && snapshot.shellOpening[terminalKey])
          var renaming = editable && snapshot.renameIndex === index
          return h(FolderRow, {
            key: path + '#' + index,
            root: root,
            editable: editable,
            first: index === 0,
            last: index === roots.length - 1,
            renaming: renaming,
            renameValue: snapshot.renameValue,
            expanded: expanded,
            children: expanded ? rootChildren(path) : null,
            onToggle: function () { togglePath(path) },
            onMenu: function (event) { openMenu(root, index, event) },
            onContextMenu: function (event) { openMenu(root, index, event) },
            canOpenTerminal: terminalEnabled,
            onQuote: onQuote === null ? null : function () { onQuote(root.resolvedPath, true) },
            terminalBusy: terminalBusy,
            terminalDisabled: root.exists === false,
            terminalTitle:
              root.exists === false
                ? t('hint.terminalNoDir')
                : terminalBusy
                  ? t('action.openTerminalBusy')
                  : t('action.openTerminal'),
            onOpenTerminal: function () { openProjectTerminal(root) },
            onRenameStart: function () { patch({ renameIndex: index, renameValue: root.name || '' }) },
            onRenameChange: function (next) { patch({ renameValue: next }) },
            onRenameCancel: function () { patch({ renameIndex: -1 }) },
            onRenameCommit: function () {
              var address = String(index)
              var name = snapshot.renameValue
              patch({ renameIndex: -1 })
              mutate('rename ' + address + ' "' + name + '"', 'renameFolder', { address: address, name: name })
            },
            onMoveUp: function () { mutate('move ' + index + ' ' + (index - 1), 'moveFolder', { address: String(index), toIndex: index - 1 }) },
            onMoveDown: function () { mutate('move ' + index + ' ' + (index + 1), 'moveFolder', { address: String(index), toIndex: index + 1 }) },
            onReveal: function () { reveal(root.resolvedPath) },
            onRemove: function () { mutate('remove ' + index, 'removeFolder', { address: String(index) }) },
            draggable: editable && !busy && !renaming,
            onDragStart: function (event) {
              if (event && event.dataTransfer) {
                try {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(index))
                } catch (error) {
                  /* a browser without a data transfer still gets the drop edge */
                }
              }
              setDrag({ from: index, over: -1, edge: null })
            },
            onDragOver: function (event) {
              if (dragFrom < 0 || dragFrom === index) return
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
              var edge = 'before'
              if (event && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function' && typeof event.clientY === 'number') {
                var rect = event.currentTarget.getBoundingClientRect()
                edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
              }
              if (drag.over !== index || drag.edge !== edge) setDrag({ from: dragFrom, over: index, edge: edge })
            },
            onDrop: function (event) {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
              var from = dragFrom
              var edge = drag.edge === 'after' ? 'after' : 'before'
              var over = drag.over
              setDrag({ from: -1, over: -1, edge: null })
              if (from < 0 || over < 0 || over === from) return
              var to = edge === 'after' ? over + 1 : over
              if (from < to) to -= 1
              if (to === from) return
              mutate('move ' + from + ' ' + to, 'moveFolder', { address: String(from), toIndex: to })
            },
            dropEdge: drag.over === index && dragFrom !== index ? drag.edge : null,
          })
        }

        var rows = []
        for (var rowIndex = 0; rowIndex < roots.length; rowIndex += 1) rows.push(buildRow(roots[rowIndex], rowIndex))

        var inner = roots.length === 0
          ? h('div', { key: 'empty', style: { fontSize: 13, lineHeight: '20px', color: TOKEN.labelDim, padding: '12px 10px' } }, [t('empty.roots')])
          : h(
              'div',
              {
                key: 'rows',
                role: 'tree',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  maxHeight: 460,
                  overflowY: 'auto',
                  scrollbarGutter: 'stable',
                  marginRight: 2,
                  overscrollBehavior: 'contain',
                },
              },
              rows,
            )
        // `flat` lets the caller own the material: the rows then render inside the
        // identity card instead of a card of their own.
        var body = props.flat === true ? inner : h(Card, { padding: 8 }, [inner])
        var menuNode = menu === null || roots[menu.index] === undefined ? null : renderMenu(roots[menu.index], menu.index)
        return h('div', { key: 'folder-list', style: { position: 'relative', minWidth: 0 } }, [body, menuNode])
      }

      /**
       * The `dsh-resource://file/session/…` address for one workspace file.
       *
       * A path inside the session root becomes relative — the form the shipped
       * Files page produces. Any other absolute path stays absolute, which is the
       * point here: the additional roots of a `.code-workspace` file live outside
       * the session root, and the Host's `workspaceFiles` reads are not
       * workspace-contained, so an absolute address previews them.
       */
      function fileAddressOf(sessionId, rootDir, filePath) {
        var util = optionalRequire('@deepseek-ai/dsh-util-workspace-path')
        if (util && typeof util.fileAddressFor === 'function') {
          try {
            return util.fileAddressFor(sessionId, rootDir, filePath)
          } catch (error) {
            /* fall back to the local form rather than refusing the file */
          }
        }
        var slashed = String(filePath).replace(/\\/g, '/')
        var root = String(rootDir || '').replace(/\\/g, '/').replace(/\/+$/, '')
        var relative = slashed
        if (
          root !== '' &&
          slashed.length > root.length &&
          slashed.slice(0, root.length).toLowerCase() === root.toLowerCase() &&
          slashed.charAt(root.length) === '/'
        ) {
          relative = slashed.slice(root.length + 1)
        }
        var encoded = relative
          .split('/')
          .map(function (segment) { return encodeURIComponent(segment).replace(/%3A/g, ':') })
          .join('/')
        return 'dsh-resource://file/session/' + encodeURIComponent(String(sessionId)) + '/' + encoded
      }

      /** The session the app is showing, for a surface that has no session kit. */
      function currentSessionId() {
        try {
          var list = sessions && sessions.list
          var snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
          var current = snapshot && snapshot.current
          return typeof current === 'string' && current !== '' ? current : null
        } catch (error) {
          return null
        }
      }

      /** Open one workspace file in the right Sidebar's document preview. */
      function openWorkspaceFile(sessionId, rootDir, filePath) {
        if (sessionId === null || sessionId === undefined || sessionId === '') {
          patch({ notice: t('hint.treeNoSession'), noticeTone: 'info' })
          return
        }
        var sidebar
        try {
          sidebar = ctx.get('sidebarRight')
        } catch (error) {
          sidebar = null
        }
        if (!sidebar) {
          patch({ notice: t('hint.treeNoSession'), noticeTone: 'info' })
          return
        }
        var address = fileAddressOf(sessionId, rootDir, filePath)
        try {
          if (typeof sidebar.openResourceIn === 'function') sidebar.openResourceIn(sessionId, address)
          else if (typeof sidebar.openResource === 'function') sidebar.openResource(address)
          // The preview makes this a reading session: fold the management block
          // (paths, actions, pickers) so the folder tree keeps the height. The
          // chevron in the card's title row brings it back.
          patch({ compact: true })
        } catch (error) {
          patch({ notice: t('hint.treeNoSession'), noticeTone: 'info' })
        }
      }

      /**
       * One row of the workspace file tree.
       *
       * A directory expands on first click and remembers what it loaded; a file
       * opens in the right Sidebar's document preview, where the read-only Monaco
       * renderer lives. `disabled` covers a folder the workspace file names but
       * the disk does not have.
       *
       * GEOMETRY, the whole point of this row: it is drawn on the same caret /
       * glyph / name columns as the folder row above it, one 16px step per level,
       * so a tree reads as a ladder hanging UNDER its folder instead of drifting
       * out to the left of it.
       *
       *   28  the folder row's caret, and the first tree row's guide line
       *   44  a first-level entry's caret (28 + one 16px step)
       *   62  its glyph
       *   84  its name — level 2 adds another 16 to all three
       *
       * The guides are the empty 16px cells in front of the caret, each carrying a
       * left border at its ancestor's caret column: one per level, including the
       * folder row's own. That is why this row has no flex `gap` — a gap would
       * shift every guide off its column — and why the caret and glyph carry
       * explicit right margins instead.
       */
      function TreeNode(props) {
        var entry = props.entry
        var depth = props.depth
        var disabled = props.disabled === true
        var isDirectory = entry.kind === 'directory'
        var expanded = props.open[entry.path] === true
        var data = props.data[entry.path]
        var hover = useHover()
        var rowStyle = {
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          minWidth: 0,
          minHeight: 24,
          border: 0,
          background: hover.hovered && !disabled ? TOKEN.hover : 'transparent',
          color: disabled ? TOKEN.labelDimmed : isDirectory ? TOKEN.label : TOKEN.labelDim,
          font: 'inherit',
          fontSize: 12.5,
          lineHeight: '22px',
          borderRadius: TOKEN.radiusSm,
          paddingTop: 0,
          paddingBottom: 0,
          paddingRight: 6,
          paddingLeft: 6,
          textAlign: 'left',
          cursor: disabled ? 'default' : 'pointer',
        }
        // One guide cell per level, the folder row's column included.
        var guides = []
        for (var level = 0; level <= depth; level += 1) {
          guides.push(h('span', {
            key: 'indent-' + level,
            'data-indent': '',
            style: { width: 16, flex: 'none', alignSelf: 'stretch', borderLeft: '1px solid ' + TOKEN.borderSoft },
          }))
        }
        var children = [
          h('button', {
            key: 'row',
            type: 'button',
            title: entry.path,
            disabled: disabled,
            'data-depth': String(depth),
            style: rowStyle,
            onClick: function () { if (!disabled) props.onActivate(entry) },
            onMouseEnter: hover.handlers.onMouseEnter,
            onMouseLeave: hover.handlers.onMouseLeave,
          }, guides.concat([
            h('span', { key: 'caret', style: { width: 12, flex: 'none', marginRight: 6, textAlign: 'center', fontSize: 10, lineHeight: '12px', color: TOKEN.labelFaint } }, [isDirectory ? (expanded ? '▾' : '▸') : '']),
            h('span', {
              key: 'icon',
              style: { width: 16, flex: 'none', marginRight: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: TOKEN.labelFaint },
            }, [isDirectory ? h(FolderGlyph, null) : h(FileTypeGlyph, { name: entry.name })]),
            h('span', {
              key: 'name',
              // `flex:1` keeps the label taking the row's width so the row's own
              // action (quote) sits on the right edge instead of trailing the text.
              style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isDirectory ? 500 : 400 },
            }, [String(entry.name)]),
            typeof props.onQuote === 'function'
              ? h('span', {
                key: 'quote',
                role: 'button',
                title: t('action.quote'),
                'aria-label': t('action.quote'),
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  props.onQuote(entry.path, isDirectory)
                },
                style: {
                  flex: 'none',
                  marginLeft: 6,
                  width: 18,
                  textAlign: 'center',
                  fontSize: 12,
                  lineHeight: '18px',
                  color: TOKEN.labelFaint,
                  // Revealed on hover, and only then pointer-active: an invisible
                  // hit area would swallow clicks meant for the row.
                  opacity: hover.hovered ? 1 : 0,
                  pointerEvents: hover.hovered ? 'auto' : 'none',
                  cursor: 'pointer',
                },
              }, ['⤴'])
              : null,
          ])),
        ]
        if (isDirectory && expanded && !disabled) {
          // A note sits in the name column of the entries it stands in for.
          var noteStyle = { paddingLeft: 78 + depth * 16, fontSize: 11.5, lineHeight: '20px' }
          if (data === undefined || data.loading === true) {
            children.push(h('div', { key: 'loading', style: Object.assign({ color: TOKEN.labelFaint }, noteStyle) }, [t('hint.treeLoading')]))
          } else if (data.error) {
            children.push(h('div', { key: 'error', title: data.error, style: Object.assign({ color: TOKEN.danger }, noteStyle) }, [t('error.tree')]))
          } else if (data.entries.length === 0) {
            children.push(h('div', { key: 'empty', style: Object.assign({ color: TOKEN.labelFaint }, noteStyle) }, [t('hint.treeEmpty')]))
          } else {
            for (var index = 0; index < data.entries.length; index += 1) {
              children.push(h(TreeNode, {
                key: data.entries[index].path,
                entry: data.entries[index],
                depth: depth + 1,
                open: props.open,
                data: props.data,
                onActivate: props.onActivate,
                onQuote: props.onQuote,
              }))
            }
            if (data.truncated === true) {
              children.push(h('div', { key: 'truncated', style: Object.assign({ color: TOKEN.labelFaint }, noteStyle) }, [t('hint.treeTruncated')]))
            }
          }
        }
        return h('div', { key: entry.path + ':' + depth }, children)
      }

      /**
       * The add-folder form: the one way to grow the workspace file from here.
       *
       * Collapsed by default behind a single button — it is a secondary action,
       * and an always-open form between the folder list and the file tree was
       * what pushed the tree off the bottom of the panel. The fields stay in the
       * DOM while collapsed (`display: none`) rather than being unmounted, so
       * their values survive a close/open cycle and Enter still submits.
       */
      function AddFolderForm(props) {
        var snapshot = props.snapshot
        var busy = snapshot.busy === true
        var canAdd = !busy && String(snapshot.addPath || '').trim() !== ''
        var openPair = React.useState(false)
        var open = openPair[0] === true
        var setOpen = openPair[1]
        var labelStyle = {
          flex: 'none',
          width: 128,
          fontSize: 12,
          lineHeight: '18px',
          color: TOKEN.labelDim,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }
        var rowStyle = { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { key: 'toggle-row', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
            h(
              Button,
              {
                key: 'toggle',
                variant: open ? 'outline' : 'ghost',
                disabled: busy,
                ariaPressed: open,
                ariaLabel: t('action.add'),
                onClick: function () { setOpen(!open) },
              },
              [(open ? '− ' : '＋ ') + t('action.addRoot')],
            ),
          ]),
          h('div', { key: 'body', style: { display: open ? 'flex' : 'none', flexDirection: 'column', gap: 8 } }, [
            h('div', { key: 'row-path', style: rowStyle }, [
              h('span', { key: 'label', title: t('field.folderPath'), style: labelStyle }, [t('field.folderPath')]),
              h(TextInput, {
                key: 'input',
                dataField: 'add-path',
                value: snapshot.addPath,
                placeholder: t('field.folderPath.hint'),
                ariaLabel: t('field.folderPath'),
                disabled: busy,
                onChange: props.onPathChange,
                onEnter: props.onSubmit,
              }),
              h(Button, { key: 'add', variant: 'primary', disabled: !canAdd, style: { height: 26, padding: '0 8px' }, onClick: props.onSubmit }, [t('action.add')]),
            ]),
            h('div', { key: 'row-name', style: rowStyle }, [
              h('span', { key: 'label', title: t('field.folderName'), style: labelStyle }, [t('field.folderName')]),
              h(TextInput, {
                key: 'input',
                dataField: 'add-name',
                value: snapshot.addName,
                placeholder: t('field.folderName.hint'),
                ariaLabel: t('field.folderName'),
                disabled: busy,
                onChange: props.onNameChange,
                onEnter: props.onSubmit,
              }),
            ]),
          ]),
        ])
      }


      /**
       * The "new workspace file" form, in place of `window.prompt`.
       *
       * The Desktop renderer cannot show a prompt (Chromium has no delegate for
       * it), so the old button threw and looked dead. This is the same inline
       * pattern as {@link AddFolderForm}: a name field, Create, Cancel, driven by
       * the store so it works from a plain render pass as well.
       */
      function CreateFileForm(props) {
        var snapshot = props.snapshot || {}
        var busy = snapshot.busy === true
        var value = String(snapshot.createName || '')
        var canCreate = !busy && value.trim() !== ''
        return h('div', { key: 'create-form', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' } }, [
          h('span', { key: 'label', style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: TOKEN.labelDim } }, [t('field.workspaceName')]),
          h(TextInput, {
            key: 'input',
            dataField: 'create-name',
            value: value,
            placeholder: t('field.workspaceName.hint'),
            ariaLabel: t('field.workspaceName'),
            disabled: busy,
            onChange: function (next) { patch({ createName: next }) },
            onEnter: function () { if (canCreate) createFile(value) },
          }),
          h(Button, { key: 'create', variant: 'primary', disabled: !canCreate, style: { height: 26, padding: '0 10px' }, onClick: function () { createFile(value) } }, [t('action.createConfirm')]),
          h(Button, { key: 'cancel', disabled: busy, onClick: function () { patch({ creating: false, createName: '' }) } }, [t('action.cancel')]),
        ])
      }

      /**
       * Open the host's own file dialog and take whatever it returns.
       *
       * The host's directory picker seam has no file variant, so the host half
       * opens a platform file dialog for this (see `workspace-picker.js`). The
       * three answers are all meaningful to the user: a path opens it, a cancel
       * says nothing at all, and an unavailable host explains itself once (not
       * Windows, or the operator is not at the host's screen) so they know to use
       * the browser below instead of clicking again.
       */
      function pickNativeFile() {
        patch({ busy: true, error: null, notice: null, noticeTone: 'info' })
        return call('pickFile', { cwd: fileBrowseStart() }).then(
          function (value) {
            var outcome = value && value.outcome
            if (outcome === 'picked' && typeof value.path === 'string' && value.path !== '') {
              patch({ busy: false, error: null })
              return openFile(value.path)
            }
            if (outcome === 'cancelled') {
              patch({ busy: false, error: null })
              return undefined
            }
            patch({
              busy: false,
              error: null,
              notice: t('hint.noNativePicker') + (value && value.error ? '（' + String(value.error) + '）' : ''),
              noticeTone: 'info',
            })
            return undefined
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      /**
       * The plugin's own directory browser: the toolbar, the current path, the
       * rows.
       *
       * It exists because the host's file dialog is not always available (an SSH
       * session cannot show one), so the toolbar keeps the three working entry
       * points and the row list stays inside a scrolling card.
       */
      function BrowseSection(props) {
        var snapshot = useSnapshot()
        var browse = snapshot.browse
        var busy = snapshot.busy === true
        var hoverPair = React.useState(-1)
        var hovered = hoverPair[0]
        var setHovered = hoverPair[1]

        function rowNode(entry, index) {
          var selected = hovered === index
          return h(
            'div',
            {
              key: entry.path,
              role: 'listitem',
              onClick: function () {
                if (entry.kind === 'workspace-file') openFile(entry.path)
                else browseTo(entry.path)
              },
              onMouseEnter: function () { setHovered(index) },
              onMouseLeave: function () { setHovered(-1) },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                boxSizing: 'border-box',
                minHeight: 32,
                padding: '5px 10px',
                borderRadius: TOKEN.radiusSm,
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: '22px',
                color: TOKEN.label,
                background: selected ? TOKEN.hover : 'transparent',
              },
            },
            [
              h('span', { key: 'glyph', style: { display: 'inline-flex', width: 16, justifyContent: 'center', flex: 'none', color: TOKEN.labelFaint, fontSize: 13 } }, [entry.kind === 'directory' ? '▸' : '◆']),
              h(
                'span',
                {
                  key: 'name',
                  style: {
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: entry.kind === 'workspace-file' ? 500 : 400,
                  },
                },
                [String(entry.name || '')],
              ),
              entry.kind === 'workspace-file' ? h(Badge, { key: 'badge', tone: 'outline' }, [t('badge.workspaceFile')]) : null,
            ],
          )
        }

        var body
        if (!browse) {
          body = h('div', { key: 'loading', style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint, padding: '3px 10px' } }, [t('status.loading')])
        } else {
          var entries = Array.isArray(browse.entries) ? browse.entries : []
          var rows = []
          for (var index = 0; index < entries.length; index += 1) rows.push(rowNode(entries[index], index))
          body =
            rows.length === 0
              ? h('div', { key: 'empty', style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint, padding: '3px 10px' } }, [t('hint.noFile')])
              : h(
                  'div',
                  {
                    key: 'list',
                    role: 'list',
                    style: {
                      padding: '0 4px 8px',
                      maxHeight: 260,
                      overflowY: 'auto',
                      scrollbarGutter: 'stable',
                      marginRight: 2,
                      overscrollBehavior: 'contain',
                    },
                  },
                  rows,
                )
        }

        // See the recent section: flat material when this opens inside the card.
        var toolbar = h('div', { key: 'toolbar', style: { padding: '8px 8px 4px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h(Button, { key: 'parent', variant: 'outline', disabled: !browse || !browse.parent, onClick: function () { if (browse) browseTo(browse.parent) } }, [t('action.parent')]),
          h(Button, { key: 'mkdir', onClick: makeDir }, [t('action.newFolder')]),
          h(Button, { key: 'pick', disabled: busy, onClick: pickNativeFile }, [t('action.nativePick')]),
          h(
            'div',
            {
              key: 'path',
              title: browse ? String(browse.path || '') : '',
              style: { flex: 1, minWidth: 0, fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            [browse ? String(browse.path || '') : ''],
          ),
        ])
        var browseMaterial = props.flat === true
          ? h('div', { key: 'card' }, [
            toolbar,
            body,
          ])
          : h(Card, { key: 'card', padding: 0 }, [
            toolbar,
            body,
          ])

        return h('section', null, [
          h(SectionHeader, {
            key: 'head',
            title: t('label.browse'),
            action: h(IconButton, { key: 'close', small: true, title: t('action.close'), onClick: function () { patch({ showBrowse: false }) } }, ['✕']),
          }),
          browseMaterial,
        ])
      }


      /**
       * One spelling for comparing paths across the two halves.
       *
       * The host composes every path it answers with forward slashes, while a
       * Windows dialog and the plugin's own store can hand back backslashes — so
       * a plain string comparison between them silently finds nothing. Fold the
       * separator and the case (Windows paths are case-insensitive) for identity
       * only; no displayed value comes from here.
       */
      function pathKey(path) {
        // Match the host's `toComparable`: fold case only for Windows spellings,
        // so a POSIX host compares its case-sensitive paths the same way on both
        // halves. Unconditional lowercasing would silently fail to match a POSIX
        // path that differs only in case.
        var s = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '')
        return /^[A-Za-z]:[\\/]/.test(s) || /^[\\/]{2}[^\\/]/.test(s) ? s.toLowerCase() : s
      }

      // ------------------------------------------------------ project terminals
      // One shortcut per workspace folder, opening the shipped right-sidebar
      // terminal in that folder. Everything here is CLIENT-side: the terminal
      // service already owns PTY lifetime, quotas, screen recovery and process
      // permissions, so this plugin must not re-implement any of it.
      //
      // Two upstream facts shape the section:
      //
      //   1. `terminal/create` has no cwd field — the host always starts the
      //      shell in the Session workspace. The only way to land in an additional
      //      root is to type a `cd` into the PTY once it is writable. That line
      //      stays visible on screen, which is the honest answer: there is no API
      //      to set a per-terminal cwd, and faking one would lie to the user.
      //   2. `terminal` is a `multiple: true` tab type, so every open allocates a
      //      fresh tab with a random contentId that the caller cannot address up
      //      front. The new tab is claimed from the sidebar's tab inventory and
      //      its borrowed view is looked up by `(sessionId, tabId)`.
      //
      // The terminal services are OPTIONAL: a composition without the right
      // sidebar or the terminal plugin must keep every other panel feature, so
      // they are injected softly and every entry point re-checks availability.

      /** The injected terminal services, or null when this composition lacks them. */
      var shellServices = null
      var shellListeners = []
      var shellAvailableCache = false

      /** Whether the shortcut can actually do anything in this composition. */
      function shellUsable() {
        var services = shellServices
        if (!services) return false
        var sidebar = services.sidebarRight
        var terminals = services.webTerminals
        var tabs = services.sidebarRightTabs
        if (!sidebar || typeof sidebar.openTab !== 'function') return false
        if (!sidebar.openTabs || typeof sidebar.openTabs.getSnapshot !== 'function') return false
        if (!terminals || typeof terminals.view !== 'function') return false
        if (!tabs || typeof tabs.get !== 'function') return false
        try {
          return tabs.get('terminal') !== undefined
        } catch (error) {
          return false
        }
      }

      function shellAvailable() {
        return shellAvailableCache
      }

      function subscribeShell(fn) {
        shellListeners.push(fn)
        return function () {
          var index = shellListeners.indexOf(fn)
          if (index >= 0) shellListeners.splice(index, 1)
        }
      }

      function notifyShell() {
        var next = shellUsable()
        if (next === shellAvailableCache) return
        shellAvailableCache = next
        var listeners = shellListeners.slice()
        for (var i = 0; i < listeners.length; i += 1) {
          try {
            listeners[i]()
          } catch (error) {
            /* one listener's failure must not stop the others */
          }
        }
      }

      /**
       * A boolean store the folder rows read: whether the terminal shortcut is
       * usable right now. The value changes only when the bridge does, which
       * keeps `useSyncExternalStore` from looping on a fresh selector result.
       */
      function useShellAvailable() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(subscribeShell, shellAvailable, shellAvailable)
        }
        return shellAvailable()
      }

      if (ctx.inject) {
        ctx.inject(['sidebarRight', 'webTerminals', 'sidebarRightTabs'], function (scope) {
          shellServices = scope
          notifyShell()
          // The `terminal` tab kind is registered by its own plugin, which may
          // arrive after the services themselves: re-check when the registry moves.
          if (scope && typeof scope.effect === 'function' && scope.sidebarRightTabs && typeof scope.sidebarRightTabs.subscribe === 'function') {
            scope.effect(function () {
              return scope.sidebarRightTabs.subscribe(notifyShell)
            }, 'dsh-code-workspace: project terminal availability')
          }
        })
      }

      /** The identity one folder's terminal is remembered under, scoped per session. */
      function shellKey(sessionId, path) {
        return String(sessionId) + '\u0000' + pathKey(path)
      }

      /** The display name a project terminal is titled with. */
      function shellName(root) {
        var label = root && typeof root.label === 'string' ? root.label : ''
        if (label === '') label = lastSegment(root && root.resolvedPath ? root.resolvedPath : '')
        return label === '' ? t('title.tab') : label
      }

      // ------------------------------------------------ shell bindings storage
      // These live in `localStorage`, never in the host store and never in the
      // prompt: they are a browser convenience — "that folder already has a shell
      // in this window" — not part of the workspace model. Storage failure simply
      // forgets the association; it never blocks opening a shell.

      function readShellStore() {
        try {
          var raw = window.localStorage.getItem(SHELL_STORE_KEY)
          if (!raw) return []
          var parsed = JSON.parse(raw)
          if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
          var out = []
          for (var i = 0; i < parsed.entries.length; i += 1) {
            var entry = parsed.entries[i]
            if (!entry || typeof entry.sessionId !== 'string' || typeof entry.path !== 'string' || typeof entry.contentId !== 'string') continue
            out.push(entry)
          }
          return out
        } catch (error) {
          return []
        }
      }

      function writeShellStore(entries) {
        try {
          window.localStorage.setItem(SHELL_STORE_KEY, JSON.stringify({ version: 1, entries: entries }))
        } catch (error) {
          /* a browser that refuses storage simply forgets the shells */
        }
      }

      function shellEntryFor(sessionId, path) {
        var wanted = pathKey(path)
        var entries = readShellStore()
        for (var i = 0; i < entries.length; i += 1) {
          if (entries[i].sessionId === sessionId && entries[i].path === wanted) return entries[i]
        }
        return null
      }

      function rememberShell(sessionId, path, contentId) {
        var wanted = pathKey(path)
        var entries = readShellStore().filter(function (entry) {
          return !(entry.sessionId === sessionId && entry.path === wanted)
        })
        entries.unshift({ sessionId: sessionId, path: wanted, contentId: contentId, at: Date.now() })
        if (entries.length > SHELL_STORE_LIMIT) entries.length = SHELL_STORE_LIMIT
        writeShellStore(entries)
      }

      function forgetShell(sessionId, path) {
        var wanted = pathKey(path)
        writeShellStore(
          readShellStore().filter(function (entry) {
            return !(entry.sessionId === sessionId && entry.path === wanted)
          }),
        )
      }

      /** One folder's terminal is being opened (or focused) right now. */
      function setShellOpening(key, opening) {
        var next = {}
        for (var existing in state.shellOpening) {
          if (Object.prototype.hasOwnProperty.call(state.shellOpening, existing)) next[existing] = state.shellOpening[existing]
        }
        if (opening) next[key] = true
        else delete next[key]
        patch({ shellOpening: next })
      }

      /** The open tabs the sidebar reports for every session this window knows. */
      function shellTabs() {
        if (!shellServices || !shellServices.sidebarRight || !shellServices.sidebarRight.openTabs) return []
        try {
          var snapshot = shellServices.sidebarRight.openTabs.getSnapshot()
          return Array.isArray(snapshot) ? snapshot : []
        } catch (error) {
          return []
        }
      }

      /**
       * The tabs one session currently holds.
       *
       * The flat `openTabs` inventory carries every session's tabs at once
       * (including sessions restored from storage), and its `tabId`s are minted
       * by a per-session counter — so two sessions routinely hold the same
       * `tab2`. A delta keyed by bare `tabId` therefore filters out the tab it
       * just opened as soon as any other session holds that id, which is what
       * made the project-terminal shortcut report "the terminal tab did not
       * appear" while the terminal had in fact opened. `sidebarRight.tabsIn`
       * reads one session's committed layout, so its ids (and content ids) only
       * describe tabs this session owns; the inventory stays as the fallback for
       * compositions that do not expose the scoped read.
       *
       * @param sessionId - session whose tabs are wanted.
       * @returns the session's tabs as `{ id, kind, contentId, sessionId }`.
       */
      function sessionTabs(sessionId) {
        var sidebar = shellServices && shellServices.sidebarRight
        if (!sidebar) return []
        try {
          if (typeof sidebar.tabsIn === 'function') {
            var own = sidebar.tabsIn(sessionId)
            if (Array.isArray(own)) {
              var mapped = []
              for (var index = 0; index < own.length; index += 1) {
                var record = own[index]
                if (!record || typeof record.id !== 'string' || typeof record.contentId !== 'string') continue
                mapped.push({ id: record.id, kind: record.kind, contentId: record.contentId, sessionId: sessionId })
              }
              return mapped
            }
          }
        } catch (error) {
          /* the runtime may not have adopted this session's surface yet */
        }
        var tabs = shellTabs()
        var out = []
        for (var i = 0; i < tabs.length; i += 1) {
          var tab = tabs[i]
          if (tab && tab.sessionId === sessionId) {
            out.push({ id: tab.tabId, kind: tab.kind, contentId: tab.contentId, sessionId: sessionId })
          }
        }
        return out
      }

      /** The live tab one remembered contentId still points at, if any. */
      function findShellTab(sessionId, contentId) {
        var tabs = sessionTabs(sessionId)
        for (var i = 0; i < tabs.length; i += 1) {
          var tab = tabs[i]
          if (tab.kind === 'terminal' && tab.contentId === contentId) return tab
        }
        return null
      }

      /**
       * Whether a terminal tab was opened by the terminal plugin for a Host
       * terminal its Agent created. Those carry `params.terminalId`; typing a
       * `cd` into one would write into the Agent's shell, so they are never
       * claimed as the user's project terminal.
       */
      function isAgentTerminalTab(sessionId, tab) {
        var sidebar = shellServices && shellServices.sidebarRight
        try {
          if (!sidebar || !sidebar.tabDomain || typeof sidebar.tabDomain.occurrence !== 'function') return false
          var occurrence = sidebar.tabDomain.occurrence(sessionId, { id: tab.id })
          if (!occurrence || !occurrence.navigation || typeof occurrence.navigation.getSnapshot !== 'function') return false
          var params = occurrence.navigation.getSnapshot().params
          return params !== undefined && params !== null && params.terminalId !== undefined
        } catch (error) {
          return false
        }
      }

      /** Focus one project's terminal tab, expanding the column when collapsed. */
      function focusShellTab(tab) {
        var sidebar = shellServices.sidebarRight
        try {
          if (typeof sidebar.isExpanded === 'function' && !sidebar.isExpanded() && typeof sidebar.toggleExpanded === 'function') {
            sidebar.toggleExpanded()
          }
        } catch (error) {
          /* the column may be transitioning; focus still works */
        }
        try {
          if (typeof sidebar.focus === 'function') sidebar.focus(tab.id)
        } catch (error) {
          /* a vanished tab is a state change, not a failure to report */
        }
      }

      // --------------------------------------------------- cd command spelling
      // There is no shell-independent way to change a directory, and the
      // discovered shell's own syntax is what the PTY will understand.

      /** The discovered shell's executable stem, lower-cased (`powershell`, `cmd`, `bash`…). */
      function shellStem(info) {
        var shell = info && info.shell ? info.shell : info
        var raw = shell && typeof shell === 'object' ? shell.path || shell.name || '' : ''
        return String(raw)
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          .replace(/\.exe$/i, '')
          .toLowerCase()
      }

      /**
       * The command that moves a freshly spawned shell into `path`.
       *
       * PowerShell and cmd need their own quoting; every other discovered shell
       * is POSIX-shaped. A POSIX shell discovered on Windows is Git Bash/MSYS,
       * whose spelling of `D:\x` is `/d/x`.
       */
      function cdCommand(info, path) {
        var name = shellStem(info)
        var target = String(path)
        if (name === 'powershell' || name === 'pwsh') {
          return "Set-Location -LiteralPath '" + target.replace(/'/g, "''") + "'"
        }
        if (name === 'cmd') {
          return 'cd /d "' + target.replace(/"/g, '""') + '"'
        }
        var flat = target.replace(/\\/g, '/')
        var posix = /^[A-Za-z]:\//.test(flat) ? '/' + flat.slice(0, 1).toLowerCase() + flat.slice(2) : flat
        return "cd '" + posix.replace(/'/g, "'\\''") + "'"
      }

      // ---------------------------------------------------- opening a terminal

      function terminalLimitError() {
        var error = new Error('the terminal limit is reached')
        error.code = 'terminal-limit'
        return error
      }

      /** Translate an open failure into the panel's own copy (never upstream text). */
      function terminalErrorText(error) {
        if (error && error.code === 'terminal-limit') return t('error.terminalLimit')
        var text = messageOf(error)
        if (/no session surface is mounted/i.test(text)) return t('error.terminalNoSession')
        if (/terminal limit|limit-reached/i.test(text)) return t('error.terminalLimit')
        // Three failures are produced by this bundle itself (the tab never
        // appeared, the view never became writable, the tab landed in another
        // session), so they can be explained instead of echoed. Anything else is
        // the host's or the PTY's own message, which stays as the detail.
        if (/the terminal tab did not appear/i.test(text)) return t('error.terminalNoTab')
        if (/the terminal did not become writable/i.test(text)) return t('error.terminalNotWritable')
        if (/the terminal opened in another session/i.test(text)) return t('error.terminalOtherSession')
        return t('error.terminalFailed', { message: text })
      }

      /**
       * Wait until one terminal view is attached and accepts input.
       *
       * `TerminalView.write` DROPS input while the view is not writable, so the
       * `cd` must wait for the attachment; the view itself is created by the
       * tab's own body, which mounts a few frames after the tab appears.
       */
      function whenShellWritable(view, done) {
        var settled = false
        var timer = null
        var unsubscribe = null
        function finish(error) {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch (cleanupError) {
              /* an already-detached store is harmless */
            }
          }
          done(error)
        }
        function check() {
          var snapshot
          try {
            snapshot = view.state.getSnapshot()
          } catch (error) {
            return
          }
          if (!snapshot) return
          if (snapshot.issue === 'terminalLimit') {
            finish(terminalLimitError())
            return
          }
          if (snapshot.phase === 'failed' || snapshot.phase === 'closed') {
            finish(new Error(snapshot.error || 'the terminal ' + snapshot.phase))
            return
          }
          if (snapshot.phase === 'connected' && snapshot.writable === true && snapshot.info && snapshot.info.state === 'running') {
            finish(null)
          }
        }
        timer = setTimeout(function () {
          finish(new Error('the terminal did not become writable'))
        }, SHELL_WRITABLE_MS)
        try {
          unsubscribe = view.state.subscribe(check)
        } catch (error) {
          /* checking once is still better than not checking at all */
        }
        if (settled) {
          try {
            if (typeof unsubscribe === 'function') unsubscribe()
          } catch (cleanupError) {
            /* nothing left to detach */
          }
          return
        }
        check()
      }

      /**
       * Open (or focus) the terminal of one workspace folder.
       *
       * Every outcome is reported on the panel's own notice/error line; the
       * shortcut never throws into React. The steps mirror the design doc:
       *
       *   1. reuse a remembered, still-live tab for this project;
       *   2. otherwise allocate a new `terminal` tab and claim it from the
       *      inventory delta (openTab returns no tab id);
       *   3. borrow the terminal view it owns and wait for writable;
       *   4. `cd` for an additional root, rename the tab, report.
       */
      function openProjectTerminal(root) {
        if (!shellAvailable()) {
          patch({ error: t('error.terminalUnavailable'), notice: null, noticeTone: 'info' })
          return Promise.resolve()
        }
        if (!root || typeof root.resolvedPath !== 'string' || root.resolvedPath === '' || root.exists === false) {
          patch({ error: t('hint.terminalNoDir'), notice: null, noticeTone: 'info' })
          return Promise.resolve()
        }
        if (state.mode !== 'session' || !state.sessionId) {
          patch({ error: t('error.terminalNoSession'), notice: null, noticeTone: 'info' })
          return Promise.resolve()
        }
        var sessionId = state.sessionId
        var path = root.resolvedPath
        var key = shellKey(sessionId, path)
        if (state.shellOpening && state.shellOpening[key]) return Promise.resolve()

        var remembered = shellEntryFor(sessionId, path)
        if (remembered) {
          var existing = findShellTab(sessionId, remembered.contentId)
          if (existing) {
            focusShellTab(existing)
            patch({ error: null, notice: t('notice.terminalFocused', { name: shellName(root) }), noticeTone: 'success' })
            return Promise.resolve()
          }
          // The tab is gone (closed, or the layout was cleared): forget it and
          // allocate a fresh shell below.
          forgetShell(sessionId, path)
        }

        var sidebar = shellServices.sidebarRight
        // Identity for the delta is the content id, which this runtime mints
        // uniquely per open (`sidebar://terminal/<uuid>`); a bare `tabId` is
        // per-session state and collides with other sessions' tabs.
        var before = {}
        var tabsBefore = sessionTabs(sessionId)
        for (var i = 0; i < tabsBefore.length; i += 1) {
          if (tabsBefore[i].contentId !== undefined) before[tabsBefore[i].contentId] = true
        }
        setShellOpening(key, true)
        return new Promise(function (resolve) {
          var settled = false
          var timer = null
          var unsubscribe = null

          function done(error) {
            if (settled) return
            settled = true
            if (timer !== null) clearTimeout(timer)
            if (typeof unsubscribe === 'function') {
              try {
                unsubscribe()
              } catch (cleanupError) {
                /* nothing left to detach */
              }
            }
            setShellOpening(key, false)
            if (error) patch({ error: terminalErrorText(error), notice: null, noticeTone: 'info' })
            else patch({ error: null, notice: t('notice.terminalOpened', { name: shellName(root) }), noticeTone: 'success' })
            resolve()
          }

          function claim(tab) {
            if (settled) return
            if (typeof unsubscribe === 'function') {
              try {
                unsubscribe()
              } catch (cleanupError) {
                /* nothing left to detach */
              }
              unsubscribe = null
            }
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
            if (tab.sessionId !== sessionId) {
              // Defensive only: every candidate now comes from this session's
              // own tabs. Never close a tab another session owns; report the
              // mismatch instead of typing a path into someone else's shell.
              done(new Error('the terminal opened in another session'))
              return
            }
            rememberShell(sessionId, path, tab.contentId)
            var view
            try {
              view = shellServices.webTerminals.view(sessionId, tab.id, tab.contentId)
            } catch (viewError) {
              done(viewError)
              return
            }
            var primary = pathKey(path) === pathKey(state.rootDir)
            whenShellWritable(view, function (waitError) {
              if (settled) return
              if (waitError) {
                done(waitError)
                return
              }
              if (!primary) {
                var snapshot = null
                try {
                  snapshot = view.state.getSnapshot()
                } catch (readError) {
                  snapshot = null
                }
                try {
                  view.write(cdCommand(snapshot && snapshot.info, path) + '\r')
                } catch (writeError) {
                  // A refused write leaves the shell at the Session root; the
                  // user sees where it is and no retry can invent a cwd.
                }
              }
              try {
                var renamed = view.rename(shellName(root))
                if (renamed && typeof renamed.catch === 'function') renamed.catch(function () {})
              } catch (renameError) {
                /* the tab title is cosmetic */
              }
              done(null)
            })
          }

          function scan() {
            if (settled) return
            var tabs = sessionTabs(sessionId)
            for (var index = 0; index < tabs.length; index += 1) {
              var tab = tabs[index]
              if (tab.kind !== 'terminal') continue
              if (before[tab.contentId]) continue
              // An Agent's own terminal is not this folder's shell: typing a
              // `cd` into it would drive the Agent's process.
              if (isAgentTerminalTab(sessionId, tab)) continue
              claim(tab)
              return
            }
          }

          timer = setTimeout(function () {
            done(new Error('the terminal tab did not appear'))
          }, SHELL_TAB_APPEAR_MS)
          try {
            unsubscribe = sidebar.openTabs.subscribe(scan)
          } catch (subscribeError) {
            /* the scan right after the open still sees a synchronous commit */
          }
          try {
            sidebar.openTab('terminal')
          } catch (openError) {
            done(openError)
            return
          }
          scan()
        })
      }

      /**
       * One row of the workspace list.
       *
       * A row answers three questions at a glance and offers one action: which
       * workspace is this (title + the directory the file lives in), is it still
       * there (the host probes every recorded file), and is it the one the panel
       * is showing. The action is "open" — derive the file's root, register it
       * as a DSH workspace and switch to it — so a row is also how the session
       * moves between workspaces. The danger action (dropping the record) sits at
       * the far end, away from the row's own click target.
       */
      function WorkspaceRow(props) {
        var item = props.item
        var active = props.active === true
        var hover = useHover()
        return h(
          'div',
          Object.assign(
            {
              title: String(item.file || ''),
              role: 'listitem',
              onClick: function () { openFile(item.file) },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                boxSizing: 'border-box',
                minHeight: 48,
                padding: '6px 10px',
                borderRadius: TOKEN.radiusSm,
                cursor: 'pointer',
                background: active ? TOKEN.pressed : hover.hovered ? TOKEN.hover : 'transparent',
              },
            },
            hover.handlers,
          ),
          [
            h(
              'span',
              { key: 'mark', style: { display: 'inline-flex', width: 16, justifyContent: 'center', flex: 'none', color: active ? TOKEN.accent : TOKEN.labelFaint } },
              [active ? '◆' : '◇'],
            ),
            h('div', { key: 'text', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, [
              h('div', { key: 'title-row', style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } }, [
                h(
                  'span',
                  {
                    key: 'title',
                    style: {
                      fontSize: 14,
                      lineHeight: '22px',
                      fontWeight: active ? 500 : 400,
                      color: TOKEN.label,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  [String(item.title || item.file)],
                ),
                props.open ? h(Badge, { key: 'open', tone: 'success' }, [t('badge.open')]) : null,
                item.exists === false ? h(Badge, { key: 'missing', tone: 'warning' }, [t('badge.missing')]) : null,
              ]),
              h(
                'div',
                {
                  key: 'dir',
                  style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                [String(item.fileDir || '')],
              ),
            ]),
            h(
              IconButton,
              {
                key: 'forget',
                small: true,
                danger: true,
                title: t('action.forget'),
                onClick: function (event) {
                  // The row itself opens the workspace; forgetting must not.
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  forgetFileAt(item.file)
                },
              },
              ['✕'],
            ),
          ],
        )
      }

      /**
       * Remove one recorded file from the list, addressed by the file itself.
       *
       * The panel's "unlink" works from the current workspace, which cannot reach
       * a record the session is not on — and a stale one (a temporary workspace
       * whose directory is gone) is exactly what a user wants to clear. Confirmed,
       * because this list has no undo.
       */
      function forgetFileAt(file) {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return
        if (!window.confirm(t('confirm.forget') + '\n' + String(file))) return
        patch({ busy: true, error: null, notice: null, noticeTone: 'info' })
        return call('forgetFile', { file: file }).then(
          function (value) {
            patch({ busy: false, error: null, recent: value && Array.isArray(value.files) ? value.files : [] })
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      /**
       * Subscribe the caller to the DSH workspace list, so a workspace registered
       * or removed elsewhere re-renders this list and refreshes its "registered"
       * marks. The snapshot is read for that re-render; the set itself is built by
       * {@link readOpenWorkspaces}.
       */
      function useOpenWorkspacesList() {
        var list = workspaces && workspaces.list
        var subscribeFn = list && typeof list.subscribe === 'function' ? list.subscribe.bind(list) : null
        var getFn = list && typeof list.getSnapshot === 'function' ? list.getSnapshot.bind(list) : null
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(
            subscribeFn || noopSubscribe,
            getFn || noopSnapshot,
            getFn || noopSnapshot,
          )
        }
        // Very old React without the hook: a coarse subscription keeps the list
        // re-rendering on change, just a little more often than needed.
        var pair = React.useState(0)
        var bump = pair[1]
        React.useEffect(function () {
          if (!subscribeFn) return undefined
          return subscribeFn(function () { bump(function (n) { return n + 1 }) })
        }, [])
        return undefined
      }

      /**
       * Every `.code-workspace` file this plugin knows, most recently used
       * first, with the ones that are already registered DSH workspaces marked.
       *
       * This IS the manager page ({@link ManagerBody}): a detail view of one file
       * is not a manager, and managing "which VS Code workspace am I on" means
       * keeping the others in sight while changing it. The rows come from the
       * host's recorded store (`recent`, which probes each file); the open set is
       * the DSH workspace list. Two sources, joined by path spelling, because they
       * answer different questions: "a file I have used" versus "a workspace this
       * app already has".
       *
       * `tools` is the page's action group, rendered in the section header so the
       * page has one row of controls above the list it acts on.
       */
      function WorkspaceList(props) {
        var snapshot = useSnapshot()
        useOpenWorkspacesList()

        // The registered set is a local read, not a request: doing it during the
        // render keeps it in step with the rows it marks. `loadRecent` is the one
        // thing that talks to the host, and the store tells us when it answered.
        var open = readOpenWorkspaces()
        loadRecent()

        // "Active" is the FILE, not the directory. Two files can derive the same
        // root — DSH then treats them as one workspace — so marking by root would
        // light up every row and tell the user nothing.
        var activeFile = snapshot.snapshot && snapshot.snapshot.file ? snapshot.snapshot.file : null
        var items = snapshot.recent || []
        var knownKeys = {}
        for (var i = 0; i < items.length; i += 1) knownKeys[pathKey(items[i].file)] = true

        var recordedRows = []
        for (var r = 0; r < items.length; r += 1) {
          recordedRows.push(
            h(WorkspaceRow, {
              key: items[r].file,
              item: items[r],
              open: open[pathKey(items[r].file)] !== undefined,
              active: activeFile !== null && pathKey(items[r].file) === pathKey(activeFile),
            }),
          )
        }
        // A DSH workspace the plugin has no file for: recorded support files can
        // only come from a panel or a command, so hiding it would make the list a
        // lie about what this app already has.
        var extraKeys = Object.keys(open)
        var extraRows = []
        for (var e = 0; e < extraKeys.length; e += 1) {
          if (knownKeys[extraKeys[e]] === true) continue
          extraRows.push(extraWorkspaceRow(open[extraKeys[e]], extraKeys[e]))
        }
        var allRows = recordedRows.concat(extraRows)

        var children = []
        // The empty copy is the page's own explanation only when the card is
        // actually empty. It used to key off the recorded store alone, which put
        // "nothing has been recorded" directly above a registered workspace: on a
        // page whose whole body is this list, that reads as a contradiction.
        if (allRows.length === 0) {
          children.push(h('div', { key: 'empty', style: { fontSize: 13, lineHeight: '20px', color: TOKEN.labelDim, padding: '12px 10px' } }, [t('empty.workspaces')]))
        }
        if (allRows.length > 0) {
          children.push(h('div', { key: 'rows', role: 'list', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, allRows))
        }

        return h('section', null, [
          h(SectionHeader, {
            key: 'head',
            title: t('label.workspaces'),
            count: t('label.workspaceCount', { count: items.length + extraKeys.length }),
            action: props && props.tools ? props.tools : null,
          }),
          h(Card, { key: 'card', padding: 8 }, children),
        ])
      }

      /**
       * One registered DSH workspace this plugin has no file for.
       *
       * It is addressable by its path alone, and clicking it opens that
       * workspace's session — the honest action when there is no file to manage.
       */
      function extraWorkspaceRow(path, key) {
        return h(
          'div',
          {
            key: 'open-' + key,
            title: path,
            role: 'listitem',
            onClick: function () { openWorkspaceDirectory(path) },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxSizing: 'border-box',
              minHeight: 48,
              padding: '6px 10px',
              borderRadius: TOKEN.radiusSm,
              cursor: 'pointer',
            },
          },
          [
            h('span', { key: 'mark', style: { display: 'inline-flex', width: 16, justifyContent: 'center', flex: 'none', color: TOKEN.labelFaint } }, ['◇']),
            h(
              'span',
              {
                key: 'path',
                style: { flex: 1, minWidth: 0, fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px', color: TOKEN.labelDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              },
              [String(path)],
            ),
            h(Badge, { key: 'open', tone: 'success' }, [t('badge.open')]),
          ],
        )
      }

      /**
       * The "open in editor" buttons: one per family member this host can prove.
       *
       * They live in the identity card's header row rather than in a section of
       * their own: opening the workspace in an editor is an action on that card's
       * subject, and the header had the room. The tooltip names the executable and
       * the target the host will actually use — the workspace file whenever one is
       * associated, the session root otherwise.
       */
      function EditorButtons() {
        var snapshot = useSnapshot()
        var editors = snapshot.editors
        if (editors === null || editors.length === 0) return null
        var value = snapshot.snapshot
        var target = value && value.file ? value.file : snapshot.rootDir
        return h(
          'div',
          {
            key: 'editors',
            role: 'group',
            'aria-label': t('label.editors'),
            style: { display: 'flex', gap: 6, flexWrap: 'wrap', flex: 'none', justifyContent: 'flex-end' },
          },
          editors.map(function (editor) {
            return h(
              Button,
              {
                key: editor.id,
                variant: 'outline',
                style: { height: 24, padding: '0 8px' },
                title: t('action.editor') + ' — ' + editor.label + '\n' + String(editor.executable || '') + '\n' + String(target || ''),
                disabled: snapshot.busy,
                onClick: function () { openInEditor(editor.id) },
              },
              [editor.label],
            )
          }),
        )
      }

      /**
       * Why there is no editor button: still loading, none installed, or SSH.
       *
       * A silent header would leave the user wondering whether the plugin broke,
       * so the explanation stays — as one small line, and only in that state.
       */
      function EditorNote() {
        var snapshot = useSnapshot()
        if (snapshot.editors !== null && snapshot.editors.length > 0) return null
        var text =
          snapshot.editors === null
            ? t('status.loading')
            : snapshot.editorsSsh
              ? t('hint.editorSsh')
              : t('hint.noEditor')
        return h('div', { key: 'editors-note', style: { fontSize: 11.5, lineHeight: '16px', color: TOKEN.labelFaint, padding: '2px 2px' } }, [text])
      }

      // ------------------------------------------------------------ sections

      /**
       * The workspace identity card: which file this is, where it lives, what the
       * session's root is, and the actions on it.
       *
       * The H1 is the FILE NAME — the tab strip above already says "Code
       * Workspace", so repeating it here would say nothing. The full path is the
       * subtitle, and the two directories are a definition grid, which is what
       * makes the second line explain itself instead of looking like a stray
       * string.
       */
      function IdentityCard(props) {
        var value = props.value
        var snapshot = props.snapshot
        var busy = props.busy === true
        var inView = props.inView === true
        // The fold belongs to the reading surface. The creation page's popover
        // exists only to pick a file, and its actions ARE the picker — never hide
        // them there, whatever this session left folded.
        var compact = snapshot.compact === true && inView
        var file = value.file ? String(value.file) : ''
        var heading = file ? lastSegment(file) : t('title.none')

        var metaValue = {
          fontFamily: TOKEN.mono,
          fontSize: 12,
          lineHeight: '18px',
          color: TOKEN.label,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          userSelect: 'text',
        }

        var headerRow = h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
          inView
            ? h(IconButton, {
              key: 'compact',
              small: true,
              title: compact ? t('action.expandDetails') : t('action.collapseDetails'),
              onClick: function () { patch({ compact: !compact }) },
            }, [compact ? '▸' : '▾'])
            : null,
          h('span', { key: 'icon', style: { display: 'inline-flex', alignItems: 'center', flex: 'none', color: TOKEN.labelFaint } }, [
            h(WorkspacePanelIcon, { size: 18 }),
          ]),
          h(
            'h1',
            {
              key: 'h1',
              title: file,
              style: {
                margin: 0,
                flex: 1,
                minWidth: 0,
                fontSize: 15,
                lineHeight: '22px',
                fontWeight: 500,
                color: TOKEN.label,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            [heading],
          ),
          busy ? h('span', { key: 'busy', style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint } }, [t('status.working')]) : null,
          h(EditorButtons, { key: 'editors' }),
          h(IconButton, { key: 'refresh', title: t('action.refresh'), disabled: busy, onClick: refresh }, ['⟳']),
          inView ? null : h(IconButton, { key: 'close', title: t('action.close'), onClick: closePanel }, ['✕']),
        ])

        var fileRow = file
          ? h('div', { key: 'file', style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } }, [
              h(
                'span',
                {
                  key: 'path',
                  title: file,
                  style: {
                    flex: 1,
                    minWidth: 0,
                    fontFamily: TOKEN.mono,
                    fontSize: 11.5,
                    lineHeight: '16px',
                    color: TOKEN.labelDim,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    userSelect: 'text',
                  },
                },
                [file],
              ),
              h(CopyPath, { key: 'copy', text: file }),
            ])
          : null

        // The definitions as one wrapping row of "label value" chips. The old
        // layout spent a 96px label column and a full row on each definition,
        // which on a narrow panel cost more height than the information is worth.
        var metaGroups = []
        var metaGroupStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }
        var metaLabelInline = { flex: 'none', fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint }
        if (value.rootDir) {
          metaGroups.push(h('div', { key: 'root', style: metaGroupStyle }, [
            h('span', { key: 'root-label', style: metaLabelInline }, [t('label.rootDir')]),
            h('span', { key: 'root-path', title: String(value.rootDir), style: metaValue }, [String(value.rootDir)]),
            h(Badge, { key: 'root-primary', tone: 'info' }, [t('badge.primary')]),
            value.workspace ? h(Badge, { key: 'root-registered', tone: 'success' }, [t('badge.open')]) : null,
            h(CopyPath, { key: 'root-copy', text: value.rootDir }),
          ]))
        }
        if (value.fileDir && value.fileDir !== value.rootDir) {
          metaGroups.push(h('div', { key: 'filedir', style: metaGroupStyle }, [
            h('span', { key: 'file-label', style: metaLabelInline }, [t('label.fileDir')]),
            h('span', { key: 'file-path', title: String(value.fileDir), style: metaValue }, [String(value.fileDir)]),
            h(CopyPath, { key: 'file-copy', text: value.fileDir }),
          ]))
        }

        var actions = h('div', { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } }, [
          h(
            Button,
            {
              key: 'switch',
              variant: 'outline',
              disabled: busy,
              onClick: function () {
                patch({ showBrowse: true, showRecent: false, creating: false })
                browseTo(fileBrowseStart())
              },
            },
            [t('action.openOther')],
          ),
          h(Button, {
            key: 'create',
            disabled: busy,
            ariaPressed: snapshot.creating === true,
            style: snapshot.creating ? { background: TOKEN.pressed, color: TOKEN.label } : undefined,
            onClick: function () {
              patch({ creating: snapshot.creating !== true, createName: '', showRecent: false, showBrowse: false })
            },
          }, [t('action.create')]),
          h(
            Button,
            {
              key: 'recent',
              ariaPressed: snapshot.showRecent === true,
              disabled: busy,
              style: snapshot.showRecent ? { background: TOKEN.pressed, color: TOKEN.label } : undefined,
              onClick: function () {
                patch({ showRecent: snapshot.showRecent !== true, showBrowse: false, creating: false })
                loadRecent(true)
              },
            },
            [t('action.recent')],
          ),
          value.file ? h(Button, { key: 'reveal', disabled: busy, onClick: function () { reveal(value.file) } }, [t('action.reveal')]) : null,
          value.workspace ? h(Button, { key: 'use', disabled: busy, onClick: function () { enterWorkspace(value) } }, [t('action.useWorkspace')]) : null,
          h(
            Button,
            {
              key: 'forget',
              danger: true,
              disabled: busy,
              // Pushed away from the navigation actions, and never given the
              // manager row's tooltip: the two "unlink" controls must not be
              // confusable by an accessible-name lookup.
              style: { marginLeft: 'auto' },
              onClick: function () {
                confirmThen(t('confirm.unlink'), function () { mutate('use ""', 'useFile', { file: '' }) })
              },
            },
            [t('action.forget')],
          ),
        ])

        // Compact keeps the title row and the folder tree; the paths, the actions
        // and whatever they opened are the management surface, and that is what
        // folds. A preview is a reading state, so opening one folds them.
        var stack = [headerRow]
        if (!compact) {
          if (fileRow) stack.push(fileRow)
          if (metaGroups.length > 0) {
            stack.push(
              h(
                'div',
                { key: 'meta', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 6, minWidth: 0 } },
                metaGroups,
              ),
            )
          }
          stack.push(actions)

          // The pickers the action row just opened sit directly under it. At the
          // foot of the page they were below the fold, so "切换文件" / "最近使用" read
          // as buttons that do nothing at all.
          if (Array.isArray(props.pickers)) {
            for (var pickerIndex = 0; pickerIndex < props.pickers.length; pickerIndex += 1) {
              if (props.pickers[pickerIndex] !== null && props.pickers[pickerIndex] !== undefined) stack.push(props.pickers[pickerIndex])
            }
          }
        }

        // The roots the file names, inside the same card: the workspace file and
        // the folders it brings are one subject, and two cards made the second
        // look like a separate feature.
        if (Array.isArray(props.folders)) {
          for (var folderIndex = 0; folderIndex < props.folders.length; folderIndex += 1) {
            stack.push(props.folders[folderIndex])
          }
        }

        return h(Card, { key: 'identity', padding: 14 }, [h('div', { key: 'stack', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, stack)])
      }

      /**
       * The no-workspace state: the page IS the picker.
       *
       * Its three actions are the only entry points while nothing is associated,
       * which is why the first one is the page's primary button in this state.
       */
      function EmptyWorkspace(props) {
        var busy = props.busy === true
        return h(Card, { padding: 0 }, [
          h(EmptyState, {
            key: 'state',
            title: t('title.none'),
            body: t('hint.noWorkspace'),
            actions: [
              h(Button, { key: 'switch', variant: 'primary', disabled: busy, onClick: function () { patch({ showRecent: false }); browseTo(browseStart()) } }, [
                t('action.openOther'),
              ]),
              h(Button, { key: 'create', disabled: busy, onClick: function () { patch({ showRecent: false }); createFile() } }, [t('action.create')]),
              h(Button, { key: 'pick', disabled: busy, onClick: pickNativeFile }, [t('action.nativePick')]),
            ],
          }),
        ])
      }

      /** The busy state as a skeleton card, so a slow read looks like a read. */
      function LoadingCard() {
        return h(Card, { padding: 16 }, [
          h('div', { key: 'bars', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
            h('div', { key: 'wide', style: { width: '40%', height: 12, borderRadius: TOKEN.radiusXs, background: TOKEN.skeleton } }),
            h('div', { key: 'narrow', style: { width: '72%', height: 10, borderRadius: TOKEN.radiusXs, background: TOKEN.skeleton } }),
          ]),
          h('div', { key: 'label', style: { marginTop: 8, fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint } }, [t('status.loading')]),
        ])
      }

      /**
       * The settled-but-empty state.
       *
       * It is the honest answer when the host returns no workspace file for this
       * directory (or when the directory could not be read), so it keeps saying
       * exactly that.
       */
      function NoDataCard() {
        return h(Card, { padding: 16 }, [
          h('div', { key: 'line', style: { fontSize: 13, lineHeight: '20px', color: TOKEN.labelDim } }, [t('hint.noFile')]),
        ])
      }

      /**
       * The conflict section: other files that name the same root.
       *
       * DSH keys a workspace by its root's canonical path, so those files ARE
       * this workspace, and only an explicit pick decides which root set the
       * session uses. Each row is addressed by the file path (its React key),
       * because the path is what the click passes on.
       */
      function ConflictSection(props) {
        var conflict = Array.isArray(props.conflict) ? props.conflict : []
        var hoverPair = React.useState(-1)
        var hovered = hoverPair[0]
        var setHovered = hoverPair[1]

        function rowNode(other, index) {
          return h(
            'div',
            {
              key: other,
              role: 'listitem',
              title: other,
              onClick: function () { openFile(other) },
              onMouseEnter: function () { setHovered(index) },
              onMouseLeave: function () { setHovered(-1) },
              style: {
                display: 'flex',
                alignItems: 'center',
                boxSizing: 'border-box',
                minHeight: 32,
                padding: '5px 10px',
                borderRadius: TOKEN.radiusSm,
                cursor: 'pointer',
                fontFamily: TOKEN.mono,
                fontSize: 12,
                lineHeight: '18px',
                color: TOKEN.link,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                background: hovered === index ? TOKEN.hover : 'transparent',
              },
            },
            [String(other)],
          )
        }

        var rows = []
        for (var index = 0; index < conflict.length; index += 1) rows.push(rowNode(conflict[index], index))

        return h('section', { key: 'conflict' }, [
          h(SectionHeader, { key: 'head', title: t('label.conflict'), count: t('label.workspaceCount', { count: conflict.length }) }),
          h(Card, { key: 'card', padding: 16 }, [
            h('div', { key: 'hint', style: { fontSize: 13, lineHeight: '20px', color: TOKEN.labelDim } }, [t('hint.conflict')]),
            h('div', { key: 'rows', role: 'list', style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 } }, rows),
          ]),
        ])
      }

      /** The recent-files section, toggled from the identity card's button. */
      function RecentSection(props) {
        var snapshot = useSnapshot()
        var recent = (snapshot.recent || []).filter(function (item) { return item.exists !== false })
        var hoverPair = React.useState(-1)
        var hovered = hoverPair[0]
        var setHovered = hoverPair[1]

        function rowNode(item, index) {
          return h(
            'div',
            {
              key: item.file,
              role: 'listitem',
              title: item.file,
              onClick: function () { openFile(item.file) },
              onMouseEnter: function () { setHovered(index) },
              onMouseLeave: function () { setHovered(-1) },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                boxSizing: 'border-box',
                minHeight: 40,
                padding: '9px 10px',
                borderRadius: TOKEN.radiusSm,
                cursor: 'pointer',
                background: hovered === index ? TOKEN.hover : 'transparent',
              },
            },
            [
              h(
                'span',
                {
                  key: 'icon',
                  style: { width: 16, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: TOKEN.labelFaint },
                },
                [h(FileTypeGlyph, { name: item.file })],
              ),
              h(
                'span',
                {
                  key: 'title',
                  style: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: '22px', color: TOKEN.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                [String(item.title || item.file)],
              ),
              h(
                'span',
                {
                  key: 'dir',
                  style: {
                    flex: 'none',
                    maxWidth: '55%',
                    marginLeft: 8,
                    fontSize: 12,
                    lineHeight: '18px',
                    color: TOKEN.labelFaint,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                [String(item.fileDir || '')],
              ),
            ],
          )
        }

        var rows = []
        for (var index = 0; index < recent.length; index += 1) rows.push(rowNode(recent[index], index))

        var body =
          rows.length === 0
            ? h('div', { key: 'empty', style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint, padding: '3px 10px' } }, [t('empty.recent')])
            : h(
                'div',
                { key: 'list', role: 'list', style: { maxHeight: 320, overflowY: 'auto', scrollbarGutter: 'stable', marginRight: 2, overscrollBehavior: 'contain' } },
                rows,
              )

        // Nested cards read as a card inside a card; a flat section drops the
        // material so it can sit inside the identity card without a second frame.
        var material = props.flat === true
          ? h('div', { key: 'card', style: { padding: '2px 0 0' } }, [body])
          : h(Card, { key: 'card', padding: 8 }, [body])
        return h('section', { key: 'recent' }, [
          h(SectionHeader, {
            key: 'head',
            title: t('action.recent'),
            action: h(IconButton, { key: 'close', small: true, title: t('action.close'), onClick: function () { patch({ showRecent: false }) } }, ['✕']),
          }),
          material,
        ])
      }

      /**
       * The two state banners, in the order they must be read.
       *
       * Shared by the panel body and the manager page: both trigger the same
       * actions and both must explain a failure in the same place, above the
       * content it left untouched.
       */
      function stateBanners(snapshot) {
        var children = []
        if (snapshot.error) {
          children.push(
            h(Banner, { key: 'error', tone: 'error', dismissible: true, onDismiss: function () { patch({ error: null }) } }, [String(snapshot.error)]),
          )
        }
        if (snapshot.notice) {
          children.push(
            h(
              Banner,
              {
                key: 'notice',
                tone: snapshot.noticeTone === 'success' ? 'success' : 'info',
                dismissible: true,
                onDismiss: function () { patch({ notice: null, noticeTone: 'info' }) },
              },
              [String(snapshot.notice)],
            ),
          )
        }
        return children
      }

      /**
       * The panel body, shared by the Conversation view page and the floating
       * overlay panel (the creation page's popover).
       *
       * Sections are assembled in one order (identity → folders → conflict →
       * editors → recent → browse), with the banners first. `variant: 'view'` is
       * the Conversation view, where the tab strip owns navigation, so the ✕ is
       * dropped; the popover keeps the ✕ that closes it. This is a DETAIL
       * surface: it says which file this session is on and lets the user change
       * that. The left column's page is the MANAGER and has its own body
       * ({@link ManagerBody}).
       */
      function PanelBody(props) {
        var inView = (props && props.variant === 'view') || viewIsActive()
        var snapshot = useSnapshot()
        var value = snapshot.snapshot
        var busy = snapshot.busy === true
        var hasValue = value !== null && value !== undefined
        // The file's folders, or — with no file — the session root as the single
        // folder of a one-folder workspace. Browsing the code is this page's job
        // either way, so the tree is never withheld just because no file declares
        // the folder; see {@link singleFolderRoot}.
        var roots = value && Array.isArray(value.roots) ? value.roots : []
        if (roots.length === 0 && hasValue && !value.file && snapshot.rootDir) {
          roots = [singleFolderRoot(snapshot.rootDir)]
        }
        // The project terminal shortcut is session-scoped: the right sidebar's
        // terminal belongs to the on-screen session. `terminalEnabled` is false
        // only when this composition has no terminal services at all, or when a
        // view was handed no session id — in that state the rows draw no button
        // rather than one that cannot work.
        var terminalAvailable = useShellAvailable()
        var sessionId = snapshot.sessionId || null
        var terminalEnabled = terminalAvailable && sessionId !== null

        // Quote-to-chat. The composer's standard kit is what a session-scope slot
        // receives; the creation page's popover has neither a session nor an
        // input, so it simply draws no quote affordance. Dragging a row into the
        // chat cannot work from inside the page (a page drag carries text, not
        // files), so the affordance this page offers is the semantic equivalent:
        // put the same `@path` reference into the draft that an Explorer drop of
        // that file would produce.
        var inputActions = props && props.inputActions
        var useInput = props && typeof props.useInput === 'function' ? props.useInput : selectNothing
        var draftText = useInput(function (input) {
          return input && typeof input.draft === 'string' ? input.draft : ''
        })
        var canQuote = Boolean(
          sessionId !== null &&
          inputActions &&
          typeof inputActions.captureInsertion === 'function' &&
          typeof inputActions.insertText === 'function',
        )

        function quoteToChat(path, directory) {
          if (!canQuote) return
          // A row hands over the entry it stands for, a folder row hands over its
          // resolved path; anything that is not a path is a wiring bug, and it must
          // not reach the draft as `@[object Object]`.
          if (typeof path !== 'string' || path === '') return
          var span = null
          try {
            span = inputActions.captureInsertion()
          } catch (error) {
            span = null
          }
          var target = String(path || '').replace(/\\/g, '/')
          if (directory === true) target += '/'
          var mention = formatMention(target, 'file', false)
          if (mention === undefined) {
            patch({ notice: t('notice.quoteUnsupported'), noticeTone: 'info' })
            return
          }
          if (span === null || typeof span.start !== 'number') {
            patch({ notice: t('notice.quoteBusy'), noticeTone: 'info' })
            return
          }
          var before = String(draftText || '').slice(0, span.start)
          var separator = before === '' || /\s$/.test(before) ? '' : ' '
          if (!inputActions.insertText(separator + mention + ' ', span)) {
            patch({ notice: t('notice.quoteBusy'), noticeTone: 'info' })
          }
        }
        var onQuote = canQuote ? quoteToChat : null

        // 1. State banners, before anything they explain.
        var children = stateBanners(snapshot)

        // 2. What the identity card's action row can open. It renders under that
        // row when the card exists; with no card (empty / loading / read failure)
        // it renders at page level instead, where the empty state's own buttons
        // put it. Either way it is on screen where the click happened, which is
        // what made these buttons look dead when the sections lived at the foot
        // of a page taller than the viewport.
        var pickers = []
        if (snapshot.creating === true) pickers.push(h(CreateFileForm, { key: 'create-form', snapshot: snapshot }))
        if (snapshot.showRecent === true) pickers.push(h(RecentSection, { key: 'recent', flat: true }))
        if (snapshot.showBrowse === true) pickers.push(h(BrowseSection, { key: 'browse', flat: true }))
        var pickersInCard = Boolean(snapshot.rootDir) && hasValue

        // 2. Identity, the empty state, or the read state.
        if (!snapshot.rootDir) {
          children.push(h(EmptyWorkspace, { key: 'empty', busy: busy }))
        } else if (!hasValue) {
          children.push(busy ? h(LoadingCard, { key: 'loading' }) : h(NoDataCard, { key: 'nodata' }))
        } else {
          // The folders ARE this workspace, so they render inside the same card:
          // one subject, one block. The form that grows the list sits under it,
          // collapsed to a single line — and only when a file exists to write it
          // to, since a folder list is declared by that file.
          var folderBlock = null
          if (value.file || roots.length > 0) {
            var folderChildren = [
              h('div', { key: 'rule', style: { height: 0, borderTop: '0.5px solid ' + TOKEN.line, margin: '2px 0' } }),
              h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } }, [
                h('span', { key: 'title', style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelDim } }, [t('label.roots')]),
                h('span', { key: 'count', style: { fontSize: 12, lineHeight: '18px', color: TOKEN.labelFaint } }, [t('label.folderCount', { count: roots.length })]),
              ]),
              h(FolderList, { key: 'list', flat: true, rootDir: snapshot.rootDir, roots: roots, snapshot: snapshot, busy: busy, sessionId: sessionId, terminalEnabled: terminalEnabled, onQuote: onQuote }),
            ]
            if (value.file) {
              folderChildren.push(
                h(AddFolderForm, {
                  key: 'form',
                  snapshot: snapshot,
                  onPathChange: function (next) { patch({ addPath: next }) },
                  onNameChange: function (next) { patch({ addName: next }) },
                  onSubmit: submitAdd,
                }),
              )
            }
            folderBlock = folderChildren
          }
          children.push(h(IdentityCard, { key: 'identity', value: value, snapshot: snapshot, busy: busy, inView: inView, folders: folderBlock, pickers: pickers }))
          if (value.error) {
            children.push(
              h(Banner, { key: 'parse', tone: 'warning', dismissible: false }, [t('warning.parse') + ' ' + String(value.error.message || '')]),
            )
          }
        }

        // 3. Only the conflict section is left outside the identity card: the
        // roots and their files are one tree inside it now.
        if (hasValue && value.file) {
          // A root named by several files is a fact the user must see.
          if (Array.isArray(value.conflict) && value.conflict.length > 0) {
            children.push(h(ConflictSection, { key: 'conflict', conflict: value.conflict }))
          }
        }

        // 4. Why there is no editor button, when that is the case; the buttons
        // themselves sit in the identity card's header row.
        if (snapshot.rootDir) children.push(h(EditorNote, { key: 'editors-note' }))
        if (!pickersInCard) {
          for (var pickerIndex = 0; pickerIndex < pickers.length; pickerIndex += 1) children.push(pickers[pickerIndex])
        }

        return h(
          'div',
          {
            role: 'main',
            'aria-busy': busy ? 'true' : undefined,
            style: { display: 'flex', flexDirection: 'column', gap: inView ? 16 : 12 },
          },
          children,
        )
      }

      /**
       * The manager page: the left column's entry, and the only surface that can
       * open a `.code-workspace` file before any session exists.
       *
       * It is deliberately NOT the Conversation view's detail card. That card
       * describes "the file this session is on" and its actions are scoped to a
       * session; this page has no session by construction, so a copy of the card
       * here could only answer with a global meaning and would push the list —
       * the page's actual subject — below the fold. So the page is the list plus
       * the two ways to add to it, and everything else lives where a session
       * exists to say it for.
       */
      function ManagerBody() {
        var snapshot = useSnapshot()
        var busy = snapshot.busy === true
        var children = stateBanners(snapshot)
        children.push(h(WorkspaceList, { key: 'workspaces', tools: h(ManagerTools, null) }))
        if (snapshot.showBrowse) children.push(h(BrowseSection, { key: 'browse' }))
        return h(
          'div',
          {
            role: 'main',
            'aria-busy': busy ? 'true' : undefined,
            style: { display: 'flex', flexDirection: 'column', gap: 16 },
          },
          children,
        )
      }

      /**
       * The manager page's actions: pick a file from disk, or re-read the list.
       *
       * "New workspace file" is absent on purpose: creating one needs a
       * directory to create it in, and this page has no session to supply one.
       * The surfaces that do have a directory — the Conversation tab and the
       * creation-page popover — keep that action.
       */
      function ManagerTools() {
        var snapshot = useSnapshot()
        var busy = snapshot.busy === true
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' } }, [
          h(
            Button,
            {
              key: 'switch',
              variant: 'primary',
              disabled: busy,
              onClick: function () {
                patch({ showRecent: false })
                browseTo(fileBrowseStart())
              },
            },
            [t('action.openOther')],
          ),
          h(Button, { key: 'pick', disabled: busy, onClick: pickNativeFile }, [t('action.nativePick')]),
          h(
            IconButton,
            {
              key: 'refresh',
              title: t('action.refresh'),
              disabled: busy,
              onClick: function () {
                loadRecent(true)
                refresh()
              },
            },
            ['⟳'],
          ),
        ])
      }

      function submitAdd() {
        var path = String(state.addPath || '').trim()
        if (path === '') return
        var displayName = String(state.addName || '').trim()
        patch({ addPath: '', addName: '' })
        mutate('add "' + path + '"', 'addFolder', { path: path, name: displayName })
      }

      /**
       * Create a workspace file in the session root, under a name the user typed.
       *
       * The name comes from an inline field, not `window.prompt`: the Desktop
       * renderer is Chromium with no prompt delegate, so `prompt()` throws there
       * and the button used to do nothing at all. `name` is also accepted from the
       * caller so Enter can submit the field's value without a second store read.
       */
      function createFile(name) {
        var dir = state.rootDir
        if (!dir) {
          patch({ error: t('error.noWorkspace') })
          return
        }
        var input = String(name === undefined ? state.createName : name).trim()
        if (input === '') return
        patch({ busy: true, error: null, creating: false })
        // Session mode rides the command channel for the same reason openFile
        // does: the new file's root association must be attributed to THIS
        // session, not merely to the directory.
        var action =
          state.mode === 'session' && state.sessionId
            ? runCommand(state.sessionId, 'create "' + String(input) + '"')
            : call('create', { rootDir: dir, name: input })
        action.then(
          function (value) {
            patch({ busy: false, createName: '', snapshot: value, rootDir: value && value.rootDir ? value.rootDir : dir, mode: 'workspace' })
            return enterWorkspace(value)
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      // ------------------------------------------------------------- surfaces

      var panelStyle = {
        position: 'fixed',
        top: 56,
        right: 16,
        width: 430,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 96px)',
        overflow: 'auto',
        padding: 12,
        boxSizing: 'border-box',
        background: TOKEN.overlay,
        border: '0.5px solid ' + TOKEN.lineStrong,
        borderRadius: TOKEN.radiusLg,
        boxShadow: TOKEN.shadow,
        color: TOKEN.label,
        // `shell.overlay` is click-through; every entry must opt back in.
        pointerEvents: 'auto',
        zIndex: 400,
      }

      /**
       * The floating panel: the creation page's popover.
       *
       * It is the only surface that can pick a `.code-workspace` file before a
       * session exists, so it stays — but only the hero-phase chip (and its
       * own ✕) may drive it. The anchor check is not decoration: this store
       * survives a page reload in the browser's session storage, so a panel that
       * was left open by an older build would otherwise float over every session
       * with nothing on screen able to close it. Anything addressed to another
       * surface simply does not render here, which retires that stale state the
       * first time this component draws.
       */
      function OverlayPanel() {
        var snapshot = useSnapshot()
        if (!snapshot.open || snapshot.anchor !== 'hero') return null
        return h('div', { style: panelStyle, onMouseDown: function (event) { event.stopPropagation() } }, [h(PanelBody, null)])
      }

      // ------------------------------------------------ the Conversation view

      /**
       * The layout service's `selectPanel`, when this composition has one.
       *
       * `selectPanel` is the cross-plugin navigation face and `selectPanel(null)`
       * is the documented way back to the Conversation (a panel id is validated,
       * `null` is not a panel). The registration below waits for the service and
       * records it here; nothing reads it before that callback runs.
       */
      var layoutService = null
      function layout() {
        return layoutService
      }

      /**
       * Whether this panel's Conversation view actually registered.
       *
       * The cell is registered from `ctx.inject(['layout'], …)`, so this is the
       * condition for "the tab strip is showing this page". The header button
       * asks it to decide whether it is needed at all: a tab is visible for the
       * whole session, and a second entry point for one page is noise.
       */
      var viewIsRegistered = false

      /** Whether the Conversation is currently showing this panel's page. */
      function viewIsActive() {
        var service = layout()
        var info = service && service.panelInfo
        if (!info || typeof info.getSnapshot !== 'function') return false
        try {
          var snapshot = info.getSnapshot()
          return Boolean(snapshot) && snapshot.activePanelId === VIEW_ID
        } catch (error) {
          return false
        }
      }

      /**
       * Show this panel's page.
       *
       * There is no overlay fallback here. The page and the floating sessionless
       * popover used to be two surfaces for one action, and a user who clicked
       * the header button could end up with both on screen — the page plus a
       * floating copy of it. So a composition without the layout service simply
       * has no page to show, and the header button does nothing rather than
       * opening a second window. The overlay stays registered for the one thing
       * the page cannot do: picking a workspace file on the creation page, where
       * no session exists yet.
       */
      function openWorkspaceView() {
        var service = layout()
        if (!service) return false
        // The sessionless popover is a different surface for the same panel; a
        // page opening must not leave it floating beside the page.
        if (state.open && state.anchor === 'hero') closePanel()
        try {
          service.selectPanel(VIEW_ID)
          return true
        } catch (error) {
          // `selectPanel` throws for a panel id the shell has not registered —
          // reachable if this bundle registered the view but the owner dropped
          // it. That is a state, not a failure: report it and change nothing.
          return false
        }
      }

      /** Back to the Conversation, which is how this panel is left. */
      function closeWorkspaceView() {
        var service = layout()
        if (!service) return false
        try {
          service.selectPanel(null)
          return true
        } catch (error) {
          return false
        }
      }

      /**
       * Make the panel address the session it is drawn for.
       *
       * The store is shared with the floating overlay and the creation-page
       * popover, so the view must scope it before rendering: otherwise a panel
       * left on session A would drive session B after the user switches, and the
       * `/code-workspace` command would land in the wrong conversation. This is
       * the single authority on which session the panel is on.
       *
       * A session change also drops the previous session's state: those folders
       * belong to a conversation this page is no longer showing, and painting
       * them while the new session loads would be a lie.
       */
      function syncPanelScope(sessionId, rootDir) {
        var dir = rootDir || null
        var target = sessionId || null
        // The page owns the panel from the moment it draws: a floating copy left
        // over from the creation page (or from a build that had an overlay
        // fallback) must not float beside the page it duplicates.
        if (state.open && state.anchor === 'hero') {
          closePanel()
          return
        }
        if (state.open && state.sessionId === target && state.rootDir === dir) return
        var next = { open: true, anchor: 'view', sessionId: target, rootDir: dir, mode: target ? 'session' : 'workspace', error: null, notice: null, noticeTone: 'info' }
        if (state.sessionId !== target) next.snapshot = null
        patch(next)
      }

      /**
       * Read the workspace state for the Conversation view, which just mounted.
       *
       * One read per mount: React mounts the view when its tab is selected and
       * unmounts it when the user leaves, so mounting *is* the "show me the
       * current state" gesture. The editor family is read here too, because that
       * section renders from the same snapshot: a session with no workspace file
       * still offers "open in editor", so the list must not wait for a workspace
       * read.
       */
      function ensureViewPanel(sessionId) {
        loadEditors()
        refresh()
      }

      /**
       * Read what the manager page shows, when it just mounted.
       *
       * The list is the page, so it is read fresh rather than through
       * {@link loadRecent}'s window: the reason to open this page is usually that
       * something changed elsewhere (a file picked on the creation page, a
       * workspace registered by the agent), and a cached answer would make the
       * manager report the state it had before that happened.
       */
      function ensureManagerPanel() {
        loadRecent(true)
        refresh()
      }

      /**
       * The Conversation view body.
       *
       * The owner renders one registered view at a time and hands it the standard
       * session kit, so the session address is `props.sessionId` and the root is
       * that session's `cwd` (falling back to whatever the store already holds
       * for the creation page, where there is no session).
       *
       * Layout: the owner's view area is a full-height flex column, so this fills
       * it and scrolls internally. The content keeps the Conversation's own
       * reading width (`--dsh-chat-content-width`, the token the transcript and
       * the width handle both use) because a workspace form stretched across a
       * wide window reads badly; the 24px gutters match that handle's geometry.
       * The token is read with a fallback so the page still lays out under a
       * theme that does not define it.
       */
      function WorkspaceView(props) {
        var sessionId = props.sessionId || null
        var rootDir = useRootDir(props) || state.rootDir || null

        syncPanelScope(sessionId, rootDir)
        React.useEffect(function () { ensureViewPanel(sessionId) }, [sessionId])

        return h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'center',
              flex: '1 1 auto',
              height: '100%',
              minHeight: 0,
              overflow: 'auto',
              boxSizing: 'border-box',
              scrollbarGutter: 'stable',
              background: TOKEN.bgBase,
              color: TOKEN.label,
            },
          },
          [
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  maxWidth: 'calc(var(--dsh-chat-content-width, 920px) + 48px)',
                  boxSizing: 'border-box',
                  padding: '24px 24px 40px',
                },
              },
              [h(PanelBody, { variant: 'view', useInput: props.useInput, inputActions: props.inputActions })],
            ),
          ],
        )
      }

      /**
       * Session header action: the entry point only when there is no tab to use.
       *
       * Once the panel registered as a Conversation view, the tab strip shows it
       * for the whole life of the session, so a header button would be a second
       * entry point for the same page — and the page count is what told us to
       * drop it. What the button still has is the composition where the view
       * could not register: there, no tab exists, and this is the only way into
       * the panel's page. So it renders on exactly that condition, and it never
       * opens the floating sessionless popover (that surface belongs to the
       * creation page).
       */
      function HeaderButton(props) {
        if (viewIsRegistered) return null
        var rootDir = useRootDir(props)
        return h(
          'button',
          {
            type: 'button',
            title: rootDir || t('title.none'),
            onClick: function () {
              if (closeIfActive()) return
              openWorkspaceView()
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px',
              fontSize: 12,
              lineHeight: '18px',
              color: TOKEN.label,
              background: TOKEN.fill,
              border: '1px solid ' + TOKEN.borderSoft,
              borderRadius: 6,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          ['◆ ' + t('label')],
        )
      }

      /**
       * The header button's toggle half: leave the page when it is the active view.
       */
      function closeIfActive() {
        if (!viewIsActive()) return false
        return closeWorkspaceView()
      }

      // -------------------------------------- the sidebar entry for the manager
      // One entry in the left column's panel list, next to the shipped Plugins and
      // Scheduled-tasks rows, so the manager is reachable WITHOUT a session: that
      // is the whole point of it. It shares its id with the Conversation view and
      // the `main` panel (see PANEL_KEY), so all three address one id — but the
      // sidebar page is the MANAGER (the list) and the Conversation view is the
      // DETAIL card for the session's own file.

      /**
       * The sidebar row's glyph.
       *
       * Geometry, not font: the row asks for a square edge in pixels (16–18) and
       * this bundle draws it, so no icon name has to exist upstream. A folder with
       * a workspace branch inside reads as "a workspace", which is the thing the
       * whole plugin is about.
       */
      function WorkspacePanelIcon(props) {
        var size = props && typeof props.size === 'number' ? props.size : 16
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          [
            h('path', {
              key: 'folder',
              d: 'M1.75 3.25h4.1l1.4 1.6h7v7.9h-12.5z',
              stroke: 'currentColor',
              strokeWidth: '1.2',
              strokeLinejoin: 'round',
            }),
            h('path', {
              key: 'branch',
              d: 'M5.6 7.4v3.3M5.6 8.4h3.1M8.7 6.6v2.0',
              stroke: 'currentColor',
              strokeWidth: '1.2',
              strokeLinecap: 'round',
            }),
            h('circle', { key: 'node-a', cx: '5.6', cy: '6.4', r: '1.0', stroke: 'currentColor', strokeWidth: '1.1' }),
            h('circle', { key: 'node-b', cx: '8.7', cy: '5.6', r: '1.0', stroke: 'currentColor', strokeWidth: '1.1' }),
          ],
        )
      }

      /**
       * Scope the store for the sessionless central panel.
       *
       * The panel has no session by construction, so it drives the host's
       * sessionless channel in `workspace` mode (see `refresh`). It still writes
       * the same store the Conversation view uses, because the panel body reads
       * its whole state from there; the view re-scopes that store on its own
       * render, so whichever surface is on screen owns it.
       */
      function syncPanelScopeGlobal(rootDir) {
        var dir = rootDir || null
        if (state.open && state.anchor === 'panel' && state.rootDir === dir) return
        var next = { open: true, anchor: 'panel', sessionId: null, rootDir: dir, mode: 'workspace', error: null, notice: null, noticeTone: 'info' }
        // Re-scoping to the same directory must not discard a snapshot that was
        // just read: another surface closing in between re-enters this function,
        // and dropping the value there would repaint an already-loaded page as
        // "no workspace file".
        if (state.rootDir !== dir) next.snapshot = null
        patch(next)
      }

      /**
       * The manager page behind the sidebar entry.
       *
       * Sessionless on purpose: this is how a profile that has no single-project
       * workspace open yet reaches a `.code-workspace` file at all. Picking one
       * registers its directory as a DSH workspace and, when `uiWorkspace` is
       * available, opens it — which is where a session comes from.
       *
       * The page is the list, not a copy of the Conversation tab's detail card:
       * the card's actions are session-scoped, and this page has no session. What
       * it keeps from the store is only the directory the browser should start
       * in (`rootDir`), so a file chosen on the creation page is still in scope
       * when this page is opened.
       */
      function WorkspacePanel() {
        var rootDir = state.rootDir || null

        syncPanelScopeGlobal(rootDir)
        React.useEffect(function () { ensureManagerPanel() }, [])

        return h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'center',
              height: '100%',
              minHeight: 0,
              overflow: 'auto',
              boxSizing: 'border-box',
              scrollbarGutter: 'stable',
              background: TOKEN.bgBase,
              color: TOKEN.label,
            },
          },
          [
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  maxWidth: 'calc(var(--dsh-chat-content-width, 920px) + 48px)',
                  boxSizing: 'border-box',
                  padding: '24px 24px 40px',
                },
              },
              [h(ManagerBody, null)],
            ),
          ],
        )
      }

      /**
       * Session-creation-page entry, inside the New Session row itself.
       *
       * `conversation.hero.options` is the shell's seat for compact chips at the
       * right end of the row that holds the workspace picker and the agent-preset
       * control, so this entry shares their line instead of taking one of its
       * own. It used to ride `conversation.input.dock`, the full-width band
       * directly above the composer card: that outlet is `display: contents`, so
       * the chip landed on a second line under the row users read as "the
       * toolbar" — one lone pill, one row of height, for no gain.
       *
       * No phase guard here, and that is deliberate: the row itself is drawn only
       * during the hero phase (`{hero && heroWorkspaceRow}` in the shell), so the
       * slot's own lifetime is the guard. The old dock entry had to test the
       * phase because its outlet is live in a finished conversation too — and
       * that test leaned on the dock's `props.session`, which this seat does not
       * pass. Keep the entry unconditional or it disappears.
       */
      function HeroChip(props) {
        var sessionId = props.sessionId
        var rootDir = useRootDir(props)
        var snapshot = useSnapshot()
        var active = snapshot.open && snapshot.anchor === 'hero'
        return h(
          'button',
          {
            type: 'button',
            title: rootDir ? rootDir : t('title.none'),
            onClick: function () {
              if (active) closePanel()
              else openPanel('hero', rootDir, sessionId || null, 'workspace')
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              minHeight: 28,
              padding: '0 9px',
              fontSize: 13,
              lineHeight: '20px',
              fontWeight: 500,
              color: rootDir ? TOKEN.label : TOKEN.labelDim,
              background: active ? TOKEN.hover : TOKEN.fill,
              border: '1px solid ' + TOKEN.borderSoft,
              borderRadius: 6,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            },
          },
          ['◆ ' + t('label.hero')],
        )
      }

      /**
       * The addressed session's workspace ROOT, from the standard kit.
       *
       * The session's `cwd` is the root by construction: it is what the plugin
       * asked `workspaceRegistry` for, which is the file's first existing
       * folder — not the directory the file lives in. The workspace service is
       * consulted as a fallback because some compositions publish only that.
       */
      function useRootDir(props) {
        var sessionId = props.sessionId
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing
        var useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : selectNothing
        // Both hook calls are unconditional so the hook order never changes.
        var fromSessions = useSessions(function (snapshot) {
          if (!snapshot || !snapshot.byId || !sessionId) return null
          var row = snapshot.byId[sessionId]
          return row && typeof row.cwd === 'string' ? row.cwd : null
        })
        var fromWorkspaces = useWorkspaces(function (snapshot) {
          if (!snapshot || !Array.isArray(snapshot.items) || !sessionId) return null
          for (var i = 0; i < snapshot.items.length; i += 1) {
            var item = snapshot.items[i]
            if (item && Array.isArray(item.sessionIds) && item.sessionIds.indexOf(sessionId) >= 0) return item.path
          }
          return null
        })
        return fromSessions || fromWorkspaces || null
      }

      /** A selector used only to keep an unavailable hook's call unconditional. */
      function selectNothing() {
        return null
      }

      /** A no-op store subscription, for a store the shell did not publish. */
      function noopSubscribe() {
        return function () {}
      }

      /** A stable empty snapshot, for a store the shell did not publish. */
      function noopSnapshot() {
        return null
      }

      // ------------------------------------------------------------ registers

      function tryRegister(slot, spec, component, claim) {
        try {
          slots.inject(slot, function () {
            if (typeof claim === 'function') claim()
            return slots.register(spec, component)
          })
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[dsh-code-workspace] cannot register ' + slot, error)
        }
      }

      tryRegister(
        'conversation.session.header.actions',
        { name: 'conversation.session.header.actions', id: ENTRY_ID, order: 30, label: function () { return t('label') }, locale: NS },
        HeaderButton,
      )

      // `inject` only runs once the owning package declares the seat, which is
      // what makes this slot degrade quietly on a shell that never declares it.
      // The timer is the one trace of that outcome: without the seat there is no
      // chip, and a silent absence is the hardest bug to report.
      var heroSeatClaimed = false
      tryRegister(
        'conversation.hero.options',
        { name: 'conversation.hero.options', id: ENTRY_ID, order: HERO_ORDER, label: function () { return t('label.hero') }, locale: NS },
        HeroChip,
        function () { heroSeatClaimed = true },
      )
      // Only worth arming when the seat was not there at apply time (a shell
      // that declares it late, or a composition that never declares it).
      if (!heroSeatClaimed && typeof setTimeout === 'function') {
        setTimeout(function () {
          if (heroSeatClaimed || typeof console === 'undefined') return
          console.warn('[dsh-code-workspace] conversation.hero.options never became available: the New Session row shows no code-workspace chip')
        }, 4000)
      }

      tryRegister('shell.overlay', { name: 'shell.overlay', id: PANEL_ID, order: PANEL_ORDER }, OverlayPanel)

      // ------------------------------- the left column entry + its central panel
      // Two halves under one id, which the shell itself stitches together: the
      // sidebar owns the button and the label, and `selectPanel(id)` (which is
      // what clicking it calls) renders the `main` cell registered under the SAME
      // id. No session is involved anywhere here, which is exactly why this entry
      // can exist on a profile that has no workspace open yet.
      //
      // `main` is a keyed slot and a fresh key cannot collide, so this is
      // additive: the shipped Conversation keeps its own `conversation` cell.
      tryRegister(
        'main',
        { name: 'main', key: PANEL_KEY },
        WorkspacePanel,
      )

      tryRegister(
        'sidebar.panellist',
        { name: 'sidebar.panellist', id: PANEL_KEY, order: SIDEBAR_ORDER, label: function () { return t('label.panel') }, locale: NS },
        WorkspacePanelIcon,
      )

      // ------------------------------------------- the Conversation view page
      // One registration, and the owner does the rest: `conversation.view` is the
      // list slot the tab strip walks, so this entry appears beside Chat /
      // Trajectory / Git and is rendered by id when selected. The owner also
      // feeds each entry the standard session kit, which is where the body's
      // `sessionId` comes from.
      //
      // Soft, on the layout service. It is the same package that declares that
      // slot and the only face that can select it, so:
      //
      //   * the callback waits for it instead of reading `ctx.get` once at apply
      //     time (loader rows activate in dependency order, and a one-shot read
      //     here would capture `undefined` for the rest of the plugin's life);
      //   * a composition without a Conversation never registers the cell, which
      //     is what the header button checks to know whether it is needed at all
      //     — a cell registered into an undeclared slot would only throw.
      if (ctx.inject) {
        ctx.inject(['layout'], function (scope) {
          layoutService = scope.layout && typeof scope.layout.selectPanel === 'function' ? scope.layout : null
          if (!layoutService) return
          tryRegister(
            'conversation.view',
            { name: 'conversation.view', id: VIEW_ID, order: VIEW_ORDER, label: function () { return t('title.tab') }, locale: NS },
            WorkspaceView,
          )
          viewIsRegistered = true
        })
      }

      // --------------------------------------------- the shipped "Open In…" cell
      // The shipped control cannot open a workspace: its host catalog is a
      // compile-time table (`OPEN_IN_APP_CATALOG`), its browser half filters ids
      // through a matching `APP_LABEL_KEY` map, and its launch route accepts only
      // an absolute DIRECTORY. So `<exe> <dir>` is all it can ever do, and the
      // multi-root `.code-workspace` window is unreachable through it.
      //
      // The slots ledger makes taking the cell over a supported move: a `list`
      // slot keeps one cell per id and the LOWEST priority for that id renders
      // (`dsh-client-ui-slots`), while same id at the SAME priority throws. This
      // bundle registers id `open-in-app` at priority -2, so:
      //
      //   * the shipped registration (priority 0) stays live underneath, and comes
      //     back untouched the moment this plugin is disposed;
      //   * `dsh-plugin-open-in-trae` (priority -1), if it is still installed, also
      //     stays registered and valid — different priority, no collision — and
      //     simply does not render while this plugin is loaded. Retiring that
      //     plugin afterwards is a cleanup, not a prerequisite.
      //
      // What is OURS: which family member is offered, which target it opens (the
      // workspace file whenever one is associated, the directory otherwise), and
      // the two additions the shipped catalog does not carry at all (VSCodium and
      // Trae / Trae CN). What stays SHIPPED: every other application, its name
      // (the `open-in-app` locale namespace), its icon and its launch — this
      // bundle only re-draws the cell and routes the family ids to this plugin's
      // own launcher.

      /** The shipped control's namespace and cell id, read and shadowed, never edited. */
      var SHIPPED_NS = 'open-in-app'
      var MENU_ID = 'open-in-app'
      /** Below the shipped 0 and below open-in-trae's -1: lowest renders. */
      var MENU_PRIORITY = -2
      /** Remembered editor, per browser; this plugin owns the key. */
      var MENU_CHOICE_KEY = 'dsh.code-workspace.editor'

      /** Primitives the takeover draws with; a missing one disables it instead of breaking a cell. */
      var REQUIRED_PRIMITIVES = [
        'Menu', 'Tooltip', 'Toast',
        'IconChevronDownOutlineRegular', 'IconRightUpOutlineRegular', 'IconWarningOutlineRegular',
      ]

      /** Every family id this bundle knows how to launch itself. */
      var FAMILY_IDS = { vscode: true, vscodeinsiders: true, vscodium: true, cursor: true, windsurf: true, trae: true }

      var MENU_CLASS = {
        menuAnchor: 'cws_menuAnchor',
        split: 'cws_split',
        main: 'cws_main',
        chevron: 'cws_chevron',
        appIcon: 'cws_appIcon',
      }

      /**
       * The shipped split button's own token-based rules, so the shadowed control
       * keeps the shipped border, radius, height and hover surface instead of
       * introducing a second visual language into the header.
       */
      var MENU_CSS = [
        '.cws_menuAnchor{flex:none;align-self:center;display:inline-flex}',
        '.cws_split{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);',
        'border-radius:var(--dsw-radius-sm);height:24px;font-family:var(--dsw-font-family);',
        'align-items:stretch;display:inline-flex;overflow:hidden}',
        '.cws_main,.cws_chevron{color:var(--dsw-alias-label-primary);white-space:nowrap;',
        'cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;',
        'font-size:11px;line-height:16px;display:inline-flex}',
        '.cws_main{gap:4px;padding:3px 5px}',
        '.cws_chevron{border-left:.5px solid var(--dsw-alias-border-l4);',
        'color:var(--dsw-alias-label-secondary);padding:3px 4px 3px 3px}',
        '.cws_main:hover:not(:disabled),.cws_main:focus-visible,',
        '.cws_chevron:hover:not(:disabled),.cws_chevron:focus-visible{',
        'background:var(--dsw-alias-interactive-bg-hover)}',
        '.cws_main:disabled,.cws_chevron:disabled{cursor:default}',
        '.cws_appIcon{object-fit:contain}',
        '.cws_split[data-size=large]{border-radius:var(--dsw-radius-md);',
        'border-color:var(--dsw-alias-border-l2);height:36px}',
        '.cws_split[data-size=large] .cws_main{gap:6px;padding:6px 14px;font-size:14px}',
        '.cws_split[data-size=large] .cws_chevron{padding:6px 10px}',
      ].join('')

      /**
       * A minimal snapshot store, so the menu shares one truth between the header
       * cell and the file-tree cell without a second module dependency.
       */
      function menuStore(initial) {
        var value = initial
        var listeners = []
        return {
          get: function () { return value },
          set: function (next) {
            if (next === value) return
            value = next
            for (var i = 0; i < listeners.length; i += 1) {
              try {
                listeners[i]()
              } catch (e) {
                /* a listener failure must never break the others */
              }
            }
          },
          subscribe: function (fn) {
            listeners.push(fn)
            return function () {
              var index = listeners.indexOf(fn)
              if (index >= 0) listeners.splice(index, 1)
            }
          },
        }
      }

      /**
       * The manifest, remembered choice and launch carrier of the takeover, one
       * instance per plugin life.
       *
       * The control is handed these through slot scope data, but a slot host may
       * not deliver them (DSH 0.2.2 stopped passing through a registering
       * plugin's own `hooks` bag), so the control also reaches the instance
       * directly. Rendering must never depend on that channel: an entry that
       * throws loses the whole cell, including the shipped control it shadows.
       */
      var openInAppRuntime = null

      /**
       * Subscribe a component to one store, with the same fallback the panel uses.
       *
       * A missing or foreign-shaped store is not a failure: it answers with the
       * supplied fallback, which is what keeps this control renderable on a
       * composition that does not deliver the runtime's stores.
       */
      function useMenuStore(store, fallback) {
        if (!store || typeof store.subscribe !== 'function' || typeof store.get !== 'function') return fallback
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(store.subscribe, store.get, store.get)
        }
        var pair = React.useState(0)
        var bump = pair[1]
        React.useEffect(function () {
          return store.subscribe(function () { bump(function (n) { return n + 1 }) })
        }, [])
        return store.get()
      }

      /** The remembered editor id, when the browser carries one. */
      function readMenuChoice() {
        try {
          return window.localStorage.getItem(MENU_CHOICE_KEY) || ''
        } catch (e) {
          return ''
        }
      }

      function writeMenuChoice(id) {
        try {
          window.localStorage.setItem(MENU_CHOICE_KEY, id)
        } catch (e) {
          /* a browser that refuses storage simply does not remember the choice */
        }
      }

      /**
       * Host reads, the remembered choice and the launch carrier, one per plugin
       * life so availability is read once and shared by every mounted cell.
       *
       * Shipped reads go to the shipped HTTP routes (they are the shipped host's
       * own); this plugin's own data goes over the shared RPC channel it already
       * uses for the panel. A failed read is an empty answer, never an error
       * surface: without the family the cell still lists the shipped entries.
       */
      function createOpenInAppController() {
        /** Shipped ids, in host order. */
        var shipped = menuStore([])
        /** Family members this host can prove. */
        var editors = menuStore([])
        /** The merged menu, rebuilt whenever either read (or an icon) lands. */
        var applications = menuStore([])
        /** Family ids this bundle launches itself; the rest go to the shipped route. */
        var ownIds = {}
        /** Family id -> data URL (null when extraction yielded none). */
        var icons = {}
        var choice = menuStore(readMenuChoice())
        var operation = menuStore({ phase: 'idle', id: null })
        var loading = null

        function shippedName(id) {
          if (!locale || typeof locale.bind !== 'function') return undefined
          var key = 'app.' + id
          var name = locale.bind(SHIPPED_NS)(key)
          return name === key ? undefined : name
        }

        function rebuild() {
          var shippedIds = shipped.get()
          var detected = editors.get()
          var byId = {}
          for (var i = 0; i < detected.length; i += 1) byId[detected[i].id] = detected[i]
          var next = []
          var own = {}
          for (var s = 0; s < shippedIds.length; s += 1) {
            var id = shippedIds[s]
            var name = shippedName(id)
            // An id the shipped label map does not name is dropped, exactly as the
            // shipped control drops it: the shipped set stays the shipped set.
            if (name === undefined) continue
            var detector = byId[id]
            if (FAMILY_IDS[id] === true && detector !== undefined) {
              own[id] = true
              next.push({ id: id, name: name, icon: 'open-in-app/icon/' + id, family: true })
            } else {
              next.push({ id: id, name: name, icon: 'open-in-app/icon/' + id, family: false })
            }
          }
          for (var d = 0; d < detected.length; d += 1) {
            var entry = detected[d]
            if (shippedIds.indexOf(entry.id) >= 0) continue
            own[entry.id] = true
            next.push({ id: entry.id, name: entry.label, icon: icons[entry.id] || null, family: true })
          }
          ownIds = own
          applications.set(next)
        }

        /** Icons this plugin must supply itself: the ones no shipped route serves. */
        function loadIcons(detected, shippedIds) {
          var pending = []
          for (var i = 0; i < detected.length; i += 1) {
            var id = detected[i].id
            if (shippedIds.indexOf(id) >= 0) continue
            if (Object.prototype.hasOwnProperty.call(icons, id)) continue
            icons[id] = null
            pending.push(
              call('editorIcon', { id: id }).then(
                function (value) { return value },
                function () { return null },
              ).then(function (value) {
                return function (dataUrl) {
                  icons[value] = dataUrl && dataUrl.dataUrl ? dataUrl.dataUrl : null
                }
              }(id)),
            )
          }
          return Promise.all(pending)
        }

        function readShipped() {
          if (typeof fetch !== 'function') return Promise.resolve([])
          return fetch('open-in-app/apps', { headers: { accept: 'application/json' } }).then(
            function (response) {
              if (!response.ok) return []
              return response.json().then(
                function (payload) {
                  return payload && Array.isArray(payload.apps) ? payload.apps.filter(function (id) { return typeof id === 'string' }) : []
                },
                function () { return [] },
              )
            },
            function () { return [] },
          )
        }

        function readEditors() {
          return call('editors', {}).then(
            function (value) { return value && Array.isArray(value.editors) ? value.editors : [] },
            function () { return [] },
          )
        }

        function load() {
          if (loading !== null) return loading
          loading = Promise.all([readShipped(), readEditors()]).then(function (values) {
            shipped.set(values[0])
            editors.set(values[1])
            rebuild()
            return loadIcons(values[1], values[0]).then(rebuild)
          })
          return loading
        }

        /**
         * Open one application on one directory, routing to the host that owns it.
         * A family id this bundle can launch goes to this plugin's own launcher,
         * which opens the workspace file when the session has one; everything else
         * keeps the shipped route and the shipped behaviour.
         */
        function launch(id, path) {
          operation.set({ phase: 'busy', id: id })
          var run
          if (ownIds[id] === true) {
            // The session id is attached only when the path IS this session's
            // root: the same control also serves the file tree, whose path can
            // be any folder, and a session id there would answer the wrong
            // question.
            var openArgs = { rootDir: path, editorId: id }
            if (state.rootDir && state.sessionId && pathKey(String(path)) === pathKey(String(state.rootDir))) {
              openArgs.sessionId = state.sessionId
            }
            run = call('openInEditor', openArgs)
          } else if (typeof fetch === 'function') {
            run = fetch('open-in-app/open', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ app: id, path: path }),
            }).then(function (response) {
              if (!response.ok) throw new Error('open failed: HTTP ' + String(response.status))
            })
          } else {
            run = Promise.reject(new Error('no transport for the shipped open route'))
          }
          return run.then(
            function () {
              operation.set({ phase: 'idle', id: null })
            },
            function (error) {
              operation.set({ phase: 'error', id: id })
              throw error
            },
          )
        }

        return {
          applications: applications,
          choice: choice,
          operation: operation,
          load: load,
          launch: launch,
          choose: function (id) {
            choice.set(id)
            writeMenuChoice(id)
          },
        }
      }

      /** One application image with a per-image fallback, as the shipped control renders it. */
      function MenuApplicationIcon(props) {
        var pair = React.useState(false)
        var failed = pair[0]
        var setFailed = pair[1]
        var source = props.source
        if (source === null || source === undefined || failed) {
          return h(primitives.IconRightUpOutlineRegular, { size: props.size === undefined ? 14 : props.size })
        }
        return h('img', {
          src: source,
          width: props.size === undefined ? 14 : props.size,
          height: props.size === undefined ? 14 : props.size,
          className: MENU_CLASS.appIcon,
          alt: '',
          draggable: false,
          onError: function () { setFailed(true) },
        })
      }

      /**
       * The split button and its application menu: the shipped control's shape,
       * with the family's own launch behind it.
       */
      function OpenInFamilyButton(props) {
        var menuPair = React.useState(false)
        var menuOpen = menuPair[0]
        var setMenuOpen = menuPair[1]
        var pendingPair = React.useState(false)
        var pending = pendingPair[0]
        var setPending = pendingPair[1]
        var failurePair = React.useState(null)
        var failure = failurePair[0]
        var setFailure = failurePair[1]
        var inFlight = React.useRef(false)
        var disabled = pending || props.busy === true
        var preferred = props.preferred
        var uiText = props.uiText

        var run = function (id, remember) {
          if (inFlight.current) return
          inFlight.current = true
          setPending(true)
          setMenuOpen(false)
          props.launch(id, props.path).then(
            function () {
              if (remember === true) props.choose(id)
            },
            function () {
              setFailure({ text: uiText('path.openError'), seq: Date.now() })
            },
          ).then(function () {
            inFlight.current = false
            setPending(false)
          })
        }

        var primaryLabel = uiText('open.title', { app: preferred.name })
        return h(React.Fragment, null, [
          h(
            primitives.Menu,
            {
              key: 'menu',
              className: MENU_CLASS.menuAnchor,
              open: menuOpen && !disabled,
              autoFocus: true,
              portal: true,
              dense: true,
              align: 'end',
              onClose: function () { setMenuOpen(false) },
              items: props.applications.map(function (app) {
                return {
                  id: 'app:' + app.id,
                  icon: h(MenuApplicationIcon, { key: app.id, source: app.icon }),
                  // The shipped control marks the application its main button will
                  // launch; an added entry follows the same rule.
                  label: app.id === preferred.id ? uiText('path.appDefault', { app: app.name }) : app.name,
                }
              }),
              onSelect: function (itemId) { run(itemId.slice(4), true) },
              anchor: h(
                'div',
                {
                  className: MENU_CLASS.split,
                  // What this control PREFERS to open. The host still falls back to
                  // the session root when the session has no workspace file,
                  // which is the one case where a directory is the honest target.
                  'data-open-target': 'workspace',
                  'data-code-workspace': true,
                  'data-size': 'compact',
                  'data-state': disabled ? 'busy' : 'idle',
                },
                [
                  h(
                    primitives.Tooltip,
                    {
                      key: 'primary',
                      portal: true,
                      label: primaryLabel,
                      side: 'bottom',
                      delayMs: 500,
                      children: h(
                        'button',
                        {
                          type: 'button',
                          className: MENU_CLASS.main,
                          disabled: disabled,
                          'aria-label': primaryLabel,
                          onClick: function () { run(preferred.id, false) },
                        },
                        h(MenuApplicationIcon, { source: preferred.icon, size: 13 }),
                      ),
                    },
                  ),
                  h(
                    'button',
                    {
                      key: 'chevron',
                      type: 'button',
                      className: MENU_CLASS.chevron,
                      disabled: disabled,
                      'aria-haspopup': 'menu',
                      'aria-expanded': menuOpen && !disabled,
                      'aria-label': uiText('path.more'),
                      onClick: function () { setMenuOpen(function (value) { return !value }) },
                    },
                    h(primitives.IconChevronDownOutlineRegular, { size: 10 }),
                  ),
                ],
              ),
            },
          ),
          failure === null
            ? null
            : h(
                primitives.Toast,
                {
                  key: 'toast',
                  text: failure.text,
                  icon: h(primitives.IconWarningOutlineRegular, {}),
                  onDone: function () { setFailure(null) },
                },
                failure.seq,
              ),
        ])
      }

      /** The control itself: applications, the remembered choice and the launch. */
      function OpenInFamilyControl(props) {
        var runtime = openInAppRuntime
        if (runtime === null) return null
        var scope = props && props.hooks ? props.hooks : {}
        var applications = useMenuStore(scope.openInAppFamily || runtime.applications, [])
        var choice = useMenuStore(scope.openInAppChoice || runtime.choice, readMenuChoice())
        var operation = useMenuStore(scope.openInAppLaunch || runtime.operation, { phase: 'idle', id: null })
        var preferred = null
        for (var i = 0; i < applications.length; i += 1) {
          if (applications[i].id === choice) preferred = applications[i]
        }
        if (preferred === null && applications.length > 0) preferred = applications[0]
        if (preferred === null) return null
        return h(OpenInFamilyButton, {
          applications: applications,
          preferred: preferred,
          path: props.absolutePath,
          busy: operation && operation.phase === 'busy',
          uiText: props.uiText || runtime.uiText,
          launch: props.launch || runtime.launch,
          choose: props.choose || runtime.choose,
        })
      }

      /** Session header cell: the directory is the Session's `cwd`, as the shipped cell reads it. */
      function OpenInFamilySessionAction(props) {
        var sessionId = props.sessionId
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing
        var cwd = useSessions(function (snapshot) {
          if (!snapshot || !snapshot.byId || !sessionId) return null
          var row = snapshot.byId[sessionId]
          return row && typeof row.cwd === 'string' ? row.cwd : null
        })
        return cwd ? h(OpenInFamilyControl, Object.assign({}, props, { absolutePath: cwd })) : null
      }

      /** File tree cell: the tree hands its root down as `absolutePath`. */
      function OpenInFamilyPathAction(props) {
        return props.absolutePath ? h(OpenInFamilyControl, props) : null
      }

      /**
       * Offer the family inside the shipped control's cell. Skipped — leaving the
       * shipped control in place — when the primitives are unavailable, because a
       * shadow that cannot render a menu would remove a working control instead of
       * extending it.
       */
      function registerOpenInFamily() {
        if (primitives === null) return
        var missing = []
        for (var i = 0; i < REQUIRED_PRIMITIVES.length; i += 1) {
          if (primitives[REQUIRED_PRIMITIVES[i]] === undefined) missing.push(REQUIRED_PRIMITIVES[i])
        }
        if (missing.length > 0) {
          if (typeof console !== 'undefined') {
            console.warn('[dsh-code-workspace] client primitives ' + missing.join(', ') + ' are unavailable; leaving the shipped "Open In…" control in place')
          }
          return
        }

        try {
          if (typeof document !== 'undefined') {
            ctx.effect(function () {
              var tag = document.createElement('style')
              tag.dataset.plugin = 'dsh-code-workspace'
              tag.textContent = MENU_CSS
              document.head.appendChild(tag)
              return function () { tag.remove() }
            }, 'dsh-code-workspace: menu styles')
          }
        } catch (e) {
          /* no DOM: the takeover simply renders unstyled */
        }

        var controller = createOpenInAppController()
        controller.load()
        var uiText = function (key, params) {
          if (!locale || typeof locale.bind !== 'function') return t(key, params)
          var text = locale.bind(SHIPPED_NS)(key, params)
          return text === key ? t(key, params) : text
        }
        openInAppRuntime = {
          applications: controller.applications,
          choice: controller.choice,
          operation: controller.operation,
          load: controller.load,
          launch: controller.launch,
          choose: controller.choose,
          uiText: uiText,
        }
        try {
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () { openInAppRuntime = null }
            }, 'dsh-code-workspace: open-in runtime')
          }
        } catch (effectError) {
          /* the cell simply keeps a runtime that outlives its registrations */
        }
        var injected = function () {
          return {
            hooks: {
              openInAppFamily: controller.applications,
              openInAppChoice: controller.choice,
              openInAppLaunch: controller.operation,
            },
            uiText: uiText,
            launch: controller.launch,
            choose: controller.choose,
          }
        }

        // `locale: NS` contributes `t`; `inject` contributes the rest. `priority`
        // is what makes this a shadow rather than a duplicate.
        tryRegister(
          'conversation.session.header.utilities',
          { name: 'conversation.session.header.utilities', id: MENU_ID, priority: MENU_PRIORITY, order: -10, locale: NS, inject: injected },
          OpenInFamilySessionAction,
        )
        tryRegister(
          'sidebar.right.tab.files.actions',
          { name: 'sidebar.right.tab.files.actions', id: MENU_ID, priority: MENU_PRIORITY, locale: NS, inject: injected },
          OpenInFamilyPathAction,
        )
      }

      registerOpenInFamily()

      // ------------------------------------------------- `@` companion group
      // The shipped `@` provider builds exactly one searcher from the session
      // cwd and refuses every candidate outside it, so another workspace folder
      // is unreachable through it. This companion group answers from the
      // plugin's own endpoint and leaves the shipped group untouched.

      ctx.inject(['inputTriggers'], function (scope) {
        var registry = scope.inputTriggers
        if (!registry || typeof registry.registerSource !== 'function') return
        scope.effect(function () {
          return registry.registerSource({
            trigger: '@',
            name: NS,
            order: 10,
            showGroupTitle: false,
            candidates: function (session, request) {
              if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return Promise.resolve([])
              var summary = sessions.list.getSnapshot().byId[session.sessionId]
              var rootDir = summary && summary.cwd
              if (!rootDir) return Promise.resolve([])
              var preserveQuote = request.quoted === true
              // The session id goes along so a root named by several files
              // indexes the folders of the file THIS session is on.
              return call('listFiles', { rootDir: rootDir, query: request.query, sessionId: session.sessionId || undefined }).then(
                function (value) {
                  var items = value && Array.isArray(value.candidates) ? value.candidates : []
                  var rows = []
                  for (var i = 0; i < items.length; i += 1) {
                    rows = rows.concat(fileRow(items[i], preserveQuote))
                  }
                  return rows
                },
                // Discovery is advisory: a failure is an empty group, never a
                // broken composer and never a failed send.
                function () { return [] },
              )
            },
            onPick: function (pick) {
              var chosen = rowValue(pick.candidate.value)
              if (chosen === undefined) return undefined
              var name = lastSegment(chosen.path)
              if (chosen.kind === 'directory' && pick.action === 'drill') {
                return { text: chosen.mention, continue: true }
              }
              return {
                insert: {
                  source: NS,
                  ref: chosen.mention,
                  label: chosen.kind === 'directory' ? name + '/' : name,
                  appearance: chosen.kind === 'directory' ? 'folder' : 'file',
                  clipboardText: chosen.mention,
                },
              }
            },
            // The mention IS the model form, so serialization is the identity.
            codec: {
              clipboardText: function (ref) { return ref },
              serialize: function (ref) { return Promise.resolve(ref) },
            },
          })
        }, 'dsh-code-workspace: @ discovery source')
      })

      // ----------------------------------------------------------- @ helpers

      function lastSegment(path) {
        var parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/)
        return parts.length === 0 ? '' : parts[parts.length - 1]
      }

      /** Shorten a path under the host home to a `~`-prefixed heading. */
      function abbreviate(path) {
        var home = remote && remote.$host ? remote.$host.home : undefined
        if (!home) return path
        var flat = String(path).replace(/\\/g, '/')
        var prefix = String(home).replace(/\\/g, '/')
        if (flat.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) return path
        return '~' + flat.slice(prefix.length)
      }

      /**
       * Mention text for one discovered path. Mirrors the shipped grammar:
       * whitespace quotes the path, a quoted directory keeps its quote open so
       * completion can descend, and a path with control characters or an
       * embedded quote is unrepresentable (the row is dropped rather than
       * inserted broken).
       */
      function formatMention(path, kind, preserveQuote) {
        var text = kind === 'directory' ? path + '/' : path
        if (/[\u0000-\u001f\u007f-\u009f"]/.test(text)) return undefined
        if (!preserveQuote && !/\s/.test(text)) return '@' + text
        return kind === 'directory' ? '@"' + text : '@"' + text + '"'
      }

      function rowValue(value) {
        if (typeof value !== 'string') return undefined
        try {
          var parsed = JSON.parse(value)
          return parsed && typeof parsed.mention === 'string' ? parsed : undefined
        } catch (e) {
          return undefined
        }
      }

      function fileRow(candidate, preserveQuote) {
        var path = String(candidate.path || '').replace(/\\/g, '/')
        var kind = candidate.dir === true ? 'directory' : 'file'
        var mention = formatMention(path, kind, preserveQuote)
        if (mention === undefined) return []
        var rel = String(candidate.rel || '')
        var name = rel === '' ? lastSegment(path) : lastSegment(rel)
        var slash = rel.lastIndexOf('/')
        var parent = slash < 0 ? '' : rel.slice(0, slash)
        var heading = abbreviate(String(candidate.rootPath || candidate.rootLabel || ''))
        var attributes = {
          name: kind === 'directory' ? name + '/' : name,
          icon: kind === 'directory' ? 'folder' : 'file',
          section: heading,
          value: JSON.stringify({ kind: kind, path: path, mention: mention }),
        }
        if (parent !== '') attributes.description = parent
        if (kind === 'directory') attributes.drill = true
        return [attributes]
      }

      // The panel is reachable from any workspace modal; a click on the
      // backdrop closes it. Wrapped because a test environment has no `document`.
      try {
        if (typeof document !== 'undefined') {
          ctx.effect(function () {
            var onKey = function (event) {
              if (event.key === 'Escape' && state.open) closePanel()
            }
            document.addEventListener('keydown', onKey)
            return function () {
              document.removeEventListener('keydown', onKey)
            }
          }, 'dsh-code-workspace: escape-to-close')
        }
      } catch (e) {
        /* no DOM: the panel simply has no keyboard shortcut */
      }
    }

    return { name: name, inject: inject, apply: apply }
  },
})
