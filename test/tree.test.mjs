/**
 * The workspace file tree's listing.
 *
 * `listWorkspaceDirectory` is the Host half of "browse every root": the shipped
 * Files page can only list the session root, so the additional folders of a
 * `.code-workspace` file are reachable through this listing alone. These tests
 * pin its contract against a fake filesystem seam: children come back with
 * absolute, forward-slashed paths; directories precede files; the cap truncates
 * without throwing; and a non-absolute target is refused rather than resolved
 * against the process's current drive.
 *
 * "Fully qualified" is platform-specific, so the root is spelled for the running
 * host and every expected path is expressed through it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { listWorkspaceDirectory } from '../lib/index.js'

const WINDOWS = process.platform === 'win32'
/** What the caller passes in: a Windows drive path or a POSIX absolute path. */
const ROOT_SPELLING = WINDOWS ? 'D:\\work\\proj' : '/srv/app'
/** What the listing reports: normalized to forward slashes. */
const ROOT = WINDOWS ? 'D:/work/proj' : '/srv/app'

/** The normalized absolute path of one child. */
const child = (name) => ROOT + '/' + name

/** A minimal `ctx.fs` face: resolve a spelling, report it, list its children. */
function fakeFs(children, options = {}) {
  return {
    async resolve(path) {
      if (options.resolveFails === true) throw new Error('no such directory')
      return { path }
    },
    processPath(handle) {
      return handle.path
    },
    async listDir() {
      if (options.listFails === true) throw new Error('access denied')
      return children
    },
  }
}

test('directories precede files, each sorted, with absolute paths', async () => {
  const children = [
    { name: 'zeta.txt', type: 'file' },
    { name: 'src', type: 'directory' },
    { name: 'Alpha.txt', type: 'file' },
    { name: 'docs', type: 'directory' },
  ]
  const result = await listWorkspaceDirectory(fakeFs(children), ROOT_SPELLING)
  assert.equal(result.path, ROOT)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['docs', 'src', 'Alpha.txt', 'zeta.txt'])
  assert.deepEqual(result.entries.map((entry) => entry.kind), ['directory', 'directory', 'file', 'file'])
  assert.deepEqual(result.entries.map((entry) => entry.path), [
    child('docs'),
    child('src'),
    child('Alpha.txt'),
    child('zeta.txt'),
  ])
})

test('keeps hidden entries and flags them', async () => {
  const result = await listWorkspaceDirectory(fakeFs([{ name: '.git', type: 'directory' }]), ROOT_SPELLING)
  assert.equal(result.path, ROOT)
  assert.equal(result.entries[0].hidden, true)
  assert.equal(result.entries[0].path, child('.git'))
})

test('skips nameless and missing children instead of inventing entries', async () => {
  const children = [null, undefined, { name: '', type: 'file' }, { name: null, type: 'file' }, { name: 'ok.txt', type: 'file' }]
  const result = await listWorkspaceDirectory(fakeFs(children), ROOT_SPELLING)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['ok.txt'])
})

test('truncates past the cap without failing', async () => {
  const children = []
  for (let index = 0; index < 5; index += 1) children.push({ name: `f${String(index)}.txt`, type: 'file' })
  const result = await listWorkspaceDirectory(fakeFs(children), ROOT_SPELLING, 3)
  assert.equal(result.truncated, true)
  assert.equal(result.entries.length, 3)
})

test('refuses a spelling that is not fully qualified', async () => {
  await assert.rejects(() => listWorkspaceDirectory(fakeFs([]), 'relative/path'), /fully qualified/u)
})

test('reports an unreadable directory with the path it tried', async () => {
  const escaped = ROOT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  await assert.rejects(
    () => listWorkspaceDirectory(fakeFs([], { listFails: true }), ROOT_SPELLING),
    new RegExp('cannot list "' + escaped + '": access denied', 'u'),
  )
})
