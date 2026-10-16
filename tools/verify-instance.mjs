/**
 * Live verification against a booted throwaway DSH profile.
 *
 * Usage: node tools/verify-instance.mjs <url-with-token>
 *
 * A successful profile boot only proves the composition composed. This script
 * proves the three things that actually matter for the plugin:
 *
 *   1. the client bundle is part of the boot graph the index injects;
 *   2. the served bundle really is this package's factory (right id, right
 *      exports, and both the `@` source and the "Open In…" takeover present),
 *      which is what makes the client half load in a browser;
 *   3. the sessionless `/api` route answers `codeWorkspace/*`, which is the only
 *      transport the session-creation page has — including the editor family and
 *      the two refusals (an unknown icon id, an unknown editor) that must hold on
 *      every machine.
 *
 * Nothing here launches an editor: the two editor calls it makes are refusals by
 * construction, so running this against a live Harness cannot open a window.
 *
 * The index fence is a launch-token → signed-cookie exchange, and `fetch`
 * follows the 303 without keeping the cookie, so the redirect is handled
 * manually on purpose.
 */

const url = process.argv[2]
if (!url) {
  console.error('usage: node tools/verify-instance.mjs <url-with-token>')
  process.exit(2)
}

const base = new URL(url)
const token = base.searchParams.get('token')
const origin = base.origin

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''))
}

// 0. exchange the launch token for the signed browser cookie -----------------
const indexResponse = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
const setCookie = indexResponse.headers.get('set-cookie')
record('GET /?token=… redirects with a session cookie', indexResponse.status === 303 && Boolean(setCookie), 'status ' + indexResponse.status)

const cookie = setCookie ? setCookie.split(';')[0] : ''
const authed = { cookie, accept: 'text/html' }

// 1. the authenticated index ------------------------------------------------
let html = ''
if (cookie) {
  const authedIndex = await fetch(origin + '/', { headers: authed, redirect: 'manual' })
  html = await authedIndex.text()
  record('GET / serves the index with the cookie', authedIndex.ok && /<html/i.test(html), 'status ' + authedIndex.status + ', ' + html.length + ' bytes')
}

// 2. the client bundle is injected and is this package's factory -------------
// The shell injects one combined `plugins/??a/client.js,b/client.js` URL, so the
// membership test is on the module specifier inside it, not on a `.js` path that
// happens to contain the id.
record('the index injects the plugin client module', html.includes('dsh-code-workspace/client.js'), 'looking for dsh-code-workspace/client.js')

