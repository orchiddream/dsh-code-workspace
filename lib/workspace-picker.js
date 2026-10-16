/**
 * One `.code-workspace` file, chosen in the host's own file dialog.
 *
 * The shipped picker seam only answers directories: `directoryPicker`'s `native`
 * capability opens the platform dialog with a pick-folders flag, and there is no
 * file variant of that seam to compose with. So this module is the file-shaped
 * sibling of the shipped picker, built the same way `editor-icon.js` builds its
 * icon: a generated PowerShell script, absolute `powershell.exe`, no shell, and an
 * injectable runner so the decision logic is tested without opening a dialog.
 *
 * A file dialog is a **host desktop** affair. Over SSH — or anywhere the operator
 * is not sitting at the host's screen — the honest answer is `unavailable`, which
 * is exactly what a caller needs to fall back to the in-app browser rather than
 * put a dialog on a machine nobody is looking at.
 *
 * The three outcomes are distinct on purpose:
 *
 *   * `picked` — the operator chose a file; `path` is absolute.
 *   * `cancelled` — the operator closed the dialog. Not a failure.
 *   * `unavailable` — this host cannot show the dialog at all (not Windows, over
 *     SSH, or PowerShell failed to start).
 *
 * `error` carries a failure message for the third case when there is one worth
 * telling the user about; the client shows it instead of guessing.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The dialog script.
 *
 * `-STA` is required: the common file dialog is a COM apartment-threaded control
 * and WinForms refuses to run it in an MTA process. `RestoreDirectory` plus an
 * explicit `InitialDirectory` means the dialog opens where the caller said (the
 * host home), not wherever the last dialog happened to be.
 *
 * The chosen path goes to a file rather than stdout: no output parsing, no host
 * encoding in the way, and a cancelled dialog simply leaves that file absent.
 */
export const PICK_FILE_PS1 = [
  'param([string]$Start, [string]$Target)',
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
  '$dialog.Title = "Select a .code-workspace file"',
  '$dialog.Filter = "Code Workspace (*.code-workspace)|*.code-workspace|All files (*.*)|*.*"',
  '$dialog.CheckFileExists = $true',
  '$dialog.Multiselect = $false',
  '$dialog.RestoreDirectory = $true',
  'if ($Start -ne "" -and (Test-Path -LiteralPath $Start)) { $dialog.InitialDirectory = $Start }',
  'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [System.IO.File]::WriteAllText($Target, $dialog.FileName)',
  '  exit 0',
  '}',
  'exit 1',
  '',
].join('\n')

/**
 * `powershell.exe` by absolute path, for the same reason `editor-icon.js` uses
 * one: Windows PowerShell ships on every supported Windows install while
 * PowerShell 7 may not, and an absolute path removes PATH lookup from the failure
 * surface.
 */
const POWERSHELL = process.platform === 'win32'
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'

/**
 * How long the operator may leave the dialog open.
 *
 * Long on purpose: this is a modal dialog a person is interacting with, and a
 * short deadline would kill it mid-choice. It is a leak guard, not a pace.
 */
export const PICK_FILE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Run one command to completion with stdout ignored.
 * @param command - executable path.
 * @param args - argv.
 * @param timeoutMs - deadline; the child is killed past it.
 * @returns the exit code, or `null` when it could not run or did not finish.
 */
export function runToCompletion(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    } catch {
      // A synchronous spawn rejection is a failure to run, not a distinguishable state.
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
 * Whether this Harness was reached over SSH, where the host's desktop is not the
 * operator's.
 * @returns true when the environment says a forwarded SSH session.
 */
export function reachedThroughSsh() {
  const connection = process.env.SSH_CONNECTION
  const tty = process.env.SSH_TTY
  return (typeof connection === 'string' && connection !== '') || (typeof tty === 'string' && tty !== '')
}

/**
 * Open the host's file dialog and answer what the operator chose.
 *
 * @param options - platform, starting directory, deadline, SSH flag, PowerShell
 *   path, and the command runner (all injectable for tests).
 * @returns `{ outcome: 'picked', path }`, `{ outcome: 'cancelled' }`, or
 *   `{ outcome: 'unavailable', error? }`.
 */
export async function pickWorkspaceFile(options = {}) {
  const {
    platform = process.platform,
    startDir = '',
    timeoutMs = PICK_FILE_TIMEOUT_MS,
    ssh = reachedThroughSsh(),
    run = runToCompletion,
    powershell = POWERSHELL,
  } = options

  if (platform !== 'win32') {
    return { outcome: 'unavailable', error: 'the native file dialog is implemented on Windows only' }
  }
  if (ssh === true) {
    return { outcome: 'unavailable', error: 'this Harness was reached over SSH: the browser is not on this host' }
  }

  let workDir
  try {
    workDir = await mkdtemp(join(tmpdir(), 'dsh-code-workspace-pick-'))
    const script = join(workDir, 'pick-file.ps1')
    const outFile = join(workDir, 'picked.txt')
    await writeFile(script, PICK_FILE_PS1, 'utf8')
    const code = await run(powershell, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script,
      typeof startDir === 'string' ? startDir : '', outFile,
    ], timeoutMs)

    // Exit 1 is the script's own "the operator cancelled" answer, and it is the
    // only exit code that means cancellation.
    if (code === 1) return { outcome: 'cancelled' }
    if (code !== 0) {
      return { outcome: 'unavailable', error: 'the file dialog could not be shown (PowerShell exited ' + String(code) + ')' }
    }

    const chosen = (await readFile(outFile, 'utf8')).trim()
    // The dialog guarantees an existing file, but a path is still validated here:
    // this value is about to become a workspace root, and an empty or relative
    // answer must never be treated as a choice.
    if (chosen === '' || !isAbsolutePath(chosen)) {
      return { outcome: 'unavailable', error: 'the file dialog returned no usable path' }
    }
    return { outcome: 'picked', path: chosen }
  } catch (error) {
    return { outcome: 'unavailable', error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Whether a path is fully qualified: a drive-absolute, UNC, or POSIX-absolute path.
 * @param value - candidate path.
 * @returns true when the path can be used without a working directory.
 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^\\\\[^\\]/.test(value)) return true
  return value.startsWith('/')
}
