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
 * - `conversation.session.header.actions` — a session button that opens the panel.
 * - `conversation.input.dock` — the session-creation page entry, in the same
 *   band as the shipped git-branch chip. It renders only in the hero phase, so
 *   the session header entry and this one never appear together.
 * - `shell.overlay` — the floating panel itself (a fixed-position element that
 *   opts back into pointer events; that layer is click-through by design).
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

    // ------------------------------------------------------------ dictionaries
    // `locale.register` enforces BCP 47 tags and rejects a duplicate
    // (namespace, locale) pair; bilingual key balance is our own discipline.

    var zh = {
      label: '代码工作区',
      'label.hero': '代码工作区',
      title: '代码工作区',
      'title.none': '未关联 .code-workspace 文件',
      'hint.noWorkspace': '请先选择一个工作区目录（或在下方打开一个 .code-workspace 文件）。',
      'hint.noFile': '该目录下没有 .code-workspace 文件。',
      'hint.pickFile': '选择一个 .code-workspace 文件：',
      'action.open': '打开工作区文件',
      'action.openOther': '切换文件',
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
      'label.hero': 'Code Workspace',
      title: 'Code Workspace',
      'title.none': 'No .code-workspace file',
      'hint.noWorkspace': 'Select a workspace directory first (or open a .code-workspace file below).',
      'hint.noFile': 'This directory has no .code-workspace file.',
      'hint.pickFile': 'Pick a .code-workspace file:',
      'action.open': 'Open workspace file',
      'action.openOther': 'Switch file',
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

      function loadRecent() {
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
        loadRecent()
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

      /** The panel body, shared by the overlay panel and the creation-page popover. */
      function PanelBody() {        var snapshot = useSnapshot()
        var value = snapshot.snapshot
        var busy = snapshot.busy
        var roots = value && Array.isArray(value.roots) ? value.roots : []

        var children = [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
            h('div', { style: labelStyle({ fontWeight: 600, fontSize: 13, flex: 1 }) }, [t('title')]),
            h(Button, { title: t('action.refresh'), disabled: busy, onClick: refresh }, ['⟳']),
            h(Button, { title: t('action.close'), onClick: closePanel }, ['✕']),
          ]),
        ]

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
          children.push(h('div', { key: 'nodir', style: labelStyle({ marginTop: 8, color: TOKEN.labelDim }) }, [t('hint.noWorkspace')]))
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
                h(Button, { onClick: function () { patch({ showRecent: !snapshot.showRecent }); loadRecent() } }, [t('action.recent')]),
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

      function OverlayPanel() {
        var snapshot = useSnapshot()
        if (!snapshot.open) return null
        return h('div', { style: panelStyle, onMouseDown: function (event) { event.stopPropagation() } }, [h(PanelBody, null)])
      }

      /** Session header action: the entry point once a session exists. */
      function HeaderButton(props) {
        var sessionId = props.sessionId
        var containerDir = useContainerDir(props)
        var snapshot = useSnapshot()
        var active = snapshot.open && snapshot.anchor === 'header'
        return h(
          'button',
          {
            type: 'button',
            title: containerDir || t('title.none'),
            onClick: function () {
              if (active) closePanel()
              else openPanel('header', containerDir, sessionId)
            },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px',
              fontSize: 12,
              lineHeight: '18px',
              color: TOKEN.label,
              background: active ? TOKEN.hover : TOKEN.fill,
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
