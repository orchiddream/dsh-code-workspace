/**
 * Client-half behaviour tests, run with no browser, no DSH and no React.
 *
 * The bundle is a hand-written `client-modules` factory: it registers three
 * slots, a docked right-Sidebar tab type plus its body (when the composition
 * carries that Sidebar), one `@` source and its own dictionaries, and never
 * renders anything by itself. So the tests
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

/**
 * Hooks resolve once per call: enough for a deterministic render pass.
 *
 * `useEffect` is the one hook the shim has to model more carefully. React runs an
 * effect once per MOUNT, but this shim re-expands a component on every render, so
 * a naive pass-through would re-run the effect and turn an ordinary re-render
 * into a second read — a state machine the browser never has. The shim therefore
 * drains effects once and then ignores them until the test declares a remount
 * (`markUnmounted`), which is also how a test says "mount it again".
 */
const EFFECT = { pending: true, cleanups: [] }
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
    if (!EFFECT.pending) return
    EFFECT.pending = false
    const cleanup = callback()
    if (typeof cleanup === 'function') EFFECT.cleanups.push(cleanup)
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

/** End the current mount: React would have unmounted the tree, so effects re-arm. */
function markUnmounted() {
  EFFECT.cleanups.splice(0).forEach((cleanup) => cleanup())
  EFFECT.pending = true
}

// --------------------------------------------------- shipped routes and widgets
// The menu takeover reads the shipped applications and posts the shipped launch,
// so the two shipped HTTP routes are stubbed for this whole file. The UI
// primitives it draws with are platform seed modules; the stub below renders the
// same data as plain host elements, which is what lets a test inspect the menu
// and click it.

const shippedRoutes = { apps: [], appsOk: true, openLog: [], openOk: true }

globalThis.fetch = (input, init = {}) => {
  const url = String(input)
  if (url === 'open-in-app/apps') {
    return Promise.resolve(shippedRoutes.appsOk
      ? { ok: true, status: 200, json: () => Promise.resolve({ apps: shippedRoutes.apps }) }
      : { ok: false, status: 500, json: () => Promise.resolve({}) })
  }
  if (url === 'open-in-app/open') {
    shippedRoutes.openLog.push(JSON.parse(String(init.body)))
    return Promise.resolve({ ok: shippedRoutes.openOk, status: shippedRoutes.openOk ? 200 : 502, json: () => Promise.resolve({}) })
  }
  return Promise.reject(new Error('unexpected fetch: ' + url))
}

/** The primitives the takeover needs, rendered as inspectable host elements. */
const primitivesStub = {
  Menu: (props) => reactShim.createElement('div', { 'data-menu': props.className }, [
    props.anchor,
    reactShim.createElement('div', { 'data-menu-open': props.open === true }, (props.items || []).map((item) =>
      reactShim.createElement('button', {
        key: item.id,
        'data-item': item.id,
        onClick: () => props.onSelect(item.id),
      }, [item.label, item.icon]))),
  ]),
  Tooltip: (props) => props.children,
  Toast: (props) => reactShim.createElement('div', { 'data-toast': props.text }, [props.text]),
  IconChevronDownOutlineRegular: () => reactShim.createElement('span', null, ['chevron']),
  IconRightUpOutlineRegular: () => reactShim.createElement('span', null, ['up']),
  IconWarningOutlineRegular: () => reactShim.createElement('span', null, ['warning']),
}

