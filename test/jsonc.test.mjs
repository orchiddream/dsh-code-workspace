import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  JsoncSyntaxError,
  REMOVE,
  detectIndent,
  parseDocument,
  parseJsonc,
  patchDocument,
  stringifyDocument,
} from '../lib/jsonc.js'

/** The real-world fixture: a Trae/VS Code workspace file, tab-indented. */
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

test('parses plain JSON', () => {
  assert.deepEqual(parseJsonc('{"a":1,"b":[true,false,null]}'), { a: 1, b: [true, false, null] })
})

test('parses line comments, block comments and trailing commas', () => {
  const text = `{
  // a leading note
  "folders": [
    { "path": "a" }, /* inline */
    { "path": "b" },
  ],
  "settings": { "x": 1, },
}`
  assert.deepEqual(parseJsonc(text), { folders: [{ path: 'a' }, { path: 'b' }], settings: { x: 1 } })
})

test('a comment-like sequence inside a string is not a comment', () => {
  assert.deepEqual(parseJsonc('{"url":"https://example.com/a/*b*/c"}'), { url: 'https://example.com/a/*b*/c' })
})

test('tolerates a BOM', () => {
  assert.deepEqual(parseJsonc('\ufeff{"a":1}'), { a: 1 })
})

test('escapes round-trip', () => {
  const value = { p: 'a\\b"c\nd\te\u00e9' }
  assert.deepEqual(parseJsonc(JSON.stringify(value)), value)
})

test('reports line and column on malformed input', () => {
  let error
  try {
    parseJsonc('{\n  "a": 1,\n  "b": ,\n}')
  } catch (e) {
    error = e
  }
  assert.ok(error instanceof JsoncSyntaxError)
  assert.equal(error.line, 3)
  assert.match(error.message, /line 3/)
})

test('rejects unterminated strings and comments', () => {
  assert.throws(() => parseJsonc('{"a":"unterminated'), JsoncSyntaxError)
  assert.throws(() => parseJsonc('{"a":1} /* nope'), JsoncSyntaxError)
})

test('rejects trailing content', () => {
  assert.throws(() => parseJsonc('{"a":1} garbage'), JsoncSyntaxError)
})

test('parseJsonc reads any JSONC value; parseDocument requires an object root', () => {
  assert.deepEqual(parseJsonc('[1,2]'), [1, 2])
  assert.throws(() => parseDocument('[1,2]'), JsoncSyntaxError)
  assert.throws(() => parseDocument('"a string"'), JsoncSyntaxError)
})

test('detects the indentation style', () => {
  assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t')
  assert.equal(detectIndent('{\n  "a": 1\n}'), '  ')
  assert.equal(detectIndent('{\n    "a": {\n        "b": 1\n    }\n}'), '    ')
  assert.equal(detectIndent('{}'), '  ')
})

test('parseDocument exposes top-level member ranges', () => {
  const { value, members, indent } = parseDocument(SAMPLE)
  assert.equal(indent, '\t')
  assert.equal(value.folders.length, 3)
  assert.ok(members.has('folders'))
  assert.ok(members.has('trae'))
  const folders = members.get('folders')
  assert.equal(SAMPLE.slice(folders.keyStart, folders.keyEnd), '"folders"')
  assert.equal(SAMPLE[folders.valueStart], '[')
  assert.equal(SAMPLE[folders.valueEnd - 1], ']')
})

