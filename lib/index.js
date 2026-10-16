/**
 * dsh-code-workspace — host half.
 *
 * VS Code-compatible multi-root workspaces for DeepSeek Harness. A
 * `.code-workspace` file is the SINGLE SOURCE OF TRUTH: its `folders` array
 * defines the session's writable roots, exactly as it does in VS Code, Trae and
 * Cursor. Nothing else configures the roots — there is no parallel store to
 * drift out of sync with the file the user actually maintains.
 *
 * ## Mapping onto DSH
 *
 * DSH models a workspace as ONE canonical directory, and `workspaceRegistry`
 * refuses anything that is not an existing directory. A `.code-workspace` file
 * is not a directory, so the plugin uses the file's own directory as the
 * session's primary root (the "container directory") and treats every
 * `folders[]` entry as an additional root. Reading a `.code-workspace` file
 * therefore means: open the containing directory as a DSH workspace, and the
 * file's folders become reachable in the session.
 *
 * ## What this host half does
 *
 * 1. **Discovery** — for a session whose `cwd` is `C`, the active workspace file
 *    is the known `.code-workspace` file whose directory is `C`, else the single
 *    `*.code-workspace` file found in `C`. A directory with none makes the
 *    plugin completely inert: no section, no interception, no endpoints.
 * 2. **Parsing** — `lib/jsonc.js` + `lib/workspace-file.js` read the file with
 *    VS Code's own path rules and report malformed folder entries as warnings
 *    instead of failing, so a file the user is midway through editing still
 *    renders in the panel.
 * 3. **Interception** (`tools/execute` around-dispatch waterfall) — `write`,
 *    `edit`, `pwsh` and `bash` calls whose path (or resolved `workdir`) lands
 *    inside an additional root are serviced here with the session's standing
 *    sandbox policy re-rooted to that directory. The mode is never touched, so
 *    `read-only` still denies, `workspace-write` still allows, and
 *    `danger-full-access` still allows — identical semantics to the primary
 *    root. Background shell runs register with `ctx.jobs` under the same
 *    re-rooted policy. Reads (`read`/`glob`/`grep`) are unfenced by DSH and
 *    already work everywhere.
 * 4. **Prompt injection** — one ordered section lists the roots and the
 *    one-writable-root-per-command rule, because that rule is what makes a
 *    re-rooted run succeed where a `git -C` from the primary root fails.
 * 5. **`/code-workspace`** — the human-command channel, which is also what the
 *    panel drives inside a session.
 * 6. **Sessionless remote API** — a `codeWorkspace` namespace of hand-written
 *    `src-json` Typert descriptors plus a plain-object service, keyed by PATHS
 *    rather than a session id, so the session-creation page (which has no
 *    session yet) can open a workspace file and edit its folders.
 * 7. **`@` discovery** — DSH's own `@` file menu is single-root by construction
 *    (its provider walks the session `cwd` and refuses escapees), so the
 *    additional roots are invisible to it. `codeWorkspace/listFiles` indexes
 *    them over the `fs` seam and the client half contributes a companion group.
 * 8. **Open in an editor** — `lib/editor.js` resolves this host's VS Code family
 *    (VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae / Trae CN) and launches
 *    the chosen one with the `.code-workspace` FILE, so the editor's multi-root
 *    window is the session's own root set. The shipped "Open In…" control cannot
 *    do that (its catalog is compiled in and its route accepts only a directory),
 *    which is why the client half also takes over that control's cell.
 *
 * ## Security posture
 *
 * Roots are granted by a file the user owns. The agent must therefore never be
 * able to widen its own roots by editing that file, so the interceptor refuses
 * `write`/`edit` against ANY `*.code-workspace` file and against the plugin's own
 * store. Directories are user-managed — exactly the posture `dsh-multi-folder`
 * established for its config file, with the difference that here the source of
 * truth is a file the user already edits in their editor.
 *
 * That guard is a TOOL-LAYER guarantee, not a sandbox guarantee: an agent that
 * writes a `.code-workspace` file through a script (`pwsh`/`bash`) is not
 * stopped, because no path-level check can see inside an opaque command. The
 * plugin documents this boundary instead of pretending to close it.
 */

import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import os from 'node:os'

import {
  addFolder,
  createWorkspaceDocument,
  extraRootsFor,
  fileStamp,
  isInside,
  isWorkspaceFileName,
  moveFolder,
  normalizeSpelling,
  parseWorkspaceFile,
  pathApiFor,
  relativeTo,
  removeFolder,
  serializeFolders,
  setFolderName,
  storagePathFor,
  toComparable,
  workspaceTitle,
} from './workspace-file.js'
import { JsoncSyntaxError, patchDocument, stringifyDocument } from './jsonc.js'
import { chooseEditor, editorTarget, findFamilyMember, launchEditor, resolveEditors } from './editor.js'
import { extractExecutableIconPng, iconDataUrl } from './editor-icon.js'
import { pickWorkspaceFile } from './workspace-picker.js'

export const name = 'dsh-code-workspace'
export const inject = ['fs', 'sandboxPolicy', 'systemPrompt']

/** Prompt sections: tool guidance occupies 100–129, so this sits clearly after it. */
const SECTION_NAME = 'code-workspace:roots'
const SECTION_ORDER = 165
const COMMAND_NAME = 'code-workspace'
/** Marker line the browser panel parses out of command results. */
const JSON_MARK = '[CWS:JSON]'
const INTERCEPT_TOOLS = new Set(['write', 'edit', 'pwsh', 'bash'])

/** How long an auto-detected (pointer-less) workspace file stays trusted. */
const DISCOVERY_TTL_MS = 3000
/**
 * How long a loaded workspace file is reused before it is read again.
 *
 * The model is deliberately NOT invalidated through `fs.stat` metadata: the
 * exact fields an `FsInfo` carries are not part of the plugin-facing contract,
 * so a stamp built from them could silently never change and pin a stale root
 * set for the whole session. A short time-to-live is both dependency-free and
 * bounded — a folder the user adds in VS Code is picked up within this window,
 * and every panel/command read forces a fresh parse anyway.
 */
const MODEL_TTL_MS = 2000
/** Complete-result bound of one browse level (mirrors the shipped browse backend). */
const MAX_BROWSE_ENTRIES = 1000

const GUARD_TEXT =
  'This file is managed by the dsh-code-workspace plugin. A *.code-workspace file defines which directories ' +
  'this session may write, so it is user-managed: edit it in your editor, or use the /code-workspace command or ' +
  'the plugin panel to add or remove a folder. Direct agent write/edit is rejected.'

const STORE_GUARD_TEXT =
  'This file belongs to the dsh-code-workspace plugin store. It records which .code-workspace file owns each ' +
  'directory; it is user-managed and cannot be written by the agent.'

/** `<DSH_HOME>/storages/code-workspace` — outside every agent sandbox root. */
const storeDir = () => join(process.env.DSH_HOME || join(os.homedir(), '.dsh'), 'storages', 'code-workspace')
const storePath = () => join(storeDir(), 'index.json')

/** Which `ctx.shell` seam shape this DSH release exposes (see dsh-multi-folder's analysis). */
const shellUsesExecute = (shell) => shell !== undefined && typeof shell.execute === 'function'

const isAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
const reasonOf = (e) => String(e && e.message ? e.message : e)

/**
 * Whether a path names one fixed filesystem location regardless of process
 * state: drive-qualified (`C:\…`) or complete UNC (`\\server\share…`) on
 * Windows, POSIX-absolute otherwise. Rooted drive-less Windows forms (`\foo`,
 * `/foo`) resolve against the process's current drive, so they are refused
 * rather than rebased.
 */
const fullyQualified = (path) =>
  process.platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : path.startsWith('/')

/** The parent level of one absolute path, or null at a filesystem root. */
const parentOf = (path) => {
  const api = pathApiFor(path)
  const parent = api.dirname(path)
  return parent === path ? null : parent
}

