#!/usr/bin/env node
/**
 * Read the packed `resources/app.asar` of the DSH desktop application.
 *
 * The desktop app ships its own DSH runtime **inside** `app.asar`, and that
 * runtime is not necessarily the version installed from npm (on this machine the
 * app carries `0.2.2-rc.5` while the global CLI is `0.2.0-rc.2`). Plugin
 * contracts quoted in `docs/` must come from the app's own sources, so this tool
 * reads the archive directly: no dependency, no extraction step, works on the
 * live installation.
 *
 * It also follows pnpm-style `link` entries, so a package that appears as a
 * symlink in the archive (for example `@deepseek-ai/dsh`'s dependencies) still
 * resolves.
 *
 * Usage:
 *   node tools/asar-peek.mjs list <app.asar> <innerPrefix> [limit]
 *   node tools/asar-peek.mjs get  <app.asar> <innerPath>              # file bytes to stdout
 *   node tools/asar-peek.mjs dump <app.asar> <innerPrefix> <outDir>   # extract a subtree
 *   node tools/asar-peek.mjs find <app.asar> <regex> [limit]          # paths matching a regex
 *
 * Typical session (read the shipped sidebar-right contract of the app):
 *   ASAR="D:/AI/DeepSeek Harness/resources/app.asar"
 *   node tools/asar-peek.mjs find "$ASAR" "client-ui-sidebar-right/(src|lib)/"
 *   node tools/asar-peek.mjs dump "$ASAR" "dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right" ./ref/sidebar-right
 *
 * The archive layout: `[8-byte header][header pickle: payload size, JSON length, JSON][file data]`.
 * File entries carry `offset`/`size` relative to the data section; `unpacked: true`
 * entries live in `app.asar.unpacked` and are reported but never extracted here.
 */
import { openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, posix } from 'node:path'

const ARCHIVE_HEADER = 8

/** Open the archive and parse its header pickle. */
function openArchive(file) {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  // The header is a Pickle: [payloadSize][stringLength][JSON...][padding to 4].
  const jsonLength = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'))
  return { fd, header, dataOffset: ARCHIVE_HEADER + headerSize }
}

/** Resolve one inner path against the header tree. */
function lookup(header, inner) {
  const parts = inner.split('/').filter(Boolean)
  let node = header
  for (const part of parts) {
    if (!node || !node.files || !node.files[part]) return null
    node = node.files[part]
  }
  return node
}

/** Follow archive `link` entries to the entry that actually carries the data. */
function realPath(header, inner, depth = 0) {
  if (depth > 32) return null
  const node = lookup(header, inner)
  if (node && node.link && !node.files) {
    return realPath(header, posix.normalize(posix.join(posix.dirname(inner), node.link)), depth + 1)
  }
  return node
}

/** Depth-first list of every file entry under one node. */
function walk(node, base, out) {
  if (!node || !node.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const path = base ? base + '/' + name : name
    if (child.files) walk(child, path, out)
    else if (child.link) out.push({ path, link: child.link })
    else out.push({ path, size: Number(child.size), offset: Number(child.offset), unpacked: child.unpacked })
  }
}

const [mode, asar, arg3, arg4] = process.argv.slice(2)
if (!mode || !asar) {
  console.error('usage: asar-peek.mjs <list|get|dump|find> <app.asar> <arg> [arg]')
  process.exit(2)
}
const { fd, header, dataOffset } = openArchive(asar)

/** Read one packed file entry's bytes. */
function readFileAt(entry) {
  const node = realPath(header, entry.path)
  if (!node || node.files || node.unpacked || node.size === undefined) throw new Error('not a readable packed file: ' + entry.path)
  const size = Number(node.size)
  const buf = Buffer.alloc(size)
  readSync(fd, buf, 0, size, dataOffset + Number(node.offset))
  return buf
}

if (mode === 'list') {
  const all = []
  walk(lookup(header, arg3 || '') || (arg3 ? null : header), arg3 || '', all)
  for (const entry of all.slice(0, Number(arg4 || 500))) {
    console.log((entry.size === undefined ? 'link' : entry.size) + '\t' + entry.path + (entry.link ? ' -> ' + entry.link : ''))
  }
  console.log('# total ' + all.length)
} else if (mode === 'get') {
  process.stdout.write(readFileAt({ path: arg3 }))
} else if (mode === 'dump') {
  const base = arg3.replace(/^\/+/, '')
  const all = []
  walk(lookup(header, base) || header, base, all)
  let written = 0
  for (const entry of all) {
    if (entry.link) continue
    let buf
    try {
      buf = readFileAt(entry)
    } catch (error) {
      continue // an unpacked file lives beside the archive, not inside it
    }
    const target = join(arg4, relative(base, entry.path))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buf)
    written += 1
  }
  console.log('# wrote ' + written + ' of ' + all.length + ' entries to ' + arg4)
} else if (mode === 'find') {
  const rx = new RegExp(arg3)
  const all = []
  walk(header, '', all)
  const hits = all.filter((entry) => rx.test(entry.path))
  for (const hit of hits.slice(0, Number(arg4 || 200))) console.log(hit.path + (hit.link ? ' -> ' + hit.link : ''))
  console.log('# matches ' + hits.length)
} else {
  console.error('unknown mode: ' + mode)
  process.exitCode = 2
}
closeSync(fd)