test('replacing a member preserves comments, order and formatting', () => {
  const text = `{
\t// Which folders are open in this window.
\t"folders": [
\t\t{ "path": "a" }
\t],
\t// Kept verbatim.
\t"settings": { "editor.tabSize": 4 }
}
`
  const next = patchDocument(text, 'folders', [{ path: 'a' }, { name: 'B', path: '../b' }])
  const parsed = parseJsonc(next)
  assert.deepEqual(parsed.folders, [{ path: 'a' }, { name: 'B', path: '../b' }])
  assert.match(next, /\/\/ Which folders are open in this window\./)
  assert.match(next, /\/\/ Kept verbatim\./)
  assert.match(next, /"editor\.tabSize": 4/)
  // The untouched tail is byte-identical.
  assert.ok(next.endsWith('\t// Kept verbatim.\n\t"settings": { "editor.tabSize": 4 }\n}\n'))
  // Indentation of the inserted array follows the member's own indent.
  assert.match(next, /\n\t"folders": \[\n\t\t\{\n\t\t\t"path": "a"\n\t\t\},/)
})

test('replaced text is stable under a second identical patch', () => {
  const once = patchDocument(SAMPLE, 'folders', [{ path: 'only' }])
  const twice = patchDocument(once, 'folders', [{ path: 'only' }])
  assert.equal(once, twice)
})

test('appending a member adds a separating comma to the previous last member', () => {
  const text = '{\n\t"folders": []\n}\n'
  const next = patchDocument(text, 'settings', { 'a.b': 1 })
  assert.deepEqual(parseJsonc(next), { folders: [], settings: { 'a.b': 1 } })
  assert.match(next, /"folders": \[\],/)
  assert.ok(next.endsWith('\n}\n'))
})

test('appending into an empty object', () => {
  const next = patchDocument('{}\n', 'folders', [{ path: 'a' }])
  assert.deepEqual(parseJsonc(next), { folders: [{ path: 'a' }] })
})

test('appending into an object whose last member has a trailing comma', () => {
  const text = '{\n\t"folders": [],\n}\n'
  const next = patchDocument(text, 'settings', {})
  assert.deepEqual(parseJsonc(next), { folders: [], settings: {} })
  assert.equal(next, '{\n\t"folders": [],\n\t"settings": {}\n}\n')
})

test('appending keeps a trailing comment that sits above the closing brace', () => {
  const text = '{\n\t"folders": [],\n\t// keep me\n}\n'
  const next = patchDocument(text, 'settings', {})
  assert.deepEqual(parseJsonc(next), { folders: [], settings: {} })
  assert.match(next, /\t\/\/ keep me\n/)
  assert.ok(next.endsWith('\t"settings": {}\n}\n'))
})

test('removing a middle member drops its comma line', () => {
  const text = `{
\t"folders": [],
\t"settings": {},
\t"trae": { "workspaceId": "x" }
}
`
  const next = patchDocument(text, 'settings', REMOVE)
  assert.deepEqual(parseJsonc(next), { folders: [], trae: { workspaceId: 'x' } })
  assert.ok(!next.includes('settings'))
})

test('removing the last member drops the preceding comma', () => {
  const text = '{\n\t"folders": [],\n\t"trae": {}\n}\n'
  const next = patchDocument(text, 'trae', REMOVE)
  assert.deepEqual(parseJsonc(next), { folders: [] })
  assert.equal(next, '{\n\t"folders": []\n}\n')
})

test('removing an absent member is a no-op', () => {
  assert.equal(patchDocument(SAMPLE, 'tasks', REMOVE), SAMPLE)
})

test('a BOM survives every patch path', () => {
  const bom = '\ufeff'
  assert.ok(patchDocument(bom + SAMPLE, 'folders', [{ path: 'a' }]).startsWith(bom))
  assert.ok(patchDocument(bom + '{\n\t"a": 1\n}\n', 'b', 2).startsWith(bom))
  assert.ok(patchDocument(bom + '{\n\t"a": 1,\n\t"b": 2\n}\n', 'a', REMOVE).startsWith(bom))
})

test('CRLF line endings are not rewritten outside the patched range', () => {
  const text = '{\r\n\t"folders": [],\r\n\t"settings": {}\r\n}\r\n'
  const next = patchDocument(text, 'folders', [{ path: 'a' }])
  assert.ok(next.includes('\r\n\t"settings": {}\r\n}\r\n'))
  assert.deepEqual(parseJsonc(next).folders, [{ path: 'a' }])
})

test('patchDocument rejects a non-serialisable value', () => {
  assert.throws(() => patchDocument('{}\n', 'folders', undefined), TypeError)
})

test('stringifyDocument emits a trailing newline and tabs', () => {
  assert.equal(stringifyDocument({ folders: [] }), '{\n\t"folders": []\n}\n')
})

test('patchDocument reports malformed input instead of corrupting it', () => {
  assert.throws(() => patchDocument('{ "folders": [ }', 'folders', []), JsoncSyntaxError)
})
