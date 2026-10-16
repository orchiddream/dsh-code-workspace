import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addFolder,
  createWorkspaceDocument,
  deriveRoot,
  extraRootsFor,
  fileStamp,
  findFolderIndex,
  isAbsoluteWorkspacePath,
  isInside,
  isWorkspaceFileName,
  isWorkspaceFilePath,
  moveFolder,
  parseWorkspaceFile,
  removeFolder,
  resolveFolderPath,
  serializeFolders,
  setFolderName,
  storagePathFor,
  toComparable,
  workspaceTitle,
} from '../lib/workspace-file.js'

const FILE = 'D:\\kjsjs\\deepseek\\dsh-nl.code-workspace'

const SAMPLE = `{
\t"folders": [
\t\t{
\t\t\t"path": "dsh-nl"
\t\t},
\t\t{
\t\t\t"path": "deepseek-harness"
\t\t},
\t\t{
\t\t\t"path": "dsh-plugin-nl-theme"
\t\t}
\t],
\t"settings": {},
\t"trae": {
\t\t"workspaceId": "e783efee8020e0cabbf01525107e2464"
\t}
}
`

test('recognises workspace file names and paths', () => {
  assert.equal(isWorkspaceFileName('a.code-workspace'), true)
  assert.equal(isWorkspaceFileName('A.CODE-WORKSPACE'), true)
  assert.equal(isWorkspaceFileName('a.code-workspace.bak'), false)
  assert.equal(isWorkspaceFileName(undefined), false)
  assert.equal(isWorkspaceFilePath('D:\\x\\a.code-workspace'), true)
  assert.equal(isWorkspaceFilePath('/home/x/a.code-workspace/'), true)
  assert.equal(isWorkspaceFilePath('D:\\x\\a.json'), false)
})

test('absolute-path detection follows the VS Code rules, ./ first', () => {
  assert.equal(isAbsoluteWorkspacePath('dsh-nl'), false)
  assert.equal(isAbsoluteWorkspacePath('../website'), false)
  assert.equal(isAbsoluteWorkspacePath('./sub'), false)
  // The trap: a drive-qualified spelling behind `./` is RELATIVE.
  assert.equal(isAbsoluteWorkspacePath('./C:/x'), false)
  assert.equal(isAbsoluteWorkspacePath('C:\\x'), true)
  assert.equal(isAbsoluteWorkspacePath('C:/x'), true)
  assert.equal(isAbsoluteWorkspacePath('/home/x'), true)
  assert.equal(isAbsoluteWorkspacePath('\\\\server\\share\\x'), true)
  assert.equal(isAbsoluteWorkspacePath('//server/share'), true)
})

test('relative folder paths resolve against the workspace file directory', () => {
  assert.equal(resolveFolderPath(FILE, 'dsh-nl'), 'D:/kjsjs/deepseek/dsh-nl')
  assert.equal(resolveFolderPath(FILE, '../website'), 'D:/kjsjs/website')
  assert.equal(resolveFolderPath(FILE, './dsh-nl/'), 'D:/kjsjs/deepseek/dsh-nl')
  assert.equal(resolveFolderPath(FILE, 'a/./b/../c'), 'D:/kjsjs/deepseek/a/c')
})

test('absolute folder paths are taken as written, and case is preserved', () => {
  assert.equal(resolveFolderPath(FILE, 'D:\\Other\\Repo'), 'D:/Other/Repo')
  assert.equal(resolveFolderPath(FILE, 'C:/Mixed/Case'), 'C:/Mixed/Case')
  assert.equal(resolveFolderPath('/home/u/Ws.code-workspace', '/srv/Repo'), '/srv/Repo')
})

test('toComparable folds case only for Windows spellings', () => {
  assert.equal(toComparable('D:\\A\\B\\'), 'd:/a/b')
  assert.equal(toComparable('/Home/A/'), '/Home/A')
})

test('isInside matches the root itself and its descendants only', () => {
  assert.equal(isInside('D:/a', 'D:\\a'), true)
  assert.equal(isInside('D:/a/b', 'D:/a'), true)
  assert.equal(isInside('D:/ab', 'D:/a'), false)
  assert.equal(isInside('D:/a', 'D:/a/b'), false)
})

test('storagePathFor prefers a portable relative spelling', () => {
  assert.equal(storagePathFor(FILE, 'D:/kjsjs/deepseek/dsh-nl'), 'dsh-nl')
  assert.equal(storagePathFor(FILE, 'D:/kjsjs/other'), '../other')
  assert.equal(storagePathFor(FILE, 'D:/kjsjs/deepseek'), '.')
  assert.equal(storagePathFor(FILE, 'D:/kjsjs'), '..')
  assert.equal(storagePathFor(FILE, 'D:/kjsjs/deepseek/deep/a'), 'deep/a')
  // Cross-drive on Windows has no relative form: keep it absolute.
  assert.equal(storagePathFor(FILE, 'C:/elsewhere'), 'C:/elsewhere')
})

