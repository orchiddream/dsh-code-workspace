/**
 * Host-half behaviour tests, run without the DSH runtime.
 *
 * A fake `fs` seam, a fake `systemPrompt`, a fake `commands` registry and a fake
 * `shell` executor are enough to exercise everything the plugin decides: which
 * file owns a session directory, which calls get re-rooted, which calls are
 * refused, and what the panel's remote API writes back into the file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { normalizeSpelling, pathApiFor, toComparable } from '../lib/workspace-file.js'

// The plugin's store lives under `DSH_HOME`. Point it at a throwaway directory
// BEFORE the plugin ever computes a store path, so a test run can never read or
// overwrite the developer's real `~/.dsh/storages/code-workspace`.
const TEST_HOME = await mkdtemp(join(tmpdir(), 'dsh-code-workspace-test-'))
process.env.DSH_HOME = TEST_HOME
test.after(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
})

// --------------------------------------------------------------- fake kernel

/** Normalize one path (relative paths resolve against `base`) to forward slashes. */
function norm(path, base) {
  const api = pathApiFor(base ?? path)
  const abs = api.isAbsolute(String(path)) ? String(path) : api.join(base ?? process.cwd(), String(path))
  return api.normalize(abs).replace(/\\/g, '/')
}

function createFakeFs(initial) {
  const entries = []
  for (const entry of initial) entries.push({ mtime: 1, ...entry, path: norm(entry.path) })

  const find = (path) => entries.find((e) => toComparable(e.path) === toComparable(path))
  const writes = []

  const fs = {
    async resolve(path, opts = {}) {
      const base = opts.cwd !== undefined ? norm(opts.cwd) : process.cwd()
      const resolved = norm(path, base)
      return { path: resolved, displayPath: String(path) }
    },
    processPath: (target) => target.path,
    async stat(target) {
      const entry = find(target.path)
      if (entry === undefined) return undefined
      return { type: entry.type, size: entry.text === undefined ? 0 : entry.text.length, mtimeMs: entry.mtime }
    },
    async readText(target) {
      const entry = find(target.path)
      if (entry === undefined) throw Object.assign(new Error('ENOENT: ' + target.path), { code: 'ENOENT' })
      if (entry.type !== 'file') throw new Error('EISDIR: ' + target.path)
      return entry.text
    },
    async listDir(target) {
      const base = toComparable(target.path)
      const out = []
      for (const entry of entries) {
        const key = toComparable(entry.path)
        if (!key.startsWith(base + '/')) continue
        const rest = key.slice(base.length + 1)
        if (rest.includes('/')) continue
        out.push({ name: entry.path.split('/').pop(), type: entry.type })
      }
      return out
    },
    async writeText(target, content, expected, signal, policy) {
      const existing = find(target.path)
      writes.push({ path: target.path, content, policy })
      if (existing === undefined) entries.push({ path: target.path, type: 'file', text: content, mtime: 1 })
      else {
        existing.text = content
        existing.mtime++
      }
      return { operation: existing === undefined ? 'create' : 'update', version: 'v' + writes.length }
    },
    async editText(target, edit, expected, signal, policy) {
      const existing = find(target.path)
      if (existing === undefined) throw Object.assign(new Error('ENOENT: ' + target.path), { code: 'ENOENT' })
      writes.push({ path: target.path, policy })
      if (!existing.text.includes(edit.oldString)) {
        throw Object.assign(new Error('old_string not found'), { code: 'FS_EDIT_NOT_FOUND' })
      }
      existing.text = edit.replaceAll
        ? existing.text.split(edit.oldString).join(edit.newString)
        : existing.text.replace(edit.oldString, edit.newString)
      existing.mtime++
      return { version: 'e' + writes.length, before: edit.oldString, after: edit.newString }
    },
  }

  return {
    fs,
    writes,
    entries,
    textAt: (path) => find(path)?.text,
    setText: (path, text) => {
      const existing = find(path)
      if (existing === undefined) entries.push({ path: norm(path), type: 'file', text, mtime: 1 })
      else {
        existing.text = text
        existing.mtime++
      }
    },
  }
}