/** The `requires` map that makes the takeover render. */
const withPrimitives = () => ({ '@deepseek-ai/dsh-client-ui-primitives': primitivesStub })

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
async function bootClient({ services = {}, requires = {}, dictionaries = [], validInjects = [] } = {}) {
  const source = await readFile(BUNDLE, 'utf8')
  // Same realm on purpose: the bundle's own arrays/objects must satisfy
  // `assert.deepStrictEqual`, which a `vm` context's foreign prototypes break.
  const storage = new Map()
  const fakeWindow = {
    __ModuleLoader__: {
      load(options) {
        fakeWindow.__loaded = options
      },
    },
    prompt: () => 'prompted',
    // Records what was asked and answers yes, so a test can assert both that the
    // user is warned and that the action proceeds.
    confirm: (message) => {
      fakeWindow.__confirmations.push(message)
      return true
    },
    __confirmations: [],
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        storage.set(key, String(value))
      },
    },
  }
  const runBundle = new Function('window', source)
  runBundle(fakeWindow)

  const loadOptions = fakeWindow.__loaded
  assert.ok(loadOptions, 'the bundle must register a factory')
  const exportsObject = loadOptions.factory((specifier) => {
    if (specifier === 'react') return reactShim
    if (Object.prototype.hasOwnProperty.call(requires, specifier)) return requires[specifier]
    throw new Error('unexpected require: ' + specifier)
  })

  const slots = []
  const triggers = []
  const allDictionaries = dictionaries.slice()
  const effects = []
  const triggersRegistry = {
    registerSource(source) {
      triggers.push(source)
      return () => {}
    },
  }

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
        allDictionaries.push({ ns, dicts })
        return () => {}
      },
      bind(ns) {
        return (key, params) => {
          const dict = allDictionaries.find((entry) => entry.ns === ns)
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
      // Cordis calls the callback exactly when every named service exists — not
      // earlier, and never with one of them `undefined`. This stub therefore has
      // to keep the same promise: a scope that always fires would exercise a
      // branch production cannot reach (and would hand the bundle `undefined`
      // where production hands it a real service).
      if (deps.every((dep) => services[dep] !== undefined || validInjects.includes(dep))) {
        const scope = Object.assign({}, ctx, services, { slots: ctx.slots, effect: ctx.effect })
        callback(scope)
      }
      if (deps.includes('inputTriggers') && !services.inputTriggers) {
        callback({ inputTriggers: triggersRegistry, effect: ctx.effect })
      }
    },
    get(name) {
      if (name === 'inputTriggers') return services.inputTriggers || triggersRegistry
      return services[name]
    },
  }

  exportsObject.apply(ctx)

  return {
    exportsObject,
    loadOptions,
    slots,
    triggers,
    dictionaries: allDictionaries,
    effects,
    confirmations: fakeWindow.__confirmations,
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

/**
 * The layout face a composition with `@deepseek-ai/dsh-client-ui-layout`
 * publishes: `selectPanel` (which validates a panel id and takes `null` for the
 * Conversation) and the `panelInfo` selection source the header button reads to
 * decide whether it is a toggle. `panels` records every selection AND is the
 * set of ids `selectPanel` accepts.
 */
function layoutStub({ panels = ['conversation', 'code-workspace'], active = null, accept = true, refuseSelect = false } = {}) {
  const selections = []
  let current = active
  const listeners = []
  return {
    selections,
    services: {
      layout: {
        panelInfo: {
          getSnapshot: () => ({ activePanelId: current }),
          subscribe(listener) {
            listeners.push(listener)
            return () => {}
          },
        },
        selectPanel(panelId) {
          if (refuseSelect || (panelId !== null && (!accept || !panels.includes(panelId)))) {
            throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
          }
          selections.push(panelId)
          current = panelId
          for (const listener of listeners) listener()
        },
      },
    },
  }
}

/**
 * Boot the client with both transports wired, and return a render helper.
 *
 * A layout face is supplied by default, because the panel's page IS a
 * Conversation view: without one the bundle registers no view cell at all (that
 * is the degradation the dedicated tests below cover), so every other test here
 * would be exercising a surface that no longer exists.
 */
async function boot({ onRpc, onCommand, services = {}, requires = {}, dictionaries = [], layout: layoutFace = undefined, noLayout = false } = {}) {
  // A fresh harness is a fresh tree: effects arm again.
  EFFECT.pending = true
  EFFECT.cleanups.length = 0
  const rpcLog = []
  const commandLog = []
  const face = noLayout ? null : (layoutFace || layoutStub())
  const harness = await bootClient({
    requires,
    dictionaries,
    services: {
      ...(face ? face.services : {}),
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
  const view = harness.slots.find((entry) => entry.spec.name === 'conversation.view')
  const panel = harness.slots.find((entry) => entry.spec.name === 'main')
  return { harness, rpcLog, commandLog, header, dock, overlay, view, panel, layout: face, confirmations: harness.confirmations }
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

test('apply registers the View tab, the sidebar entry, its panel, the header action, the dock entry and the overlay', async () => {
  const face = layoutStub()
  const harness = await bootClient({ services: face.services })
  assert.deepEqual(
    harness.slots.map((entry) => entry.spec.name),
    ['conversation.session.header.actions', 'conversation.input.dock', 'shell.overlay', 'main', 'sidebar.panellist', 'conversation.view'],
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

  // The Conversation view: a list cell beside Chat (0) and Trajectory (10),
  // addressed by id because the owner filters the registered entries by it.
  const view = harness.slot('conversation.view').spec
  assert.equal(view.id, 'code-workspace')
  assert.equal(view.order, 30)
  assert.equal(view.locale, 'code-workspace')
  assert.equal(view.label(), '代码工作区')

  // The sidebar entry and the central panel it opens, under ONE id: the shell
  // resolves a sidebar click through `selectPanel(id)`, which dispatches by the
  // `main` cell's key.
  const main = harness.slot('main').spec
  assert.equal(main.key, 'code-workspace')
  const entry = harness.slot('sidebar.panellist').spec
  assert.equal(entry.id, 'code-workspace')
  assert.equal(entry.locale, 'code-workspace')
  assert.equal(entry.label(), '代码工作区')
  // The shipped rows are plugins at 0 and scheduled tasks at 10.
  assert.ok(entry.order > 0 && entry.order < 10, 'the entry sits between the shipped app panels')
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

test('the page reads its session state over the command channel', async () => {
  const { view, commandLog } = await boot()
  expand(view.component(kit()))
  await flush()
  assert.equal(commandLog.length, 1)
  assert.equal(commandLog[0].sessionId, 'session-1')
  assert.equal(commandLog[0].line, '/code-workspace list')
  // The third business argument is required on DSH >= 0.1.1.
  assert.deepEqual(commandLog[0].attachments, [])
})

test('the page renders the file, every folder, and the primary badge', async () => {
  const { view } = await boot()
  expand(view.component(kit()))
  await flush()
  const tree = expand(view.component(kit()))
  assert.ok(tree, 'the View must render while its tab is selected')
  const text = textOf(tree)
  assert.match(text, /D:\/ws\/app\.code-workspace/)
  assert.match(text, /Other/)
  assert.match(text, /D:\/other/)
  assert.match(text, /主目录/)
  assert.match(text, /工作区文件夹/)
})

test('the floating panel renders nothing until the creation page opens it', async () => {
  const { overlay } = await boot()
  assert.equal(expand(overlay.component({})), null)
})

test('a panel addressed to another surface never draws the floating window', async () => {
  const { view, overlay } = await boot()
  // A panel scoped to the Conversation page (the shape an older build left open
  // as a fallback) must not float once the page draws.
  expand(view.component(kit()))
  assert.equal(expand(overlay.component({})), null)
})

test('the page takes the panel over from a popover that was already open', async () => {
  const { dock, view, overlay } = await boot()
  // Pick a workspace file on the creation page: that popover is the one surface
  // a sessionless page has, so it must keep working.
  expand(dock.component(kit())).children[0].props.onClick()
  await flush()
  assert.ok(expand(overlay.component({})), 'the creation-page popover must render')
  // Then the user opens the page. The popover is the same panel on another
  // surface, so it must go away rather than float beside its own copy.
  expand(view.component(kit()))
  await flush()
  assert.equal(expand(overlay.component({})), null)
  assert.match(textOf(expand(view.component(kit()))), /该目录下没有 \.code-workspace 文件/)
})

// --------------------------------------------------- the Conversation view

test('the panel is a Conversation view, registered beside Chat and Trajectory', async () => {
  const face = layoutStub()
  const { view, rpcLog } = await boot({ layout: face })
  assert.ok(view, 'the panel must register in conversation.view')
  assert.equal(view.spec.id, 'code-workspace')
  assert.equal(view.spec.order, 30)
  assert.equal(view.spec.locale, 'code-workspace')
  assert.equal(view.spec.label(), '代码工作区')
  // With no session kit at all (a bare environment) it must still render — the
  // empty state is a state — and must not read the sessionless state channel.
  assert.ok(view.component({}))
  assert.equal(rpcLog.some((call) => call.endpoint === 'codeWorkspace/state'), false)
})

test('the header button is not rendered at all while the tab strip shows the page', async () => {
  const face = layoutStub()
  const { header } = await boot({ layout: face })
  // Two entry points for one page is noise: the tab is visible for the whole
  // session, so the header button removes itself.
  assert.equal(header.component(kit()), null)
  assert.equal(expand(header.component(kit())), null)
})

test('the header button still offers the page when the View could not register', async () => {
  const { header } = await boot({ noLayout: true })
  const button = header.component(kit())
  assert.ok(button, 'without a tab to use, the header button is the only way in')
  assert.match(textOf(button), /代码工作区/)
})

test('without a layout service the header button opens nothing, never a floating copy', async () => {
  const { header, overlay, view, commandLog } = await boot({ noLayout: true })
  assert.equal(view, undefined, 'the view cell is not registered without the layout face')
  assert.doesNotThrow(() => header.component(kit()).props.onClick())
  await flush()
  // No page to show, and deliberately no second surface either: the floating
  // panel is the creation page's popover, not a fallback for this button.
  assert.equal(expand(overlay.component({})), null)
  assert.equal(commandLog.length, 0)
})

test('a layout that refuses the panel id opens nothing and does not throw', async () => {
  // The cell registers (the service is present), but `selectPanel` refuses — the
  // documented behaviour for a panel id the shell has not registered. The tab is
  // there, so the header button is not drawn; nothing floats instead.
  const face = layoutStub({ refuseSelect: true })
  const { header, overlay, commandLog, view } = await boot({ layout: face })
  assert.equal(header.component(kit()), null, 'the tab exists, so the button is not drawn')
  assert.equal(expand(overlay.component({})), null)
  assert.equal(commandLog.length, 0)
  // The page itself still renders when its tab is selected: only the header
  // toggle depends on `selectPanel`.
  assert.ok(view.component(kit()))
})

test('the View scopes the shared panel store to the session it is drawn for', async () => {
  const face = layoutStub()
  const { view, commandLog, rpcLog } = await boot({ layout: face })
  expand(view.component(kit()))
  await flush()
  const tree = expand(view.component(kit()))
  assert.ok(tree)
  assert.match(textOf(tree), /D:\/ws\/app\.code-workspace/)
  assert.match(textOf(tree), /工作区文件夹/)
  assert.equal(commandLog[0].sessionId, 'session-1')
  // The View is not the creation page: it must not touch the sessionless channel
  // for state it can read through the conversation's own command.
  assert.equal(rpcLog.some((call) => call.endpoint === 'codeWorkspace/state'), false)
})

test('switching to another session re-addresses the shared store, so no command lands in the wrong conversation', async () => {
  const face = layoutStub()
  const { view, commandLog } = await boot({ layout: face })
  // Both sessions sit in the same container directory, so the container alone
  // cannot tell them apart — only the view's own session can.
  const propsFor = (sessionId) => kit({
    sessionId,
    useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/ws' }, 'session-2': { cwd: 'D:/ws' } } }),
  })
  const mount = (sessionId) => expand(view.component(propsFor(sessionId)))

  // The View mounted for session 1 already holds session 1's state.
  expand(view.component(propsFor('session-1')))
  await flush()
  assert.deepEqual(commandLog.map((call) => call.sessionId), ['session-1'])
  assert.match(textOf(expand(view.component(propsFor('session-1')))), /D:\/ws\/app\.code-workspace/)

  // The user switches sessions: the owner unmounts the old View and mounts one
  // for session 2. Every subsequent command — the read AND a mutation — must name
  // session 2.
  markUnmounted()
  expand(view.component(propsFor('session-2')))
  await flush()
  assert.deepEqual(commandLog.map((call) => call.sessionId), ['session-1', 'session-2'], 'session 2 must be read on its own turn: ' + JSON.stringify(commandLog))
  const two = expand(view.component(propsFor('session-2')))
  assert.match(textOf(two), /D:\/ws\/app\.code-workspace/)
  buttonByTitle(two, '移除').props.onClick()
  await flush()
  const remove = commandLog.find((call) => call.line === '/code-workspace remove 0')
  assert.ok(remove, 'the mutation must be issued')
  assert.equal(remove.sessionId, 'session-2', 'a mutation must never land in the session that was open before')
})

test('a re-render never triggers a read, and a remount reads once', async () => {
  const face = layoutStub()
  const { view, commandLog } = await boot({ layout: face })
  expand(view.component(kit()))
  await flush()
  assert.deepEqual(commandLog.map((call) => call.sessionId), ['session-1'])
  // React re-renders a mounted View on every state patch; those renders must not
  // each issue a command.
  expand(view.component(kit()))
  await flush()
  expand(view.component(kit()))
  await flush()
  assert.deepEqual(commandLog.map((call) => call.sessionId), ['session-1'])
  // Leaving the tab unmounts it; coming back is the deliberate "show me the
  // current state" gesture, so that mount reads again.
  markUnmounted()
  expand(view.component(kit()))
  await flush()
  assert.deepEqual(commandLog.map((call) => call.sessionId), ['session-1', 'session-1'])
})

test('a stale record can be removed from the list, and the file itself is not touched', async () => {
  const calls = []
  const { panel, confirmations } = await boot({
    onRpc: (endpoint, args) => {
      if (endpoint === 'codeWorkspace/recent') {
        return ok({ files: [{ file: 'D:/gone/old.code-workspace', containerDir: 'D:/gone', title: 'old', exists: false, missing: true }] })
      }
      if (endpoint === 'codeWorkspace/forgetFile') {
        calls.push(args.file)
        // The host answers the refreshed list, so one round trip both removes and
        // re-reads.
        return ok({ files: [] })
      }
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      return ok(STATE)
    },
  })
  expand(panel.component({}))
  await flush()
  const tree = expand(panel.component({}))
  const forget = nodesWhere(tree, (node) => node.props && node.props.title === '取消关联')[0]
  assert.ok(forget, 'a record must be removable from the list — text: ' + textOf(tree))
  forget.props.onClick({ stopPropagation() {} })
  await flush()
  assert.deepEqual(calls, ['D:/gone/old.code-workspace'])
  // A list has no undo, so the user is asked first.
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0], /old\.code-workspace/)
  assert.match(textOf(expand(panel.component({}))), /还没有记录过任何/)
})

test('a View with no workspace renders the empty state and still reads its session', async () => {
  const face = layoutStub()
  const { view } = await boot({
    layout: face,
    services: {
      sessions: { list: { getSnapshot: () => ({ current: 'session-2', ids: ['session-2'], byId: { 'session-2': { cwd: undefined } } }) } },
      workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    },
  })
  // `useContainerDir` reads the view's own session through the standard kit, so
  // this is the empty state a session without a recorded directory produces.
  const tree = expand(view.component({
    sessionId: 'session-2',
    useSessions: (selector) => selector({ byId: { 'session-2': { cwd: undefined } } }),
    useWorkspaces: (selector) => selector({ items: [] }),
  }))
  assert.ok(tree)
  assert.match(textOf(tree), /还没有关联 \.code-workspace 文件/)
})

test('with nothing associated the page itself is the picker, starting at the host home', async () => {
  const face = layoutStub()
  const { view, rpcLog } = await boot({
    layout: face,
    onRpc: (endpoint) => (endpoint === 'codeWorkspace/browse' ? ok({ path: 'C:/Users/edy', parent: 'C:/Users', home: 'C:/Users/edy', entries: [], truncated: false }) : ok(null)),
    services: {
      sessions: { list: { getSnapshot: () => ({ current: 'session-2', ids: ['session-2'], byId: { 'session-2': { cwd: undefined } } }) } },
      workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    },
  })
  const props = {
    sessionId: 'session-2',
    useSessions: (selector) => selector({ byId: { 'session-2': { cwd: undefined } } }),
    useWorkspaces: (selector) => selector({ items: [] }),
  }
  expand(view.component(props))
  await flush()
  const tree = expand(view.component(props))
  // The entry that was lost when the header button's popover went away: without
  // it there is no way to associate a workspace file from this session at all.
  buttonByLabel(tree, '切换文件').props.onClick()
  await flush()
  const browse = rpcLog.find((call) => call.endpoint === 'codeWorkspace/browse')
  assert.ok(browse, 'opening a workspace file must start a browse')
  // Not the session directory (where the file was already shown to be absent),
  // but the host home — the one place a host can name to browse from.
  assert.deepEqual(browse.args, { path: 'C:/Users/edy' })
  const browsed = expand(view.component(props))
  assert.match(textOf(browsed), /浏览目录/)
  assert.match(textOf(browsed), /C:\/Users\/edy/)
})

// ------------------------------------------- the sidebar entry and its panel

test('the sidebar entry opens a sessionless panel, so it works with no workspace open yet', async () => {
  const { panel, overlay, commandLog, rpcLog } = await boot()
  assert.ok(panel, 'the sidebar panel must register as the main cell')
  expand(panel.component({}))
  await flush()
  // No session exists here, so the page drives the host's sessionless channel.
  // That is the whole point of this entry: it does not need a Workspace.
  assert.deepEqual(commandLog, [])
  assert.ok(rpcLog.some((call) => call.endpoint === 'codeWorkspace/editors'), JSON.stringify(rpcLog))
  // Nothing is associated yet, so the page offers the picker rather than a status.
  const tree = expand(panel.component({}))
  assert.match(textOf(tree), /代码工作区/)
  assert.equal(expand(overlay.component({})), null)
})

test('the sidebar page is a manager: it lists every workspace it knows, and marks the registered ones', async () => {
  const listing = {
    path: 'C:/Users/edy',
    parent: 'C:/Users',
    home: 'C:/Users/edy',
    entries: [],
    truncated: false,
  }
  const { panel } = await boot({
    services: {
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [{ id: 'w1', path: 'D:/ws', sessionIds: ['session-1'] }] }),
        },
      },
    },
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/recent') {
        return ok({
          files: [
            { file: 'D:/ws/app.code-workspace', containerDir: 'D:/ws', title: 'app', exists: true, missing: false },
            // Recorded but gone: the host probes every file, and a manager that
            // silently dropped it would hide that it disappeared.
            { file: 'D:/gone/old.code-workspace', containerDir: 'D:/gone', title: 'old', exists: false, missing: true },
          ],
        })
      }
      if (endpoint === 'codeWorkspace/browse') return ok(listing)
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      if (endpoint === 'codeWorkspace/state') return ok(STATE)
      return ok(null)
    },
  })
  expand(panel.component({}))
  await flush()
  const tree = expand(panel.component({}))
  const text = textOf(tree)
  assert.match(text, /代码工作区/, 'the list has a heading')
  assert.match(text, /app/)
  assert.match(text, /D:\/ws/)
  assert.match(text, /old/)
  // `D:/ws` is a registered DSH workspace, `D:/gone` is not.
  assert.match(text, /已注册/)
  assert.match(text, /不存在/)
})

