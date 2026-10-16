/**
 * Dump the authenticated index for one booted DSH instance and report how it
 * references plugin client bundles.
 *
 * Usage: node tools/probe-index.mjs <url-with-token>
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const url = process.argv[2]
const origin = new URL(url).origin

const boot = await fetch(url, { redirect: 'manual' })
const cookie = (boot.headers.get('set-cookie') || '').split(';')[0]
const response = await fetch(origin + '/', { headers: { cookie } })
const html = await response.text()

mkdirSync('.scratch', { recursive: true })
writeFileSync('.scratch/index.html', html)
console.log('index bytes:', html.length, 'status:', response.status)

for (const id of ['dsh-code-workspace', 'dsh-multi-folder', 'dshmarket', 'usage-meter']) {
  console.log('  contains', id, '->', html.includes(id))
}

const moduleRefs = html.match(/[^"'<> ]{0,40}client-modules[^"'<> ]{0,60}/g)
console.log('client-modules references:', JSON.stringify((moduleRefs || []).slice(0, 8), null, 2))

const scripts = html.match(/<script[^>]*>/g)
console.log('script tags:', JSON.stringify(scripts, null, 2))

const boot2 = /__DSH_BOOT__\s*=\s*/.exec(html)
if (boot2) {
  console.log('__DSH_BOOT__ present at', boot2.index)
  console.log('boot slice:', html.slice(boot2.index, boot2.index + 1200))
}