/** Boot the plugin against a fake kernel and return its handles. */
function boot({ files, standing = { mode: 'workspace-write', workspaceRoot: 'D:/ws' }, services = {} }) {
  const world = createFakeFs(files)
  const sections = []
  const events = new Map()
  const commands = new Map()
  const shellCalls = []
  const jobCalls = []
  let provided = null
  let remoteContribution = null

  const shell = {
    resolve: (spec) => spec,
    async execute(spec) {
      shellCalls.push(spec)
      return {
        status: 'exited',
        exitCode: 0,
        signal: null,
        kill() {},
        done: Promise.resolve(),
        readOutput: () => ({ delta: '' }),
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: { text: 'ran in ' + spec.workdir, truncated: false },
          stderr: { text: '' },
          sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
        }),
      }
    },
  }

  const registry = {
    fs: world.fs,
    sandboxPolicy: { resolve: () => ({ ...standing }) },
    systemPrompt: { section: (section) => sections.push(section) },
    shell,
    shellEnv: { collect: () => ({ DSH: '1' }) },
    jobs: {
      start(spec) {
        jobCalls.push(spec)
        return 'job-1'
      },
    },
    workspaceRegistry: {
      async create(path, title) {
        return { id: 'ws-1', path, title }
      },
    },
    directoryPicker: { capability: () => ({ kind: 'native', pick: async () => 'D:/picked' }) },
    ...services,
  }

  const ctx = {
    fs: registry.fs,
    sandboxPolicy: registry.sandboxPolicy,
    systemPrompt: registry.systemPrompt,
    on: (event, handler) => {
      if (!events.has(event)) events.set(event, [])
      events.get(event).push(handler)
      return () => {}
    },
    inject: (deps, callback) => {
      if (deps.includes('commands')) {
        callback({
          commands: {
            register: (definition) => {
              commands.set(definition.name, definition)
              return () => {}
            },
          },
        })
      }
      if (deps.includes('typert')) callback({ typert: { register: (contribution) => void (remoteContribution = contribution) } })
    },
    provide: (name, api) => void (provided = { name, api }),
    get: (name) => registry[name],
    emit: () => {},
    logger: { warn: () => {} },
  }

  apply(ctx)

  const emit = async (event, ...args) => {
    const handlers = events.get(event) ?? []
    const results = []
    for (const handler of handlers) results.push(await handler(...args))
    return results
  }

  return {
    world,
    sections,
    commands,
    shellCalls,
    jobCalls,
    registry,
    emit,
    api: provided?.api,
    providedName: provided?.name,
    remoteContribution,
    standing,
    /** Writes to a `.code-workspace` file (never the plugin's own store). */
    workspaceWrites: () => world.writes.filter((w) => String(w.path).toLowerCase().endsWith('.code-workspace')),
    runTool: async (exec) => emit('tools/execute', exec, async () => ({ isError: false, fellThrough: true })),
  }
}

const WORKSPACE = `{
\t// Kept by hand.
\t"folders": [
\t\t{ "path": "." },
\t\t{ "name": "Other", "path": "../other" }
\t],
\t"settings": { "editor.tabSize": 4 }
}
`

const BASE_FILES = [
  { path: 'D:/ws', type: 'directory' },
  { path: 'D:/ws/app.code-workspace', type: 'file', text: WORKSPACE },
  { path: 'D:/other', type: 'directory' },
  { path: 'D:/other/src', type: 'directory' },
  { path: 'D:/other/src/main.ts', type: 'file', text: 'export const x = 1\n' },
]

const agent = () => ({ id: 'session-1', session: { id: 'session-1', header: { cwd: 'D:/ws' } } })

// ------------------------------------------------------------------- tests