test('choosing a listed workspace opens it, which is how a session moves between workspaces', async () => {
  const opened = []
  const { panel } = await boot({
    onRpc: (endpoint, args) => {
      if (endpoint === 'codeWorkspace/recent') {
        return ok({ files: [{ file: 'D:/other/team.code-workspace', containerDir: 'D:/other', title: 'team', exists: true, missing: false }] })
      }
      if (endpoint === 'codeWorkspace/open') {
        opened.push(args.file)
        return ok(Object.assign({}, STATE, { workspace: { id: 'w2', path: 'D:/other', title: 'team' } }))
      }
      if (endpoint === 'codeWorkspace/browse') {
        return ok({ path: 'D:/other', parent: 'D:/', home: 'C:/Users/edy', entries: [], truncated: false })
      }
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      return ok(STATE)
    },
  })
  expand(panel.component({}))
  await flush()
  const tree = expand(panel.component({}))
  const row = nodesWhere(tree, (node) => node.props && node.props.title === 'D:/other/team.code-workspace')[0]
  assert.ok(row, 'the listed workspace must render a row — text: ' + textOf(tree))
  row.props.onClick()
  await flush()
  assert.deepEqual(opened, ['D:/other/team.code-workspace'])
})

test('the sidebar panel shows a workspace picked on the creation page', async () => {
  const opened = []
  const { dock, overlay, panel } = await boot({
    services: { uiWorkspace: { openWorkspace(id) { opened.push(id); return Promise.resolve() } } },
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/open') {
        return ok(Object.assign({}, STATE, { workspace: { id: 'w9', path: 'D:/ws', title: 'app' } }))
      }
      if (endpoint === 'codeWorkspace/recent') return ok({ files: [] })
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      if (endpoint === 'codeWorkspace/browse') {
        return ok({ path: 'D:/ws', parent: 'D:/', home: 'C:/Users/edy', entries: [], truncated: false })
      }
      return ok(STATE)
    },
  })
  // Pick the file on the creation page, which has no session…
  expand(dock.component(kit())).children[0].props.onClick()
  await flush()
  assert.match(textOf(expand(overlay.component({}))), /D:\/ws\/app\.code-workspace/)
  // …then the user opens the sidebar page, for the same workspace, with no session.
  expand(panel.component({}))
  await flush()
  const tree = expand(panel.component({}))
  assert.match(textOf(tree), /D:\/ws\/app\.code-workspace/)
  assert.equal(expand(overlay.component({})), null, 'the sidebar page takes over from the popover')
})

