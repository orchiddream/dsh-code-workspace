/**
 * VS Code-family editors: discovery and launch.
 *
 * The plugin's contract with the user is "the editor opens the WORKSPACE", not a
 * single folder: `Code.exe <file.code-workspace>` opens the multi-root window the
 * `.code-workspace` file describes, which is the same set of folders the session
 * is writing to. Every editor this module launches therefore receives the
 * workspace file as its one positional argument when the session has one, and the
 * session root only as the fallback when it does not.
 *
 * ## Why the family, and why this order
 *
 * VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf and Trae are all forks of
 * the same application: same `.code-workspace` grammar, same "path argument opens
 * workspace or folder" CLI contract, same relocated-install problem. One module
 * covers them; {@link EDITOR_FAMILY} is the preference order, which is the order
 * the control offers them in and the order the automatic choice follows.
 *
 * ## Installing anywhere means proving, not concluding
 *
 * A VS Code fork installs wherever the user chose, and only some of them register
 * `App Paths`. So every source below yields CANDIDATES and the file system has to
 * prove each one twice: the file must exist, and its basename must still be that
 * member's own executable name. A registry record — which any installer can write
 * — therefore cannot point the launcher at an unrelated program.
 *
 * Sources, in order, per family member:
 *
 * 1. `App Paths` (`HKLM`/`HKCU`, 32- and 64-bit views);
 * 2. uninstall records (`DisplayIcon`, then `InstallLocation` + the exe names);
 * 3. `PATH` (`where.exe` / `which`);
 * 4. the conventional install directories.
 *
 * ## The two traps this module exists to handle
 *
 * **`ELECTRON_RUN_AS_NODE`.** The Harness runs as a Node-mode Electron child, so
 * that marker sits in this process's environment. Any Electron application
 * spawned with it set starts as a plain Node process, prints nothing and exits 0:
 * the editor never opens a window while the launcher reads a success. Every child
 * environment is therefore scrubbed by {@link editorChildEnv}.
 *
 * **Launch success is not process lifetime.** A GUI editor stays in the
 * foreground for as long as its window lives, and a second launch delegates to
 * the running instance and exits 0. {@link launchEditor} resolves from a short
 * watch window: a spawn rejection or an early nonzero exit is a failure, a child
 * still running when the window closes is a success.
 *
 * Pure decision helpers take their environment (platform, environment, registry
 * reader, PATH lookup, file probe) as injectable options, so the whole chain runs
 * in tests without a Windows registry, without any editor installed, and without
 * spawning anything.
 */
import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * One install shape of one family member: the executable basename Windows shows
 * on disk, and the name to display when that is the install that was found.
 * (`Trae` and `Trae CN` are two shapes of one member, not two menu entries.)
 */
const variant = (exe, label) => ({ exe, label })

/**
 * The VS Code family, in preference order.
 *
 * `id` is the menu identity. For the four members the shipped "Open In…" catalog
 * already knows (`vscode`, `vscodeinsiders`, `cursor`, `windsurf`) the id is that
 * catalog's own, so one entry is shadowed-and-replaced rather than listed twice;
 * `vscodium` and `trae` are additions this plugin owns.
 */
export const EDITOR_FAMILY = [
  {
    id: 'vscode',
    label: 'VS Code',
    variants: [variant('Code.exe', 'VS Code')],
    cli: ['code'],
    winDirs: ['Microsoft VS Code'],
    uninstallPrefixes: ['Microsoft Visual Studio Code'],
    macApps: ['Visual Studio Code.app'],
  },
  {
    id: 'vscodeinsiders',
    label: 'VS Code Insiders',
    variants: [variant('Code - Insiders.exe', 'VS Code Insiders')],
    cli: ['code-insiders'],
    winDirs: ['Microsoft VS Code Insiders'],
    uninstallPrefixes: ['Microsoft Visual Studio Code Insiders'],
    macApps: ['Visual Studio Code - Insiders.app'],
  },
  {
    id: 'vscodium',
    label: 'VSCodium',
    variants: [variant('VSCodium.exe', 'VSCodium')],
    cli: ['codium'],
    winDirs: ['VSCodium'],
    uninstallPrefixes: ['VSCodium'],
    macApps: ['VSCodium.app'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    variants: [variant('Cursor.exe', 'Cursor')],
    cli: ['cursor'],
    winDirs: ['cursor'],
    uninstallPrefixes: ['Cursor'],
    macApps: ['Cursor.app'],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    variants: [variant('Windsurf.exe', 'Windsurf')],
    cli: ['windsurf'],
    winDirs: ['Windsurf'],
    uninstallPrefixes: ['Windsurf'],
    macApps: ['Windsurf.app'],
  },
  {
    id: 'trae',
    label: 'Trae',
    variants: [variant('Trae.exe', 'Trae'), variant('Trae CN.exe', 'Trae CN')],
    cli: ['trae'],
    winDirs: ['Trae', 'Trae CN'],
    uninstallPrefixes: ['Trae'],
    macApps: ['Trae.app', 'Trae CN.app'],
  },
]

/** Family member ids, for validating a client-supplied choice. */
export const EDITOR_IDS = EDITOR_FAMILY.map((member) => member.id)

/**
 * The path flavour of one platform. Every path this module builds or splits uses
 * the flavour of the platform being RESOLVED for, not of the process asking: the
 * platform is injectable, and a candidate list assembled with the host's own
 * separators would be wrong for the platform it describes.
 */
const pathsFor = (platform) => (platform === 'win32' ? win32 : posix)

/** Credential-shaped environment names that must not reach an editor process. */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * Electron/Node host-mode markers this process may inherit. `ELECTRON_RUN_AS_NODE`
 * is the load-bearing one: see the module header.
 */
const HOST_MODE_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'])

/** Registry roots holding per-executable `App Paths` entries. */
const APP_PATHS_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
]