test('apply registers the prompt section, the command, the service and the remote contribution', () => {
  const b = boot({ files: BASE_FILES })
  assert.equal(b.sections.length, 1)
  assert.equal(b.sections[0].name, 'code-workspace:roots')
  assert.equal(b.sections[0].order, 165)
  assert.ok(b.commands.has('code-workspace'))
  assert.equal(b.providedName, 'codeWorkspace')
  assert.equal(b.api.typertRemote.namespace, 'codeWorkspace')
  assert.equal(b.api.typertRemote.serviceKey, 'codeWorkspace')
  assert.equal(b.remoteContribution.package, 'dsh-code-workspace')
  const methods = b.remoteContribution.invocations.map((i) => i.method)
  assert.deepEqual(methods, [
    'state', 'recent', 'forgetFile', 'open', 'forget', 'useFile', 'create',
    'addFolder', 'removeFolder', 'renameFolder', 'moveFolder',
    'browse', 'makeDir', 'pick', 'pickFile', 'reveal', 'editors', 'editorIcon',
    'openInEditor', 'listFiles',
  ])
  for (const invocation of b.remoteContribution.invocations) {
    assert.equal(invocation.service, 'codeWorkspace')
    assert.equal(invocation.invocation.kind, 'direct')
    assert.equal(invocation.result.mode, 'src-json')
  }
  const pick = b.remoteContribution.invocations.find((i) => i.method === 'pick')
  assert.deepEqual(pick.cancellation, { parameter: 'signal' })
})

test('a directory holding one .code-workspace file adopts it, and the prompt lists the folders', async () => {
  const b = boot({ files: BASE_FILES })
  await b.emit('agent/created', { agent: agent() })
  const text = b.sections[0].text({ agent: agent() })
  assert.match(text, /workspace file: D:\/ws\/app\.code-workspace/)
  assert.match(text, /primary working directory: D:\/ws/)
  assert.match(text, /Other — D:\/other/)
  assert.match(text, /\(primary\)/)
  assert.match(text, /ONE root/)
})

test('a directory with no workspace file leaves the plugin completely inert', async () => {
  const b = boot({
    files: [
      { path: 'D:/plain', type: 'directory' },
      { path: 'D:/plain/a.txt', type: 'file', text: 'hi' },
    ],
    standing: { mode: 'workspace-write', workspaceRoot: 'D:/plain' },
  })
  const exec = { name: 'write', arguments: { file_path: 'a.txt', content: 'x' }, agent: { id: 's', session: { id: 's', header: { cwd: 'D:/plain' } } } }
  const [result] = await b.runTool(exec)
  assert.equal(result.fellThrough, true)
  assert.equal(b.sections[0].text({ agent: { session: { header: { cwd: 'D:/plain' } } } }), '')
})

test('two candidate workspace files are ambiguous and adopt neither', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/a.code-workspace', type: 'file', text: '{ "folders": [] }' },
      { path: 'D:/ws/b.code-workspace', type: 'file', text: '{ "folders": [] }' },
    ],
  })
  await b.emit('agent/created', { agent: agent() })
  assert.equal(b.sections[0].text({ agent: agent() }), '')
})

test('write into an extra root is re-rooted at that folder', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'write',
    arguments: { file_path: 'D:/other/src/main.ts', content: 'export const x = 2\n' },
    agent: agent(),
    signal: undefined,
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, false)
  assert.equal(result.fellThrough, undefined)
  const written = b.world.writes.at(-1)
  assert.equal(written.path, 'D:/other/src/main.ts')
  assert.deepEqual(written.policy, { mode: 'workspace-write', workspaceRoot: 'D:/other' })
})

test('write inside the primary directory falls through to the default pipeline', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = { name: 'write', arguments: { file_path: 'D:/ws/new.txt', content: 'x' }, agent: agent() }
  const [result] = await b.runTool(exec)
  assert.equal(result.fellThrough, true)
  assert.equal(b.workspaceWrites().length, 0)
})

test('read-only mode is preserved on the re-rooted policy (never widened)', async () => {
  const b = boot({ files: BASE_FILES, standing: { mode: 'read-only', workspaceRoot: 'D:/ws' } })
  const exec = { name: 'write', arguments: { file_path: 'D:/other/x.txt', content: 'x' }, agent: agent() }
  await b.runTool(exec)
  assert.equal(b.world.writes.at(-1).policy.mode, 'read-only')
})

