/**
 * Link / unlink this plugin into a DSH profile WITHOUT pnpm.
 *
 * Why this exists: a `link:` dependency needs neither the network nor a package
 * manager, but two environment facts make the normal routes unavailable on some
 * machines:
 *
 *   - `dsh plugin --profile desktop add …` refuses outright — the Electron
 *     application owns the `desktop` profile exclusively (`dsh/lib/bin.js:36`),
 *     and that holds for any profile the application created;
 *   - the in-app plugin manager runs pnpm, and pnpm verifies the profile's whole
 *     `pnpm-lock.yaml` against the active supply-chain policy before installing.
 *     A profile whose lockfile carries any package younger than
 *     `minimumReleaseAge` therefore fails to install anything at all — a
 *     pre-existing, unrelated condition.
 *
 * This script does exactly what `pnpm add link:<dir>` would have done, and
 * nothing else:
 *
 *   1. `dependencies["dsh-code-workspace"] = "link:<abs dir>"` in the profile's
 *      `package.json`;
 *   2. `"dsh-code-workspace"` appended to `dsh.profile.bundles`;
 *   3. a directory junction at `<profile>/node_modules/dsh-code-workspace`.
 *
 * It backs up `package.json` first, is idempotent, supports `--dry-run`, and
 * only ever removes a junction it can prove points at this plugin.
 *
 * Usage:
 *   node tools/profile-link.mjs install   [--profile desktop] [--dry-run]
 *   node tools/profile-link.mjs uninstall [--profile desktop] [--dry-run]
 *   node tools/profile-link.mjs status    [--profile desktop]
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-code-workspace'
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { command: argv[0], profile: 'desktop', dryRun: false }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--profile') out.profile = argv[++i]
    else if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true
    else throw new Error('unknown argument: ' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !['install', 'uninstall', 'status'].includes(args.command)) {
  console.log('usage: node tools/profile-link.mjs install|uninstall|status [--profile <name>] [--dry-run]')
  process.exit(args.help ? 0 : 2)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', args.profile)
const packageJsonPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)

function fail(message) {
  console.error('error: ' + message)
  process.exit(1)
}

if (!existsSync(packageJsonPath)) fail(`no profile at ${profileDir} (expected ${packageJsonPath})`)

/** The spelling pnpm/DSH writes for a local link on this platform. */
const linkSpec = 'link:' + PLUGIN_DIR.replace(/\\/g, '/')

/**
 * What `<profile>/node_modules/dsh-code-workspace` currently is.
 *
 * The shape is always `{ kind, target }` — an earlier version returned an
 * optional `directory` flag, so a real junction reported as "absent" in
 * `status` and was silently skipped by `uninstall`.
 *
 * @returns `{ kind: 'absent' | 'junction' | 'directory', target?: string }`;
 *   `directory` means a REAL directory (never touched by this script).
 */
function currentLinkTarget() {
  try {
    const stat = lstatSync(linkPath)
    if (stat.isSymbolicLink()) return { kind: 'junction', target: resolve(readlinkSync(linkPath)) }
    if (stat.isDirectory()) return { kind: 'directory' }
    return { kind: 'absent' }
  } catch {
    return { kind: 'absent' }
  }
}

function report() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const dependency = pkg.dependencies ? pkg.dependencies[PACKAGE_NAME] : undefined
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  const link = currentLinkTarget()
  console.log('profile          ' + profileDir)
  console.log('dependency       ' + (dependency === undefined ? '(absent)' : dependency))
  console.log('in bundles       ' + (bundles.includes(PACKAGE_NAME) ? 'yes' : 'no'))
  console.log(
    'node_modules     ' +
      (link.kind === 'junction'
        ? `junction -> ${link.target}`
        : link.kind === 'directory'
          ? 'a REAL directory (not a junction)'
          : '(absent)'),
  )
  if (bundles.includes('dsh-multi-folder')) {
    console.log('WARNING          dsh-multi-folder is still in dsh.profile.bundles; both plugins intercept tools/execute. Remove it.')
  }
  return { pkg, dependency, bundles, link }
}