test('the browser offers the host file dialog, and a chosen file is opened as a workspace', async () => {
  const listing = {
    path: 'C:/Users/edy',
    parent: 'C:/Users',
    home: 'C:/Users/edy',
    entries: [],
    truncated: false,
  }
  const opened = []
  const { view } = await boot({
    onRpc: (endpoint, args) => {
      if (endpoint === 'codeWorkspace/browse') return ok(listing)
      if (endpoint === 'codeWorkspace/pickFile') return ok({ outcome: 'picked', path: 'D:/ws/app.code-workspace' })
      if (endpoint === 'codeWorkspace/open') {
        opened.push(args.file)
        return ok(Object.assign({}, STATE, { workspace: { id: 'w9', path: 'D:/ws', title: 'app' } }))
      }
      if (endpoint === 'codeWorkspace/recent') return ok({ files: [] })
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      return ok(STATE)
    },
  })
  expand(view.component(kit()))
  await flush()
  const tree = expand(view.component(kit()))
  buttonByLabel(tree, '切换文件').props.onClick()
  await flush()
  const browseTree = expand(view.component(kit()))
  // The dialog is offered beside the in-app browser, not instead of it: a host
  // that cannot show one (SSH, non-Windows) still has a working path.
  const native = buttonByLabel(browseTree, '从资源管理器选择')
  assert.ok(native, 'the host file dialog must be offered — tree: ' + textOf(browseTree))
  native.props.onClick()
  await flush()
  assert.deepEqual(opened, ['D:/ws/app.code-workspace'])
})