test('writing any .code-workspace file is refused, so the agent cannot widen its own roots', async () => {
  const b = boot({ files: BASE_FILES })
  for (const target of ['D:/ws/app.code-workspace', 'D:/other/evil.code-workspace']) {
    const exec = { name: 'write', arguments: { file_path: target, content: '{ "folders": [{ "path": "C:/" }] }' }, agent: agent() }
    const [result] = await b.runTool(exec)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /user-managed/)
  }
  assert.equal(b.workspaceWrites().length, 0)
})

test('editing the workspace file is refused as well', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'edit',
    arguments: { file_path: 'D:/ws/app.code-workspace', old_string: 'D:/other', new_string: 'C:/' },
    agent: agent(),
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, true)
})

test('edit inside an extra root is re-rooted', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'edit',
    arguments: { file_path: 'D:/other/src/main.ts', old_string: 'x = 1', new_string: 'x = 2' },
    agent: agent(),
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, false)
  assert.equal(b.world.textAt('D:/other/src/main.ts'), 'export const x = 2\n')
  assert.equal(b.world.writes.at(-1).policy.workspaceRoot, 'D:/other')
})

test('a failing edit in an extra root reports its own error, never the primary-root denial', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'edit',
    arguments: { file_path: 'D:/other/src/main.ts', old_string: 'not present', new_string: 'x' },
    agent: agent(),
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /old_string not found/)
  assert.doesNotMatch(result.content[0].text, /sandbox/)
})

test('a shell run whose absolute workdir is an extra root is re-rooted', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'pwsh',
    arguments: { command: 'npm test', workdir: 'D:/other/src' },
    agent: agent(),
    signal: undefined,
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, false)
  assert.equal(b.shellCalls.length, 1)
  assert.equal(b.shellCalls[0].workdir, 'D:/other/src')
  assert.equal(b.shellCalls[0].sandboxPolicy.workspaceRoot, 'D:/other')
  assert.deepEqual(b.shellCalls[0].dshEnv, { DSH: '1' })
  assert.match(result.content[0].text, /ran in D:\/other\/src/)
})

test('a RELATIVE workdir resolves against the primary root, so it is not re-rooted', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = { name: 'pwsh', arguments: { command: 'ls', workdir: 'sub' }, agent: agent() }
  const [result] = await b.runTool(exec)
  assert.equal(result.fellThrough, true)
  assert.equal(b.shellCalls.length, 0)
})

test('a background shell run in an extra root registers a job under the re-rooted policy', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'pwsh',
    arguments: { command: 'long build', workdir: 'D:/other', run_in_background: true },
    agent: agent(),
    signal: undefined,
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.isError, false)
  assert.equal(result.value.jobId, 'job-1')
  assert.equal(b.jobCalls.length, 1)
  assert.equal(b.jobCalls[0].kind, 'pwsh')
  assert.equal(b.jobCalls[0].owner, 'session-1')
  const hooks = b.jobCalls[0].run()
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(typeof hooks.readOutput, 'function')
  await hooks.done
  assert.equal(b.shellCalls.at(-1).sandboxPolicy.workspaceRoot, 'D:/other')
})

test('an escalation request is handed to the default pipeline, which owns the approval flow', async () => {
  const b = boot({ files: BASE_FILES })
  const exec = {
    name: 'write',
    arguments: { file_path: 'D:/other/x.txt', content: 'x', sandbox_permissions: 'danger-full-access' },
    agent: agent(),
  }
  const [result] = await b.runTool(exec)
  assert.equal(result.fellThrough, true)
})

test('the remote API reads state, edits folders, and preserves comments on write-back', async () => {
  const b = boot({ files: BASE_FILES })
  const state = await b.api.state('D:/ws')
  assert.equal(state.file, 'D:/ws/app.code-workspace')
  assert.equal(state.title, 'app')
  assert.deepEqual(state.roots.map((r) => r.label), ['ws', 'Other'])
  assert.deepEqual(state.extraRoots, ['D:/other'])
  assert.equal(state.roots[0].isPrimary, true)
  assert.equal(state.roots[0].relative, '.')

  const added = await b.api.addFolder('D:/ws', 'D:/other/src', 'Sources')
  assert.equal(added.changed, true)
  assert.equal(added.state.roots.length, 3)
  assert.deepEqual(added.state.roots[2].label, 'Sources')

  const text = b.world.textAt('D:/ws/app.code-workspace')
  assert.match(text, /\/\/ Kept by hand\./)
  assert.match(text, /"editor\.tabSize": 4/)
  assert.match(text, /"path": "\.\.\/other\/src"/)
  const reparsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
  assert.deepEqual(reparsed.folders, [{ path: '.' }, { name: 'Other', path: '../other' }, { name: 'Sources', path: '../other/src' }])

  const removed = await b.api.removeFolder('D:/ws', 'Other')
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.state.roots.map((r) => r.label), ['ws', 'Sources'])

  const again = await b.api.removeFolder('D:/ws', 'Other')
  assert.equal(again.changed, false)
})