const scriptTag = /(?:src|href)="([^"]*dsh-code-workspace\/client\.js[^"]*)"/.exec(html)
if (scriptTag) {
  // The HTML attribute is entity-encoded; `&amp;` must become `&` before use.
  const src = scriptTag[1].replace(/&amp;/g, '&')
  const bundleResponse = await fetch(new URL(src, origin), { headers: { cookie } })
  const code = await bundleResponse.text()
  record('GET the combined client bundle', bundleResponse.ok, 'status ' + bundleResponse.status + ', ' + code.length + ' bytes')
  record("the served bundle registers id 'dsh-code-workspace'", /id:\s*['"]dsh-code-workspace['"]/.test(code) && /__ModuleLoader__/.test(code))
  record(
    'the served bundle carries all three slot surfaces',
    code.includes('conversation.input.dock') && code.includes('conversation.session.header.actions') && code.includes('shell.overlay'),
  )
  record('the served bundle carries the @ companion source', code.includes('registerSource') && code.includes('codeWorkspace/listFiles'))
  record(
    'the served bundle carries the Open In… takeover on both shipped cells',
    code.includes('conversation.session.header.utilities') && code.includes('sidebar.right.tab.files.actions') && code.includes('open-in-app') && code.includes('MENU_PRIORITY'),
    'the priority VALUE is pinned by test/client.test.mjs; this only proves the takeover shipped',
  )
} else {
  record('the index exposes a fetchable client bundle url', false, 'no script src matched')
}

// 3. the sessionless remote endpoint answers --------------------------------
async function rpc(endpoint, args, rpcId) {
  const response = await fetch(origin + '/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  // The wire envelope is `{ type, rpcId, result: { ok, value | error } }`; the
  // browser-side `connection.rpc.call` unwraps `result` before the plugin sees it.
  const result = parsed && parsed.result
  return { status: response.status, text, result, ok: Boolean(result && result.ok === true), value: result && result.value }
}

const recent = await rpc('codeWorkspace/recent', {}, 'verify-recent')
record('POST /api/codeWorkspace/recent is routed', recent.status === 200, 'status ' + recent.status)
record('recent answers with the plugin\'s own shape', recent.ok && Array.isArray(recent.value.files), recent.text.slice(0, 200))

// 3b. the editor family, and the two refusals that must hold on every machine --
const editors = await rpc('codeWorkspace/editors', {}, 'verify-editors')
record('POST /api/codeWorkspace/editors is routed', editors.status === 200, 'status ' + editors.status)
record(
  'editors answers the envelope the panel and the menu read',
  editors.ok && Array.isArray(editors.value.editors) && typeof editors.value.ssh === 'boolean' && typeof editors.value.platform === 'string',
  editors.ok ? JSON.stringify({ count: editors.value.editors.length, preferred: editors.value.preferred, ssh: editors.value.ssh }) : editors.text.slice(0, 200),
)

const badIcon = await rpc('codeWorkspace/editorIcon', { id: 'not-an-editor' }, 'verify-icon-refused')
record(
  'editorIcon refuses an id that is not a family member',
  badIcon.ok === false && /unknown editor/.test(badIcon.text),
  badIcon.text.slice(0, 200),
)

const badOpen = await rpc('codeWorkspace/openInEditor', { rootDir: 'D:/kjsjs/deepseek', editorId: 'not-an-editor' }, 'verify-open-refused')
record(
  'openInEditor refuses an unknown editor instead of launching anything',
  badOpen.ok === false && /no VS Code family editor|is not available/.test(badOpen.text),
  badOpen.text.slice(0, 200),
)

const state = await rpc('codeWorkspace/state', { rootDir: 'D:/kjsjs/deepseek' }, 'verify-state')
record('POST /api/codeWorkspace/state is routed', state.status === 200, 'status ' + state.status)
record(
  'state resolves the real sample workspace file',
  state.ok && /dsh-nl\.code-workspace$/.test(String(state.value.file)),
  state.ok ? String(state.value.file) : state.text.slice(0, 300),
)
record(
  'state reports the sample file three folders',
  state.ok && Array.isArray(state.value.roots) && state.value.roots.length === 3,
  state.ok ? JSON.stringify(state.value.roots.map((root) => root.resolvedPath)) : '',
)
record(
  'no folder resolves to the container directory, so every root needs re-rooting',
  state.ok && state.value.roots.every((root) => root.isPrimary === false) && state.value.extraRoots.length === 3,
  state.ok ? 'extraRoots=' + JSON.stringify(state.value.extraRoots) : '',
)

const browse = await rpc('codeWorkspace/browse', { path: 'D:/kjsjs/deepseek' }, 'verify-browse')
record(
  'browse lists the sample .code-workspace file',
  browse.ok && browse.value.entries.some((entry) => entry.name === 'dsh-nl.code-workspace' && entry.kind === 'workspace-file'),
  browse.text.slice(0, 200),
)

const files = await rpc('codeWorkspace/listFiles', { rootDir: 'D:/kjsjs/deepseek', query: '' }, 'verify-files')
record(
  'listFiles yields the workspace roots as entry points',
  files.ok && files.value.candidates.length === 3,
  files.text.slice(0, 200),
)

const ranked = await rpc('codeWorkspace/listFiles', { rootDir: 'D:/kjsjs/deepseek', query: 'package' }, 'verify-ranked')
record(
  'listFiles ranks a real fragment across the roots',
  ranked.ok && ranked.value.candidates.length > 0,
  ranked.ok ? JSON.stringify(ranked.value.candidates.slice(0, 3).map((candidate) => candidate.rel)) : ranked.text.slice(0, 200),
)

// 4. a real folders write-back through the sandboxed fs seam ----------------
// This is the path that matters most: `fs.writeText` under an explicit
// `workspace-write` policy, with a comment-preserving rewrite of just the
// `folders` member. It runs against a throwaway directory and cleans up.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchBase = await mkdtemp(join(tmpdir(), 'dsh-cws-live-'))
const rootDir = join(scratchBase, 'ws').replace(/\\/g, '/')
await mkdir(join(rootDir, 'a'), { recursive: true })
await mkdir(join(rootDir, 'b'), { recursive: true })

try {
  const HANDWRITTEN = `{
\t// kept by hand
\t"folders": [
\t\t{ "path": "." }
\t],
\t"settings": { "editor.tabSize": 4 }
}
`
  const file = join(rootDir, 'team.code-workspace').replace(/\\/g, '/')
  await writeFile(file, HANDWRITTEN, 'utf8')

  const sameDir = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()
  const opened = await rpc('codeWorkspace/open', { file }, 'verify-open')
  record(
    // This file declares `{ "path": "." }`, so the root it DERIVES is the
    // directory the file lives in — that is what makes this a one-line check
    // rather than one that has to move the scratch file somewhere else.
    'open registers the root the file derives as a DSH workspace',
    opened.ok && opened.value.workspace && sameDir(opened.value.workspace.path, rootDir),
    opened.ok ? JSON.stringify(opened.value.workspace) : opened.text.slice(0, 300),
  )
  record('open returns the folders the file declares', opened.ok && opened.value.roots.length === 1 && opened.value.roots[0].path === '.')

  const added = await rpc('codeWorkspace/addFolder', { rootDir, path: join(rootDir, 'b').replace(/\\/g, '/'), name: 'Bee' }, 'verify-add')
  record('addFolder rewrites the file through the sandboxed fs seam', added.ok && added.value.changed === true, added.ok ? JSON.stringify(added.value.state.roots.map((root) => root.path)) : added.text.slice(0, 300))

  const afterAdd = await readFile(file, 'utf8')
  record('the write-back kept the hand-written comment', afterAdd.includes('// kept by hand'))
  record('the write-back kept the untouched settings member', afterAdd.includes('"editor.tabSize": 4'))
  record('the write-back appended the new folder with a display name', /"name":\s*"Bee"/.test(afterAdd) && /"path":\s*"b"/.test(afterAdd))

  const removed = await rpc('codeWorkspace/removeFolder', { rootDir, address: 'Bee' }, 'verify-remove')
  record('removeFolder addresses a folder by its display name', removed.ok && removed.value.changed === true, removed.ok ? JSON.stringify(removed.value.state.roots.map((root) => root.path)) : removed.text.slice(0, 300))

  const afterRemove = await readFile(file, 'utf8')
  record('the removal left the file parseable and comment-bearing', afterRemove.includes('// kept by hand') && JSON.parse(afterRemove.replace(/^\s*\/\/.*$/gm, '')).folders.length === 1)

  const missing = await rpc('codeWorkspace/addFolder', { rootDir, path: join(rootDir, 'nope').replace(/\\/g, '/') }, 'verify-missing')
  record('adding a missing directory is refused with a readable message', missing.ok === false && /does not exist/.test(missing.text), missing.text.slice(0, 200))
} finally {
  // The scratch directory is about to disappear, but `open` recorded its file in
  // the profile's workspace store — a real, persistent write. Drop the record too,
  // or the run leaves a permanent "missing" entry in the user's workspace list
  // (which is how one got there in the first place).
  await rpc('codeWorkspace/forgetFile', { file: join(scratchBase, 'ws', 'team.code-workspace').replace(/\\/g, '/') }, 'verify-cleanup').catch(() => undefined)
  await rm(scratchBase, { recursive: true, force: true })
}

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