/** Registry roots holding per-application uninstall records. */
const UNINSTALL_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/**
 * The environment a launched editor receives: the ambient parent environment
 * minus this Harness's own identity and credentials (the same scrub the shipped
 * launcher applies) and minus the Electron/Node host-mode markers above. `PATH`,
 * `HOME`, locale and the Windows folder variables survive, so the editor starts
 * exactly as it would from the shell.
 * @param parent - environment to scrub; defaults to this process's.
 * @returns a fresh environment object safe to hand to a detached spawn.
 */
export function editorChildEnv(parent = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV.test(name)) continue
    const upper = name.toUpperCase()
    if (upper.startsWith('DSH_') || HOST_MODE_ENV.has(upper)) continue
    env[name] = value
  }
  return env
}

/**
 * Read a registry query's stdout; an absent key or value is an empty string,
 * because "not found" and "unreadable" both mean the same thing to a candidate list.
 *
 * Output is decoded as UTF-8, so a localized value *name* or non-ASCII value data
 * would arrive as mojibake. Only ASCII is read back from it — the value names
 * (`DisplayIcon`, `InstallLocation`) and executable paths.
 * @param args - `reg.exe` argv after the program name.
 * @returns decoded stdout, or `''` when the query failed.
 */
export function readRegistry(...args) {
  try {
    const result = spawnSync('reg.exe', args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return typeof result.stdout === 'string' ? result.stdout : ''
  } catch {
    // Swallows a spawn that could not even be attempted (`reg.exe` absent, a
    // sandbox that forbids the pipe): an unreadable registry is an empty one.
    return ''
  }
}

/**
 * Ask the platform's own PATH search for the given executable names.
 *
 * `where.exe` (Windows) and `which` both print one absolute path per line and
 * exit nonzero when there is none. One invocation carries every name — the
 * acceptance rule is the basename, not which pattern matched, so attribution
 * would buy nothing and cost a process per name.
 * @param names - executable basenames to look for.
 * @returns candidate absolute paths, in the platform's own order.
 */
export function readPathLookup(names = []) {
  if (names.length === 0) return []
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = spawnSync(command, names.slice(), {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    if (typeof result.stdout !== 'string') return []
    const found = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const path = line.trim()
      if (path !== '') found.push(path)
    }
    return found
  } catch {
    // Swallows a spawn that could not be attempted: no PATH hits, no failure.
    return []
  }
}

/**
 * Whether `path` is a regular file (never a directory, never a reparse-only stub
 * the stat cannot follow).
 * @param path - absolute candidate path.
 * @returns true when the path names a readable file.
 */
export function isRegularFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    // Swallows ENOENT/EACCES/EINVAL: an unprovable candidate is not a candidate.
    return false
  }
}

/**
 * Strip the quotes a registry value may carry and the resource index
 * (`DisplayIcon` may read `"C:\...\Code.exe",0`). The index is removed FIRST:
 * while it is still attached the value does not end in a quote, so a quote-strip
 * that ran first would leave the quotes in place.
 * @param value - raw registry string value.
 * @returns the cleaned path, or `''` when nothing is left.
 */
export function cleanRegistryPath(value) {
  if (typeof value !== 'string') return ''
  const withoutIndex = value.trim().replace(/,\s*-?\d+$/, '').trim()
  return withoutIndex.replace(/^"(.*)"$/, '$1').trim()
}

/**
 * A named string value line of `reg.exe query` output. The name is matched
 * lazily and the value greedily, because a registry value *name* may itself
 * contain spaces (`Inno Setup: App Path`) while the data always runs to the end
 * of the line.
 */
const VALUE_LINE = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/

/**
 * Named string values printed by `reg.exe query`, lower-cased by name.
 * @param text - `reg.exe query` stdout.
 * @returns one map per printed registry key, in output order.
 */