test('adding an identical folder twice is idempotent', async () => {
  const b = boot({ files: BASE_FILES })
  const first = await b.api.addFolder('D:/ws', 'D:/other')
  assert.equal(first.changed, false)
  assert.equal(first.state.roots.length, 2)
})

test('adding a missing or non-directory path is rejected', async () => {
  const b = boot({ files: BASE_FILES })
  await assert.rejects(() => b.api.addFolder('D:/ws', 'D:/nope'), /does not exist/)
  await assert.rejects(() => b.api.addFolder('D:/ws', 'D:/other/src/main.ts'), /not a directory/)
})

test('renameFolder and moveFolder rewrite the file order', async () => {
  const b = boot({ files: BASE_FILES })
  const renamed = await b.api.renameFolder('D:/ws', 1, 'Docs')
  assert.equal(renamed.state.roots[1].label, 'Docs')
  const moved = await b.api.moveFolder('D:/ws', 1, 0)
  assert.deepEqual(moved.state.roots.map((r) => r.label), ['Docs', 'ws'])
})

test('open registers the container directory and records the file', async () => {
  const b = boot({
    files: [
      { path: 'D:/proj', type: 'directory' },
      { path: 'D:/proj/p.code-workspace', type: 'file', text: '{ "folders": [{ "path": "." }] }' },
    ],
  })
  const opened = await b.api.open('D:/proj/p.code-workspace')
  assert.equal(opened.file, 'D:/proj/p.code-workspace')
  assert.deepEqual(opened.workspace, { id: 'ws-1', path: 'D:/proj', title: 'p' })
  const recent = await b.api.recent()
  assert.deepEqual(recent.files.map((f) => f.file), ['D:/proj/p.code-workspace'])
})

test('open rejects a directory, a missing file and a non-workspace name', async () => {
  const b = boot({ files: BASE_FILES })
  await assert.rejects(() => b.api.open('D:/ws'), /not a .code-workspace file/)
  await assert.rejects(() => b.api.open('D:/ws/missing.code-workspace'), /does not exist/)
  await assert.rejects(() => b.api.open('D:/ws/app.json'), /not a .code-workspace file/)
})

test('a malformed workspace file is reported and grants no roots', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/broken.code-workspace', type: 'file', text: '{ "folders": [ }' },
    ],
  })
  const state = await b.api.state('D:/ws')
  assert.equal(state.exists, true)
  assert.deepEqual(state.roots, [])
  assert.match(state.error.message, /line/)
  const text = b.sections[0].text({ agent: agent() })
  // The prompt is only assembled from the cache, so hydrate first.
  await b.emit('agent/created', { agent: agent() })
  assert.match(b.sections[0].text({ agent: agent() }), /cannot be parsed/)
  void text
})

test('the remote API never writes the file when nothing changed', async () => {
  const b = boot({ files: BASE_FILES })
  await b.api.addFolder('D:/ws', 'D:/other')
  assert.equal(b.workspaceWrites().length, 0)
})

test('browse lists directories and .code-workspace files only', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/app.code-workspace', type: 'file', text: '{}' },
      { path: 'D:/ws/readme.md', type: 'file', text: 'x' },
      { path: 'D:/ws/src', type: 'directory' },
    ],
  })
  const listing = await b.api.browse('D:/ws')
  assert.deepEqual(listing.entries.map((e) => [e.name, e.kind]), [
    ['app.code-workspace', 'workspace-file'],
    ['src', 'directory'],
  ])
  assert.equal(listing.parent, 'D:/')
})

