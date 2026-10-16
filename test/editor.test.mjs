/**
 * Editor-family behaviour tests, run with no DSH, no editor installed and no
 * registry: every source of truth (platform, environment, registry, PATH, file
 * system) is injected, so the resolution chain is exercised end to end as pure
 * decisions.
 *
 * The two properties worth stating twice:
 *
 *   - a candidate is accepted only when the file system PROVES it, and the
 *     basename still names that family member, so a registry record cannot point
 *     the launcher at an unrelated program;
 *   - a launch is `<executable> <target>` with a scrubbed environment, because
 *     `ELECTRON_RUN_AS_NODE` inherited from this harness turns any Electron
 *     editor into a silent no-op that exits 0.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EDITOR_FAMILY,
  EDITOR_IDS,
  chooseEditor,
  cleanRegistryPath,
  editorChildEnv,
  editorTarget,
  findFamilyMember,
  isRegularFile,
  launchEditor,
  looksLikeFamilyExecutable,
  parseRegistryValues,
  portableInstallPaths,
  resolveEditors,
  resolvedLabel,
  windowsInstallDirs,
} from '../lib/editor.js'
import { extractExecutableIconPng, iconDataUrl, isPlausibleIconPng } from '../lib/editor-icon.js'

// ------------------------------------------------------------- fake host

/** `reg.exe query …\App Paths\<exe> /ve` output for one registered default value. */
function appPathsOutput(exe, target) {
  const key = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe
  return '\r\n' + key + '\r\n    (Default)    REG_SZ    ' + target + '\r\n'
}

/** One `reg.exe query …Uninstall /s /f <prefix>` record. */
function uninstallOutput(displayName, values) {
  const key = 'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + displayName
  const lines = Object.entries(values).map(([name, value]) => '    ' + name + '    REG_SZ    ' + value)
  return '\r\n' + key + '\r\n' + lines.join('\r\n') + '\r\n'
}

/**
 * A host whose registry, PATH and file set are exactly what the test declares.
 * @returns `{ options, registryCalls, pathCalls }` for {@link resolveEditors}.
 */
function fakeHost({ platform = 'win32', env = {}, files = [], apps = {}, records = [], path = {} } = {}) {
  const fileSet = new Set(files.map((entry) => String(entry).toLowerCase()))
  const registryCalls = []
  const pathCalls = []
  const registry = (...args) => {
    registryCalls.push(args)
    const key = args[1]
    if (typeof key === 'string' && key.includes('App Paths')) {
      for (const [exe, target] of Object.entries(apps)) {
        if (key.endsWith('\\' + exe) && args.includes('/ve')) return appPathsOutput(exe, target)
      }
      return ''
    }
    if (typeof key === 'string' && key.includes('Uninstall')) {
      const prefix = String(args[4] ?? '')
      return records
        .filter((record) => prefix === '' || String(record.displayName).includes(prefix))
        .map((record) => uninstallOutput(record.displayName, record.values))
        .join('')
    }
    return ''
  }
  const pathLookup = (names) => {
    pathCalls.push(names)
    const found = []
    for (const name of names) for (const hit of path[name] ?? []) found.push(hit)
    return found
  }
  return {
    registryCalls,
    pathCalls,
    options: {
      platform,
      env,
      registry,
      pathLookup,
      isFile: (candidate) => fileSet.has(String(candidate).toLowerCase()),
    },
  }
}

/** A PNG payload of a plausible size, for icon assertions. */
const png = (size = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 7)])

// --------------------------------------------------------------- family

