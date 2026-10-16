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
 * - `conversation.session.header.actions` — that toggle, beside the session title.
 * - `conversation.input.dock` — the session-creation page entry, in the same
 *   band as the shipped git-branch chip. It renders only in the hero phase, so
 *   the session header entry and this one never appear together.
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
     * panel, the dock chip, the `@` group) keeps working. A hard `require` would
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
    /** The shipped dock rows use 10–20; sit clearly after them. */
    var DOCK_ORDER = 120
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
      'hint.view': '工作区是「对话 / 轨迹 / Git」旁边的一个页签；点回「对话」即可继续聊天。',
      'hint.noWorkspace': '这个会话还没有关联 .code-workspace 文件。可以直接挑一个：',
      'hint.noFile': '该目录下没有 .code-workspace 文件。',
      'hint.pickFile': '选择一个 .code-workspace 文件：',
      'action.open': '打开工作区文件',
      'action.openOther': '切换文件',
      'action.nativePick': '从资源管理器选择…',
      'hint.noNativePicker': '这台主机打不开系统文件对话框，请用下面的目录浏览器选：',
      'action.create': '新建工作区文件',
      'action.recent': '最近使用',
      'action.refresh': '刷新',
      'action.reveal': '在资源管理器中显示',
      'action.editor': '在编辑器中打开',
      'label.editors': '在编辑器中打开',
      'hint.noEditor': '未检测到 VS Code 系列编辑器（VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae）。',
      'hint.editorSsh': '该 Harness 是通过 SSH 访问的：浏览器这一端不是主机，无法在主机上打开编辑器。',
      'notice.opened': '已用 {app} 打开：{target}',
      'action.add': '添加文件夹',
      'action.remove': '移除',
      'action.rename': '重命名',
      'action.forget': '取消关联',
      'confirm.forget': '从列表里移除这条记录？工作区文件本身不会被删除。',
      'action.up': '上移',
      'action.down': '下移',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.confirm': '确定',
      'action.parent': '上级',
      'action.newFolder': '新建文件夹',
      'action.useWorkspace': '打开该工作区',
      'field.folderPath': '文件夹路径（相对或绝对）',
      'field.folderName': '显示名称（可选）',
      'field.workspaceName': '工作区文件名',
      'label.roots': '工作区文件夹',
      'label.workspaces': '代码工作区',
      'empty.workspaces': '还没有记录过任何 .code-workspace 文件。用上面的按钮挑一个：',
      'badge.open': '已注册',
      'label.file': '工作区文件',
      'label.browse': '浏览目录',
      'badge.primary': '主目录',
      'badge.missing': '不存在',
      'status.loading': '加载中…',
      'empty.recent': '暂无记录',
      'empty.roots': '该工作区文件里还没有 folders。',
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
    }

    var en = {
      label: 'Code Workspace',
      'label.panel': 'Code Workspace',
      'label.hero': 'Code Workspace',
      'title': 'Code Workspace',
      'title.none': 'No .code-workspace file',
      'title.tab': 'Code Workspace',
      'hint.view': 'The workspace is a tab beside Chat / Trajectory / Git; click Chat to go back.',
      'hint.noWorkspace': 'This session has no .code-workspace file yet. Pick one directly:',
      'hint.noFile': 'This directory has no .code-workspace file.',
      'hint.pickFile': 'Pick a .code-workspace file:',
      'action.open': 'Open workspace file',
      'action.openOther': 'Switch file',
      'action.nativePick': 'Choose in Explorer…',
      'hint.noNativePicker': 'This host cannot show a system file dialog — use the browser below:',
      'action.create': 'New workspace file',
      'action.recent': 'Recent',
      'action.refresh': 'Refresh',
      'action.reveal': 'Show in file manager',
      'action.editor': 'Open in editor',
      'label.editors': 'Open in editor',
      'hint.noEditor': 'No VS Code family editor was found (VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae).',
      'hint.editorSsh': 'This Harness was reached over SSH: the browser is not on the host, so no editor can be opened there.',
      'notice.opened': 'Opened in {app}: {target}',
      'action.add': 'Add folder',
      'action.remove': 'Remove',
      'action.rename': 'Rename',
      'action.forget': 'Unlink',
      'confirm.forget': 'Remove this record from the list? The workspace file itself is not deleted.',
      'action.up': 'Move up',
      'action.down': 'Move down',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.confirm': 'OK',
      'action.parent': 'Up',
      'action.newFolder': 'New folder',
      'action.useWorkspace': 'Open this workspace',
      'field.folderPath': 'Folder path (relative or absolute)',
      'field.folderName': 'Display name (optional)',
      'field.workspaceName': 'Workspace file name',
      'label.roots': 'Workspace folders',
      'label.workspaces': 'Code workspaces',
      'empty.workspaces': 'No .code-workspace file has been recorded yet. Pick one with the buttons above:',
      'badge.open': 'registered',
      'label.file': 'Workspace file',
      'label.browse': 'Browse',
      'badge.primary': 'primary',
      'badge.missing': 'missing',
      'status.loading': 'Loading…',
      'empty.recent': 'Nothing yet',
      'empty.roots': 'This workspace file has no folders yet.',
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
    }

    // ------------------------------------------------------------------ tokens
    // Only `--dsw-alias-*` semantic tokens, each with an inert fallback, so the
    // panel restyles with every theme without any light/dark branching.

    var TOKEN = {
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      layer: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))',
      fill: 'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
      label: 'var(--dsw-alias-label-primary, #1f1f1f)',
      labelDim: 'var(--dsw-alias-label-secondary, rgba(31,31,31,0.65))',
      labelFaint: 'var(--dsw-alias-label-tertiary, rgba(31,31,31,0.45))',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-state-error-primary, #d93f3f)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      radius: 'var(--dsw-alias-border-radius-base, 8px)',
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
        containerDir: null,
        snapshot: null,
        recent: [],
        showRecent: false,
        showBrowse: false,
        browse: null,
        addPath: '',
        addName: '',
        newName: '',
        renameIndex: -1,
        renameValue: '',
        busy: false,
        error: null,
        notice: null,
        editors: null,
        editorsSsh: false,
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
      function readOpenWorkspaces() {
        if (openWorkspacesCache !== null) return openWorkspacesCache
        var list = workspaces && workspaces.list
        if (!list || typeof list.getSnapshot !== 'function') return {}
        try {
          var snapshot = list.getSnapshot()
          var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          var out = {}
          for (var i = 0; i < items.length; i += 1) {
            var path = items[i] && items[i].path
            if (typeof path === 'string' && path !== '') out[pathKey(path)] = path
          }
          openWorkspacesCache = out
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
        if (!snapshot.containerDir) {
          patch({ snapshot: null, error: null })
          return Promise.resolve()
        }
        patch({ busy: true, error: null })
        var load
        if (snapshot.mode === 'session' && snapshot.sessionId) {
          load = runCommand(snapshot.sessionId, 'list')
        } else {
          load = call('state', { containerDir: snapshot.containerDir })
        }
        return load.then(
          function (value) {
            if (state.containerDir !== snapshot.containerDir) return
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
        if (!snapshot.containerDir) {
          patch({ error: t('error.noWorkspace') })
          return Promise.resolve()
        }
        patch({ busy: true, error: null, notice: null })
        var action
        if (snapshot.mode === 'session' && snapshot.sessionId) {
          action = runCommand(snapshot.sessionId, line)
        } else {
          action = call(endpoint, Object.assign({ containerDir: snapshot.containerDir }, args))
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
       * @param anchor - the surface that opened it (`header` | `dock`).
       * @param containerDir - the workspace directory the panel addresses.
       * @param sessionId - the addressed session, when there is one.
       * @param mode - `session` drives the `/code-workspace` command so the
       *   conversation shows the change and the agent is notified at its next
       *   message boundary; `workspace` uses the sessionless channel, which is
       *   the only one available before any session exists. The dock entry is
       *   the session-creation page, so it always opens in `workspace` mode even
       *   though the shell already has a blank session bound to it.
       */
      function openPanel(anchor, containerDir, sessionId, mode) {
        var dir = containerDir || state.containerDir || null
        patch({
          open: true,
          anchor: anchor,
          containerDir: dir,
          sessionId: sessionId || null,
          mode: mode || (sessionId ? 'session' : 'workspace'),
          showBrowse: false,
          showRecent: false,
          browse: null,
          error: null,
          notice: null,
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

      /** Open one `.code-workspace` file, register its directory, and enter it. */
      function openFile(file) {
        patch({ busy: true, error: null, notice: null })
        return call('open', { file: file }).then(
          function (value) {
            patch({
              busy: false,
              showBrowse: false,
              showRecent: false,
              containerDir: value && value.containerDir ? value.containerDir : state.containerDir,
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
          patch({ notice: t('workspace.registered') + ' ' + String(workspace.path || '') })
          return Promise.resolve()
        }
        return Promise.resolve(nav.openWorkspace(workspace.id)).catch(function (error) {
          patch({ notice: t('workspace.registered') + ' ' + String(workspace.path || ''), error: messageOf(error) })
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
        return home || state.containerDir || ''
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
       * opens the container directory. Either way the answer states which was
       * used, and the panel says so.
       */
      function openInEditor(editorId) {
        var dir = state.containerDir
        if (!dir) {
          patch({ error: t('error.noWorkspace') })
          return Promise.resolve()
        }
        patch({ busy: true, error: null, notice: null })
        return call('openInEditor', { containerDir: dir, editorId: editorId }).then(
          function (value) {
            var result = value || {}
            patch({
              busy: false,
              notice: t('notice.opened', { app: result.label || String(editorId), target: result.target || dir }),
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

      function labelStyle(extra) {
        return Object.assign({ color: TOKEN.label, fontSize: 12, lineHeight: '18px' }, extra || {})
      }

      function Button(props) {
        var style = Object.assign(
          {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 8px',
            fontSize: 12,
            lineHeight: '18px',
            color: props.danger ? TOKEN.danger : TOKEN.label,
            background: TOKEN.fill,
            border: '1px solid ' + TOKEN.borderSoft,
            borderRadius: 6,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.5 : 1,
            whiteSpace: 'nowrap',
          },
          props.style || {},
        )
        return h(
          'button',
          {
            type: 'button',
            title: props.title || undefined,
            disabled: props.disabled === true,
            onClick: props.disabled ? undefined : props.onClick,
            style: style,
          },
          [props.children],
        )
      }

      function Badge(props) {
        return h(
          'span',
          {
            style: {
              fontSize: 10,
              lineHeight: '14px',
              padding: '0 5px',
              borderRadius: 999,
              border: '1px solid ' + TOKEN.borderSoft,
              color: props.tone === 'warn' ? TOKEN.warn : props.tone === 'danger' ? TOKEN.danger : TOKEN.labelDim,
              background: TOKEN.subtle,
            },
          },
          [props.children],
        )
      }

      function TextInput(props) {
        return h('input', {
          type: 'text',
          value: props.value,
          placeholder: props.placeholder,
          spellCheck: false,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && props.onEnter) props.onEnter()
          },
          style: {
            flex: 1,
            minWidth: 0,
            padding: '3px 7px',
            fontSize: 12,
            lineHeight: '18px',
            color: TOKEN.label,
            background: TOKEN.layer,
            border: '1px solid ' + TOKEN.borderSoft,
            borderRadius: 6,
            outline: 'none',
          },
        })
      }

      function Row(props) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 0',
              borderTop: '1px solid ' + TOKEN.borderSoft,
            },
          },
          props.children,
        )
      }

      /** One workspace folder entry. */
      function FolderRow(props) {
        var root = props.root
        var renaming = props.renaming
        return h(Row, null, [
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            renaming
              ? h(TextInput, {
                  value: props.renameValue,
                  placeholder: t('field.folderName'),
                  onChange: props.onRenameChange,
                  onEnter: props.onRenameCommit,
                })
              : h('div', null, [
                  h('div', { style: labelStyle({ fontWeight: 500 }) }, [
                    String(root.label || ''),
                    root.isPrimary ? h(Badge, null, [t('badge.primary')]) : null,
                    root.exists === false ? h(Badge, { tone: 'warn' }, [t('badge.missing')]) : null,
                  ]),
                  h(
                    'div',
                    {
                      title: root.resolvedPath,
                      style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                    },
                    [String(root.resolvedPath || '')],
                  ),
                ]),
          ),
          renaming
            ? h('div', { style: { display: 'flex', gap: 4 } }, [
                h(Button, { onClick: props.onRenameCommit }, [t('action.confirm')]),
                h(Button, { onClick: props.onRenameCancel }, [t('action.cancel')]),
              ])
            : h('div', { style: { display: 'flex', gap: 4 } }, [
                h(Button, { title: t('action.up'), disabled: props.first, onClick: props.onMoveUp }, ['↑']),
                h(Button, { title: t('action.down'), disabled: props.last, onClick: props.onMoveDown }, ['↓']),
                h(Button, { title: t('action.rename'), onClick: props.onRenameStart }, ['✎']),
                h(Button, { title: t('action.reveal'), onClick: props.onReveal }, ['⧉']),
                h(Button, { title: t('action.remove'), danger: true, onClick: props.onRemove }, ['✕']),
              ]),
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
        patch({ busy: true, error: null, notice: null })
        return call('pickFile', { cwd: state.containerDir || browseStart() }).then(
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
            })
            return undefined
          },
          function (error) {
            patch({ busy: false, error: messageOf(error) })
          },
        )
      }

      /** The plugin's own directory browser: directories plus workspace files. */
      function BrowseView(props) {
        var browse = props.browse
        if (!browse) return h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [t('status.loading')])
        var rows = (browse.entries || []).map(function (entry) {
          return h(
            'div',
            {
              key: entry.path,
              onClick: function () {
                if (entry.kind === 'workspace-file') openFile(entry.path)
                else browseTo(entry.path)
              },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 6px',
                borderRadius: 5,
                cursor: 'pointer',
                color: TOKEN.label,
                fontSize: 12,
              },
              onMouseEnter: function (event) {
                event.currentTarget.style.background = TOKEN.hover
              },
              onMouseLeave: function (event) {
                event.currentTarget.style.background = 'transparent'
              },
            },
            [
              h('span', null, [entry.kind === 'directory' ? '▸' : '◆']),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: entry.kind === 'workspace-file' ? 500 : 400 } }, [entry.name]),
              entry.kind === 'workspace-file' ? h(Badge, null, [t('action.open')]) : null,
            ],
          )
        })
        return h('div', null, [
          h('div', { style: { display: 'flex', gap: 4, alignItems: 'center' } }, [
            h(Button, { disabled: !browse.parent, onClick: function () { browseTo(browse.parent) } }, [t('action.parent')]),
            h(Button, { onClick: makeDir }, [t('action.newFolder')]),
            h(Button, { disabled: state.busy, onClick: pickNativeFile }, [t('action.nativePick')]),
            h(
              'div',
              { title: browse.path, style: labelStyle({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: TOKEN.labelFaint }) },
              [String(browse.path || '')],
            ),
          ]),
          h('div', { onClick: function (event) { event.stopPropagation() }, style: { marginTop: 6, maxHeight: 260, overflow: 'auto' } }, [
            rows.length === 0 ? h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [t('hint.noFile')]) : rows,
          ]),
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
        return String(path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      }

      /**
       * One row of the workspace list.
       *
       * A row answers three questions at a glance and offers one action: which
       * workspace is this (title + container directory), is it still there (the
       * host probes every recorded file), and is it the one the panel is showing.
       * The action is "open" — register the container directory as a DSH
       * workspace and switch to it — so a row is also how the session moves
       * between workspaces.
       */
      function WorkspaceRow(props) {
        var item = props.item
        var active = props.active
        return h(
          'div',
          {
            title: String(item.file || ''),
            onClick: function () { openFile(item.file) },
            onMouseEnter: function (event) { if (!active) event.currentTarget.style.background = TOKEN.hover },
            onMouseLeave: function (event) { if (!active) event.currentTarget.style.background = 'transparent' },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              background: active ? TOKEN.hover : 'transparent',
              border: '1px solid ' + (active ? TOKEN.borderSoft : 'transparent'),
              color: TOKEN.label,
              fontSize: 12,
            },
          },
          [
            h('span', { key: 'mark', style: { color: TOKEN.accent, flex: 'none' } }, [active ? '◆' : '◇']),
            h('span', { key: 'name', style: { flex: 'none', maxWidth: '45%', fontWeight: active ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [String(item.title || item.file)]),
            h('span', { key: 'dir', style: { flex: 1, minWidth: 0, color: TOKEN.labelFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [String(item.containerDir || '')]),
            item.exists === false ? h(Badge, { key: 'missing', tone: 'warn' }, [t('badge.missing')]) : null,
            props.open ? h(Badge, { key: 'open' }, [t('badge.open')]) : null,
            h(
              'span',
              {
                key: 'forget',
                title: t('action.forget'),
                onClick: function (event) {
                  // The row itself opens the workspace; forgetting must not.
                  event.stopPropagation()
                  forgetFileAt(item.file)
                },
                style: { flex: 'none', padding: '0 5px', border: '1px solid ' + TOKEN.borderSoft, borderRadius: 6, color: TOKEN.danger },
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
        patch({ busy: true, error: null, notice: null })
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
       * The page's workspace list: every `.code-workspace` file this plugin knows,
       * most recently used first, with the ones that are already registered DSH
       * workspaces marked.
       *
       * This is what the left-column entry is FOR. A detail view of one file is
       * not a manager, and managing "which VS Code workspace am I on" means
       * keeping the others in sight while changing it. The rows come from the
       * host's recorded store (`recent`, which probes each file); the open set is
       * the DSH workspace list. Two sources, joined by path spelling, because they
       * answer different questions: "a file I have used" versus "a workspace this
       * app already has".
       */
      function WorkspaceList() {
        var snapshot = useSnapshot()

        // The registered set is a local read, not a request: doing it during the
        // render keeps it in step with the rows it marks. `loadRecent` is the one
        // thing that talks to the host, and the store tells us when it answered.
        var open = readOpenWorkspaces()
        loadRecent()

        var target = snapshot.containerDir
        var items = snapshot.recent || []
        var knownKeys = {}
        for (var i = 0; i < items.length; i += 1) knownKeys[pathKey(items[i].file)] = true

        return h('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + TOKEN.borderSoft } }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } }, [
            h('div', { style: labelStyle({ fontWeight: 600, fontSize: 12, flex: 1 }) }, [t('label.workspaces')]),
            h(Button, { disabled: snapshot.busy, onClick: function () { browseTo(browseStart()) } }, [t('action.openOther')]),
            h(Button, { disabled: snapshot.busy, onClick: pickNativeFile }, [t('action.nativePick')]),
            h(Button, { disabled: snapshot.busy, onClick: createFile }, [t('action.create')]),
          ]),
          items.length === 0
            ? h('div', { key: 'empty', style: labelStyle({ marginTop: 6, color: TOKEN.labelDim }) }, [t('empty.workspaces')])
            : h(
                'div',
                { key: 'rows', style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 } },
                items.map(function (item) {
                  return h(WorkspaceRow, {
                    key: item.file,
                    item: item,
                    open: open[pathKey(item.file)] !== undefined,
                    active: pathKey(item.file) === pathKey(target),
                  })
                }),
              ),
          // A DSH workspace the plugin has no file for: recorded support files can
          // only come from a panel or a command, so hiding it would make the list
          // a lie about what this app already has.
          Object.keys(open).map(function (key) {
            if (knownKeys[key] === true) return null
            return h(
              'div',
              {
                key: 'open-' + key,
                title: open[key],
                onClick: function () { openWorkspaceDirectory(open[key]) },
                style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: TOKEN.labelDim },
              },
              [
                h('span', { key: 'mark', style: { color: TOKEN.labelFaint } }, ['◇']),
                h('span', { key: 'dir', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [String(open[key])]),
                h(Badge, { key: 'open' }, [t('badge.open')]),
              ],
            )
          }),
        ])
      }

      /**
       * The "open in editor" section: one button per family member this host can
       * prove, named after the editor.
       *
       * Buttons rather than a primary-plus-menu widget, because the choice IS the
       * content here: the workspace panel is where the folders are managed, and a
       * second dropdown would hide the members this plugin added. The tooltip
       * names the executable and the target the host will actually use — the
       * workspace file whenever one is associated, the container directory
       * otherwise.
       */
      function EditorSection() {
        var snapshot = useSnapshot()
        var editors = snapshot.editors
        var value = snapshot.snapshot
        var target = value && value.file ? value.file : snapshot.containerDir
        var body
        if (editors === null) {
          body = h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [t('status.loading')])
        } else if (editors.length === 0) {
          body = h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [snapshot.editorsSsh ? t('hint.editorSsh') : t('hint.noEditor')])
        } else {
          body = h(
            'div',
            { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } },
            editors.map(function (editor) {
              return h(
                Button,
                {
                  key: editor.id,
                  title: t('action.editor') + ' — ' + editor.label + '\n' + String(editor.executable || '') + '\n' + String(target || ''),
                  disabled: snapshot.busy,
                  onClick: function () { openInEditor(editor.id) },
                },
                [editor.label],
              )
            }),
          )
        }
        return h('div', { key: 'editors', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + TOKEN.borderSoft } }, [
          h('div', { style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11 }) }, [t('label.editors')]),
          body,
        ])
      }

      /**
       * The panel body, shared by the Conversation view page, the floating
       * overlay panel and the creation-page popover.
       *
       * `variant: 'view'` is the Conversation view, where the tab strip already
       * owns navigation, so the ✕ is dropped and a line saying where the panel
       * lives takes its place. Every other variant keeps the ✕ that closes the
       * floating overlay.
       */
      function PanelBody(props) {
        // The ✕ is a control on the floating popover only, and it is decided by
        // the surface the panel is actually on rather than by who rendered it:
        // the same body is drawn in the Conversation page AND in the sessionless
        // popover, and those two can be on screen together (the page opened while
        // the creation-page popover was up). A ✕ there would close the popover
        // while the page kept showing, which reads as a dead button.
        var inView = (props && props.variant === 'view') || viewIsActive()
        // The sidebar page is the manager: it draws the workspace list. The
        // Conversation view is a detail surface for the session's own file, so it
        // does not repeat the list there.
        var inPanel = props && props.variant === 'panel'
        var snapshot = useSnapshot()
        var value = snapshot.snapshot
        var busy = snapshot.busy
        var roots = value && Array.isArray(value.roots) ? value.roots : []

        var children = [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
            h('div', { style: labelStyle({ fontWeight: 600, fontSize: 13, flex: 1 }) }, [t('title')]),
            h(Button, { title: t('action.refresh'), disabled: busy, onClick: refresh }, ['⟳']),
            inView ? null : h(Button, { title: t('action.close'), onClick: closePanel }, ['✕']),
          ]),
        ]

        if (inView) {
          children.push(h('div', { key: 'view', style: labelStyle({ marginTop: 4, color: TOKEN.labelFaint, fontSize: 11 }) }, [t('hint.view')]))
        }

        if (snapshot.error) {
          children.push(
            h('div', { key: 'error', style: { marginTop: 6, color: TOKEN.danger, fontSize: 12, lineHeight: '17px' } }, [snapshot.error]),
          )
        }
        if (snapshot.notice) {
          children.push(
            h('div', { key: 'notice', style: { marginTop: 6, color: TOKEN.labelDim, fontSize: 12, lineHeight: '17px' } }, [snapshot.notice]),
          )
        }

        if (!snapshot.containerDir) {
          // Nothing is associated yet, so the page IS the picker: the browser and
          // the create flow live here rather than one level down inside the file
          // section, which only exists once a file is known.
          children.push(
            h('div', { key: 'nodir', style: labelStyle({ marginTop: 8, color: TOKEN.labelDim }) }, [t('hint.noWorkspace')]),
            h('div', { key: 'nodir-actions', style: { display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' } }, [
              h(Button, { disabled: busy, onClick: function () { patch({ showRecent: false }); browseTo(browseStart()) } }, [t('action.openOther')]),
              h(Button, { disabled: busy, onClick: function () { patch({ showRecent: false }); createFile() } }, [t('action.create')]),
            ]),
          )
        } else if (value === null || value === undefined) {
          children.push(h('div', { key: 'loading', style: labelStyle({ marginTop: 8, color: TOKEN.labelDim }) }, [busy ? t('status.loading') : t('hint.noFile')]))
        } else {
          if (value.error) {
            children.push(
              h('div', { key: 'parse', style: { marginTop: 6, color: TOKEN.danger, fontSize: 12, lineHeight: '17px' } }, [
                t('warning.parse') + ' ' + String(value.error.message || ''),
              ]),
            )
          }
          children.push(
            h('div', { key: 'file', style: { marginTop: 8 } }, [
              h('div', { style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11 }) }, [t('label.file')]),
              h(
                'div',
                { title: String(value.file || ''), style: labelStyle({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) },
                [String(value.file || t('title.none'))],
              ),
              h('div', { style: { display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' } }, [
                h(Button, { onClick: function () { patch({ showBrowse: true }); browseTo(state.containerDir) } }, [t('action.openOther')]),
                h(Button, { onClick: function () { patch({ showRecent: !snapshot.showRecent }); loadRecent(true) } }, [t('action.recent')]),
                value.file ? h(Button, { onClick: function () { reveal(value.file) } }, [t('action.reveal')]) : null,
                value.workspace ? h(Button, { onClick: function () { enterWorkspace(value) } }, [t('action.useWorkspace')]) : null,
                h(Button, { onClick: function () { patch({ showRecent: false }); createFile() } }, [t('action.create')]),
                h(Button, { danger: true, onClick: function () { mutate('use ""', 'useFile', { file: '' }) } }, [t('action.forget')]),
              ]),
            ]),
          )

          children.push(
            h('div', { key: 'roots', style: { marginTop: 10 } }, [
              h('div', { style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11 }) }, [t('label.roots')]),
              roots.length === 0
                ? h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [t('empty.roots')])
                : roots.map(function (root, index) {
                    return h(
                      FolderRow,
                      {
                        key: root.resolvedPath + '#' + index,
                        root: root,
                        first: index === 0,
                        last: index === roots.length - 1,
                        renaming: snapshot.renameIndex === index,
                        renameValue: snapshot.renameValue,
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
                      },
                    )
                  }),
            ]),
          )

          children.push(
            h('div', { key: 'add', style: { marginTop: 10 } }, [
              h('div', { style: { display: 'flex', gap: 4 } }, [
                h(TextInput, {
                  value: snapshot.addPath,
                  placeholder: t('field.folderPath'),
                  onChange: function (next) { patch({ addPath: next }) },
                  onEnter: submitAdd,
                }),
                h(Button, { disabled: busy, onClick: submitAdd }, [t('action.add')]),
              ]),
              h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } }, [
                h(TextInput, {
                  value: snapshot.addName,
                  placeholder: t('field.folderName'),
                  onChange: function (next) { patch({ addName: next }) },
                  onEnter: submitAdd,
                }),
              ]),
            ]),
          )
        }

        if (inPanel) {
          // The list is what makes this page a MANAGER rather than a detail view:
          // it stays put as the selection moves, so switching workspaces never
          // means losing sight of the others. Hidden while the file browser is
          // open, because then the browser is the task.
          if (!snapshot.showBrowse) children.push(h(WorkspaceList, { key: 'list' }))
        }

        if (snapshot.containerDir) children.push(h(EditorSection, null))

        if (snapshot.showBrowse) {
          children.push(h('div', { key: 'browse', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + TOKEN.borderSoft } }, [
            h('div', { style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11 }) }, [t('label.browse')]),
            h(BrowseView, { browse: snapshot.browse }),
          ]))
        }

        if (snapshot.showRecent) {
          var recent = (snapshot.recent || []).filter(function (item) { return item.exists !== false })
          children.push(h('div', { key: 'recent', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + TOKEN.borderSoft } }, [
            h('div', { style: labelStyle({ color: TOKEN.labelFaint, fontSize: 11 }) }, [t('action.recent')]),
            recent.length === 0
              ? h('div', { style: labelStyle({ color: TOKEN.labelDim }) }, [t('empty.recent')])
              : recent.map(function (item) {
                  return h(
                    'div',
                    {
                      key: item.file,
                      onClick: function () { openFile(item.file) },
                      title: item.file,
                      style: { padding: '4px 6px', borderRadius: 5, cursor: 'pointer', fontSize: 12, color: TOKEN.label, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    },
                    [String(item.title || item.file)],
                  )
                }),
          ]))
        }

        return h('div', null, children)
      }

      function submitAdd() {
        var path = String(state.addPath || '').trim()
        if (path === '') return
        var displayName = String(state.addName || '').trim()
        patch({ addPath: '', addName: '' })
        mutate('add "' + path + '"', 'addFolder', { path: path, name: displayName })
      }

      function createFile() {
        var dir = state.containerDir
        if (!dir) {
          patch({ error: t('error.noWorkspace') })
          return
        }
        var input = window.prompt(t('field.workspaceName'), 'workspace')
        if (!input) return
        patch({ busy: true, error: null })
        call('create', { containerDir: dir, name: input }).then(
          function (value) {
            patch({ busy: false, snapshot: value, containerDir: value && value.containerDir ? value.containerDir : dir, mode: 'workspace' })
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
        background: TOKEN.surface,
        border: '1px solid ' + TOKEN.border,
        borderRadius: TOKEN.radius,
        boxShadow: '0 12px 32px rgba(0,0,0,0.24)',
        color: TOKEN.label,
        // `shell.overlay` is click-through; every entry must opt back in.
        pointerEvents: 'auto',
        zIndex: 400,
      }

      /**
       * The floating panel: the creation page's popover.
       *
       * It is the only surface that can pick a `.code-workspace` file before a
       * session exists, so it stays — but only the hero-phase dock chip (and its
       * own ✕) may drive it. The anchor check is not decoration: this store
       * survives a page reload in the browser's session storage, so a panel that
       * was left open by an older build would otherwise float over every session
       * with nothing on screen able to close it. Anything addressed to another
       * surface simply does not render here, which retires that stale state the
       * first time this component draws.
       */
      function OverlayPanel() {
        var snapshot = useSnapshot()
        if (!snapshot.open || snapshot.anchor !== 'dock') return null
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
        if (state.open && state.anchor === 'dock') closePanel()
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
      function syncPanelScope(sessionId, containerDir) {
        var dir = containerDir || null
        var target = sessionId || null
        // The page owns the panel from the moment it draws: a floating copy left
        // over from the creation page (or from a build that had an overlay
        // fallback) must not float beside the page it duplicates.
        if (state.open && state.anchor === 'dock') {
          closePanel()
          return
        }
        if (state.open && state.sessionId === target && state.containerDir === dir) return
        var next = { open: true, anchor: 'view', sessionId: target, containerDir: dir, mode: target ? 'session' : 'workspace', error: null, notice: null }
        if (state.sessionId !== target) next.snapshot = null
        patch(next)
      }

      /**
       * Read the workspace state for whichever surface just mounted.
       *
       * One read per mount either way: React mounts the Conversation view when
       * its tab is selected and the sidebar panel when its entry is, and unmounts
       * each when the user leaves, so mounting *is* the "show me the current
       * state" gesture. The editor family is read here too, because that section
       * renders from the same snapshot: a session with no workspace file still
       * offers "open in editor", so the list must not wait for a workspace read.
       * The sidebar panel passes no session id and reads through the sessionless
       * channel, which `refresh` picks from the store's mode.
       */
      function ensureViewPanel(sessionId) {
        loadEditors()
        refresh()
      }

      /**
       * The Conversation view body.
       *
       * The owner renders one registered view at a time and hands it the standard
       * session kit, so the session address is `props.sessionId` and the
       * container directory is that session's `cwd` (falling back to whatever the
       * store already holds for the creation page, where there is no session).
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
        var containerDir = useContainerDir(props) || state.containerDir || null

        syncPanelScope(sessionId, containerDir)
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
                  gap: 8,
                  width: '100%',
                  maxWidth: 'calc(var(--dsh-chat-content-width, 760px) + 48px)',
                  boxSizing: 'border-box',
                  padding: '16px 24px 24px',
                },
              },
              [h(PanelBody, { variant: 'view' })],
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
        var containerDir = useContainerDir(props)
        return h(
          'button',
          {
            type: 'button',
            title: containerDir || t('title.none'),
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

      // ------------------------------------------- the sidebar entry for the page
      // One entry in the left column's panel list, next to the shipped Plugins and
      // Scheduled-tasks rows, so the panel is reachable WITHOUT a session: that is
      // the whole point of it. It shares its id with the Conversation view and the
      // `main` panel (see PANEL_KEY), so all three address one page.

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
      function syncPanelScopeGlobal(containerDir) {
        var dir = containerDir || null
        if (state.open && state.anchor === 'panel' && state.containerDir === dir) return
        patch({
          open: true,
          anchor: 'panel',
          sessionId: null,
          containerDir: dir,
          mode: 'workspace',
          error: null,
          notice: null,
          snapshot: null,
        })
      }

      /**
       * The central panel behind the sidebar entry.
       *
       * Sessionless on purpose: this is how a profile that has no single-project
       * workspace open yet reaches a `.code-workspace` file at all. Picking one
       * registers its directory as a DSH workspace and, when `uiWorkspace` is
       * available, opens it — which is where a session comes from.
       *
       * `containerDir` comes from the store rather than from a session, so a file
       * chosen on the creation page is already in scope when this page is opened.
       */
      function WorkspacePanel() {
        var containerDir = state.containerDir || null

        syncPanelScopeGlobal(containerDir)
        React.useEffect(function () { ensureViewPanel(null) }, [])

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
                  gap: 8,
                  width: '100%',
                  maxWidth: 'calc(var(--dsh-chat-content-width, 760px) + 48px)',
                  boxSizing: 'border-box',
                  padding: '24px 24px 32px',
                },
              },
              [h(PanelBody, { variant: 'panel' })],
            ),
          ],
        )
      }

      /**
       * Session-creation-page entry, in the dock band above the composer card.
       * The dock outlet is `display: contents`, so the row must stay IN FLOW —
       * absolute positioning here would silently overlap a neighbouring plugin.
       */
      function DockChip(props) {
        var sessionId = props.sessionId
        var containerDir = useContainerDir(props)
        var hero = useHeroPhase(props, sessionId)
        var snapshot = useSnapshot()
        if (!hero) return null
        var active = snapshot.open && snapshot.anchor === 'dock'
        return h(
          'div',
          { style: { display: 'flex', paddingLeft: 20, paddingBottom: 6 } },
          [
            h(
              'button',
              {
                type: 'button',
                title: containerDir ? containerDir : t('title.none'),
                onClick: function () {
                  if (active) closePanel()
                  else openPanel('dock', containerDir, sessionId || null, 'workspace')
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px',
                  fontSize: 12,
                  lineHeight: '18px',
                  color: containerDir ? TOKEN.label : TOKEN.labelDim,
                  background: active ? TOKEN.hover : TOKEN.fill,
                  border: '1px solid ' + TOKEN.borderSoft,
                  borderRadius: 999,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                },
              },
              ['◆ ' + t('label.hero')],
            ),
          ],
        )
      }

      /** The addressed session's workspace directory, from the standard kit. */
      function useContainerDir(props) {
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

      /** Hero-phase detection, adaptive across DSH shell generations. */
      function useHeroPhase(props, sessionId) {
        var useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing
        var fromSession = useSessions(function (snapshot) {
          if (!snapshot || !snapshot.byId || !sessionId) return false
          var row = snapshot.byId[sessionId]
          if (!row) return false
          if (row.composerPhase !== undefined) {
            return row.composerPhase === 'blank' && (row.openState === 'open' || row.openState === undefined)
          }
          return row.blank === true && !row.running && !row.promptAttempted && row.openState === 'open'
        })
        var ownerBlank = props.session && props.session.blank === true
        return fromSession === true || (fromSession === false && ownerBlank)
      }

      /** A selector used only to keep an unavailable hook's call unconditional. */
      function selectNothing() {
        return null
      }

      // ------------------------------------------------------------ registers

      function tryRegister(slot, spec, component) {
        try {
          slots.inject(slot, function () {
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

      tryRegister(
        'conversation.input.dock',
        { name: 'conversation.input.dock', id: ENTRY_ID, order: DOCK_ORDER, label: function () { return t('label.hero') }, locale: NS },
        DockChip,
      )

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

      /** Subscribe a component to one store, with the same fallback the panel uses. */
      function useMenuStore(store) {
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
            run = call('openInEditor', { containerDir: path, editorId: id })
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
                  // the container directory when the session has no workspace file,
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
        var applications = useMenuStore(props.hooks.openInAppFamily)
        var choice = useMenuStore(props.hooks.openInAppChoice)
        var operation = useMenuStore(props.hooks.openInAppLaunch)
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
          busy: operation.phase === 'busy',
          uiText: props.uiText,
          launch: props.launch,
          choose: props.choose,
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
              var containerDir = summary && summary.cwd
              if (!containerDir) return Promise.resolve([])
              var preserveQuote = request.quoted === true
              return call('listFiles', { containerDir: containerDir, query: request.query }).then(
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