test('parses the real-world sample', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  assert.equal(model.fileDir, 'D:\\kjsjs\\deepseek')
  assert.deepEqual(model.roots, [
    'D:/kjsjs/deepseek/dsh-nl',
    'D:/kjsjs/deepseek/deepseek-harness',
    'D:/kjsjs/deepseek/dsh-plugin-nl-theme',
  ])
  assert.deepEqual(model.warnings, [])
  assert.deepEqual(model.settings, {})
  assert.equal(model.raw.trae.workspaceId, 'e783efee8020e0cabbf01525107e2464')
  assert.equal(model.indent, '\t')
  assert.equal(workspaceTitle(FILE), 'dsh-nl')
})

test('a folder entry keeps its display name and unknown keys', () => {
  const text = `{
\t"folders": [
\t\t{ "name": "Docs", "path": "../website", "icon": "globe" }
\t]
}
`
  const model = parseWorkspaceFile(text, FILE)
  assert.equal(model.folders[0].name, 'Docs')
  assert.equal(model.folders[0].resolvedPath, 'D:/kjsjs/website')
  assert.deepEqual(serializeFolders(model.folders), [
    { name: 'Docs', path: '../website', icon: 'globe' },
  ])
})

test('malformed folder entries degrade to warnings instead of throwing', () => {
  const text = `{
\t"folders": [
\t\t"not-an-object",
\t\t{ "name": "no path" },
\t\t{ "path": "a" },
\t\t{ "path": "a" },
\t\t{ "path": "b" }
\t]
}
`
  const model = parseWorkspaceFile(text, FILE)
  assert.deepEqual(model.roots, ['D:/kjsjs/deepseek/a', 'D:/kjsjs/deepseek/b'])
  assert.deepEqual(
    model.warnings.map((w) => w.code),
    ['folder-not-an-object', 'folder-without-path', 'duplicate-folder'],
  )
  assert.equal(model.folders[0].sourceIndex, 2)
})

test('a non-array folders member warns and yields no roots', () => {
  const model = parseWorkspaceFile('{ "folders": { "path": "a" } }', FILE)
  assert.deepEqual(model.roots, [])
  assert.equal(model.warnings[0].code, 'folders-not-an-array')
})

test('a missing folders member is simply empty', () => {
  const model = parseWorkspaceFile('{ "settings": {} }', FILE)
  assert.deepEqual(model.roots, [])
  assert.deepEqual(model.warnings, [])
})

test('JSONC comments in a workspace file are accepted', () => {
  const model = parseWorkspaceFile('{\n\t// roots\n\t"folders": [{ "path": "a" }],\n}\n', FILE)
  assert.deepEqual(model.roots, ['D:/kjsjs/deepseek/a'])
})

test('extraRootsFor excludes the session root and orders longest first', () => {
  const text = `{
\t"folders": [
\t\t{ "path": "." },
\t\t{ "path": "deep/outer" },
\t\t{ "path": "deep/outer/inner" }
\t]
}
`
  const model = parseWorkspaceFile(text, FILE)
  assert.deepEqual(model.roots, [
    'D:/kjsjs/deepseek',
    'D:/kjsjs/deepseek/deep/outer',
    'D:/kjsjs/deepseek/deep/outer/inner',
  ])
  assert.deepEqual(extraRootsFor(model, 'D:\\kjsjs\\deepseek'), [
    'D:/kjsjs/deepseek/deep/outer/inner',
    'D:/kjsjs/deepseek/deep/outer',
  ])
})

test('deriveRoot takes the first folder that exists, never the file folder', () => {
  const model = parseWorkspaceFile(`{ "folders": [{ "path": "../api" }, { "path": "../shared" }] }`, 'D:/lib/api.code-workspace')
  assert.deepEqual(model.roots, ['D:/api', 'D:/shared'])

  // Unprobed folders are taken at face value — this is a pure function over the
  // model, and the host probes every folder before calling it.
  assert.equal(deriveRoot(model, 'D:/lib'), 'D:/api')

  // A folder PROVEN missing (or proven to be a file) is skipped.
  model.folders[0].exists = false
  model.folders[0].isDirectory = false
  assert.equal(deriveRoot(model, 'D:/lib'), 'D:/shared')
})