export function parseRegistryValues(text) {
  const keys = []
  let current = null
  for (const line of String(text).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      current = new Map()
      keys.push(current)
      continue
    }
    const match = VALUE_LINE.exec(line)
    if (match === null || current === null) continue
    current.set(match[1].toLowerCase(), match[2])
  }
  return keys
}

/**
 * Every executable basename any install shape of this member uses.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @returns lower-cased basenames.
 */
export function variantExeNames(member) {
  return member.variants.map((shape) => shape.exe.toLowerCase())
}

/**
 * Whether a resolved path still names this family member, so registry output or a
 * PATH entry can never point the launcher at an unrelated program.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @param path - resolved candidate path.
 * @param platform - `process.platform` value.
 * @returns true when the basename is this member's own.
 */
export function looksLikeFamilyExecutable(member, path, platform = process.platform) {
  const base = pathsFor(platform).basename(String(path)).toLowerCase()
  if (base === '') return false
  if (platform === 'win32') return variantExeNames(member).includes(base)
  return member.cli.map((name) => name.toLowerCase()).includes(base)
}

/**
 * The display label of a resolved install: the shape that matched when it has a
 * name of its own (`Trae CN.exe` → `Trae CN`), the member's label otherwise.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @param path - resolved executable path.
 * @param platform - `process.platform` value.
 * @returns the name to show in the menu and on the panel button.
 */
export function resolvedLabel(member, path, platform = process.platform) {
  if (platform !== 'win32') return member.label
  const base = pathsFor(platform).basename(String(path)).toLowerCase()
  const shape = member.variants.find((entry) => entry.exe.toLowerCase() === base)
  return shape === undefined ? member.label : shape.label
}

/**
 * Windows locations a per-user or per-machine install commonly uses.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @param env - environment carrying the Windows folder variables.
 * @returns candidate directories, most likely first.
 */
export function windowsInstallDirs(member, env = process.env) {
  const roots = [
    env.LOCALAPPDATA === undefined ? null : win32.join(env.LOCALAPPDATA, 'Programs'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA,
    env.APPDATA,
  ].filter((root) => typeof root === 'string' && root !== '')
  const dirs = []
  for (const root of roots) {
    for (const name of member.winDirs) dirs.push(win32.join(root, name))
  }
  return dirs
}

/**
 * Absolute candidates outside Windows: the application bundle's own launcher on
 * macOS, the usual `bin` directories on Linux, plus whatever `PATH` answers.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @param platform - `process.platform` value.
 * @param env - environment carrying `HOME`.
 * @returns candidate paths, most likely first.
 */
export function portableInstallPaths(member, platform, env = process.env) {
  const api = pathsFor(platform)
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : null
  const paths = []
  if (platform === 'darwin') {
    for (const app of member.macApps) {
      for (const cli of member.cli) {
        paths.push(api.join('/Applications', app, 'Contents', 'Resources', 'app', 'bin', cli))
        if (home !== null) paths.push(api.join(home, 'Applications', app, 'Contents', 'Resources', 'app', 'bin', cli))
      }
    }
  }
  for (const cli of member.cli) {
    paths.push(
      api.join('/usr/bin', cli),
      api.join('/usr/local/bin', cli),
      api.join('/opt/homebrew/bin', cli),
      api.join('/snap/bin', cli),
    )
    if (home !== null) paths.push(api.join(home, '.local', 'bin', cli))
  }
  return paths
}

/**
 * Resolve every family member this host can prove, in preference order.
 *
 * A member is absent when no source yields a file that exists AND whose basename
 * is still its own, so an installed-but-unrelated program can never be listed.
 * @param options - injectable facts (platform, environment, registry, PATH and file probes).
 * @returns `[{ id, label, executable, source }]`, possibly empty.
 */
export function resolveEditors(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    family = EDITOR_FAMILY,
    registry = readRegistry,
    pathLookup = readPathLookup,
    isFile = isRegularFile,
    cliCandidates = null,
  } = options
  const resolved = []
  for (const member of family) {
    const hit = resolveMember(member, { platform, env, registry, pathLookup, isFile, cliCandidates })
    if (hit !== null) {
      resolved.push({
        id: member.id,
        label: resolvedLabel(member, hit.executable, platform),
        executable: hit.executable,
        source: hit.source,
      })
    }
  }
  return resolved
}

/**
 * Resolve one member through the source chain described in the module header.
 * @param member - one {@link EDITOR_FAMILY} entry.
 * @param facts - injectable environment facts.
 * @returns `{ executable, source }`, or null when this host has no provable install.
 */
