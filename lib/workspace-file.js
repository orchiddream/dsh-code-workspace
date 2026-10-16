/**
 * The `.code-workspace` document model — the VS Code / Trae / Cursor workspace
 * file format, interpreted for DSH.
 *
 * Everything here is PURE: no filesystem access, no environment probing. Path
 * resolution follows the flavour of the workspace file's own spelling (Windows
 * drive/UNC spellings use `win32` semantics, POSIX spellings use `posix`), so a
 * `.code-workspace` file can be parsed and rewritten correctly on any host and
 * the whole module is deterministic under test.
 *
 * ## The format (as VS Code defines it)
 *
 * ```jsonc
 * {
 *   "folders": [                                  // the roots of the window
 *     { "path": "app" },                          // relative to THIS file
 *     { "name": "Docs", "path": "../website" },   // optional display name
 *     { "path": "C:/absolute/tree" }              // absolute, no "./" prefix
 *   ],
 *   "settings":     { ... },                      // preserved verbatim
 *   "extensions":   { ... },                      // preserved verbatim
 *   "launch":       { ... },                      // preserved verbatim
 *   "tasks":        { ... },                      // preserved verbatim
 *   "trae":         { ... }                       // any foreign member survives
 * }
 * ```
 *
 * Path rules, which are the part every reimplementation gets wrong:
 *
 * - A `path` beginning with `./` or `../` is ALWAYS relative — even on Windows,
 *   where `./C:/x` would otherwise look drive-qualified.
 * - Otherwise a drive-qualified (`C:\x`, `C:/x`), UNC (`\\server\share`), or
 *   leading-slash (`/x`) path is absolute.
 * - Everything else — including a bare `app` — is relative to the directory
 *   containing the `.code-workspace` file.
 *
 * Unknown keys inside one folder entry (newer VS Code writes an `icon`) are
 * preserved on rewrite; the model never drops what it does not understand.
 */

import { posix, win32 } from 'node:path'

import { parseDocument } from './jsonc.js'

/** The extension VS Code uses; the whole feature keys off it. */
export const WORKSPACE_FILE_EXT = '.code-workspace'

/** Whether a file name is a workspace file (case-insensitive, like Windows). */
export function isWorkspaceFileName(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith(WORKSPACE_FILE_EXT)
}