test('the family covers every VS Code fork the shipped catalog knows, plus VSCodium and Trae', () => {
  // These four ids are the shipped `OPEN_IN_APP_CATALOG` ids verbatim, so the
  // menu takeover replaces an entry instead of listing the same editor twice.
  for (const shipped of ['vscode', 'vscodeinsiders', 'cursor', 'windsurf']) {
    assert.ok(EDITOR_IDS.includes(shipped), shipped + ' must keep the shipped id')
  }
  assert.ok(EDITOR_IDS.includes('vscodium'))
  assert.ok(EDITOR_IDS.includes('trae'))
  assert.equal(new Set(EDITOR_IDS).size, EDITOR_IDS.length, 'ids must be unique')
  for (const member of EDITOR_FAMILY) {
    assert.equal(typeof member.label, 'string')
    assert.ok(member.variants.length > 0, member.id + ' needs an install shape')
    assert.ok(member.cli.length > 0, member.id + ' needs a CLI name')
    assert.ok(member.winDirs.length > 0, member.id + ' needs a conventional directory')
    for (const shape of member.variants) assert.match(shape.exe, /\.exe$/)
  }
  // Trae ships as `Trae` and `Trae CN`: two shapes of one member, in that order.
  const trae = findFamilyMember('trae')
  assert.deepEqual(trae.variants.map((shape) => shape.exe), ['Trae.exe', 'Trae CN.exe'])
  assert.equal(findFamilyMember('not-an-editor'), null)
  assert.equal(findFamilyMember(undefined), null)
})

test('editorChildEnv strips this harness\'s identity, credentials and the Electron host marker', () => {
  const env = editorChildEnv({
    PATH: 'C:\\Windows',
    HOME: 'C:\\Users\\edy',
    LOCALAPPDATA: 'C:\\Users\\edy\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    LANG: 'zh_CN.UTF-8',
    DSH_HOME: 'C:\\Users\\edy\\.dsh',
    DSH_WEB_URL: 'http://127.0.0.1:19387',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096',
    OPENAI_API_KEY: 'sk-x',
    GH_TOKEN: 'ghp-x',
    DB_PASSWORD: 'hunter2',
    MY_SECRET: 'x',
    EMPTY: undefined,
  })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOCALAPPDATA', 'PATH', 'ProgramFiles'])
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
})

test('cleanRegistryPath removes quotes and the icon resource index', () => {
  assert.equal(cleanRegistryPath('"C:\\app\\Code.exe",0'), 'C:\\app\\Code.exe')
  assert.equal(cleanRegistryPath('  C:\\app\\Code.exe  '), 'C:\\app\\Code.exe')
  assert.equal(cleanRegistryPath('"D:\\app\\Trae CN\\Trae CN.exe",-12'), 'D:\\app\\Trae CN\\Trae CN.exe')
  assert.equal(cleanRegistryPath(undefined), '')
})

test('parseRegistryValues lower-cases value names and keeps one map per printed key', () => {
  const text = 'HKEY_A\r\n    DisplayIcon    REG_SZ    C:\\a.exe,0\r\n    InstallLocation    REG_EXPAND_SZ    C:\\a\r\nHKEY_B\r\n    (Default)    REG_SZ    D:\\b.exe\r\n'
  const keys = parseRegistryValues(text)
  assert.equal(keys.length, 2)
  assert.equal(keys[0].get('displayicon'), 'C:\\a.exe,0')
  assert.equal(keys[0].get('installlocation'), 'C:\\a')
  assert.equal(keys[1].get('(default)'), 'D:\\b.exe')
})