function resolveMember(member, facts) {
  const { platform, env, registry, pathLookup, isFile, cliCandidates } = facts
  const seen = new Set()
  /** Accept one candidate once, and only when the file system proves it. */
  const accept = (candidate, source) => {
    if (typeof candidate !== 'string') return null
    const path = cleanRegistryPath(candidate)
    if (path === '' || !looksLikeFamilyExecutable(member, path, platform)) return null
    const key = path.toLowerCase()
    if (seen.has(key)) return null
    seen.add(key)
    return isFile(path) ? { executable: path, source } : null
  }

  if (platform !== 'win32') {
    for (const candidate of portableInstallPaths(member, platform, env)) {
      const hit = accept(candidate, 'install-dir')
      if (hit !== null) return hit
    }
    const names = Array.isArray(cliCandidates) ? cliCandidates : member.cli
    for (const candidate of pathLookup(names)) {
      const hit = accept(candidate, 'path')
      if (hit !== null) return hit
    }
    return null
  }

  for (const root of APP_PATHS_ROOTS) {
    for (const shape of member.variants) {
      const keys = parseRegistryValues(registry('query', `${root}\\${shape.exe}`, '/ve'))
      for (const values of keys) {
        for (const value of values.values()) {
          const hit = accept(value, 'app-paths')
          if (hit !== null) return hit
        }
      }
    }
  }

  for (const root of UNINSTALL_ROOTS) {
    for (const prefix of member.uninstallPrefixes) {
      for (const values of parseRegistryValues(registry('query', root, '/s', '/f', prefix))) {
        const icon = accept(values.get('displayicon'), 'uninstall-record')
        if (icon !== null) return icon
        const location = cleanRegistryPath(values.get('installlocation'))
        if (location === '') continue
        for (const shape of member.variants) {
          const hit = accept(win32.join(location, shape.exe), 'uninstall-record')
          if (hit !== null) return hit
        }
      }
    }
  }

  for (const candidate of pathLookup(member.variants.map((shape) => shape.exe))) {
    const hit = accept(candidate, 'path')
    if (hit !== null) return hit
  }

  for (const dir of windowsInstallDirs(member, env)) {
    for (const shape of member.variants) {
      const hit = accept(win32.join(dir, shape.exe), 'install-dir')
      if (hit !== null) return hit
    }
  }
  return null
}

/**
 * The member a client-supplied id names.
 * @param id - family id from a request.
 * @param family - family table to search.
 * @returns the member, or null when the id is not part of the family.
 */
export function findFamilyMember(id, family = EDITOR_FAMILY) {
  if (typeof id !== 'string') return null
  return family.find((member) => member.id === id) ?? null
}

/**
 * The editor a request should launch: the explicit choice when it is a detected
 * member, otherwise the first detected one (the family's preference order).
 * @param editors - result of {@link resolveEditors}.
 * @param id - requested id, or a non-string for "no preference".
 * @returns the chosen entry, or null when this host has no editor at all.
 */
export function chooseEditor(editors, id) {
  if (typeof id === 'string' && id !== '') {
    const named = editors.find((entry) => entry.id === id)
    return named ?? null
  }
  return editors.length === 0 ? null : editors[0]
}

/**
 * What one launch should open.
 *
 * The workspace file wins whenever the session has one, because that is what
 * makes the editor's window match the session's roots. A recorded file that is
 * gone falls back to the directory rather than failing: the user can still open
 * the folder, and the panel already marks the file as missing.
 * @param input - the session root, the resolved workspace file, and the file's existence.
 * @returns `{ target, kind }` where `kind` is `workspace` or `directory`.
 */
export function editorTarget(input) {
  const { rootDir, file = null, fileExists = false } = input
  if (typeof file === 'string' && file !== '' && fileExists === true) {
    return { target: file, kind: 'workspace' }
  }
  return { target: rootDir, kind: 'directory' }
}

/**
 * Start one editor on one path and report only early failures.
 * @param executable - absolute executable path from {@link resolveEditors}.
 * @param target - absolute path to open: a `.code-workspace` file, or a directory.
 * @param options - watch window, the scrubbed child environment, and the spawn implementation.
 * @returns `launched`, `missing` (executable gone), or `failed`.
 */
export function launchEditor(executable, target, options = {}) {
  const { watchMs = 1_200, env = editorChildEnv(), spawnImpl = spawn } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(executable, [target], { detached: true, stdio: 'ignore', windowsHide: false, env })
    } catch {
      // Swallows a synchronous spawn rejection: it has exactly one meaning here.
      resolve('failed')
      return
    }
    let settled = false
    // Declared before `finish` so a synchronous failure can still clear it.
    let timer
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    timer = setTimeout(() => {
      child.unref?.()
      finish('launched')
    }, watchMs)
    child.on('error', (error) => {
      finish(error?.code === 'ENOENT' ? 'missing' : 'failed')
    })
    child.on('exit', (code) => {
      finish(code === 0 ? 'launched' : 'failed')
    })
  })
}