/** Whether a path looks like a workspace file path. */
export function isWorkspaceFilePath(path) {
  return typeof path === 'string' && isWorkspaceFileName(String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')
}

/** Whether a path is spelled in the Windows flavour (drive-qualified or UNC). */
export function isWindowsSpelling(path) {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/** The `path` API that matches one path's own spelling. */
export function pathApiFor(path) {
  return isWindowsSpelling(path) ? win32 : posix
}

/**
 * Whether one `folders[].path` value is absolute in VS Code's sense.
 *
 * The `./` / `../` prefix test comes FIRST on purpose: `./C:/x` is a legal
 * relative spelling and must not be mistaken for a drive-qualified path.
 */
export function isAbsoluteWorkspacePath(value) {
  const p = String(value)
  if (p.startsWith('./') || p.startsWith('../') || p === '.' || p === '..') return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith('\\\\')) return true
  if (p.startsWith('//') && !p.startsWith('///')) return true
  return p.startsWith('/')
}

/**
 * Resolve one `folders[].path` against the directory holding the workspace file.
 * @param filePath - the `.code-workspace` file's own path (its spelling picks the flavour).
 * @param value - the raw `path` string from the file.
 * @returns the absolute, normalized path with forward slashes. CASE IS KEPT —
 *   this value is used as a real filesystem path (a sandbox root), so only
 *   {@link toComparable} may fold case, and only for comparison.
 */
export function resolveFolderPath(filePath, value) {
  const api = pathApiFor(filePath)
  const raw = String(value)
  const base = api.dirname(filePath)
  const joined = isAbsoluteWorkspacePath(raw) ? raw : api.join(base, raw)
  return toForward(api.normalize(joined))
}

/** Normalize a path for comparison only: forward slashes, lowercase, no trailing separator. */
export function toComparable(path) {
  const s = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  // Windows paths compare case-insensitively; POSIX ones do not.
  return isWindowsSpelling(s) ? s.toLowerCase() : s
}

/** Whether `child` is `parent` itself or lies inside it. */
export function isInside(child, parent) {
  const c = toComparable(child)
  const p = toComparable(parent)
  if (p === '') return false
  return c === p || c.startsWith(p + '/')
}

/**
 * The portable spelling of `absoluteTarget` relative to `base`: a relative path
 * when one exists, the absolute path otherwise (a cross-drive relationship on
 * Windows has no relative form).
 */
export function relativeTo(base, absoluteTarget) {
  const api = pathApiFor(base)
  const rel = api.relative(base, absoluteTarget)
  if (rel === '') return '.'
  return api.isAbsolute(rel) ? toForward(absoluteTarget) : toForward(rel)
}

/**
 * The spelling to STORE for one absolute folder path in a workspace file:
 * relative to the file's own directory when possible, absolute otherwise.
 */
export function storagePathFor(filePath, absoluteTarget) {
  return relativeTo(pathApiFor(filePath).dirname(filePath), absoluteTarget)
}

/**
 * Backslashes to forward slashes, keeping UNC prefixes intact and removing
 * redundant trailing separators — but never collapsing a filesystem root
 * (`D:/`, `/`, `//server/share`) into something that is not one.
 *
 * Exported so every path the plugin CONSTRUCTS (rather than receives from the
 * `fs` seam) has one predictable spelling: identity, comparison, display and
 * the store all agree, on every platform.
 */
export function normalizeSpelling(path) {
  let s = String(path)
  let unc = ''
  if (/^\\\\/.test(s)) {
    unc = '\\\\'
    s = s.slice(2)
  }
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(s)) s += '/'
  return unc + s
}

/** The internal alias kept for readability at the call sites below. */
const toForward = normalizeSpelling

/** A model-folders entry rendered back into the on-disk shape. */
export function serializeFolder(entry) {
  const out = { ...(entry.raw ?? {}) }
  out.path = entry.path
  if (entry.name === undefined || entry.name === null || String(entry.name).trim() === '') delete out.name
  else out.name = String(entry.name)
  return out
}

/** A model-folders entry rendered into the shape `folders` is written as. */
export function serializeFolders(entries) {
  return entries.map(serializeFolder)
}

/**
 * Parse one workspace file's text.
 *
 * Never throws on *content* problems: a malformed `folders` member, an entry
 * that is not an object, a missing `path`, or a duplicate root all degrade to a
 * `warnings` entry with the offending folder dropped, so the panel can still
 * show — and repair — a file the user is midway through editing.
 *
 * @param text - the file's raw contents (JSONC).
 * @param filePath - the file's own path.
 * @returns the model.
 * @throws {JsoncSyntaxError} when the text is not parseable JSONC at all.
 */
export function parseWorkspaceFile(text, filePath) {
  const warnings = []
  const document = parseDocument(text)
  const value = document.value

  const rawFolders = value.folders
  const folders = []
  const seen = new Map()

  if (rawFolders !== undefined && rawFolders !== null) {
    if (!Array.isArray(rawFolders)) {
      warnings.push({ code: 'folders-not-an-array', message: '"folders" must be an array; it was ignored.' })
    } else {
      rawFolders.forEach((raw, index) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          warnings.push({ code: 'folder-not-an-object', index, message: `folders[${index}] is not an object; it was ignored.` })
          return
        }
        if (typeof raw.path !== 'string' || raw.path.trim() === '') {
          warnings.push({ code: 'folder-without-path', index, message: `folders[${index}] has no "path"; it was ignored.` })
          return
        }
        const resolvedPath = resolveFolderPath(filePath, raw.path)
        const key = toComparable(resolvedPath)
        if (seen.has(key)) {
          warnings.push({
            code: 'duplicate-folder',
            index,
            path: raw.path,
            message: `folders[${index}] ("${raw.path}") duplicates folders[${seen.get(key)}]; it was ignored.`,
          })
          return
        }
        seen.set(key, index)
        folders.push({
          index: folders.length,
          sourceIndex: index,
          raw,
          path: String(raw.path),
          name: typeof raw.name === 'string' ? raw.name : undefined,
          resolvedPath,
        })
      })
    }
  }

  return {
    filePath,
    /** The directory HOLDING the file. Not the session root — see {@link deriveRoot}. */
    fileDir: pathApiFor(filePath).dirname(filePath),
    folders,
    warnings,
    /** Every other member, preserved verbatim on rewrite. */
    settings: value.settings,
    extensions: value.extensions,
    launch: value.launch,
    tasks: value.tasks,
    /** The whole parsed document, for members this model does not name. */
    raw: value,
    indent: document.indent,
    hasBom: document.hasBom,
    /** Absolute roots in file order, deduplicated. */
    get roots() {
      return folders.map((f) => f.resolvedPath)
    },
  }
}