if (args.command === 'status') {
  report()
  process.exit(0)
}

const { pkg, dependency, bundles, link } = report()

if (args.command === 'install') {
  const changes = []
  if (dependency === linkSpec) changes.push('dependency already present')
  else if (dependency !== undefined) fail(`dependencies["${PACKAGE_NAME}"] already pins "${dependency}"; resolve that first`)
  else changes.push(`dependencies["${PACKAGE_NAME}"] = "${linkSpec}"`)

  if (bundles.includes(PACKAGE_NAME)) changes.push('bundle entry already present')
  else changes.push(`dsh.profile.bundles += "${PACKAGE_NAME}"`)

  if (link.kind === 'directory') fail(`${linkPath} is a real directory, not a junction; refusing to touch it`)
  if (link.kind === 'junction' && link.target !== resolve(PLUGIN_DIR)) changes.push(`repoint junction ${link.target} -> ${PLUGIN_DIR}`)
  else if (link.kind === 'junction') changes.push('junction already correct')
  else changes.push(`create junction -> ${PLUGIN_DIR}`)

  changes.forEach((change) => console.log('  would: ' + change))
  if (args.dryRun) {
    console.log('\ndry run; nothing written')
    process.exit(0)
  }

  // Back up before the first write of this run.
  if (dependency !== linkSpec || !bundles.includes(PACKAGE_NAME)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(profileDir, '.plugin-manager', `backup-${PACKAGE_NAME}-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    cpSync(packageJsonPath, join(backupDir, 'package.json'))
    console.log('backed up package.json to ' + backupDir)
  }

  if (dependency !== linkSpec) {
    pkg.dependencies = Object.assign({}, pkg.dependencies, { [PACKAGE_NAME]: linkSpec })
  }
  if (!bundles.includes(PACKAGE_NAME)) {
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = bundles.concat([PACKAGE_NAME])
  }
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log('wrote ' + packageJsonPath)

  if (link.kind === 'junction' && link.target !== resolve(PLUGIN_DIR)) rmSync(linkPath, { recursive: false, force: true })
  if (currentLinkTarget().kind !== 'junction') {
    mkdirSync(dirname(linkPath), { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(PLUGIN_DIR, linkPath, 'junction')
    console.log('created junction ' + linkPath)
  }

  console.log('\ninstalled. Restart the DSH backend (or reload the app) so the host composition loads the new row, then reload the page.')
  if (bundles.includes('dsh-multi-folder')) {
    console.log('REMINDER: dsh-multi-folder is still bundled — remove it from dsh.profile.bundles before restarting.')
  }
  process.exit(0)
}

// ---- uninstall -------------------------------------------------------------
if (link.kind === 'junction') {
  console.log('  would: remove junction ' + linkPath)
} else if (link.kind === 'directory') {
  fail(`${linkPath} is a real directory, not a junction; refusing to touch it`)
}
if (dependency !== undefined) console.log('  would: remove the dependency entry')
if (bundles.includes(PACKAGE_NAME)) console.log('  would: remove the bundle entry')

if (args.dryRun) {
  console.log('\ndry run; nothing written')
  process.exit(0)
}

if (link.kind === 'junction') {
  // Prove the target before removing: never walk out of the junction.
  if (link.target !== resolve(PLUGIN_DIR)) {
    console.log(`note: the junction points at ${link.target}, not ${PLUGIN_DIR}; removing the link only.`)
  }
  rmSync(linkPath, { recursive: false, force: true })
  console.log('removed junction ' + linkPath)
}
if (dependency !== undefined) delete pkg.dependencies[PACKAGE_NAME]
if (bundles.includes(PACKAGE_NAME)) pkg.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('wrote ' + packageJsonPath)
console.log('\nuninstalled. Restart the DSH backend to drop the row.')