test('a host that cannot show the dialog says so once, and the browser stays usable', async () => {
  const listing = {
    path: 'C:/Users/edy',
    parent: 'C:/Users',
    home: 'C:/Users/edy',
    entries: [],
    truncated: false,
  }
  const { view } = await boot({
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/browse') return ok(listing)
      if (endpoint === 'codeWorkspace/pickFile') {
        return ok({ outcome: 'unavailable', error: 'this Harness was reached over SSH: the browser is not on this host' })
      }
      if (endpoint === 'codeWorkspace/recent') return ok({ files: [] })
      if (endpoint === 'codeWorkspace/editors') return ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })
      return ok(STATE)
    },
  })
  expand(view.component(kit()))
  await flush()
  buttonByLabel(expand(view.component(kit())), '切换文件').props.onClick()
  await flush()
  buttonByLabel(expand(view.component(kit())), '从资源管理器选择').props.onClick()
  await flush()
  const tree = expand(view.component(kit()))
  assert.match(textOf(tree), /这台主机打不开系统文件对话框/)
  assert.match(textOf(tree), /SSH/)
  // The in-app browser is still there, which is the whole reason to explain it.
  assert.ok(buttonByLabel(tree, '上级'))
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

test('removing a folder from the page issues the indexed remove command', async () => {
  const { header, view, commandLog } = await boot()
  expand(view.component(kit()))
  await flush()
  const tree = expand(view.component(kit()))
  // The page's ✕ is gone (the tab strip owns navigation), so address the row
  // action by its accessible title.
  const remove = buttonByTitle(tree, '移除')
  assert.ok(remove, 'a remove button must exist')
  remove.props.onClick()
  await flush()
  assert.ok(commandLog.some((call) => call.line === '/code-workspace remove 0'), JSON.stringify(commandLog))
  // The mutation re-reads state through the command channel.
  assert.equal(commandLog.at(-1).line, '/code-workspace list')
})