/**
 * The file text for a brand-new workspace file.
 * @param folders - folder entries in the model shape.
 * @param extra - additional members (e.g. `settings`).
 */
export function createWorkspaceDocument(folders, extra = {}) {
  return { folders: serializeFolders(folders), ...extra }
}

/** The display title VS Code would show: the file's base name without extension. */
export function workspaceTitle(filePath) {
  const name = String(filePath).split(/[\\/]/).pop() ?? ''
  return isWorkspaceFileName(name) ? name.slice(0, -WORKSPACE_FILE_EXT.length) || name : name
}

/**
 * The directory a DSH session must be rooted at so that this file's `folders`
 * are all the window VS Code would open.
 *
 * DSH models a workspace as ONE canonical directory, and the file's own
 * directory is only where the file lives — it is a *container*, not a root. A
 * user who keeps every `.code-workspace` in one folder (say `D:/home/workspace`)
 * would otherwise get a session rooted at a directory that holds no code at
 * all, and every file in that folder would collapse onto the SAME DSH
 * workspace. The file's own order decides instead: **the first folder that
 * exists on disk is the session root**, and every other folder becomes an
 * additional root.
 *
 * `model.folders` must already carry the `exists` / `isDirectory` probes the
 * caller collected (see the host's `loadModel`); a folder PROVEN missing or
 * proven not to be a directory is skipped, because `workspaceRegistry` refuses
 * anything that is not an existing directory. A folder carrying no probe is
 * taken at face value — this module is pure and cannot look. When no folder
 * qualifies the answer is the file's own directory, which is the one directory
 * this file is guaranteed to be near.
 *
 * @param model - a parsed model whose folders carry their probes.
 * @param fileDir - the directory holding the workspace file.
 * @returns the absolute root in the model's real spelling.
 */
export function deriveRoot(model, fileDir) {
  for (const folder of model.folders) {
    if (folder.exists === false || folder.isDirectory === false) continue
    if (typeof folder.resolvedPath === 'string' && folder.resolvedPath.length > 0) return folder.resolvedPath
  }
  return fileDir
}

/**
 * The roots that need the SANDBOX re-rooted: every folder except the session's
 * primary root, which the sandbox already grants.
 * Longest paths come first so an inner root wins over an enclosing one.
 * Paths keep their real spelling; only dedupe and the primary comparison fold
 * case.
 */
export function extraRootsFor(model, primaryRoot) {
  const primary = toComparable(primaryRoot)
  const seen = new Set()
  const out = []
  for (const folder of model.folders) {
    const key = toComparable(folder.resolvedPath)
    if (key === primary || seen.has(key)) continue
    seen.add(key)
    out.push(folder.resolvedPath)
  }
  return out.sort((a, b) => b.length - a.length)
}

// ---------------------------------------------------------------- mutations
// Each returns a NEW folders array in the model shape; the caller serialises it
// and patches the file. Kept separate from parsing so the same operations serve
// the slash command, the panel, and the tests.

