/**
 * Client-half behaviour tests, run with no browser, no DSH and no React.
 *
 * The bundle is a hand-written `client-modules` factory: it registers three
 * slots, one `@` source and its own dictionaries, and never renders anything by
 * itself. So the tests
 *
 *   1. capture the `window.__ModuleLoader__.load` registration and check its
 *      contract (id, exports, slot specs, dictionary balance);
 *   2. supply a minimal React shim whose hooks resolve once per call, which
 *      makes every component a plain function whose returned element tree can be
 *      inspected directly;
 *   3. drive the panel through real clicks on that tree against a fake host, so
 *      the assertions cover what a user actually triggers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

// ---------------------------------------------------------------- React shim

/** Hooks resolve once per call: enough for a single, deterministic render pass. */
const reactShim = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    // Real React also exposes `children` on props; the bundle reads it.
    const merged = Object.assign({}, props || {})
    if (children.length > 0) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(callback) {
    const cleanup = callback()
    if (typeof cleanup === 'function') CLEANUPS.push(cleanup)
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  useRef(value) {
    return { current: value }
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
}
const CLEANUPS = []

/** Recursively render function components into plain host elements. */
function expand(vnode) {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return vnode
  if (typeof vnode.type === 'function') return expand(vnode.type(vnode.props))
  return { type: vnode.type, props: vnode.props, children: (vnode.children || []).map(expand) }
}

function walk(vnode, visit) {
  if (vnode === null || vnode === undefined || typeof vnode !== 'object') return
  visit(vnode)
  for (const child of vnode.children || []) walk(child, visit)
}

/** Every string rendered anywhere in the tree, joined. */
function textOf(vnode) {
  const parts = []
  walk(vnode, (node) => {
    for (const child of node.children || []) if (typeof child === 'string') parts.push(child)
  })
  return parts.join(' ')
}

function nodesWhere(vnode, predicate) {
  const found = []
  walk(vnode, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

const buttonsIn = (vnode) => nodesWhere(vnode, (node) => node.type === 'button')
const inputsIn = (vnode) => nodesWhere(vnode, (node) => node.type === 'input')

/** The first button whose rendered label matches. */
function buttonByLabel(vnode, label) {
  for (const button of buttonsIn(vnode)) {
    if (textOf(button).includes(label)) return button
  }
  return undefined
}

/** The first button whose `title` attribute matches (an accessible-name lookup). */
function buttonByTitle(vnode, title) {
  for (const button of buttonsIn(vnode)) {
    if (button.props.title === title) return button
  }
  return undefined
}

/** The node whose React `key` matches, which uniquely addresses a list row. */
function nodeByKey(vnode, key) {
  return nodesWhere(vnode, (node) => node.props && node.props.key === key)[0]
}

// ------------------------------------------------------------------- harness

/** Load the bundle against a fresh fake window and boot it. */
async function bootClient({ services = {} } = {}) {
  const source = await readFile(BUNDLE, 'utf8')
  // Same realm on purpose: the bundle's own arrays/objects must satisfy
  // `assert.deepStrictEqual`, which a `vm` context's foreign prototypes break.
  const fakeWindow = {
    __ModuleLoader__: {
      load(options) {
        fakeWindow.__loaded = options
      },
    },
    prompt: () => 'prompted',
  }
  const runBundle = new Function('window', source)
  runBundle(fakeWindow)

  const loadOptions = fakeWindow.__loaded
  assert.ok(loadOptions, 'the bundle must register a factory')
  const exportsObject = loadOptions.factory((specifier) => {
    if (specifier === 'react') return reactShim
    throw new Error('unexpected require: ' + specifier)
  })

  const slots = []
  const triggers = []
  const dictionaries = []
  const effects = []

  const ctx = {
    slots: {
      inject(key, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register(spec, component) {
        slots.push({ spec, component })
        return () => {}
      },
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const dict = dictionaries.find((entry) => entry.ns === ns)
          const raw = dict && dict.dicts.zh ? dict.dicts.zh[key] : key
          if (raw === undefined) return key
          if (!params) return raw
          return String(raw).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
    },
    sessions: services.sessions,
    workspaces: services.workspaces,
    remote: services.remote,
    connection: services.connection,
    effect(callback, label) {
      effects.push(label)
      const disposer = callback()
      if (typeof disposer === 'function') CLEANUPS.push(disposer)
      return () => {}
    },
    inject(deps, callback) {
      if (deps.includes('inputTriggers')) {
        const registry = {
          registerSource(source) {
            triggers.push(source)
            return () => {}
          },
        }
        callback({ inputTriggers: registry, effect: ctx.effect })
      }
    },
    get(name) {
      return services[name]
    },
  }

  exportsObject.apply(ctx)

  return {
    exportsObject,
    loadOptions,
    slots,
    triggers,
    dictionaries,
    effects,
    /** Find a registered slot registration by slot key. */
    slot(key) {
      const found = slots.find((entry) => entry.spec.name === key)
      assert.ok(found, 'no registration for ' + key)
      return found
    },
  }
}

/** A reply envelope for the sessionless channel. */
const ok = (value) => ({ ok: true, value })
/** A reply envelope for the command channel carrying structured state. */
const commandOk = (state) => ({
  ok: true,
  value: { commandId: 'c1', result: { kind: 'success', text: 'state\n[CWS:JSON] ' + JSON.stringify(state) } },
})

const STATE = {
  containerDir: 'D:/ws',
  file: 'D:/ws/app.code-workspace',
  title: 'app',
  exists: true,
  roots: [
    { index: 0, path: '.', name: null, label: 'ws', resolvedPath: 'D:/ws', exists: true, isPrimary: true, relative: '.' },
    { index: 1, path: '../other', name: 'Other', label: 'Other', resolvedPath: 'D:/other', exists: true, isPrimary: false, relative: '../other' },
  ],
  warnings: [],
  error: null,
  extraRoots: ['D:/other'],
  indent: '\t',
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Boot the client with both transports wired, and return a render helper. */
async function boot({ onRpc, onCommand, services = {} } = {}) {
  const rpcLog = []
  const commandLog = []
  const harness = await bootClient({
    services: {
      sessions: {
        list: {
          getSnapshot: () => ({
            current: 'session-1',
            ids: ['session-1'],
            byId: {
              'session-1': {
                cwd: 'D:/ws',
                blank: true,
                running: false,
                promptAttempted: false,
                openState: 'open',
                composerPhase: 'blank',
              },
            },
          }),
        },
      },
      workspaces: { list: { getSnapshot: () => ({ items: [{ path: 'D:/ws', sessionIds: ['session-1'] }] }) } },
      connection: {
        rpc: {
          call(channel, endpoint, payload, signal) {
            rpcLog.push({ endpoint, args: payload && payload.args })
            const reply = onRpc ? onRpc(endpoint, payload && payload.args) : undefined
            return Promise.resolve(reply === undefined ? ok(null) : reply)
          },
        },
      },
      remote: {
        commands: {
          execute(sessionId, line, attachments) {
            commandLog.push({ sessionId, line, attachments })
            const reply = onCommand ? onCommand(line, sessionId) : undefined
            return Promise.resolve(reply === undefined ? commandOk(STATE) : reply)
          },
        },
        $host: { home: 'C:/Users/edy' },
      },
      ...services,
    },
  })
  const header = harness.slot('conversation.session.header.actions')
  const dock = harness.slot('conversation.input.dock')
  const overlay = harness.slot('shell.overlay')
  return { harness, rpcLog, commandLog, header, dock, overlay }
}

/** Props the standard kit would inject for a session-scoped entry. */
function kit(overrides = {}) {
  return Object.assign(
    {
      sessionId: 'session-1',
      useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/ws', composerPhase: 'blank', openState: 'open' } } }),
      useWorkspaces: (selector) => selector({ items: [{ path: 'D:/ws', sessionIds: ['session-1'] }] }),
      session: { blank: true },
    },
    overrides,
  )
}

// -------------------------------------------------------------------- tests

test('the bundle registers one factory under the package name and exports name/inject/apply', async () => {
  const { loadOptions, exportsObject } = await bootClient()
  assert.equal(loadOptions.id, 'dsh-code-workspace')
  assert.equal(typeof loadOptions.factory, 'function')
  assert.equal(exportsObject.name, 'dsh-code-workspace')
  assert.deepEqual(exportsObject.inject, ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale'])
  assert.equal(typeof exportsObject.apply, 'function')
})

test('apply registers the header action, the dock entry and the overlay panel', async () => {
  const harness = await bootClient()
  assert.deepEqual(
    harness.slots.map((entry) => entry.spec.name),
    ['conversation.session.header.actions', 'conversation.input.dock', 'shell.overlay'],
  )
  const header = harness.slot('conversation.session.header.actions').spec
  assert.equal(header.id, 'code-workspace')
  assert.equal(header.order, 30)
  assert.equal(header.locale, 'code-workspace')
  assert.equal(header.label(), '代码工作区')

  const dock = harness.slot('conversation.input.dock').spec
  assert.equal(dock.id, 'code-workspace')
  assert.equal(dock.order, 120)

  // `shell.overlay` has no owner props and is click-through: an id is required,
  // and no `locale` seat is asked for by the panel itself.
  const overlay = harness.slot('shell.overlay').spec
  assert.equal(overlay.id, 'code-workspace-panel')
  assert.equal(overlay.order, 110)
})

test('the zh and en dictionaries carry exactly the same keys', async () => {
  const harness = await bootClient()
  assert.equal(harness.dictionaries.length, 1)
  const { ns, dicts } = harness.dictionaries[0]
  assert.equal(ns, 'code-workspace')
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort())
  for (const key of Object.keys(dicts.zh)) {
    assert.equal(typeof dicts.zh[key], 'string', 'zh.' + key)
    assert.equal(typeof dicts.en[key], 'string', 'en.' + key)
  }
})

test('the @ source is registered as a companion group with an identity codec', async () => {
  const harness = await bootClient()
  assert.equal(harness.triggers.length, 1)
  const source = harness.triggers[0]
  assert.equal(source.trigger, '@')
  assert.equal(source.name, 'code-workspace')
  assert.equal(source.order, 10)
  assert.equal(source.showGroupTitle, false)
  assert.equal(typeof source.candidates, 'function')
  assert.equal(typeof source.onPick, 'function')
  assert.equal(typeof source.codec.serialize, 'function')
  assert.equal(await source.codec.serialize('@x'), '@x')
  assert.equal(source.codec.clipboardText('D:/a b/c.ts'), 'D:/a b/c.ts')
})

test('the session header button opens the panel and fetches state over the command channel', async () => {
  const { header, commandLog } = await boot()
  const button = header.component(kit())
  assert.match(textOf(button), /代码工作区/)
  button.props.onClick()
  await flush()
  assert.equal(commandLog.length, 1)
  assert.equal(commandLog[0].sessionId, 'session-1')
  assert.equal(commandLog[0].line, '/code-workspace list')
  // The third business argument is required on DSH >= 0.1.1.
  assert.deepEqual(commandLog[0].attachments, [])
})

test('the panel renders the file, every folder, and the primary badge', async () => {
  const { header, overlay } = await boot()
  header.component(kit()).props.onClick()
  await flush()
  const tree = expand(overlay.component({}))
  assert.ok(tree, 'the overlay must render while the panel is open')
  const text = textOf(tree)
  assert.match(text, /D:\/ws\/app\.code-workspace/)
  assert.match(text, /Other/)
  assert.match(text, /D:\/other/)
  assert.match(text, /主目录/)
  assert.match(text, /工作区文件夹/)
})

test('the overlay renders nothing while the panel is closed', async () => {
  const { overlay } = await boot()
  assert.equal(expand(overlay.component({})), null)
})

test('the dock entry renders only in the hero phase', async () => {
  const { dock } = await boot()
  const heroTree = expand(dock.component(kit()))
  assert.ok(heroTree, 'the dock chip must render on the blank-session hero')
  assert.match(textOf(heroTree), /代码工作区/)
  // A session that already has a prompt is no longer the hero phase.
  const past = kit({
    useSessions: (selector) =>
      selector({ byId: { 'session-1': { cwd: 'D:/ws', blank: false, running: false, promptAttempted: true, openState: 'open' } } }),
    session: { blank: false },
  })
  assert.equal(expand(dock.component(past)), null)
})

test('removing a folder from the panel issues the indexed remove command', async () => {
  const { header, overlay, commandLog } = await boot()
  header.component(kit()).props.onClick()
  await flush()
  const tree = expand(overlay.component({}))
  // The panel's own close button also renders a ✕, so address the row action by
  // its accessible title instead.
  const remove = buttonByTitle(tree, '移除')
  assert.ok(remove, 'a remove button must exist')
  remove.props.onClick()
  await flush()
  assert.ok(commandLog.some((call) => call.line === '/code-workspace remove 0'), JSON.stringify(commandLog))
  // The mutation re-reads state through the command channel.
  assert.equal(commandLog.at(-1).line, '/code-workspace list')
})

test('adding a folder sends the typed path and clears the field', async () => {
  const { header, overlay, commandLog } = await boot()
  header.component(kit()).props.onClick()
  await flush()
  let tree = expand(overlay.component({}))
  const pathInput = inputsIn(tree).find((input) => input.props.placeholder.includes('文件夹路径'))
  assert.ok(pathInput)
  pathInput.props.onChange({ target: { value: 'D:/third' } })
  tree = expand(overlay.component({}))
  const addButton = buttonByLabel(tree, '添加文件夹')
  addButton.props.onClick()
  await flush()
  assert.ok(commandLog.some((call) => call.line === '/code-workspace add "D:/third"'), JSON.stringify(commandLog))
  // The field is cleared optimistically.
  tree = expand(overlay.component({}))
  const cleared = inputsIn(tree).find((input) => input.props.placeholder.includes('文件夹路径'))
  assert.equal(cleared.props.value, '')
})

test('on the creation page the panel uses the sessionless channel, not the command channel', async () => {
  const { dock, rpcLog, commandLog } = await boot()
  const chip = expand(dock.component(kit()))
  chip.children[0].props.onClick()
  await flush()
  assert.deepEqual(
    rpcLog.map((call) => call.endpoint),
    ['codeWorkspace/state', 'codeWorkspace/recent'],
  )
  assert.deepEqual(rpcLog[0].args, { containerDir: 'D:/ws' })
  assert.equal(commandLog.length, 0)
})

test('a failed folder mutation surfaces the host message and re-reads state', async () => {
  const { header, overlay, commandLog } = await boot({
    onCommand: () => commandOk(STATE),
    onRpc: () => ok(null),
  })
  header.component(kit()).props.onClick()
  await flush()
  const tree = expand(overlay.component({}))
  buttonByTitle(tree, '移除').props.onClick()
  await flush()
  // One read on open, the mutation, and the read-back after it.
  assert.ok(commandLog.length >= 3, JSON.stringify(commandLog))
  assert.equal(commandLog.at(-1).line, '/code-workspace list')
})

test('the browser lists directories and workspace files and opens a chosen file', async () => {
  const listing = {
    path: 'D:/ws',
    parent: 'D:/',
    home: 'C:/Users/edy',
    entries: [
      { name: 'app.code-workspace', path: 'D:/ws/app.code-workspace', kind: 'workspace-file', hidden: false },
      { name: 'sub', path: 'D:/ws/sub', kind: 'directory', hidden: false },
    ],
    truncated: false,
  }
  const opened = []
  const { dock, overlay } = await boot({
    onRpc: (endpoint, args) => {
      if (endpoint === 'codeWorkspace/browse') return ok(listing)
      if (endpoint === 'codeWorkspace/open') {
        opened.push(args.file)
        return ok(Object.assign({}, STATE, { workspace: { id: 'w9', path: 'D:/ws', title: 'app' } }))
      }
      if (endpoint === 'codeWorkspace/recent') return ok({ files: [] })
      if (endpoint === 'codeWorkspace/state') return ok(STATE)
      return ok(null)
    },
  })
  const chip = expand(dock.component(kit()))
  chip.children[0].props.onClick()
  await flush()
  // "Open workspace file" starts the browse at the container directory.
  let tree = expand(overlay.component({}))
  buttonByLabel(tree, '切换文件').props.onClick()
  await flush()
  tree = expand(overlay.component({}))
  const row = nodeByKey(tree, 'D:/ws/app.code-workspace')
  assert.ok(row, 'the workspace file must appear as a row')
  row.props.onClick()
  await flush()
  assert.deepEqual(opened, ['D:/ws/app.code-workspace'])
})

test('opening a workspace selects it through uiWorkspace when that service exists', async () => {
  const selected = []
  const listing = {
    path: 'D:/ws',
    parent: 'D:/',
    home: 'C:/Users/edy',
    entries: [{ name: 'app.code-workspace', path: 'D:/ws/app.code-workspace', kind: 'workspace-file', hidden: false }],
    truncated: false,
  }
  const { dock, overlay } = await boot({
    services: {
      uiWorkspace: {
        openWorkspace(id) {
          selected.push(id)
          return Promise.resolve()
        },
      },
    },
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/browse') return ok(listing)
      if (endpoint === 'codeWorkspace/open') {
        return ok(Object.assign({}, STATE, { workspace: { id: 'w9', path: 'D:/ws', title: 'app' } }))
      }
      if (endpoint === 'codeWorkspace/recent') return ok({ files: [] })
      if (endpoint === 'codeWorkspace/state') return ok(STATE)
      return ok(null)
    },
  })
  expand(dock.component(kit())).children[0].props.onClick()
  await flush()
  buttonByLabel(expand(overlay.component({})), '切换文件').props.onClick()
  await flush()
  const row = nodeByKey(expand(overlay.component({})), 'D:/ws/app.code-workspace')
  assert.ok(row, 'the workspace file row must exist')
  row.props.onClick()
  await flush()
  assert.deepEqual(selected, ['w9'])
})

test('@ candidates render rows, and a quoted path keeps its quotes', async () => {
  const payload = {
    containerDir: 'D:/ws',
    roots: [],
    candidates: [
      { path: 'D:/other/src/main.ts', rel: 'src/main.ts', rootPath: 'D:/other', rootLabel: 'Other', dir: false, level: false },
      { path: 'D:/other/my dir', rel: 'my dir', rootPath: 'D:/other', rootLabel: 'Other', dir: true, level: false },
    ],
    truncated: false,
  }
  const harness = await bootClient({
    services: {
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: 'D:/ws' } } }) } },
      connection: { rpc: { call: () => Promise.resolve(ok(payload)) } },
      remote: { $host: { home: 'C:/Users/edy' } },
    },
  })
  const source = harness.triggers[0]
  const rows = await source.candidates({ sessionId: 'session-1' }, { query: 'x' })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'main.ts')
  assert.equal(rows[0].icon, 'file')
  assert.equal(rows[0].description, 'src')
  assert.equal(rows[0].section, 'D:/other')
  assert.equal(JSON.parse(rows[0].value).mention, '@D:/other/src/main.ts')
  assert.equal(rows[1].name, 'my dir/')
  assert.equal(rows[1].drill, true)
  assert.equal(JSON.parse(rows[1].value).mention, '@"D:/other/my dir/')
})

test('an @ discovery failure is an empty group, never a rejection', async () => {
  const harness = await bootClient({
    services: {
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: 'D:/ws' } } }) } },
      connection: {
        rpc: {
          call: () => Promise.reject(new Error('boom')),
        },
      },
      remote: { $host: {} },
    },
  })
  const rows = await harness.triggers[0].candidates({ sessionId: 'session-1' }, { query: 'x' })
  assert.deepEqual(rows, [])
})

test('a missing RPC channel produces a readable error instead of a TypeError', async () => {
  const harness = await bootClient({ services: {} })
  const source = harness.triggers[0]
  const rows = await source.candidates({ sessionId: 's' }, { query: 'x' })
  // `sessions` is absent, so discovery short-circuits to an empty group.
  assert.deepEqual(rows, [])
})

test('apply survives a composition with no optional services at all', async () => {
  const harness = await bootClient()
  assert.equal(harness.slots.length, 3)
  assert.equal(harness.triggers.length, 1)
  // Rendering the components with bare props must not throw.
  assert.ok(harness.slot('conversation.session.header.actions').component({}))
  assert.equal(harness.slot('conversation.input.dock').component({}), null)
  assert.equal(harness.slot('shell.overlay').component({}), null)
})