test('looksLikeFamilyExecutable refuses a basename that is not that member\'s own', () => {
  const vscode = findFamilyMember('vscode')
  assert.equal(looksLikeFamilyExecutable(vscode, 'C:\\app\\Code.exe', 'win32'), true)
  assert.equal(looksLikeFamilyExecutable(vscode, 'C:\\app\\code.exe', 'win32'), true)
  assert.equal(looksLikeFamilyExecutable(vscode, 'C:\\app\\Code - Insiders.exe', 'win32'), false)
  assert.equal(looksLikeFamilyExecutable(vscode, 'C:\\app\\evil.exe', 'win32'), false)
  // Trae answers to both of its install shapes, and to nothing else.
  const trae = findFamilyMember('trae')
  assert.equal(looksLikeFamilyExecutable(trae, 'D:\\app\\Trae\\Trae.exe', 'win32'), true)
  assert.equal(looksLikeFamilyExecutable(trae, 'D:\\app\\Trae CN\\Trae CN.exe', 'win32'), true)
  assert.equal(looksLikeFamilyExecutable(trae, 'D:\\app\\Trae CN\\trae-helper.exe', 'win32'), false)
  // Outside Windows the CLI name is the identity, never the `.exe`.
  assert.equal(looksLikeFamilyExecutable(vscode, '/usr/bin/code', 'linux'), true)
  assert.equal(looksLikeFamilyExecutable(vscode, '/usr/bin/Code.exe', 'linux'), false)
})

test('a resolved install is labelled by the shape that matched', () => {
  const trae = findFamilyMember('trae')
  assert.equal(resolvedLabel(trae, 'D:\\app\\Trae CN\\Trae CN.exe', 'win32'), 'Trae CN')
  assert.equal(resolvedLabel(trae, 'D:\\app\\Trae\\Trae.exe', 'win32'), 'Trae')
  const vscode = findFamilyMember('vscode')
  assert.equal(resolvedLabel(vscode, 'C:\\app\\Code.exe', 'win32'), 'VS Code')
  // No shape carries a nicer name outside Windows, so the member's label stands.
  assert.equal(resolvedLabel(vscode, '/usr/bin/code', 'linux'), 'VS Code')
})

// ----------------------------------------------------------- resolution

test('an installed file is accepted only when it exists and still names the family member', () => {
  const good = fakeHost({ files: ['C:\\app\\Code.exe'], apps: { 'Code.exe': 'C:\\app\\Code.exe' } })
  assert.deepEqual(resolveEditors(good.options), [
    { id: 'vscode', label: 'VS Code', executable: 'C:\\app\\Code.exe', source: 'app-paths' },
  ])

  // The registry record names another program: the osascript abuse case.
  const foreign = fakeHost({ files: ['C:\\evil\\evil.exe'], apps: { 'Code.exe': 'C:\\evil\\evil.exe' } })
  assert.deepEqual(resolveEditors(foreign.options), [])

  // The record points at the right name, but no such file exists.
  const missing = fakeHost({ apps: { 'Code.exe': 'C:\\gone\\Code.exe' } })
  assert.deepEqual(resolveEditors(missing.options), [])
})