/**
 * Append one folder.
 * @param folders - current model folders.
 * @param entry - `{ path, name?, resolvedPath }`; `path` is the STORED spelling.
 * @returns `{ folders, changed }` — `changed` is false for a duplicate root.
 */
export function addFolder(folders, entry) {
  const key = toComparable(entry.resolvedPath)
  if (folders.some((f) => toComparable(f.resolvedPath) === key)) return { folders, changed: false }
  const next = [
    ...folders,
    {
      index: folders.length,
      raw: {},
      path: entry.path,
      name: entry.name,
      resolvedPath: entry.resolvedPath,
    },
  ]
  return { folders: reindex(next), changed: true }
}

/**
 * Remove one folder, addressed by its index in the model or by any spelling of
 * its path (stored, absolute, or comparable).
 */
export function removeFolder(folders, address) {
  const target = findFolderIndex(folders, address)
  if (target < 0) return { folders, changed: false, removed: undefined }
  const next = folders.filter((_, i) => i !== target)
  return { folders: reindex(next), changed: true, removed: folders[target] }
}

/** Set or clear one folder's display name. */
export function setFolderName(folders, address, name) {
  const target = findFolderIndex(folders, address)
  if (target < 0) return { folders, changed: false }
  const cleaned = name === undefined || name === null || String(name).trim() === '' ? undefined : String(name).trim()
  if (folders[target].name === cleaned) return { folders, changed: false }
  const next = folders.map((f, i) => (i === target ? { ...f, name: cleaned } : f))
  return { folders: reindex(next), changed: true }
}

/** Move one folder to another position, DOM-`insertBefore` style. */
export function moveFolder(folders, address, toIndex) {
  const from = findFolderIndex(folders, address)
  if (from < 0) return { folders, changed: false }
  const next = [...folders]
  const [moved] = next.splice(from, 1)
  const clamped = Math.max(0, Math.min(Number.isInteger(toIndex) ? toIndex : next.length, next.length))
  next.splice(clamped, 0, moved)
  if (next.every((f, i) => f === folders[i])) return { folders, changed: false }
  return { folders: reindex(next), changed: true }
}

/**
 * Resolve a folder address — a model index (number or numeric string) or any
 * spelling of its path — to a position in `folders`, or -1.
 */
export function findFolderIndex(folders, address) {
  if (typeof address === 'number' && Number.isInteger(address)) {
    return address >= 0 && address < folders.length ? address : -1
  }
  const raw = String(address ?? '').trim()
  if (raw === '') return -1
  if (/^\d+$/.test(raw)) {
    const index = Number(raw)
    if (index >= 0 && index < folders.length) return index
  }
  const key = toComparable(raw.replace(/^\.\//, ''))
  // Match the stored spelling first (it is what the user sees), then the
  // resolved absolute path, then a suffix match so `app/src` finds `D:/x/app/src`.
  for (let i = 0; i < folders.length; i++) {
    if (toComparable(folders[i].path) === key) return i
  }
  for (let i = 0; i < folders.length; i++) {
    if (toComparable(folders[i].resolvedPath) === key) return i
  }
  for (let i = 0; i < folders.length; i++) {
    const resolved = toComparable(folders[i].resolvedPath)
    if (resolved === key || resolved.endsWith('/' + key)) return i
  }
  // Finally, allow the folder's display name.
  for (let i = 0; i < folders.length; i++) {
    if (folders[i].name !== undefined && folders[i].name === raw) return i
  }
  return -1
}

/** Re-number `index` after a mutation so the model stays self-consistent. */
function reindex(folders) {
  return folders.map((f, i) => (f.index === i ? f : { ...f, index: i }))
}

/**
 * A stable identity for one file's contents, used by the host's cache to notice
 * that the user edited the file outside DSH.
 */
export function fileStamp(stat) {
  if (stat === undefined || stat === null) return 'missing'
  const size = stat.size ?? 0
  const mtime = stat.mtimeMs ?? stat.mtime?.getTime?.() ?? 0
  return `${size}:${mtime}`
}