export function apply(ctx) {
  const { fs, sandboxPolicy, systemPrompt } = ctx
  // `shell`, `shellEnv`, `jobs`, `commands`, `typert`, `workspaceRegistry` and
  // `directoryPicker` are deliberately NOT captured here: loader rows activate
  // in dependency order, so a service resolved at apply time can be undefined.
  // Each is resolved per call, and API registration rides `ctx.inject`.

  let noteSeq = 0
  /** Comparable container dir -> discovery result. */
  const discoveryCache = new Map()
  /** Comparable file path -> loaded entry. */
  const modelCache = new Map()
  /** String(sessionId) -> notice text awaiting the next message boundary. */
  const pendingNotices = new Map()
  /** The lazily loaded host store. */
  let storePromise = null
  /** Comparable container dir -> file index for `@` discovery. */
  const fileIndexCache = new Map()

  // ------------------------------------------------------------------ store
  // `{ version: 1, files: [<absolute .code-workspace path>, …] }` — most
  // recently opened first. One file, so a write is a single atomic replace.

  async function loadStore() {
    if (storePromise === null) {
      storePromise = (async () => {
        try {
          const target = await fs.resolve(storePath())
          const raw = await fs.readText(target)
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.files)) {
            return { version: 1, files: parsed.files.filter((f) => typeof f === 'string' && f.length > 0) }
          }
        } catch {
          // Absent, unreadable or corrupt: start empty rather than fail.
        }
        return { version: 1, files: [] }
      })()
    }
    return await storePromise
  }

  async function saveStore(store) {
    await mkdir(storeDir(), { recursive: true })
    const content = JSON.stringify({ version: 1, files: store.files }, null, 2) + '\n'
    const target = await fs.resolve(storePath())
    // Host-owned store outside every sandbox root; the explicit policy is rooted
    // at the store directory itself.
    await fs.writeText(target, content, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: storeDir(),
    })
  }

  /**
   * Record one workspace file as known, most-recent-first. Idempotent, and a
   * no-op once the file is already known, so discovery can call it freely.
   * @returns whether the store changed.
   */
  async function rememberFile(file) {
    const store = await loadStore()
    const key = toComparable(file)
    if (store.files.some((f) => toComparable(f) === key)) return false
    store.files.unshift(file)
    await saveStore(store)
    return true
  }

  /** Drop one file from the known list. */
  async function forgetFile(file) {
    const store = await loadStore()
    const key = toComparable(file)
    const next = store.files.filter((f) => toComparable(f) !== key)
    if (next.length === store.files.length) return false
    store.files = next
    await saveStore(store)
    discoveryCache.clear()
    modelCache.delete(key)
    return true
  }

  // ------------------------------------------------------------ fs helpers

  /** Existence + kind of one path, never throwing. */
  async function statOf(path) {
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      // The DSH spelling of the resolved path is what the sandbox layer should
      // be handed, so it is captured here rather than reconstructed.
      const processPath = fs.processPath(target)
      if (info === undefined || info === null) {
        return { exists: false, isDirectory: false, stamp: 'missing', processPath }
      }
      const type = info.type
      return {
        exists: true,
        isDirectory: type === 'directory' || info.isDirectory === true,
        stamp: fileStamp(info),
        processPath,
      }
    } catch {
      return { exists: false, isDirectory: false, stamp: 'missing', processPath: undefined }
    }
  }

  /**
   * Canonical absolute path for a user-supplied path, or null. The result uses
   * the plugin's own forward-slash spelling so identity, dedupe, display and the
   * store agree; the sandbox spelling is read separately from {@link statOf}.
   */
  async function canonicalize(path) {
    try {
      return normalizeSpelling(fs.processPath(await fs.resolve(String(path).trim())))
    } catch {
      return null
    }
  }

  // ------------------------------------------------------- file discovery

  /**
   * The `.code-workspace` file that owns one session directory.
   *
   * A recorded file always wins (the user opened it explicitly). Otherwise, and
   * only while the discovery cache is cold, a directory holding EXACTLY ONE
   * `*.code-workspace` file adopts it and records it, because that is the
   * directory the user registered as a workspace and the file is right there.
   * Two or more candidates is ambiguous and resolves to nothing — silently
   * picking one would grant roots the user never chose.
   */
  async function resolveFileForContainer(containerDir) {
    if (typeof containerDir !== 'string' || containerDir.length === 0) return undefined
    const key = toComparable(containerDir)
    const store = await loadStore()
    const known = store.files.find((f) => toComparable(pathApiFor(f).dirname(f)) === key)
    if (known !== undefined) return known

    const cached = discoveryCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.file

    let found
    try {
      const target = await fs.resolve(containerDir)
      const entries = await fs.listDir(target)
      const names = (entries ?? [])
        .filter((entry) => entry !== null && entry !== undefined && entry.type === 'file' && isWorkspaceFileName(String(entry.name)))
        .map((entry) => String(entry.name))
        .sort((a, b) => a.localeCompare(b))
      if (names.length === 1) found = normalizeSpelling(pathApiFor(containerDir).join(containerDir, names[0]))
    } catch {
      found = undefined
    }
    discoveryCache.set(key, { file: found, at: Date.now() })
    if (found !== undefined) await rememberFile(found)
    return found
  }

  /** Invalidate everything derived from one container directory. */
  function invalidate(file) {
    if (typeof file !== 'string') {
      discoveryCache.clear()
      modelCache.clear()
      fileIndexCache.clear()
      return
    }
    const key = toComparable(file)
    modelCache.delete(key)
    fileIndexCache.delete(key)
    discoveryCache.delete(toComparable(pathApiFor(file).dirname(file)))
  }

  /**
   * Load (or reuse) the model of one workspace file.
   * @returns an entry `{ file, containerDir, model, stamp, extraRoots, error? }`
   *   or null when there is no such file. `error` carries a JSONC syntax
   *   failure; `model` is then null and the caller must fail closed.
   */
  async function loadModel(file, containerDir) {
    const key = toComparable(file)
    const container = containerDir ?? pathApiFor(file).dirname(file)
    const probe = await statOf(file)
    if (!probe.exists || probe.isDirectory) {
      modelCache.delete(key)
      return null
    }

    let text
    try {
      text = await fs.readText(await fs.resolve(file))
    } catch (e) {
      const failed = {
        file,
        containerDir: container,
        model: null,
        stamp: probe.stamp,
        at: Date.now(),
        extraRoots: [],
        error: { message: `cannot read the workspace file: ${reasonOf(e)}` },
      }
      modelCache.set(key, failed)
      return failed
    }

    let model
    try {
      model = parseWorkspaceFile(text, file)
    } catch (e) {
      // A malformed file still yields a cached entry: the panel must be able to
      // render the syntax error, and the prompt must be able to say why no
      // folders are available. It grants NO roots either way.
      const error =
        e instanceof JsoncSyntaxError
          ? { message: e.message, line: e.line, column: e.column }
          : { message: reasonOf(e) }
      const failed = { file, containerDir: container, model: null, stamp: probe.stamp, at: Date.now(), extraRoots: [], error }
      modelCache.set(key, failed)
      return failed
    }

    // Folder existence is part of what the panel renders (a root VS Code would
    // show as missing), and the sandbox spelling of each root is captured here
    // so the re-rooted policy carries exactly what the `fs` seam reported.
    for (const folder of model.folders) {
      const st = await statOf(folder.resolvedPath)
      folder.exists = st.exists
      folder.isDirectory = st.isDirectory
      if (st.processPath !== undefined) folder.sandboxPath = st.processPath
    }

    const entry = {
      file,
      containerDir: container,
      model,
      stamp: probe.stamp,
      at: Date.now(),
      // Extra roots in the sandbox's own spelling, longest first.
      extraRoots: extraRootsFor(model, container).map((resolved) => {
        const folder = model.folders.find((f) => toComparable(f.resolvedPath) === toComparable(resolved))
        return folder?.sandboxPath ?? resolved
      }),
    }
    modelCache.set(key, entry)
    return entry
  }

  /**
   * The entry for one session directory. A cached model is reused only inside
   * {@link MODEL_TTL_MS} (or when `force` is set), so an edit made in VS Code —
   * or by the panel — is picked up on the next read rather than at restart.
   */
  async function entryFor(containerDir, { force = false } = {}) {
    const file = await resolveFileForContainer(containerDir)
    if (file === undefined) return null
    const key = toComparable(file)
    if (!force) {
      const cached = modelCache.get(key)
      if (cached !== undefined && Date.now() - cached.at < MODEL_TTL_MS) return cached
    }
    return await loadModel(file, pathApiFor(file).dirname(file))
  }

  /** Synchronous view for the hot paths (prompt assembly, interception). */
  function entryForSync(containerDir) {
    const file = containerDir === undefined ? undefined : knownFileSync(containerDir)
    if (file === undefined) return null
    return modelCache.get(toComparable(file)) ?? null
  }

  function knownFileSync(containerDir) {
    if (typeof containerDir !== 'string' || containerDir.length === 0) return undefined
    const key = toComparable(containerDir)
    const cached = discoveryCache.get(key)
    if (cached !== undefined && cached.file !== undefined) return cached.file
    return undefined
  }

  /**
   * Warm the cache for one session directory. Awaited on the interception path
   * (a cold first call must not fall through to the primary-rooted pipeline) and
   * on `agent/created` (so the very first prompt assembly already lists roots).
   */
  async function hydrate(containerDir) {
    if (typeof containerDir !== 'string' || containerDir.length === 0) return null
    try {
      const store = await loadStore()
      const key = toComparable(containerDir)
      const known = store.files.find((f) => toComparable(pathApiFor(f).dirname(f)) === key)
      if (known !== undefined) {
        discoveryCache.set(key, { file: known, at: Date.now() })
        return await loadModel(known, containerDir)
      }
      return await entryFor(containerDir)
    } catch (e) {
      ctx.logger?.warn?.('code-workspace: cannot load the workspace file for ' + containerDir + ': ' + reasonOf(e))
      return null
    }
  }

  // -------------------------------------------------------- shared core
  // One validated, canonicalizing core shared by `/code-workspace` and the
  // sessionless `codeWorkspace/*` endpoints, so the security surface is
  // identical on both channels.

  const requireContainer = (containerDir) => {
    if (typeof containerDir !== 'string' || containerDir.length === 0) throw new Error('a workspace directory is required')
    return containerDir
  }

  /** Persist a new folders array into the workspace file, preserving comments. */
  async function writeFolders(entry, folders) {
    const text = await fs.readText(await fs.resolve(entry.file))
    const next = patchDocument(text, 'folders', serializeFolders(folders))
    await fs.writeText(await fs.resolve(entry.file), next, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: entry.containerDir,
    })
    invalidate(entry.file)
  }

  /** The entry a mutation must operate on, with a model. */
  async function requireEntry(containerDir) {
    const entry = await entryFor(requireContainer(containerDir))
    if (entry === null) {
      throw new Error('no .code-workspace file is associated with "' + containerDir + '"')
    }
    if (entry.model === null) {
      throw new Error('"' + entry.file + '" cannot be parsed: ' + (entry.error?.message ?? 'unknown error'))
    }
    return entry
  }

  /** One folder entry as the panel and the command render it. */
  const folderView = (folder, containerDir) => ({
    index: folder.index,
    path: folder.path,
    name: folder.name ?? null,
    label: folder.name ?? pathApiFor(folder.resolvedPath).basename(folder.resolvedPath),
    resolvedPath: folder.resolvedPath,
    exists: folder.exists !== false,
    isPrimary: toComparable(folder.resolvedPath) === toComparable(containerDir),
    relative: relativeTo(containerDir, folder.resolvedPath),
  })

  /** The full state one container directory renders from. */
  function stateOf(entry, containerDir) {
    if (entry === null) {
      return {
        containerDir,
        file: null,
        title: null,
        exists: false,
        roots: [],
        warnings: [],
        error: null,
        extraRoots: [],
        indent: '\t',
      }
    }
    const model = entry.model
    return {
      containerDir: entry.containerDir,
      file: entry.file,
      title: workspaceTitle(entry.file),
      exists: true,
      roots: model === null ? [] : model.folders.map((f) => folderView(f, entry.containerDir)),
      warnings: model === null ? [] : model.warnings,
      error: entry.error ?? null,
      extraRoots: entry.extraRoots,
      indent: model === null ? '\t' : model.indent,
    }
  }

  const coreState = async (containerDir) => {
    requireContainer(containerDir)
    const canonical = (await canonicalize(containerDir)) ?? containerDir
    return stateOf(await entryFor(canonical, { force: true }), canonical)
  }

  /** Open (or re-point at) one workspace file, registering its directory. */
  const coreOpen = async (file) => {
    if (typeof file !== 'string' || !fullyQualified(file)) throw new Error('open requires a fully qualified .code-workspace path')
    if (!isWorkspaceFileName(file)) throw new Error('"' + file + '" is not a .code-workspace file')
    const canonicalFile = await canonicalize(file)
    if (canonicalFile === null) throw new Error('cannot resolve "' + file + '"')
    const probe = await statOf(canonicalFile)
    if (!probe.exists) throw new Error('"' + canonicalFile + '" does not exist')
    if (probe.isDirectory) throw new Error('"' + canonicalFile + '" is a directory, not a workspace file')

    const containerDir = pathApiFor(canonicalFile).dirname(canonicalFile)
    // A malformed file is still openable — the panel shows the syntax error so
    // the user can fix it in their editor — but it grants no roots.
    const entry = await loadModel(canonicalFile, containerDir)
    if (entry === null) throw new Error('cannot read "' + canonicalFile + '"')
    await rememberFile(canonicalFile)

    // Register the containing directory so a DSH session can be created in it.
    let workspace = null
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined && typeof registry.create === 'function') {
        const created = await registry.create(containerDir, workspaceTitle(canonicalFile))
        workspace = created === undefined ? null : { id: String(created.id), path: created.path, title: created.title }
      }
    } catch (e) {
      ctx.logger?.warn?.('code-workspace: cannot register the workspace directory: ' + reasonOf(e))
    }
    return { ...stateOf(entry, containerDir), workspace }
  }

  /** Create a new workspace file inside one directory. */
  const coreCreate = async (containerDir, fileName, folders) => {
    requireContainer(containerDir)
    const canonicalDir = await canonicalize(containerDir)
    if (canonicalDir === null) throw new Error('cannot resolve "' + containerDir + '"')
    const dirProbe = await statOf(canonicalDir)
    if (!dirProbe.exists || !dirProbe.isDirectory) throw new Error('"' + canonicalDir + '" is not an existing directory')

    const api = pathApiFor(canonicalDir)
    let name = typeof fileName === 'string' && fileName.trim() !== '' ? fileName.trim() : 'workspace'
    if (/[\\/]/.test(name)) throw new Error('the workspace file name must be a single name, not a path')
    if (!isWorkspaceFileName(name)) name += '.code-workspace'
    const file = normalizeSpelling(api.join(canonicalDir, name))
    if ((await statOf(file)).exists) throw new Error('"' + file + '" already exists')

    const entries = Array.isArray(folders) ? folders : []
    const resolved = []
    for (const item of entries) {
      const raw = typeof item === 'string' ? item : item?.path
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const absolute = await canonicalize(isAbsolute(raw) ? raw : api.join(canonicalDir, raw))
      if (absolute === null) throw new Error('cannot resolve folder "' + raw + '"')
      resolved.push({ path: storagePathFor(file, absolute), name: typeof item === 'object' ? item?.name : undefined, resolvedPath: absolute })
    }

    const text = stringifyDocument(createWorkspaceDocument(resolved))
    await fs.writeText(await fs.resolve(file), text, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: canonicalDir,
    })
    invalidate(file)
    await rememberFile(file)
    return coreOpen(file)
  }

  /** Add one folder. `path` may be absolute or relative to the container dir. */
  const coreAddFolder = async (containerDir, path, folderName) => {
    const entry = await requireEntry(containerDir)
    if (typeof path !== 'string' || path.trim() === '') throw new Error('add requires a path')
    const api = pathApiFor(entry.containerDir)
    const raw = path.trim()
    const absolute = await canonicalize(isAbsolute(raw) ? raw : api.join(entry.containerDir, raw))
    if (absolute === null) throw new Error('cannot resolve "' + raw + '"')
    const probe = await statOf(absolute)
    if (!probe.exists) throw new Error('"' + absolute + '" does not exist')
    if (!probe.isDirectory) throw new Error('"' + absolute + '" is not a directory')

    const existing = entry.model.folders.find((f) => toComparable(f.resolvedPath) === toComparable(absolute))
    if (existing !== undefined) {
      return { changed: false, state: stateOf(entry, entry.containerDir) }
    }
    const result = addFolder(entry.model.folders, {
      path: storagePathFor(entry.file, absolute),
      name: typeof folderName === 'string' && folderName.trim() !== '' ? folderName.trim() : undefined,
      resolvedPath: absolute,
    })
    if (result.changed) await writeFolders(entry, result.folders)
    return { changed: result.changed, state: stateOf(await entryFor(entry.containerDir, { force: true }), entry.containerDir) }
  }

  /** Remove one folder, addressed by index or by any spelling of its path. */
  const coreRemoveFolder = async (containerDir, address) => {
    const entry = await requireEntry(containerDir)
    const result = removeFolder(entry.model.folders, address)
    if (result.changed) await writeFolders(entry, result.folders)
    return {
      changed: result.changed,
      removed: result.removed === undefined ? null : folderView(result.removed, entry.containerDir),
      state: stateOf(await entryFor(entry.containerDir, { force: true }), entry.containerDir),
    }
  }

  /** Set or clear one folder's display name. */
  const coreRenameFolder = async (containerDir, address, folderName) => {
    const entry = await requireEntry(containerDir)
    const result = setFolderName(entry.model.folders, address, folderName)
    if (result.changed) await writeFolders(entry, result.folders)
    return { changed: result.changed, state: stateOf(await entryFor(entry.containerDir, { force: true }), entry.containerDir) }
  }

  /** Reorder one folder. */
  const coreMoveFolder = async (containerDir, address, toIndex) => {
    const entry = await requireEntry(containerDir)
    const result = moveFolder(entry.model.folders, address, Number(toIndex))
    if (result.changed) await writeFolders(entry, result.folders)
    return { changed: result.changed, state: stateOf(await entryFor(entry.containerDir, { force: true }), entry.containerDir) }
  }

  /** Point one directory at a different workspace file, or clear the pointer. */
  const coreUseFile = async (containerDir, file) => {
    requireContainer(containerDir)
    const canonicalDir = (await canonicalize(containerDir)) ?? containerDir
    const current = await resolveFileForContainer(canonicalDir)
    if (current !== undefined) await forgetFile(current)
    if (file === null || file === undefined || file === '') {
      discoveryCache.set(toComparable(canonicalDir), { file: undefined, at: Date.now() })
      return await coreState(canonicalDir)
    }
    const state = await coreOpen(String(file))
    return state
  }

  // --------------------------------------------------------- browse & pick

  /** List directories AND `.code-workspace` files for the panel's own browser. */
  const coreBrowse = async (path) => {
    const requested = typeof path === 'string' && path.trim().length > 0 ? path.trim() : os.homedir()
    if (!fullyQualified(requested)) throw new Error('browse requires a fully qualified path, got "' + requested + '"')
    const target = await fs.resolve(requested)
    const absolute = normalizeSpelling(fs.processPath(target))
    let children
    try {
      children = await fs.listDir(target)
    } catch (e) {
      throw new Error('cannot list "' + absolute + '": ' + reasonOf(e))
    }
    const api = pathApiFor(absolute)
    const entries = []
    for (const child of children ?? []) {
      if (child === null || child === undefined) continue
      const entryName = String(child.name)
      const isDir = child.type === 'directory'
      if (!isDir && !(child.type === 'file' && isWorkspaceFileName(entryName))) continue
      entries.push({
        name: entryName,
        path: normalizeSpelling(api.join(absolute, entryName)),
        kind: isDir ? 'directory' : 'workspace-file',
        hidden: entryName.startsWith('.'),
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const truncated = entries.length > MAX_BROWSE_ENTRIES
    if (truncated) entries.length = MAX_BROWSE_ENTRIES
    return { path: absolute, parent: parentOf(absolute), home: os.homedir(), entries, truncated }
  }

  /** Create one child directory (non-recursive, single segment). */
  const coreMakeDir = async (parent, childName) => {
    if (typeof parent !== 'string' || !fullyQualified(parent)) throw new Error('makeDir requires a fully qualified parent path')
    if (typeof childName !== 'string' || childName.trim() === '' || childName === '.' || childName === '..' || /[/\\]/.test(childName)) {
      throw new Error('makeDir requires a single path segment name')
    }
    const target = normalizeSpelling(pathApiFor(parent).join(parent, childName))
    try {
      await mkdir(target)
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new Error('"' + target + '" already exists')
      throw new Error('cannot create "' + target + '": ' + reasonOf(e))
    }
    return { path: target, parent }
  }

  /**
   * Ask the host's composed `directoryPicker` — and only when it composed the
   * NATIVE backend, since a browse backend must not open an OS dialog on the
   * host machine for a remote client.
   */
  const corePick = async (cwd, signal) => {
    let picker
    try {
      picker = ctx.get('directoryPicker')
    } catch {
      picker = undefined
    }
    if (!picker || typeof picker.capability !== 'function') return { path: null, via: 'unavailable' }
    let capability
    try {
      capability = picker.capability()
    } catch {
      return { path: null, via: 'unavailable' }
    }
    if (!capability || capability.kind !== 'native' || typeof capability.pick !== 'function') {
      return { path: null, via: 'unavailable' }
    }
    const selected = await capability.pick(signal)
    return { path: typeof selected === 'string' && fullyQualified(selected) ? selected : null, via: 'host-native' }
  }

  /**
   * Ask the host's own file dialog for a `.code-workspace` file.
   *
   * The shipped picker seam answers directories only, so this is the file-shaped
   * sibling (see `workspace-picker.js`). The starting directory defaults to the
   * host home: a session directory is the one place the file has already been
   * shown to be absent, and it is rarely where a multi-root workspace file lives.
   */
  const corePickFile = async (cwd) => {
    const home = os.homedir()
    const startDir = typeof cwd === 'string' && fullyQualified(cwd) ? cwd : (typeof home === 'string' ? home : '')
    return await pickWorkspaceFile({ startDir })
  }

  /**
   * The recorded workspace files, most recently used first, each probed.
   *
   * `missing` is what lets a manager show a stale record honestly instead of
   * quietly dropping it: the file is gone, so no root can come from it, and the
   * user is the one who decides to remove the entry.
   */
  const coreRecent = async () => {
    const store = await loadStore()
    const out = []
    for (const file of store.files) {
      const probe = await statOf(file)
      out.push({
        file,
        containerDir: pathApiFor(file).dirname(file),
        title: workspaceTitle(file),
        exists: probe.exists,
        missing: !probe.exists,
      })
    }
    return { files: out }
  }

  /**
   * Drop ONE recorded file, addressed by its own path.
   *
   * The command and the panel's "unlink" both work from a container directory,
   * which is enough while a file is associated with the session in front of you.
   * A MANAGER list needs the other addressing: it shows files from every
   * directory, including ones the session is not on — and a stale record (a
   * temporary workspace whose directory is long gone) can only be cleaned up if
   * the entry itself is addressable. Returns the refreshed list, so the caller
   * has one answer instead of a delete plus a read.
   */
  const coreForgetFile = async (file) => {
    if (typeof file !== 'string' || !fullyQualified(file)) {
      throw new Error('forgetFile requires a fully qualified path')
    }
    await forgetFile(file)
    return await coreRecent()
  }

  /** Open one existing path in the host's file manager. */
  const coreReveal = async (path) => {
    if (typeof path !== 'string' || !fullyQualified(path)) throw new Error('reveal requires a fully qualified path')
    const probe = await statOf(path)
    if (!probe.exists) throw new Error('"' + path + '" does not exist')
    // The directory is what gets opened: every platform's file manager takes a
    // directory argument without needing a `/select,`-style private flag.
    const directory = probe.isDirectory ? path : pathApiFor(path).dirname(path)
    try {
      const child = spawn(revealCommand(), [directory], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
    } catch (e) {
      throw new Error('cannot open "' + directory + '": ' + reasonOf(e))
    }
    return { path: directory, via: 'host' }
  }

  const revealCommand = () =>
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open'

  // --------------------------------------------------- open in an editor
  // The shipped "Open In…" control cannot do this job: its catalog is a
  // compile-time table, and its launch route validates an absolute DIRECTORY
  // (`/open-in-app/open`), so every shipped VS Code-family entry necessarily
  // opens the container folder as a single-folder window. Opening the
  // `.code-workspace` file instead — which is what makes the editor's window show
  // the same folders this session writes to — needs a launcher of our own, and
  // that is what this section is. The client half additionally offers the family
  // through the shipped menu; this side only answers what exists and starts it.

  /**
   * Whether this Harness was reached over SSH, where the browser's desktop is not
   * the host's: opening an editor would either fail or, worse, start a GUI on a
   * machine nobody is looking at. Reported as "no editor", never as a mysterious
   * launch failure.
   */
  const launchedThroughSsh = () => {
    const connection = process.env.SSH_CONNECTION
    const tty = process.env.SSH_TTY
    return (typeof connection === 'string' && connection !== '') || (typeof tty === 'string' && tty !== '')
  }

  /** The resolved family: computed once per plugin life, `undefined` = not looked yet. */
  let resolvedEditors
  const editorsNow = () => {
    if (resolvedEditors === undefined) resolvedEditors = launchedThroughSsh() ? [] : resolveEditors()
    return resolvedEditors
  }

  /**
   * Icon data URL per editor id, extracted at most once per plugin life. Served
   * inline over the remote channel rather than from a new HTTP route, so this
   * plugin keeps its single, already-authenticated transport and needs no
   * `webServer`/`connection` dependency of its own.
   */
  const editorIcons = new Map()

  /** What the panel and the menu list: the family this host can prove, and its preference order. */
  const coreEditors = async () => {
    const editors = editorsNow()
    return {
      editors: editors.map((entry) => ({
        id: entry.id,
        label: entry.label,
        executable: entry.executable,
        source: entry.source,
      })),
      preferred: editors.length === 0 ? null : editors[0].id,
      ssh: launchedThroughSsh(),
      platform: process.platform,
    }
  }

  /**
   * The icon of one detected editor, as an `image/png` data URL.
   * @param id - a family id; anything else is refused rather than looked up, so a
   *   request can never name an arbitrary executable on this host.
   * @returns `{ id, dataUrl }`, with a null data URL when extraction yields none.
   */
  const coreEditorIcon = async (id) => {
    const member = findFamilyMember(id)
    if (member === null) throw new Error('unknown editor "' + String(id) + '"')
    const found = editorsNow().find((entry) => entry.id === member.id)
    if (found === undefined) return { id: member.id, dataUrl: null }
    if (!editorIcons.has(member.id)) {
      editorIcons.set(member.id, iconDataUrl(await extractExecutableIconPng(found.executable)))
    }
    return { id: member.id, dataUrl: editorIcons.get(member.id) ?? null }
  }

  /**
   * Open one session directory in one family editor.
   *
   * The WORKSPACE FILE wins whenever the session has one: `<exe> <file.code-workspace>`
   * is what opens the multi-root window, so the editor shows exactly the folders
   * this session may write. A recorded file that no longer exists falls back to
   * the directory rather than failing — the same degradation the panel shows as a
   * missing badge.
   * @param containerDir - the session's workspace directory.
   * @param editorId - a family id, or a non-string for "the preferred one".
   * @returns `{ ok, editor, label, executable, target, kind }` with `kind` being
   *   `workspace` or `directory`.
   */
  const coreOpenInEditor = async (containerDir, editorId) => {
    requireContainer(containerDir)
    if (launchedThroughSsh()) throw new Error('this Harness was reached over SSH: the browser is not on this host')
    const editors = editorsNow()
    if (editors.length === 0) {
      throw new Error('no VS Code family editor was found on this host (VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae)')
    }
    const chosen = chooseEditor(editors, editorId)
    if (chosen === null) throw new Error('editor "' + String(editorId) + '" is not available on this host')

    const canonical = (await canonicalize(containerDir)) ?? containerDir
    const probe = await statOf(canonical)
    if (!probe.exists) throw new Error('"' + containerDir + '" does not exist')
    const entry = await entryFor(canonical)
    const file = entry === null ? null : entry.file
    const fileExists = file !== null && (await statOf(file)).exists
    const { target, kind } = editorTarget({ containerDir: canonical, file, fileExists })

    let outcome = await launchEditor(chosen.executable, target)
    if (outcome === 'missing') {
      // The resolved install moved or was uninstalled since it was resolved:
      // re-resolve once and retry with the fresh executable.
      resolvedEditors = undefined
      editorIcons.clear()
      const fresh = chooseEditor(editorsNow(), chosen.id)
      outcome = fresh === null ? 'missing' : await launchEditor(fresh.executable, target)
    }
    if (outcome !== 'launched') {
      throw new Error(outcome === 'missing' ? 'the ' + chosen.label + ' executable is gone; reopen the panel' : 'the editor refused to start')
    }
    return { ok: true, editor: chosen.id, label: chosen.label, executable: chosen.executable, target, kind }
  }

  // ------------------------------------------------------- `@` discovery
  // Mirrors the shipped provider's shape closely enough that the companion menu
  // group reads like the built-in one: an empty query yields the roots
  // themselves, a bare fragment ranks, and a query carrying `/` lists a level.

  const INDEX_EXCLUDED = new Set([
    '.git', 'node_modules', 'dist', 'build', 'out', '.next', 'target', '.venv', 'venv',
    '__pycache__', '.cache', 'coverage', '.turbo', '.pnpm-store', '.idea', '.gradle',
  ])
  const MAX_INDEX_ENTRIES = 20000
  const MAX_CANDIDATES = 30
  const FILE_INDEX_TTL_MS = 4000

  const isSubsequence = (needle, haystack) => {
    let i = 0
    for (const ch of haystack) {
      if (ch === needle[i]) i++
      if (i === needle.length) return true
    }
    return needle.length === 0
  }

  /** Breadth-first, bounded, canonical-path-deduplicated index of every root. */
  async function indexFor(entry) {
    const key = toComparable(entry.file)
    const cached = fileIndexCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < FILE_INDEX_TTL_MS && cached.stamp === entry.stamp) return cached.index

    const index = []
    const seen = new Set()
    const queue = entry.model.folders.map((folder) => ({ absolute: folder.resolvedPath, rel: '', root: folder }))
    while (queue.length > 0 && index.length < MAX_INDEX_ENTRIES) {
      const level = queue.shift()
      let canonical
      try {
        canonical = fs.processPath(await fs.resolve(level.absolute))
      } catch {
        continue
      }
      const canonicalKey = toComparable(canonical)
      if (seen.has(canonicalKey)) continue
      seen.add(canonicalKey)

      let children
      try {
        children = await fs.listDir(await fs.resolve(canonical))
      } catch {
        continue
      }
      children = (children ?? []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
      for (const child of children) {
        if (index.length >= MAX_INDEX_ENTRIES) break
        const childName = String(child.name)
        const rel = level.rel === '' ? childName : level.rel + '/' + childName
        const absolute = normalizeSpelling(pathApiFor(canonical).join(canonical, childName))
        const isDir = child.type === 'directory'
        index.push({ rel, absolute, root: level.root, dir: isDir })
        if (isDir && !INDEX_EXCLUDED.has(childName)) queue.push({ absolute, rel, root: level.root })
      }
    }
    fileIndexCache.set(key, { at: Date.now(), stamp: entry.stamp, index })
    return index
  }

  /** Rank candidates the way the shipped provider does, over in-root relative paths. */
  function rankCandidates(candidates, query) {
    const q = query.toLowerCase()
    const scored = []
    for (const candidate of candidates) {
      const name = (candidate.rel.split('/').pop() ?? '').toLowerCase()
      const rel = candidate.rel.toLowerCase()
      let score
      if (name === q) score = 100
      else if (name.startsWith(q)) score = 80
      else if (name.includes(q)) score = 60
      else if (rel.includes(q)) score = 40
      else if (isSubsequence(q, rel)) score = 20
      else continue
      if (candidate.dir) score += 5
      score -= Math.min(candidate.rel.length, 80) / 100
      scored.push({ candidate, score })
    }
    scored.sort((a, b) => b.score - a.score || a.candidate.rel.length - b.candidate.rel.length || a.candidate.rel.localeCompare(b.candidate.rel))
    return scored.slice(0, MAX_CANDIDATES).map((s) => s.candidate)
  }

  /** One `@` query against a container directory's roots. */
  const coreListFiles = async (containerDir, query) => {
    requireContainer(containerDir)
    const entry = await entryFor(containerDir)
    const roots =
      entry === null || entry.model === null
        ? []
        : entry.model.folders.map((folder) => folderView(folder, entry.containerDir))
    if (entry === null || entry.model === null) {
      return { containerDir, roots, candidates: [], truncated: false }
    }
    const q = typeof query === 'string' ? query.trim() : ''
    const index = await indexFor(entry)
    const out = { containerDir: entry.containerDir, roots, candidates: [], truncated: index.length >= MAX_INDEX_ENTRIES }

    if (q === '') {
      out.candidates = roots.map((root) => ({
        path: root.resolvedPath,
        rel: root.label,
        rootPath: root.resolvedPath,
        rootLabel: root.label,
        dir: true,
        level: true,
      }))
      return out
    }

    const candidateView = (c, level) => ({
      path: c.absolute,
      rel: c.rel,
      rootPath: c.root.resolvedPath,
      rootLabel: c.root.name ?? pathApiFor(c.root.resolvedPath).basename(c.root.resolvedPath),
      dir: c.dir,
      level,
    })

    if (q.includes('/')) {
      // A level listing. Two spellings are accepted: the absolute path a drill
      // inserted, and a leading root-label segment (`@repo/src/`). A `..`
      // segment is refused outright — it would list a directory outside every
      // granted root while still claiming a granted root as the owner, which is
      // a listing that escaped the set the user granted wearing a name that
      // lies about it. The shipped provider refuses the same escape.
      const decoded = q.replace(/\\/g, '/')
      if (/(^|\/)\.\.(\/|$)/.test(decoded)) return out

      const directChildrenOfAbs = (prefixAbs) => {
        const wanted = toComparable(prefixAbs)
        const visible = []
        for (const candidate of index) {
          const candidateKey = toComparable(candidate.absolute)
          if (!candidateKey.startsWith(wanted + '/')) continue
          const rest = candidateKey.slice(wanted.length + 1)
          if (rest === '' || rest.includes('/')) continue
          visible.push(candidate)
        }
        return visible
      }

      if (isAbsolute(decoded)) {
        const prefixAbs = decoded.replace(/\/+$/, '')
        // The query must be inside one of THIS workspace's roots.
        const owner = roots
          .map((r) => r.resolvedPath)
          .sort((a, b) => b.length - a.length)
          .find((root) => isInside(prefixAbs, root))
        if (owner === undefined) return out
        const visible = directChildrenOfAbs(prefixAbs)
        out.truncated = out.truncated || visible.length > MAX_CANDIDATES
        out.candidates = visible.slice(0, MAX_CANDIDATES).map((c) => candidateView(c, true))
        return out
      }

      const inRoot = decoded.replace(/^\.\//, '')
      const head = inRoot.split('/')[0]
      const matches = roots.filter((r) => r.label === head)
      if (matches.length > 1) {
        // An ambiguous root label answers nothing rather than guessing a root.
        return out
      }

      let visible
      if (matches.length === 1) {
        const rootPath = matches[0].resolvedPath
        const rest = inRoot.slice(head.length).replace(/^\//, '').replace(/\/+$/, '')
        const prefixRel = rest === '' ? '' : rest + '/'
        visible = index.filter((c) => {
          if (toComparable(c.root.resolvedPath) !== toComparable(rootPath)) return false
          if (!c.rel.startsWith(prefixRel)) return false
          const tail = c.rel.slice(prefixRel.length)
          return tail !== '' && !tail.includes('/')
        })
      } else {
        // No root label: treat the fragment as a prefix inside EVERY root, so
        // `@src/` lists each folder's `src` level.
        const prefixRel = inRoot.replace(/\/+$/, '')
        visible = index.filter((c) => {
          if (!c.rel.startsWith(prefixRel)) return false
          const tail = c.rel.slice(prefixRel.length).replace(/^\//, '')
          return tail !== '' && !tail.includes('/')
        })
      }
      out.truncated = out.truncated || visible.length > MAX_CANDIDATES
      out.candidates = visible.slice(0, MAX_CANDIDATES).map((c) => candidateView(c, true))
      return out
    }

    const visible = q.startsWith('.') ? index : index.filter((c) => !c.rel.split('/').some((s) => s.startsWith('.')))
    // `rankCandidates` already caps at MAX_CANDIDATES.
    out.candidates = rankCandidates(visible, q).map((c) => candidateView(c, false))
    return out
  }

  // ------------------------------------------------------ prompt injection
  systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const containerDir =
        context.agent && context.agent.session && context.agent.session.header
          ? context.agent.session.header.cwd
          : undefined
      if (typeof containerDir !== 'string' || containerDir.length === 0) return ''
      const entry = entryForSync(containerDir)
      if (entry === null) return ''
      if (entry.model === null) {
        return (
          'A VS Code workspace file is associated with this session but cannot be parsed (dsh-code-workspace):\n- ' +
          entry.file +
          '\nReason: ' +
          (entry.error?.message ?? 'unknown error') +
          '\nTell the user to fix the file; no additional folders can be used until then.'
        )
      }
      const roots = entry.model.folders.map((folder) => ({
        label: folder.name ?? pathApiFor(folder.resolvedPath).basename(folder.resolvedPath),
        resolvedPath: folder.resolvedPath,
        primary: toComparable(folder.resolvedPath) === toComparable(entry.containerDir),
        missing: folder.exists === false,
      }))
      const extras = entry.extraRoots
      const lines = [
        'This session is a VS Code-compatible multi-root workspace (dsh-code-workspace plugin). The workspace file is the source of truth:',
        '- workspace file: ' + entry.file,
        '- primary working directory: ' + entry.containerDir,
        '- workspace folders:',
      ]
      for (const root of roots) {
        lines.push(
          '  - ' + root.label + ' — ' + root.resolvedPath + (root.primary ? ' (primary)' : '') + (root.missing ? ' (MISSING on disk)' : ''),
        )
      }
      if (extras.length === 0) {
        lines.push('Every folder above is the primary directory, so no extra permissions are involved.')
        return lines.join('\n')
      }
      lines.push(
        'You have the SAME read/write/edit and command-execution permissions on these folders as on the primary working directory under the current sandbox mode.',
        'Each command can write inside only ONE root — the one its workdir resolves to. A command whose cwd stays in the primary directory CANNOT create files inside another folder.',
        'For pwsh/bash, pass `workdir` holding the ABSOLUTE path of the folder you are writing into — foreground and `run_in_background` runs alike. A relative `workdir` is resolved against the PRIMARY directory, never against another folder.',
        'File-creating commands, git included, MUST set `workdir` to that folder: do not run `git -C <folder>` or `cd <folder>` inside a command launched elsewhere. Changing the process directory inside the command does NOT widen the writable root, so the write then fails with an OS-level access denial (Windows error 5).',
        'Reads from every folder work without `workdir`.',
        'The workspace file itself is user-managed: never write or edit a *.code-workspace file. Ask the user to add or remove a folder.',
      )
      return lines.join('\n')
    },
  })

  // -------------------------------------------------------- notice channel
  // A message's `source.kind` must be a PRODUCER-OWNED kind; session format v4
  // refuses the retired catch-all `plugin` wrapper the moment a notice is
  // appended. `plugin:<plugin>` is the spelling the format's own v3→v4
  // migration produces for a non-first-party producer.
  const NOTICE_SOURCE_KIND = 'plugin:' + name

  const noticeMessage = (text) => ({
    id: 'cws-note-' + ++noteSeq,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: String(text).split('\n')[0].slice(0, 120) },
  })

  const armNotice = (agent, text) => {
    if (!agent || !agent.session) return
    pendingNotices.set(String(agent.session.id), text)
  }

  const takeNotice = (agent) => {
    if (!agent || !agent.session) return undefined
    const key = String(agent.session.id)
    const text = pendingNotices.get(key)
    if (text !== undefined) pendingNotices.delete(key)
    return text
  }

  const rootsNotice = (state) =>
    'The workspace folders changed (dsh-code-workspace).\nWorkspace file: ' +
    (state.file ?? '(none)') +
    '\nFolders:\n' +
    (state.roots.length === 0 ? '  (none)' : state.roots.map((r) => '  - ' + r.label + ' — ' + r.resolvedPath).join('\n'))

  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent && payload.agent.session && payload.agent.session.header) {
      await hydrate(payload.agent.session.header.cwd)
    }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const text = takeNotice(payload.agent)
    if (text === undefined) return decision
    return { kind: 'enter', messages: [noticeMessage(text), ...decision.messages] }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const notice = takeNotice(exec.agent)
    if (notice === undefined) return decision
    const message = noticeMessage(notice)
    if (decision.kind === 'block') {
      return { kind: 'block', feedback: decision.feedback, additionalContexts: [message, ...(decision.additionalContexts || [])] }
    }
    return { ...decision, additionalContexts: [message, ...(decision.additionalContexts || [])] }
  })

  // ----------------------------------------------------- tool interception

  const shellRender = (value) => {
    let text = value.stdout && typeof value.stdout.text === 'string' ? value.stdout.text : ''
    if (value.stderr && typeof value.stderr.text === 'string' && value.stderr.text.length > 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += value.stderr.text
    }
    if (value.exitCode !== 0) {
      text += text.endsWith('\n') ? '' : '\n'
      text += '[exit code: ' + value.exitCode + ']'
    }
    if (value.sandbox && value.sandbox.denied) {
      text += '\n[sandbox: file access denied under ' + value.sandbox.mode + ' mode]'
    }
    return text
  }

  const processOutcome = (proc) => {
    if (proc.status === 'killed') {
      return { status: 'killed', detail: proc.signal !== null && proc.signal !== undefined ? 'signal: ' + proc.signal : 'killed before exit' }
    }
    return { status: 'completed', detail: 'exit code: ' + (proc.exitCode ?? 0) }
  }

  const renderProcessRead = (read, sandbox) => {
    const notices = []
    if (read.lossy) {
      const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined)
      notices.push('[some output was dropped from memory; full output: ' + (paths.length > 0 ? paths.join(', ') : '(unavailable)') + ']')
    }
    if (sandbox && sandbox.runnerFailed) {
      notices.push('[sandbox: the sandbox runner itself failed under ' + sandbox.mode + ' mode — the command did not run; this is a sandbox problem, not a command failure]')
    } else if (sandbox && sandbox.denied) {
      notices.push('[sandbox: file access denied under ' + sandbox.mode + ' mode]')
    }
    if (notices.length === 0) return read.delta
    return read.delta + (read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : '') + notices.join('\n')
  }

  /**
   * Adapt one asynchronous background launch to the jobs runtime's SYNCHRONOUS
   * hooks contract, mirroring the shipped pwsh/bash tools' `processJob`. The
   * handle resolves only after launch preparation (Windows ACL grants included),
   * so it can never be dereferenced from `run()`; `onExpiry: 'none'` is what
   * stops a post-0.1.7 `execute()` from inheriting the executor's default
   * deadline and killing a background command at the timeout.
   */
  const startBackgroundJob = (shell, request) => {
    const controller = new AbortController()
    const modern = shellUsesExecute(shell)
    let proc
    const done = (async () => {
      try {
        const spec = shell.resolve({ ...request, signal: controller.signal, ...(modern ? { onExpiry: 'none' } : {}) })
        proc = modern ? await shell.execute(spec) : await shell.start(spec)
        try {
          if (controller.signal.aborted) proc.kill()
        } finally {
          await proc.done
        }
        return processOutcome(proc)
      } catch (error) {
        return {
          status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
          detail: error && error.message !== undefined ? String(error.message) : String(error),
        }
      }
    })()
    return {
      cancel: (reason) => {
        if (controller.signal.aborted) return
        controller.abort(reason)
        if (proc !== undefined) proc.kill()
      },
      done,
      readOutput: () => (proc === undefined ? '' : renderProcessRead(proc.readOutput(), proc.sandbox)),
    }
  }

  /** Model-facing failure for a call the interception OWNS. */
  const ownedFailure = (error, policy) => {
    const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
    const message =
      code === 'FS_SANDBOX_DENIED'
        ? '[sandbox: file access denied under ' + policy.mode + ' mode]\n' +
          '[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
        : String(error && error.message ? error.message : error)
    return {
      isError: true,
      error: { message, ...(code === undefined ? {} : { info: { code } }) },
      content: [{ type: 'text', text: 'Error: ' + message }],
    }
  }

  /** A rejection the agent must surface verbatim (a user-managed path). */
  const guardedFailure = (text, summary) => ({
    isError: true,
    error: { message: summary },
    content: [{ type: 'text', text }],
  })

  ctx.on('tools/execute', async (exec, next) => {
    const headerCwd =
      exec.agent && exec.agent.session && exec.agent.session.header ? exec.agent.session.header.cwd : undefined
    // Hydration is AWAITED on this path: a first call landing before the file
    // read resolves would see an empty cache, fall through to the default
    // pipeline, and be fenced against the PRIMARY root — surfacing as a
    // spurious workspace-write denial for a perfectly ordinary write into
    // another workspace folder.
    if (typeof headerCwd === 'string' && headerCwd.length > 0) await hydrate(headerCwd)

    if (!INTERCEPT_TOOLS.has(exec.name)) return next()
    let owned = null
    try {
      const args = exec.arguments
      const standing = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      const primary = standing.workspaceRoot
      // An explicit escalation request belongs to the default pipeline, which
      // owns the approval flow.
      if (args && typeof args.sandbox_permissions === 'string' && args.sandbox_permissions.length > 0) return next()

      // The policy root is realpath-canonicalized while hydration is keyed by
      // the session cwd as spelled in the header; consult both.
      const entry =
        entryForSync(primary) ?? (typeof headerCwd === 'string' && headerCwd.length > 0 ? entryForSync(headerCwd) : null)
      const extraRoots = entry === null || entry.model === null ? null : entry.extraRoots
      const activeFileKey = entry === null ? null : toComparable(entry.file)

      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = args && typeof args.file_path === 'string' ? args.file_path : null
        if (filePath === null) return next()
        let target
        try {
          target = await fs.resolve(filePath, { cwd: primary })
        } catch (error) {
          if (extraRoots !== null && isAbsolute(filePath)) {
            const rawHit = extraRoots.find((root) => isInside(filePath, root))
            if (rawHit !== undefined) return ownedFailure(error, { ...standing, workspaceRoot: rawHit })
          }
          return next()
        }
        const abs = fs.processPath(target)
        const absKey = toComparable(abs)

        // Security boundary: a *.code-workspace file decides which directories
        // this session may write, so the agent must never be able to edit one.
        if (isWorkspaceFileName(pathApiFor(abs).basename(abs))) {
          const isActive = activeFileKey !== null && absKey === activeFileKey
          return guardedFailure(
            isActive
              ? GUARD_TEXT
              : 'Writing a .code-workspace file is rejected (dsh-code-workspace): such a file defines which directories this session may write. ' + GUARD_TEXT,
            isActive ? 'the workspace file is user-managed' : 'writing .code-workspace files is user-managed',
          )
        }
        if (absKey === toComparable(storePath()) || absKey.startsWith(toComparable(storeDir()) + '/')) {
          return guardedFailure(STORE_GUARD_TEXT, 'the plugin store is user-managed')
        }

        if (extraRoots === null) return next()
        const hit = extraRoots.find((root) => isInside(abs, root))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }

        if (exec.name === 'write') {
          owned = { policy }
          const outcome = await fs.writeText(target, String(args.content ?? ''), undefined, exec.signal, policy)
          if (typeof ctx.emit === 'function') {
            ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
          }
          const displayPath = target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : filePath
          const value = {
            path: displayPath,
            operation: outcome.operation === 'create' ? 'create' : 'update',
            before: outcome.before === undefined || outcome.before === null ? null : outcome.before,
            after: outcome.after === undefined ? null : outcome.after,
          }
          const content = [{
            type: 'text',
            text:
              '<path>' + displayPath + '</path>\n<type>file</type>\n<content>\n' +
              (outcome.operation === 'create' ? 'Created' : 'Updated') + ' file\n</content>',
          }]
          return { isError: false, value, content }
        }

        const oldString = args && typeof args.old_string === 'string' ? args.old_string : null
        const newString = args && typeof args.new_string === 'string' ? args.new_string : null
        if (oldString === null || newString === null) return next()
        const replaceAll = args.replace_all === true
        owned = { policy }
        const outcome = await fs.editText(target, { oldString, newString, replaceAll }, undefined, exec.signal, policy)
        if (typeof ctx.emit === 'function') {
          ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        }
        const displayPath = target.displayPath !== undefined && target.displayPath !== null ? String(target.displayPath) : filePath
        return {
          isError: false,
          value: { path: displayPath, before: outcome.before, after: outcome.after },
          content: [{
            type: 'text',
            text: replaceAll
              ? 'The file ' + displayPath + ' has been updated. All occurrences were successfully replaced.'
              : 'The file ' + displayPath + ' has been updated successfully.',
          }],
        }
      }

      if (exec.name === 'pwsh' || exec.name === 'bash') {
        if (extraRoots === null) return next()
        const shell = ctx.get('shell')
        if (shell === undefined) return next()
        const modernShell = shellUsesExecute(shell)
        const rawWorkdir = args && typeof args.workdir === 'string' ? args.workdir : null
        const joined =
          rawWorkdir === null
            ? String(primary)
            : isAbsolute(rawWorkdir)
              ? rawWorkdir
              : String(primary).replace(/[\\/]+$/, '') + '/' + rawWorkdir
        const workdirTarget = await fs.resolve(joined, { cwd: primary })
        const absWorkdir = fs.processPath(workdirTarget)
        const hit = extraRoots.find((root) => isInside(absWorkdir, root))
        if (hit === undefined) return next()
        const policy = { ...standing, workspaceRoot: hit }
        const shellEnv = ctx.get('shellEnv')
        const request = {
          command: String(args.command),
          workdir: absWorkdir,
          ...(args && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
          sandboxPolicy: policy,
        }

        if (args && args.run_in_background === true) {
          if (exec.signal && exec.signal.aborted) return next()
          const jobs = ctx.get('jobs')
          if (jobs === undefined) return next()
          owned = { policy }
          // `JobSpec.owner` is the owner's SessionId on modern releases
          // (`jobs-local` resolves it through `agents.get(id)`); the older seam
          // took the Agent itself. `Agent.id` IS the session id.
          const jobId = jobs.start({
            kind: exec.name,
            label: String(args.command),
            ...(exec.agent ? { owner: modernShell ? exec.agent.id : exec.agent } : {}),
            run: () => startBackgroundJob(shell, request),
          })
          return {
            isError: false,
            value: { kind: 'background', jobId },
            content: [{ type: 'text', text: 'started background job ' + jobId }],
          }
        }

        owned = { policy }
        const result = modernShell
          ? await (await shell.execute(shell.resolve({ ...request, signal: exec.signal }))).result()
          : await shell.run(shell.resolve({ ...request, signal: exec.signal }))
        if (result.aborted) {
          return { isError: true, error: { message: 'tool call aborted' }, content: [{ type: 'text', text: '[aborted]' }] }
        }
        const stream = (s) => ({
          text: s && typeof s.text === 'string' ? s.text : '',
          truncated: !!(s && s.truncated),
          ...(s && s.spillPath !== undefined ? { spillPath: s.spillPath } : {}),
        })
        const value = {
          kind: 'foreground',
          exitCode: result.exitCode === undefined ? null : result.exitCode,
          signal: result.signal === undefined ? null : result.signal,
          timedOut: !!result.timedOut,
          aborted: false,
          timeoutMs: result.timeoutMs === undefined ? null : result.timeoutMs,
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
          ...(result.sandbox !== undefined
            ? {
                sandbox: {
                  mode: String(result.sandbox.mode),
                  denied: !!result.sandbox.denied,
                  ...(result.sandbox.enforcement !== undefined ? { enforcement: String(result.sandbox.enforcement) } : {}),
                  ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: !!result.sandbox.runnerFailed } : {}),
                },
              }
            : {}),
        }
        return { isError: false, value, content: [{ type: 'text', text: shellRender(value) }] }
      }
      return next()
    } catch (error) {
      // A failure BEFORE the call was claimed falls back to the default
      // pipeline. A failure AFTER the claim does not: the pipeline fences
      // against the primary root and could only answer with the spurious
      // workspace-write denial, hiding the real cause.
      return owned === null ? next() : ownedFailure(error, owned.policy)
    }
  })

  // Hydration on session start. `agent/created` is a SERIAL event, so returning
  // the promise makes the framework await it — which is what guarantees the
  // very first prompt assembly already lists the folders.
  ctx.on('agent/created', async (payload) => {
    const agent = payload && payload.agent
    if (agent && agent.session && agent.session.header) await hydrate(agent.session.header.cwd)
  })

  // --------------------------------------------------- /code-workspace cmd
  ctx.inject(['commands'], (c) => {
    const commands = c.commands
    const parseArgs = (raw) => {
      const out = []
      let cur = ''
      let inQuote = false
      for (const ch of String(raw)) {
        if (ch === '"') inQuote = !inQuote
        else if (!inQuote && (ch === ' ' || ch === '\t')) {
          if (cur.length > 0) {
            out.push(cur)
            cur = ''
          }
        } else cur += ch
      }
      if (cur.length > 0) out.push(cur)
      return out
    }
    const jsonLine = (obj) => JSON_MARK + ' ' + JSON.stringify(obj)
    const stateText = (state) => {
      const head = state.file === null ? 'No .code-workspace file is associated with ' + state.containerDir + '.' : 'Workspace file: ' + state.file
      const roots =
        state.roots.length === 0
          ? 'Folders: (none)'
          : 'Folders:\n' + state.roots.map((r, i) => `  ${i}. ${r.label} — ${r.resolvedPath}${r.isPrimary ? ' (primary)' : ''}${r.exists ? '' : ' (MISSING)'}`).join('\n')
      const warnings = state.warnings.length === 0 ? '' : '\nWarnings:\n' + state.warnings.map((w) => '  - ' + w.message).join('\n')
      const error = state.error === null ? '' : '\nParse error: ' + state.error.message
      return head + '\n' + roots + warnings + error
    }
    const subcommands = 'list | roots | add <path> [name] | remove <index|path> | rename <index|path> <name> | move <index> <toIndex> | use [<file.code-workspace>] | create <name> | reload'

    return commands.register({
      name: COMMAND_NAME,
      description:
        'VS Code-compatible multi-root workspace: read and edit the .code-workspace file that defines this session\'s folders (' + subcommands + ').',
      input: { hint: '[list|add|remove|rename|move|use|create|reload]' },
      async handler(invocation) {
        try {
          const containerDir =
            invocation.agent && invocation.agent.session && invocation.agent.session.header
              ? String(invocation.agent.session.header.cwd)
              : undefined
          if (typeof containerDir !== 'string' || containerDir.length === 0) {
            return { kind: 'error', text: 'code-workspace: the session workspace is unknown' }
          }
          const argv = parseArgs(invocation.rawInput)
          const sub = argv.length === 0 ? 'list' : argv[0].toLowerCase()
          let changed = false
          let state

          switch (sub) {
            case 'list':
            case 'roots': {
              state = await coreState(containerDir)
              break
            }
            case 'add': {
              const path = argv.slice(1).join(' ').trim()
              if (path === '') return { kind: 'error', text: 'code-workspace: add requires a path' }
              const result = await coreAddFolder(containerDir, path)
              changed = result.changed
              state = result.state
              break
            }
            case 'remove': {
              const address = argv.slice(1).join(' ').trim()
              if (address === '') return { kind: 'error', text: 'code-workspace: remove requires an index or a path' }
              const result = await coreRemoveFolder(containerDir, address)
              changed = result.changed
              state = result.state
              break
            }
            case 'rename': {
              if (argv.length < 3) return { kind: 'error', text: 'code-workspace: rename requires <index|path> <name>' }
              const result = await coreRenameFolder(containerDir, argv[1], argv.slice(2).join(' '))
              changed = result.changed
              state = result.state
              break
            }
            case 'move': {
              if (argv.length < 3) return { kind: 'error', text: 'code-workspace: move requires <index> <toIndex>' }
              const result = await coreMoveFolder(containerDir, argv[1], argv[2])
              changed = result.changed
              state = result.state
              break
            }
            case 'use': {
              // No argument clears the association instead of failing: the panel's
              // "unlink" action must work on both channels, and `/code-workspace use`
              // with nothing after it is the natural spelling for that.
              const file = argv.slice(1).join(' ').trim()
              state = await coreUseFile(containerDir, file === '' ? null : file)
              changed = true
              break
            }
            case 'create': {
              const name = argv.slice(1).join(' ').trim() || 'workspace'
              state = await coreCreate(containerDir, name, [containerDir])
              changed = true
              break
            }
            case 'reload': {
              invalidate(undefined)
              await hydrate(containerDir)
              state = await coreState(containerDir)
              break
            }
            default:
              return { kind: 'error', text: 'code-workspace: unknown subcommand "' + sub + '" (use ' + subcommands + ')' }
          }

          if (changed) armNotice(invocation.agent, rootsNotice(state))
          return { kind: 'success', text: stateText(state) + '\n' + jsonLine(state) }
        } catch (e) {
          return { kind: 'error', text: 'code-workspace: ' + reasonOf(e).replace(/^code-workspace:\s*/, '') }
        }
      },
    })
  })

  // ------------------------------------------------- sessionless remote API
  // The plain-object service must be reachable through `ctx.get('codeWorkspace')`
  // with a visible `typertRemote` binding, and the registry entry makes the
  // endpoints claimable on the shared `/api` channel. Both are owned by this
  // plugin fiber, so unloading withdraws them together.

  const remoteErrorMessage = (e) => 'code-workspace: ' + reasonOf(e).replace(/^code-workspace:\s*/, '')

  const codeWorkspaceApi = {
    async state(containerDir) {
      try {
        return await coreState(containerDir)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async recent() {
      try {
        return await coreRecent()
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async forgetFile(file) {
      try {
        return await coreForgetFile(file)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async open(file) {
      try {
        return await coreOpen(file)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async forget(containerDir) {
      try {
        requireContainer(containerDir)
        const canonical = (await canonicalize(containerDir)) ?? containerDir
        const current = await resolveFileForContainer(canonical)
        if (current !== undefined) await forgetFile(current)
        return await coreState(canonical)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async useFile(containerDir, file) {
      try {
        return await coreUseFile(containerDir, file)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async create(containerDir, name) {
      try {
        return await coreCreate(containerDir, name, [containerDir])
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async addFolder(containerDir, path, name) {
      try {
        return await coreAddFolder(containerDir, path, name)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async removeFolder(containerDir, address) {
      try {
        return await coreRemoveFolder(containerDir, address)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async renameFolder(containerDir, address, name) {
      try {
        return await coreRenameFolder(containerDir, address, name)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async moveFolder(containerDir, address, toIndex) {
      try {
        return await coreMoveFolder(containerDir, address, toIndex)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async browse(path) {
      try {
        return await coreBrowse(path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async makeDir(parent, name) {
      try {
        return await coreMakeDir(parent, name)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async pick(cwd, signal) {
      try {
        signal?.throwIfAborted()
        return await corePick(cwd, signal)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async pickFile(cwd) {
      try {
        return await corePickFile(cwd)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async reveal(path) {
      try {
        return await coreReveal(path)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async editors() {
      try {
        return await coreEditors()
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async editorIcon(id) {
      try {
        return await coreEditorIcon(id)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async openInEditor(containerDir, editorId) {
      try {
        return await coreOpenInEditor(containerDir, editorId)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
    async listFiles(containerDir, query) {
      try {
        return await coreListFiles(containerDir, query)
      } catch (e) {
        throw new Error(remoteErrorMessage(e))
      }
    },
  }

  Object.defineProperty(codeWorkspaceApi, 'typertRemote', {
    value: Object.freeze({ service: codeWorkspaceApi, serviceKey: 'codeWorkspace', namespace: 'codeWorkspace' }),
  })

  const remoteParam = (paramName) => ({ name: paramName, wire: paramName, source: 'json', codec: { mode: 'src-json' } })
  const remoteInvocation = (method, params) => ({
    id: 'dsh-code-workspace#codeWorkspace/' + method,
    service: 'codeWorkspace',
    namespace: 'codeWorkspace',
    method,
    invocation: { kind: 'direct' },
    parameters: params.map(remoteParam),
    result: { mode: 'src-json' },
  })
  const REMOTE_CONTRIBUTION = {
    package: 'dsh-code-workspace',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      remoteInvocation('state', ['containerDir']),
      remoteInvocation('recent', []),
      remoteInvocation('forgetFile', ['file']),
      remoteInvocation('open', ['file']),
      remoteInvocation('forget', ['containerDir']),
      remoteInvocation('useFile', ['containerDir', 'file']),
      remoteInvocation('create', ['containerDir', 'name']),
      remoteInvocation('addFolder', ['containerDir', 'path', 'name']),
      remoteInvocation('removeFolder', ['containerDir', 'address']),
      remoteInvocation('renameFolder', ['containerDir', 'address', 'name']),
      remoteInvocation('moveFolder', ['containerDir', 'address', 'toIndex']),
      remoteInvocation('browse', ['path']),
      remoteInvocation('makeDir', ['parent', 'name']),
      { ...remoteInvocation('pick', ['cwd']), cancellation: { parameter: 'signal' } },
      remoteInvocation('pickFile', ['cwd']),
      remoteInvocation('reveal', ['path']),
      remoteInvocation('editors', []),
      remoteInvocation('editorIcon', ['id']),
      remoteInvocation('openInEditor', ['containerDir', 'editorId']),
      remoteInvocation('listFiles', ['containerDir', 'query']),
    ],
  }

  ctx.provide('codeWorkspace', codeWorkspaceApi)
  ctx.inject(['typert'], (t) => t.typert.register(REMOTE_CONTRIBUTION))
}