test('the chain is App Paths, then uninstall records, then PATH, then the conventional directories', () => {
  const all = fakeHost({
    files: ['C:\\apppath\\Code.exe', 'C:\\uninstall\\Code.exe', 'C:\\pathhit\\Code.exe', 'C:\\Users\\edy\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
    env: { LOCALAPPDATA: 'C:\\Users\\edy\\AppData\\Local' },
    apps: { 'Code.exe': 'C:\\apppath\\Code.exe' },
    records: [{ displayName: 'Microsoft Visual Studio Code', values: { DisplayIcon: 'C:\\uninstall\\Code.exe,0' } }],
    path: { 'Code.exe': ['C:\\pathhit\\Code.exe'] },
  })
  const resolved = resolveEditors(all.options)
  assert.equal(resolved[0].executable, 'C:\\apppath\\Code.exe')
  assert.equal(resolved[0].source, 'app-paths')

  const noAppPaths = fakeHost({
    files: ['C:\\uninstall\\Code.exe', 'C:\\Users\\edy\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
    env: { LOCALAPPDATA: 'C:\\Users\\edy\\AppData\\Local' },
    records: [{ displayName: 'Microsoft Visual Studio Code', values: { DisplayIcon: 'C:\\uninstall\\Code.exe,0' } }],
  })
  const fromRecord = resolveEditors(noAppPaths.options)
  assert.equal(fromRecord[0].source, 'uninstall-record')

  const fromPath = fakeHost({ files: ['C:\\pathhit\\Code.exe'], path: { 'Code.exe': ['C:\\pathhit\\Code.exe'] } })
  assert.equal(resolveEditors(fromPath.options)[0].source, 'path')

  const fromDir = fakeHost({
    files: ['C:\\Users\\edy\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
    env: { LOCALAPPDATA: 'C:\\Users\\edy\\AppData\\Local' },
  })
  const installed = resolveEditors(fromDir.options)
  assert.equal(installed[0].source, 'install-dir')
  assert.equal(installed[0].executable, 'C:\\Users\\edy\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe')
})

test('an install outside every conventional directory is still proved through its uninstall record', () => {
  // This is how Trae lands on the machine this plugin was written for:
  // `D:\app\Trae CN\`, no App Paths entry, one uninstall record.
  const host = fakeHost({
    files: ['D:\\app\\Trae CN\\Trae CN.exe'],
    records: [{ displayName: 'Trae CN', values: { DisplayIcon: 'D:\\app\\Trae CN\\Trae CN.exe', InstallLocation: 'D:\\app\\Trae CN' } }],
  })
  const resolved = resolveEditors(host.options)
  assert.deepEqual(resolved, [{ id: 'trae', label: 'Trae CN', executable: 'D:\\app\\Trae CN\\Trae CN.exe', source: 'uninstall-record' }])
})

test('an InstallLocation is the fallback when a record carries no DisplayIcon', () => {
  const host = fakeHost({
    files: ['D:\\app\\Trae\\Trae.exe'],
    records: [{ displayName: 'Trae', values: { InstallLocation: 'D:\\app\\Trae' } }],
  })
  const resolved = resolveEditors(host.options)
  assert.equal(resolved[0].executable, 'D:\\app\\Trae\\Trae.exe')
  assert.equal(resolved[0].label, 'Trae')
})

test('a record whose icon names another program is ignored, and the real install still resolves', () => {
  const host = fakeHost({
    files: ['C:\\Program Files\\Microsoft VS Code\\Code.exe'],
    env: { ProgramFiles: 'C:\\Program Files' },
    // A record for a *different* editor, matched by our own prefix search.
    records: [{ displayName: 'Microsoft Visual Studio Code Insiders', values: { DisplayIcon: 'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe,0' } }],
  })
  const resolved = resolveEditors(host.options)
  // VS Code resolves from its directory; the Insiders record cannot stand in for it.
  assert.deepEqual(resolved, [
    { id: 'vscode', label: 'VS Code', executable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', source: 'install-dir' },
  ])
})

test('the same executable found through several sources is reported once, from the first source', () => {
  const host = fakeHost({
    files: ['C:\\app\\Code.exe'],
    apps: { 'Code.exe': 'C:\\app\\Code.exe' },
    records: [{ displayName: 'Microsoft Visual Studio Code', values: { DisplayIcon: 'C:\\app\\Code.exe,0' } }],
    path: { 'Code.exe': ['C:\\app\\Code.exe'] },
  })
  const resolved = resolveEditors(host.options)
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].source, 'app-paths')
})

test('absent members are omitted and the survivors keep the family\'s preference order', () => {
  const none = fakeHost({ files: [], env: { ProgramFiles: 'C:\\Programs' } })
  assert.deepEqual(resolveEditors(none.options), [])
  // Windsurf resolves first because it is listed after VS Code in the family, not
  // because of the order the sources happened to answer in.
  const two = fakeHost({
    files: ['C:\\Programs\\Windsurf\\Windsurf.exe', 'C:\\Programs\\Microsoft VS Code\\Code.exe'],
    env: { ProgramFiles: 'C:\\Programs' },
  })
  assert.deepEqual(resolveEditors(two.options).map((entry) => entry.id), ['vscode', 'windsurf'])
})

test('outside Windows the registry is never consulted', () => {
  const linux = fakeHost({
    platform: 'linux',
    env: { HOME: '/home/edy' },
    files: ['/usr/bin/code', '/home/edy/.local/bin/cursor'],
  })
  linux.options.registry = () => {
    throw new Error('the registry must not be read on this platform')
  }
  const resolved = resolveEditors(linux.options)
  assert.deepEqual(resolved.map((entry) => entry.id), ['vscode', 'cursor'])
  assert.equal(resolved[0].source, 'install-dir')
  assert.deepEqual(linux.registryCalls, [], 'the registry is not part of the chain off Windows')
})

test('outside Windows a PATH hit resolves when no conventional path exists', () => {
  const linux = fakeHost({
    platform: 'linux',
    env: { HOME: '/home/edy' },
    files: ['/opt/editors/code'],
    path: { code: ['/opt/editors/code'] },
  })
  const resolved = resolveEditors(linux.options)
  assert.deepEqual(resolved, [{ id: 'vscode', label: 'VS Code', executable: '/opt/editors/code', source: 'path' }])
})

test('the conventional directories and application bundles are the shapes each platform uses', () => {
  const member = findFamilyMember('trae')
  const dirs = windowsInstallDirs(member, { LOCALAPPDATA: 'C:\\Users\\edy\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })
  assert.ok(dirs.includes(join('C:\\Users\\edy\\AppData\\Local', 'Programs', 'Trae CN')))
  assert.ok(dirs.includes(join('C:\\Program Files', 'Trae')))
  const mac = portableInstallPaths(findFamilyMember('vscode'), 'darwin', { HOME: '/Users/edy' })
  assert.ok(mac.includes('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'))
  assert.ok(mac.includes('/Users/edy/.local/bin/code'))
  const linux = portableInstallPaths(member, 'linux', { HOME: '/home/edy' })
  assert.ok(linux.includes('/usr/bin/trae'))
  assert.ok(linux.includes('/home/edy/.local/bin/trae'))
})

test('chooseEditor honours an explicit choice and otherwise follows the family order', () => {
  const editors = [
    { id: 'vscode', label: 'VS Code', executable: 'C:\\Code.exe', source: 'app-paths' },
    { id: 'trae', label: 'Trae CN', executable: 'D:\\Trae CN.exe', source: 'uninstall-record' },
  ]
  assert.equal(chooseEditor(editors, 'trae').id, 'trae')
  assert.equal(chooseEditor(editors, 'nope'), null)
  assert.equal(chooseEditor(editors, '').id, 'vscode')
  assert.equal(chooseEditor(editors, undefined).id, 'vscode')
  assert.equal(chooseEditor([], 'trae'), null)
})

test('the launch target is the workspace file, and the directory only as the fallback', () => {
  assert.deepEqual(
    editorTarget({ containerDir: 'D:/ws', file: 'D:/ws/app.code-workspace', fileExists: true }),
    { target: 'D:/ws/app.code-workspace', kind: 'workspace' },
  )
  // A recorded file that is gone degrades to the directory instead of failing.
  assert.deepEqual(
    editorTarget({ containerDir: 'D:/ws', file: 'D:/ws/app.code-workspace', fileExists: false }),
    { target: 'D:/ws', kind: 'directory' },
  )
  assert.deepEqual(editorTarget({ containerDir: 'D:/ws', file: null }), { target: 'D:/ws', kind: 'directory' })
})

// --------------------------------------------------------------- launch

/** A child process double that records what it was handed and emits on demand. */
function fakeChild() {
  return {
    unrefCalls: 0,
    handlers: {},
    unref() {
      this.unrefCalls += 1
    },
    on(name, handler) {
      this.handlers[name] = handler
    },
    emit(name, value) {
      this.handlers[name]?.(value)
    },
  }
}

test('launchEditor hands over exactly the target, a scrubbed environment, and reports only early failures', async () => {
  const calls = []
  const child = fakeChild()
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }
  const env = editorChildEnv({ PATH: 'C:\\Windows', DSH_HOME: 'x', ELECTRON_RUN_AS_NODE: '1' })

  const running = launchEditor('C:\\app\\Code.exe', 'D:/ws/app.code-workspace', { spawnImpl, watchMs: 5, env })
  assert.deepEqual(calls[0].args, ['D:/ws/app.code-workspace'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(await running, 'launched')
  assert.equal(child.unrefCalls, 1, 'a still-running editor is detached, not waited on')

  const clean = fakeChild()
  const exitsZero = launchEditor('C:\\app\\Code.exe', 'D:/ws', {
    spawnImpl: () => clean,
    watchMs: 50,
    env,
  })
  clean.emit('exit', 0)
  assert.equal(await exitsZero, 'launched')

  const bad = fakeChild()
  const exitsOne = launchEditor('C:\\app\\Code.exe', 'D:/ws', { spawnImpl: () => bad, watchMs: 50, env })
  bad.emit('exit', 1)
  assert.equal(await exitsOne, 'failed')

  const gone = fakeChild()
  const enoent = launchEditor('C:\\app\\Code.exe', 'D:/ws', { spawnImpl: () => gone, watchMs: 50, env })
  gone.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }))
  assert.equal(await enoent, 'missing')

  const thrown = launchEditor('C:\\app\\Code.exe', 'D:/ws', {
    spawnImpl: () => {
      throw new Error('EINVAL')
    },
    watchMs: 50,
    env,
  })
  assert.equal(await thrown, 'failed')
})

test('isRegularFile refuses a directory and a path that does not exist', () => {
  assert.equal(isRegularFile(process.execPath), true)
  assert.equal(isRegularFile(tmpdir()), false)
  assert.equal(isRegularFile(join(tmpdir(), 'definitely-not-here-' + process.pid)), false)
  assert.equal(statSync(tmpdir()).isDirectory(), true)
})

// ---------------------------------------------------------------- icons

test('a plausible icon is a PNG of sane size, and nothing else', () => {
  assert.equal(isPlausibleIconPng(png()), true)
  assert.equal(isPlausibleIconPng(Buffer.from('not a png at all, just text')), false)
  assert.equal(isPlausibleIconPng(Buffer.concat([png(0), Buffer.alloc(0)])), false)
  assert.equal(isPlausibleIconPng(png(1024 * 1024)), false)
  assert.equal(isPlausibleIconPng('a string'), false)
  assert.equal(iconDataUrl(png()).startsWith('data:image/png;base64,'), true)
  assert.equal(iconDataUrl(Buffer.from('nope')), null)
})

test('icon extraction trusts neither the exit code nor the file type', async () => {
  const bytes = png()
  const run = (write) => (command, args) => {
    write(String(args[args.length - 1]))
    return Promise.resolve(0)
  }
  const { writeFileSync } = await import('node:fs')

  const good = await extractExecutableIconPng('C:\\app\\Code.exe', {
    run: run((target) => writeFileSync(target, bytes)),
  })
  assert.equal(Buffer.isBuffer(good), true)
  assert.equal(good.length, bytes.length)

  // Exit 0 with a generic-document icon: the payload is what decides, not the code.
  const junk = await extractExecutableIconPng('C:\\app\\Code.exe', {
    run: run((target) => writeFileSync(target, 'plain text')),
  })
  assert.equal(junk, null)

  const failed = await extractExecutableIconPng('C:\\app\\Code.exe', { run: () => Promise.resolve(1) })
  assert.equal(failed, null)

  let ran = false
  const macos = await extractExecutableIconPng('/Applications/Code.app', {
    platform: 'darwin',
    run: () => {
      ran = true
      return Promise.resolve(0)
    },
  })
  assert.equal(macos, null)
  assert.equal(ran, false, 'no extraction command runs off Windows')
})