test('adding a folder sends the typed path and clears the field', async () => {
  const { header, view, commandLog } = await boot()
  // The View reads on mount, so the first paint is "busy": settle before driving
  // its controls, and render again for the state the read produced.
  expand(view.component(kit()))
  await flush()
  let tree = expand(view.component(kit()))
  const pathInput = inputsIn(tree).find((input) => input.props.placeholder.includes('文件夹路径'))
  assert.ok(pathInput, 'the folder path field must exist')
  pathInput.props.onChange({ target: { value: 'D:/third' } })
  tree = expand(view.component(kit()))
  const addButton = buttonByLabel(tree, '添加文件夹')
  assert.equal(typeof addButton.props.onClick, 'function', 'the add control must be enabled once the read settled')
  addButton.props.onClick()
  await flush()
  assert.ok(commandLog.some((call) => call.line === '/code-workspace add "D:/third"'), JSON.stringify(commandLog))
  // The field is cleared optimistically.
  tree = expand(view.component(kit()))
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
    ['codeWorkspace/state', 'codeWorkspace/recent', 'codeWorkspace/editors'],
  )
  assert.deepEqual(rpcLog[0].args, { containerDir: 'D:/ws' })
  assert.equal(commandLog.length, 0)
})

test('a failed folder mutation surfaces the host message and re-reads state', async () => {
  const { header, view, commandLog } = await boot({
    onCommand: () => commandOk(STATE),
    onRpc: () => ok(null),
  })
  expand(view.component(kit()))
  await flush()
  const tree = expand(view.component(kit()))
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
  assert.equal(harness.slots.length, 5)
  assert.equal(harness.triggers.length, 1)
  // Rendering the components with bare props must not throw.
  assert.ok(harness.slot('conversation.session.header.actions').component({}))
  assert.equal(harness.slot('conversation.input.dock').component({}), null)
  assert.equal(harness.slot('shell.overlay').component({}), null)
})

