/**
 * The vendored code-viewer route.
 *
 * These tests exercise the answer the named route gives for a request, without
 * a web server: the same `monacoAssetResponse` the Host registers. They pin the
 * security contract (only vendored files, only known media types, no traversal)
 * and the fact that the four shipped assets are actually present, so a missing
 * vendored file fails here instead of leaving the browser pane blank.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

import { monacoAssetResponse } from '../lib/index.js'

const MONACO_DIR = resolve(fileURLToPath(new URL('../lib/vendor/monaco/', import.meta.url)))

/** Build the request one browser GET produces for a path under the route. */
const request = (path) => new Request('http://127.0.0.1:61832' + path)

test('serves every vendored asset with its media type and exact bytes', async () => {
  const expected = [
    ['/code-workspace-assets/monaco.js', 'text/javascript; charset=utf-8', 'monaco.js'],
    ['/code-workspace-assets/monaco.worker.js', 'text/javascript; charset=utf-8', 'monaco.worker.js'],
    ['/code-workspace-assets/monaco.css', 'text/css; charset=utf-8', 'monaco.css'],
    ['/code-workspace-assets/codicon-37A3DWZT.ttf', 'font/ttf', 'codicon-37A3DWZT.ttf'],
  ]
  for (const [path, type, file] of expected) {
    const response = await monacoAssetResponse(request(path))
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), type, path)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path)
    assert.match(response.headers.get('cache-control') ?? '', /max-age=86400/u, path)
    const body = new Uint8Array(await response.arrayBuffer())
    const onDisk = await readFile(join(MONACO_DIR, file))
    assert.equal(body.length, onDisk.length, path)
    assert.deepEqual(body, new Uint8Array(onDisk), path)
  }
})

test('the vendored build is present and non-trivial', async () => {
  const bundle = await stat(join(MONACO_DIR, 'monaco.js'))
  assert.ok(bundle.size > 1_000_000, `monaco.js is ${String(bundle.size)} bytes`)
  const worker = await stat(join(MONACO_DIR, 'monaco.worker.js'))
  assert.ok(worker.size > 10_000, `monaco.worker.js is ${String(worker.size)} bytes`)
})

test('refuses a path outside the vendor directory', async () => {
  const paths = [
    '/code-workspace-assets/../index.js',
    '/code-workspace-assets/%2e%2e/index.js',
    '/code-workspace-assets/%2E%2E%2Findex.js',
    '/code-workspace-assets/..%5cindex.js',
    '/code-workspace-assets/../../package.json',
  ]
  for (const path of paths) {
    const response = await monacoAssetResponse(request(path))
    assert.equal(response.status, 404, path)
  }
})

test('refuses a directory, an empty name, and an unknown extension', async () => {
  for (const path of [
    '/code-workspace-assets',
    '/code-workspace-assets/',
    '/code-workspace-assets/dir',
    '/code-workspace-assets/evil.exe',
    '/code-workspace-assets/package.json',
    '/code-workspace-assets/missing.js',
  ]) {
    const response = await monacoAssetResponse(request(path))
    assert.equal(response.status, 404, path)
  }
})

test('answers a malformed escape as a bad request', async () => {
  const response = await monacoAssetResponse(request('/code-workspace-assets/%ZZ.js'))
  assert.equal(response.status, 400)
})