test('deriveRoot skips a missing or non-directory folder and falls back to the file folder', () => {
  const model = parseWorkspaceFile(
    `{ "folders": [{ "path": "../gone" }, { "path": "../a-file" }, { "path": "../here" }] }`,
    'D:/lib/one.code-workspace',
  )
  model.folders[0].exists = false
  model.folders[0].isDirectory = false
  model.folders[1].exists = true
  model.folders[1].isDirectory = false
  model.folders[2].exists = true
  model.folders[2].isDirectory = true
  assert.equal(deriveRoot(model, 'D:/lib'), 'D:/here')

  // Every folder unusable: the file's own directory is the only answer left.
  for (const folder of model.folders) {
    folder.exists = false
    folder.isDirectory = false
  }
  assert.equal(deriveRoot(model, 'D:/lib'), 'D:/lib')

  const empty = parseWorkspaceFile('{ "folders": [] }', 'D:/lib/empty.code-workspace')
  assert.equal(deriveRoot(empty, 'D:/lib'), 'D:/lib')
})

test('addFolder is idempotent per resolved root', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  const first = addFolder(model.folders, {
    path: 'new-root',
    resolvedPath: 'D:/kjsjs/deepseek/new-root',
  })
  assert.equal(first.changed, true)
  assert.equal(first.folders.length, 4)
  const again = addFolder(first.folders, { path: 'whatever', resolvedPath: 'D:/KJSJS/DEEPSEEK/NEW-ROOT' })
  assert.equal(again.changed, false)
  assert.equal(again.folders.length, 4)
})

test('removeFolder accepts an index, a stored path, an absolute path or a name', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  assert.equal(removeFolder(model.folders, 1).removed.path, 'deepseek-harness')
  assert.equal(removeFolder(model.folders, 'deepseek-harness').removed.path, 'deepseek-harness')
  assert.equal(removeFolder(model.folders, 'D:/kjsjs/deepseek/dsh-nl').removed.path, 'dsh-nl')
  assert.equal(removeFolder(model.folders, 'dsh-plugin-nl-theme').removed.path, 'dsh-plugin-nl-theme')
  assert.equal(removeFolder(model.folders, 'nope').changed, false)
})

test('findFolderIndex distinguishes a numeric path from an index', () => {
  const folders = parseWorkspaceFile('{ "folders": [{ "path": "0" }, { "path": "1" }] }', FILE).folders
  // `0` is both a valid index and a stored path; the stored path wins.
  assert.equal(findFolderIndex(folders, 0), 0)
  assert.equal(findFolderIndex(folders, '1'), 1)
  assert.equal(findFolderIndex(folders, 'D:/kjsjs/deepseek/1'), 1)
  assert.equal(findFolderIndex(folders, ''), -1)
})

test('setFolderName sets, clears and reports no-ops', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  const named = setFolderName(model.folders, 0, '  App  ')
  assert.equal(named.changed, true)
  assert.equal(named.folders[0].name, 'App')
  assert.equal(setFolderName(named.folders, 0, 'App').changed, false)
  const cleared = setFolderName(named.folders, 0, '   ')
  assert.equal(cleared.changed, true)
  assert.equal(cleared.folders[0].name, undefined)
  assert.equal(setFolderName(model.folders, 99, 'x').changed, false)
})

test('moveFolder reorders DOM-insertBefore style', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  const moved = moveFolder(model.folders, 0, 2)
  assert.deepEqual(
    moved.folders.map((f) => f.path),
    ['deepseek-harness', 'dsh-plugin-nl-theme', 'dsh-nl'],
  )
  assert.equal(moved.changed, true)
  const back = moveFolder(moved.folders, 'dsh-nl', 0)
  assert.deepEqual(back.folders.map((f) => f.path), ['dsh-nl', 'deepseek-harness', 'dsh-plugin-nl-theme'])
  assert.equal(moveFolder(back.folders, 'dsh-nl', 0).changed, false)
  assert.equal(moveFolder(model.folders, 'nope', 0).changed, false)
})

test('serializeFolder drops a blank name and preserves order', () => {
  const model = parseWorkspaceFile(SAMPLE, FILE)
  const out = serializeFolders(setFolderName(model.folders, 2, 'Theme').folders)
  assert.deepEqual(out, [
    { path: 'dsh-nl' },
    { path: 'deepseek-harness' },
    { name: 'Theme', path: 'dsh-plugin-nl-theme' },
  ])
})

test('createWorkspaceDocument emits the VS Code shape', () => {
  assert.deepEqual(createWorkspaceDocument([{ path: 'a', resolvedPath: 'D:/c/a' }]), {
    folders: [{ path: 'a' }],
  })
  assert.deepEqual(
    createWorkspaceDocument([{ path: 'a', name: 'A', resolvedPath: 'D:/c/a' }], { settings: {} }),
    { folders: [{ name: 'A', path: 'a' }], settings: {} },
  )
})

test('fileStamp distinguishes missing, unchanged and changed files', () => {
  assert.equal(fileStamp(undefined), 'missing')
  assert.equal(fileStamp({ size: 10, mtimeMs: 5 }), '10:5')
  assert.notEqual(fileStamp({ size: 10, mtimeMs: 5 }), fileStamp({ size: 10, mtimeMs: 6 }))
})