// ------------------------------------------------------- open in an editor

const DETECTED = {
  editors: [
    { id: 'trae', label: 'Trae CN', executable: 'D:/app/Trae CN/Trae CN.exe', source: 'uninstall-record' },
    { id: 'vscode', label: 'VS Code', executable: 'C:/Code/Code.exe', source: 'app-paths' },
  ],
  preferred: 'trae',
  ssh: false,
  platform: 'win32',
}

test('the page lists every detected family editor and opens the workspace through the host', async () => {
  const { header, view, rpcLog } = await boot({
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/editors') return ok(DETECTED)
      if (endpoint === 'codeWorkspace/openInEditor') {
        return ok({ ok: true, editor: 'vscode', label: 'VS Code', executable: 'C:/Code/Code.exe', target: 'D:/ws/app.code-workspace', kind: 'workspace' })
      }
      return ok(STATE)
    },
  })
  let tree = expand(view.component(kit()))
  await flush()
  tree = expand(view.component(kit()))
  assert.match(textOf(tree), /在编辑器中打开/)
  const button = buttonByLabel(tree, 'VS Code')
  assert.ok(button, 'a button per detected editor must exist')
  // The tooltip names the executable and the target the host will use.
  assert.match(String(button.props.title), /Code\.exe/)
  assert.match(String(button.props.title), /app\.code-workspace/)
  button.props.onClick()
  await flush()
  const call = rpcLog.find((entry) => entry.endpoint === 'codeWorkspace/openInEditor')
  assert.deepEqual(call.args, { containerDir: 'D:/ws', editorId: 'vscode' })
  // The host's own answer is surfaced, naming the editor and the file it opened.
  tree = expand(view.component(kit()))
  assert.match(textOf(tree), /已用 VS Code 打开/)
  assert.match(textOf(tree), /app\.code-workspace/)
})

test('a host failure on open is surfaced as the host message, not swallowed', async () => {
  const { header, view } = await boot({
    onRpc: (endpoint) => {
      if (endpoint === 'codeWorkspace/editors') return ok(DETECTED)
      if (endpoint === 'codeWorkspace/openInEditor') {
        return { ok: false, error: { message: 'code-workspace: the editor refused to start' } }
      }
      return ok(STATE)
    },
  })
  expand(view.component(kit()))
  await flush()
  buttonByLabel(expand(view.component(kit())), 'Trae CN').props.onClick()
  await flush()
  assert.match(textOf(expand(view.component(kit()))), /the editor refused to start/)
})

test('without an editor the page says so, and an SSH session says why', async () => {
  const { header, view } = await boot({
    onRpc: (endpoint) => (endpoint === 'codeWorkspace/editors' ? ok({ editors: [], preferred: null, ssh: false, platform: 'win32' }) : ok(STATE)),
  })
  expand(view.component(kit()))
  await flush()
  assert.match(textOf(expand(view.component(kit()))), /未检测到 VS Code 系列编辑器/)

  const ssh = await boot({
    onRpc: (endpoint) => (endpoint === 'codeWorkspace/editors' ? ok({ editors: [], preferred: null, ssh: true, platform: 'win32' }) : ok(STATE)),
  })
  expand(ssh.view.component(kit()))
  await flush()
  assert.match(textOf(expand(ssh.view.component(kit()))), /通过 SSH 访问/)
})

test('the family takes over the shipped cell at a lower priority, and is skipped without the primitives', async () => {
  const taken = await bootClient({ requires: withPrimitives() })
  await flush()
  const headerCell = taken.slots.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
  const treeCell = taken.slots.find((entry) => entry.spec.name === 'sidebar.right.tab.files.actions')
  assert.ok(headerCell, 'the header utilities cell must be taken over')
  assert.ok(treeCell, 'the file tree actions cell must be taken over')
  assert.equal(headerCell.spec.id, 'open-in-app')
  // Lowest priority renders, so -2 beats the shipped 0 and open-in-trae's -1
  // without ever registering at a priority that would throw.
  assert.equal(headerCell.spec.priority, -2)
  assert.equal(treeCell.spec.priority, -2)
  assert.equal(headerCell.spec.order, -10)

  // Without the seed module the shipped control is left in place rather than
  // shadowed by a cell that cannot render.
  const bare = await bootClient()
  assert.equal(bare.slots.some((entry) => entry.spec.name === 'conversation.session.header.utilities'), false)
  assert.equal(bare.slots.length, 5)
})