test('create makes a new workspace file containing the container directory', async () => {
  const b = boot({ files: [{ path: 'D:/fresh', type: 'directory' }] })
  const state = await b.api.create('D:/fresh', 'team')
  assert.equal(state.file, 'D:/fresh/team.code-workspace')
  assert.deepEqual(state.roots.map((r) => r.path), ['.'])
  const text = b.world.textAt('D:/fresh/team.code-workspace')
  assert.deepEqual(JSON.parse(text).folders, [{ path: '.' }])
})

test('create refuses an existing file and an embedded path', async () => {
  const b = boot({ files: [{ path: 'D:/fresh', type: 'directory' }] })
  await b.api.create('D:/fresh', 'team')
  await assert.rejects(() => b.api.create('D:/fresh', 'team'), /already exists/)
  await assert.rejects(() => b.api.create('D:/fresh', 'a/b'), /single name/)
})

test('listFiles yields the roots for an empty query and ranks a fragment', async () => {
  const b = boot({ files: BASE_FILES })
  const entryPoints = await b.api.listFiles('D:/ws', '')
  assert.deepEqual(entryPoints.candidates.map((c) => c.rootLabel), ['ws', 'Other'])
  assert.equal(entryPoints.candidates[0].level, true)

  const ranked = await b.api.listFiles('D:/ws', 'main')
  assert.deepEqual(ranked.candidates.map((c) => c.rel), ['src/main.ts'])
  assert.equal(ranked.candidates[0].rootLabel, 'Other')
  assert.equal(ranked.candidates[0].path, 'D:/other/src/main.ts')
  assert.equal(ranked.candidates[0].dir, false)
})

test('listFiles lists a level by root label and by absolute path', async () => {
  const b = boot({ files: BASE_FILES })
  const byLabel = await b.api.listFiles('D:/ws', 'Other/src/')
  assert.deepEqual(byLabel.candidates.map((c) => c.rel), ['src/main.ts'])
  const byAbsolute = await b.api.listFiles('D:/ws', 'D:/other/src/')
  assert.deepEqual(byAbsolute.candidates.map((c) => c.rel), ['src/main.ts'])
})

test('listFiles refuses a .. escape', async () => {
  const b = boot({ files: BASE_FILES })
  const escaped = await b.api.listFiles('D:/ws', 'Other/../../etc/')
  assert.deepEqual(escaped.candidates, [])
  const absoluteEscape = await b.api.listFiles('D:/ws', 'C:/Windows/')
  assert.deepEqual(absoluteEscape.candidates, [])
})

test('hidden entries are indexed but invisible to a global query', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/app.code-workspace', type: 'file', text: '{ "folders": [{ "path": "sub" }] }' },
      { path: 'D:/ws/sub', type: 'directory' },
      { path: 'D:/ws/sub/.hidden.ts', type: 'file', text: 'x' },
      { path: 'D:/ws/sub/shown.ts', type: 'file', text: 'x' },
      { path: 'D:/ws/sub/node_modules', type: 'directory' },
      { path: 'D:/ws/sub/node_modules/pkg.ts', type: 'file', text: 'x' },
    ],
  })
  const global = await b.api.listFiles('D:/ws', 'ts')
  assert.deepEqual(global.candidates.map((c) => c.rel), ['shown.ts'])
  const explicit = await b.api.listFiles('D:/ws', '.hidden')
  assert.deepEqual(explicit.candidates.map((c) => c.rel), ['.hidden.ts'])
})

test('the command lists, adds and removes folders and arms a notice on change', async () => {
  const b = boot({ files: BASE_FILES })
  const command = b.commands.get('code-workspace')
  const invocation = { agent: agent(), rawInput: '' }
  const listed = await command.handler(invocation)
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /Workspace file: D:\/ws\/app\.code-workspace/)
  assert.match(listed.text, /\[CWS:JSON\]/)

  const added = await command.handler({ agent: agent(), rawInput: 'add D:/other/src' })
  assert.equal(added.kind, 'success')
  assert.match(added.text, /src/)

  const bad = await command.handler({ agent: agent(), rawInput: 'nope' })
  assert.equal(bad.kind, 'error')

  // The notice is consumed at the next message boundary.
  const [decision] = await b.emit('agent/pre-step', { agent: agent() }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, 'plugin:dsh-code-workspace')
  assert.equal(decision.messages[0].source.form, 'notice')

  // ...and only once.
  const [second] = await b.emit('agent/pre-step', { agent: agent() }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(second.messages.length, 0)
})

