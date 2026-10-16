/**
 * One executable's associated icon, for the family entries the shipped "Open In…"
 * catalog has no icon route for.
 *
 * The shipped applications are icon-served by the shipped launcher
 * (`/open-in-app/icon/<id>`), so this module exists for the additions only:
 * VSCodium, Trae and Trae CN. Windows extraction mirrors the shipped launcher — a
 * generated PowerShell script runs `ExtractAssociatedIcon` and saves a 32px PNG,
 * the largest size the stock .NET surface yields without a native addon. The
 * invocation carries `-ExecutionPolicy Bypass` because the script is written fresh
 * and unsigned, and `-File` with positional arguments keeps the paths out of any
 * command-line quoting surface.
 *
 * `ExtractAssociatedIcon` answers a *generic document* icon for a non-executable
 * source and still exits 0, so its output is verified (PNG signature, plausible
 * size) rather than trusted. Every failure resolves `null`, and the control then
 * draws its own fallback glyph, so the menu never shows a wrong image.
 *
 * The command runner, platform and PowerShell path are injectable, so extraction
 * is testable without PowerShell and without an installed editor.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The associated-icon extraction script (the shape the shipped launcher uses). */
export const EXTRACT_ICON_PS1 = [
  'param([string]$Source, [string]$Target)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Drawing',
  '$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)',
  'if ($null -eq $icon) { exit 1 }',
  '$bitmap = $icon.ToBitmap()',
  '$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)',
  '',
].join('\n')

/**
 * `powershell.exe` by absolute path: Windows PowerShell is present on every
 * supported Windows install while PowerShell 7 may not be, and an absolute path
 * also removes PATH lookup from the failure surface.
 */
const POWERSHELL = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

/** Default per-command deadline; extraction measures well under a second warm. */
export const ICON_TIMEOUT_MS = 10_000

/** PNG signature, so a run can never hand the caller something it mislabels. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Below this an output cannot be a real extracted icon. */
const MIN_PNG_BYTES = 100

/** Above this it is not a 32px icon, and it has no business in a remote payload. */
const MAX_PNG_BYTES = 512 * 1024

/**
 * Run one command to completion without capturing output.
 * @param command - executable path.
 * @param args - argv.
 * @param timeoutMs - deadline; the child is killed past it.
 * @returns the exit code, or `null` when it could not run or did not finish.
 */
export function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    } catch {
      // Swallows a synchronous spawn rejection: an unlaunchable command is a failure to run.
      resolve(null)
      return
    }
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.on('error', () => {
      finish(null)
    })
    child.on('exit', (code) => {
      finish(code)
    })
  })
}

/**
 * Whether bytes are a plausible extracted icon: a PNG of sane size.
 * @param bytes - file contents.
 * @returns true when the payload can be served as an image/png.
 */
export function isPlausibleIconPng(bytes) {
  if (!Buffer.isBuffer(bytes)) return false
  if (bytes.length < MIN_PNG_BYTES || bytes.length > MAX_PNG_BYTES) return false
  return bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
}

/**
 * Extract one Windows executable's associated icon as PNG bytes.
 * @param executable - absolute path of a resolved executable.
 * @param options - platform, deadline, and the command runner (injectable for tests).
 * @returns the PNG bytes, or `null` when this host yields none.
 */
export async function extractExecutableIconPng(executable, options = {}) {
  const {
    platform = process.platform,
    timeoutMs = ICON_TIMEOUT_MS,
    run = runCommand,
    powershell = POWERSHELL,
  } = options
  if (platform !== 'win32') return null
  if (typeof executable !== 'string' || executable === '') return null
  let workDir
  try {
    workDir = await mkdtemp(join(tmpdir(), 'dsh-code-workspace-icon-'))
    const script = join(workDir, 'extract-icon.ps1')
    const outPng = join(workDir, 'icon.png')
    await writeFile(script, EXTRACT_ICON_PS1, 'utf8')
    const code = await run(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, executable, outPng,
    ], timeoutMs)
    if (code !== 0) return null
    const bytes = await readFile(outPng)
    return isPlausibleIconPng(bytes) ? bytes : null
  } catch {
    // Swallows temp-directory and read failures: this module's only other answer is null.
    return null
  } finally {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * An `image/png` data URL carrying the icon, ready for an `<img src>`.
 * @param bytes - PNG bytes from {@link extractExecutableIconPng}.
 * @returns the data URL, or null when there is no icon to carry.
 */
export function iconDataUrl(bytes) {
  if (!isPlausibleIconPng(bytes)) return null
  return 'data:image/png;base64,' + bytes.toString('base64')
}