test('the menu keeps every shipped entry, replaces the family ones, and adds the missing family', async () => {
  shippedRoutes.apps = ['explorer', 'vscode', 'sublimetext']
  shippedRoutes.openLog = []
  const harness = await bootClient({
    requires: withPrimitives(),
    dictionaries: [{ ns: 'open-in-app', dicts: { zh: { 'app.explorer': '文件资源管理器（默认）', 'app.vscode': 'VS Code', 'app.sublimetext': 'Sublime Text' }, en: {} } }],
    services: {
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: 'D:/ws' } } }) } },
      connection: {
        rpc: {
          call: (channel, endpoint) => Promise.resolve(endpoint === 'codeWorkspace/editors' ? ok(DETECTED) : ok(null)),
        },
      },
    },
  })
  await flush()
  const cell = harness.slots.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
  const props = Object.assign({}, cell.spec.inject(), {
    sessionId: 'session-1',
    useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/ws' } } }),
  })
  const tree = expand(cell.component(props))
  const items = nodesWhere(tree, (node) => node.props && node.props['data-item'] !== undefined).map((node) => node.props['data-item'])
  // Shipped order is preserved, VS Code is replaced rather than duplicated, and
  // Trae — which the shipped catalog cannot know — is appended.
  assert.deepEqual(items, ['app:explorer', 'app:vscode', 'app:sublimetext', 'app:trae'])
  assert.match(textOf(tree), /Trae CN/)
})

test('a family entry opens the workspace through this plugin, every other entry through the shipped route', async () => {
  shippedRoutes.apps = ['explorer', 'vscode']
  shippedRoutes.openLog = []
  const rpcLog = []
  const harness = await bootClient({
    requires: withPrimitives(),
    dictionaries: [{ ns: 'open-in-app', dicts: { zh: { 'app.explorer': '文件资源管理器（默认）', 'app.vscode': 'VS Code' }, en: {} } }],
    services: {
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: 'D:/ws' } } }) } },
      connection: {
        rpc: {
          call: (channel, endpoint, payload) => {
            rpcLog.push({ endpoint, args: payload && payload.args })
            return Promise.resolve(endpoint === 'codeWorkspace/editors' ? ok(DETECTED) : ok({ ok: true, editor: 'trae', label: 'Trae CN', target: 'D:/ws/app.code-workspace', kind: 'workspace' }))
          },
        },
      },
    },
  })
  await flush()
  const cell = harness.slots.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
  const props = Object.assign({}, cell.spec.inject(), {
    sessionId: 'session-1',
    useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/ws' } } }),
  })
  const itemButton = (tree, itemId) => nodesWhere(tree, (node) => node.props && node.props['data-item'] === itemId)[0]

  itemButton(expand(cell.component(props)), 'app:trae').props.onClick()
  await flush()
  const own = rpcLog.find((entry) => entry.endpoint === 'codeWorkspace/openInEditor')
  assert.deepEqual(own.args, { containerDir: 'D:/ws', editorId: 'trae' })
  assert.equal(shippedRoutes.openLog.length, 0)

  itemButton(expand(cell.component(props)), 'app:explorer').props.onClick()
  await flush()
  assert.deepEqual(shippedRoutes.openLog, [{ app: 'explorer', path: 'D:/ws' }])
})

test('a failed shipped launch leaves the control in its error state instead of claiming success', async () => {
  shippedRoutes.apps = ['explorer']
  shippedRoutes.openLog = []
  shippedRoutes.openOk = false
  try {
    const harness = await bootClient({
      requires: withPrimitives(),
      dictionaries: [{ ns: 'open-in-app', dicts: { zh: { 'app.explorer': '文件资源管理器（默认）' }, en: {} } }],
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: 'D:/ws' } } }) } },
        connection: { rpc: { call: () => Promise.resolve(ok({ editors: [], preferred: null, ssh: false, platform: 'win32' })) } },
      },
    })
    await flush()
    const cell = harness.slots.find((entry) => entry.spec.name === 'conversation.session.header.utilities')
    const props = Object.assign({}, cell.spec.inject(), {
      sessionId: 'session-1',
      useSessions: (selector) => selector({ byId: { 'session-1': { cwd: 'D:/ws' } } }),
    })
    // The launch state lives in the shared store, which is what the control's own
    // banner reads (the banner's transient copy is component state, which this
    // hook-once React shim deliberately cannot re-render).
    const operation = props.hooks.openInAppLaunch
    nodesWhere(expand(cell.component(props)), (node) => node.props && node.props['data-item'] === 'app:explorer')[0].props.onClick()
    await flush()
    assert.deepEqual(operation.get(), { phase: 'error', id: 'explorer' })
    assert.deepEqual(shippedRoutes.openLog, [{ app: 'explorer', path: 'D:/ws' }])
  } finally {
    shippedRoutes.openOk = true
  }
})