test('the command reports an unknown subcommand and a missing workspace file', async () => {
  const b = boot({ files: [{ path: 'D:/plain', type: 'directory' }], standing: { mode: 'workspace-write', workspaceRoot: 'D:/plain' } })
  const command = b.commands.get('code-workspace')
  const plain = { agent: { id: 's', session: { id: 's', header: { cwd: 'D:/plain' } } }, rawInput: 'list' }
  const listed = await command.handler(plain)
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /No \.code-workspace file/)
  const added = await command.handler({ ...plain, rawInput: 'add D:/plain' })
  assert.equal(added.kind, 'error')
  assert.match(added.text, /no \.code-workspace file is associated/)
})

test('a user edit of the workspace file is picked up after the model TTL', async () => {
  const b = boot({ files: BASE_FILES })
  await b.emit('agent/created', { agent: agent() })
  assert.equal(b.sections[0].text({ agent: agent() }).includes('D:/other/src'), false)
  b.world.setText('D:/ws/app.code-workspace', '{ "folders": [{ "path": "." }, { "path": "../other/src" }] }')
  // The cache is bounded by time, not by stat metadata; force a fresh read the
  // way the panel does.
  const state = await b.api.state('D:/ws')
  assert.deepEqual(state.roots.map((r) => r.resolvedPath), ['D:/ws', 'D:/other/src'])
})

test('useFile re-points a directory at another workspace file, and forget clears it', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/a.code-workspace', type: 'file', text: '{ "folders": [{ "path": "." }] }' },
      { path: 'D:/ws/b.code-workspace', type: 'file', text: '{ "folders": [{ "path": "../other" }] }' },
      { path: 'D:/other', type: 'directory' },
    ],
  })
  const opened = await b.api.useFile('D:/ws', 'D:/ws/b.code-workspace')
  assert.equal(opened.file, 'D:/ws/b.code-workspace')
  assert.deepEqual(opened.extraRoots, ['D:/other'])
  const forgotten = await b.api.forget('D:/ws')
  assert.equal(forgotten.file, null)
})

test('`/code-workspace use` with no argument clears the association on the command channel too', async () => {
  const b = boot({
    files: [
      { path: 'D:/ws', type: 'directory' },
      { path: 'D:/ws/a.code-workspace', type: 'file', text: '{ "folders": [{ "path": "." }] }' },
    ],
  })
  const command = b.commands.get('code-workspace')
  const listed = await command.handler({ agent: agent(), rawInput: 'list' })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /a\.code-workspace/)

  // The panel sends this exact line for its "unlink" action.
  const unlinked = await command.handler({ agent: agent(), rawInput: 'use ""' })
  assert.equal(unlinked.kind, 'success')
  assert.match(unlinked.text, /No \.code-workspace file/)

  // An explicit path attaches one again.
  const linked = await command.handler({ agent: agent(), rawInput: 'use "D:/ws/a.code-workspace"' })
  assert.equal(linked.kind, 'success')
  assert.match(linked.text, /a\.code-workspace/)
})

test('reveal opens the containing directory of a file', async () => {
  const b = boot({ files: BASE_FILES })
  const result = await b.api.reveal('D:/other/src/main.ts')
  assert.equal(result.path, 'D:/other/src')
  await assert.rejects(() => b.api.reveal('D:/nope'), /does not exist/)
})

