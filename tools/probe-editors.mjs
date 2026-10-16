/**
 * Report the VS Code-family editors THIS host can prove, and where each proof
 * came from.
 *
 * Usage:
 *   node tools/probe-editors.mjs                       # the family, with sources
 *   node tools/probe-editors.mjs --icon trae           # …and extract one icon
 *   node tools/probe-editors.mjs --icon all            # …and extract every icon
 *   node tools/probe-editors.mjs --icon trae --out D:/tmp/trae.png
 *
 * It never launches an editor: the only side effect is the icon file, and only
 * when `--icon` is asked for. The source column is the point of the tool — it is
 * how you tell a registry proof from a lucky conventional directory, which is
 * exactly what a bug report about a missing editor needs.
 *
 * Run this OUTSIDE the agent's file sandbox if you are comparing it against a
 * sandboxed plugin host: the sandbox forbids the pipe `reg.exe` / `where.exe`
 * need, so a confined run under-reports (registry and PATH sources go silent and
 * only the conventional directories are left).
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveEditors } from '../lib/editor.js'
import { extractExecutableIconPng } from '../lib/editor-icon.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? null : argv[index + 1]
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node tools/probe-editors.mjs [--icon <editorId>] [--out <file.png>]')
  process.exit(0)
}

const platform = process.platform
const editors = resolveEditors()

console.log('platform  ' + platform)
console.log('proved    ' + editors.length + ' of the VS Code family')
for (const editor of editors) {
  console.log('  ' + editor.id.padEnd(15) + editor.label.padEnd(17) + editor.source.padEnd(17) + editor.executable)
}
if (editors.length === 0) {
  console.log('  (none: no App Paths entry, no uninstall record, no PATH hit, no conventional install)')
}

/** Width and height from a PNG's IHDR, or null when the bytes are not a PNG. */
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const iconId = flag('--icon')
if (iconId !== null) {
  const chosen = iconId === 'all' ? editors : editors.filter((entry) => entry.id === iconId)
  if (chosen.length === 0) {
    console.error('no proved editor with id "' + String(iconId) + '"')
    process.exit(1)
  }
  for (const editor of chosen) {
    const bytes = await extractExecutableIconPng(editor.executable)
    if (bytes === null) {
      console.log('icon      extraction yielded nothing for ' + editor.executable)
      continue
    }
    const out = chosen.length === 1 && flag('--out') !== null
      ? flag('--out')
      : join(tmpdir(), 'cws-icon-' + editor.id + '.png')
    writeFileSync(out, bytes)
    const size = pngSize(bytes)
    console.log('icon      ' + editor.id.padEnd(15) + bytes.length + ' bytes' + (size === null ? '' : ', ' + size.width + 'x' + size.height) + ' -> ' + out)
  }
}

process.exit(0)