test('makeDir creates exactly one segment and refuses traversal', async () => {
  // `coreMakeDir` uses the real `mkdir`, so this one runs against a real
  // temporary directory rather than the fake seam.
  const base = await mkdtemp(join(tmpdir(), 'dsh-cws-mkdir-'))
  try {
    const b = boot({ files: [{ path: normalizeSpelling(base), type: 'directory' }] })
    const created = await b.api.makeDir(normalizeSpelling(base), 'sub')
    assert.equal(created.path, normalizeSpelling(join(base, 'sub')))
    assert.equal((await stat(join(base, 'sub'))).isDirectory(), true)
    await assert.rejects(() => b.api.makeDir(normalizeSpelling(base), '../evil'), /single path segment/)
    await assert.rejects(() => b.api.makeDir(normalizeSpelling(base), 'sub'), /already exists/)
    await mkdir(join(base, 'nested', 'deep'), { recursive: true })
    await assert.rejects(() => b.api.makeDir(normalizeSpelling(base), 'nested/deep'), /single path segment/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('the pick API reports unavailability instead of opening a host dialog', async () => {
  const b = boot({ files: BASE_FILES, services: { directoryPicker: undefined } })
  assert.deepEqual(await b.api.pick('D:/ws'), { path: null, via: 'unavailable' })
})

// ------------------------------------------------------- open in an editor
// The family resolution itself is covered offline in `editor.test.mjs` against an
// injected registry, PATH and file set. What is asserted here is the host's own
// contract: the envelope the panel and the menu read, and the guards that must
// hold on EVERY machine, before any editor is looked for.

test('the editors endpoint reports the family envelope the panel and the menu read', async () => {
  const b = boot({ files: BASE_FILES })
  const value = await b.api.editors()
  assert.equal(value.platform, process.platform)
  assert.equal(typeof value.ssh, 'boolean')
  assert.ok(Array.isArray(value.editors))
  if (value.editors.length === 0) {
    assert.equal(value.preferred, null)
  } else {
    assert.equal(value.preferred, value.editors[0].id)
    assert.equal(new Set(value.editors.map((entry) => entry.id)).size, value.editors.length)
  }
  for (const editor of value.editors) {
    assert.equal(typeof editor.id, 'string')
    assert.equal(typeof editor.label, 'string')
    assert.equal(typeof editor.executable, 'string')
    assert.equal(typeof editor.source, 'string')
  }
})

test('an icon request may only name a family member this host actually detected', async () => {
  const b = boot({ files: BASE_FILES })
  await assert.rejects(() => b.api.editorIcon('not-an-editor'), /unknown editor/)
  await assert.rejects(() => b.api.editorIcon(undefined), /unknown editor/)
  const detected = (await b.api.editors()).editors
  if (detected.length === 0) return
  const value = await b.api.editorIcon(detected[0].id)
  assert.equal(value.id, detected[0].id)
  assert.ok(value.dataUrl === null || value.dataUrl.startsWith('data:image/png;base64,'))
})

test('a session reached over SSH refuses to open an editor before it looks for one', async () => {
  const b = boot({ files: BASE_FILES })
  const previous = process.env.SSH_CONNECTION
  process.env.SSH_CONNECTION = '10.0.0.1 22 10.0.0.2 51000'
  try {
    // The refusal is checked first, so it holds whatever this machine has
    // installed — including nothing.
    await assert.rejects(() => b.api.openInEditor('D:/ws', 'vscode'), /SSH/)
    const value = await b.api.editors()
    assert.equal(value.ssh, true)
    assert.deepEqual(value.editors, [], 'an SSH session has no desktop to open an editor on')
  } finally {
    if (previous === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = previous
  }
})

test('an editor id this host does not have is refused, never launched', async () => {
  const b = boot({ files: BASE_FILES })
  const detected = (await b.api.editors()).editors
  const absent = ['vscode', 'vscodeinsiders', 'vscodium', 'cursor', 'windsurf', 'trae'].find(
    (id) => !detected.some((entry) => entry.id === id),
  )
  if (absent === undefined) return
  await assert.rejects(() => b.api.openInEditor('D:/ws', absent), /no VS Code family editor|is not available/)
})

test('opening in an editor refuses a directory that does not exist', async () => {
  const b = boot({ files: BASE_FILES })
  // Only reachable when this host has an editor at all; the guard order is what
  // is being pinned, and it must not depend on the machine's installs.
  const detected = (await b.api.editors()).editors
  if (detected.length === 0) return
  await assert.rejects(() => b.api.openInEditor('D:/nowhere-here', detected[0].id), /does not exist/)
})
