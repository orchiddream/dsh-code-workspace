/**
 * Native file-dialog behaviour tests, run with no Windows, no PowerShell and no
 * dialog: the platform, SSH flag and command runner are injected, so every
 * decision — who may show a dialog at all, and how each exit code is read — is
 * exercised as a pure decision.
 *
 * The property worth stating twice: `cancelled` and `unavailable` are different
 * answers. A cancel is the operator's choice and must stay silent; `unavailable`
 * is a host that cannot show the dialog and must be explained, because the user's
 * next move (use the in-app browser) depends on knowing which one happened.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PICK_FILE_PS1,
  isAbsolutePath,
  pickWorkspaceFile,
  reachedThroughSsh,
} from '../lib/workspace-picker.js'

/** A runner that records its call and answers a fixed exit code. */
function runner(code, record = []) {
  return (command, args, timeoutMs) => {
    record.push({ command, args, timeoutMs })
    return Promise.resolve(code)
  }
}

/** A runner that writes a chosen path into the script's output file, then exits 0. */
function pickingRunner(chosen) {
  return async (command, args) => {
    const outFile = args[args.length - 1]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outFile, chosen, 'utf8')
    return 0
  }
}

test('a non-Windows host answers unavailable rather than pretending to pick', async () => {
  const result = await pickWorkspaceFile({ platform: 'linux', run: runner(0) })
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.error, /Windows only/)
})

test('an SSH-reached host answers unavailable: the dialog would open on someone else screen', async () => {
  const result = await pickWorkspaceFile({ platform: 'win32', ssh: true, run: runner(0) })
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.error, /SSH/)
})

test('a successful run answers the chosen path, and the dialog is asked to filter workspace files', async () => {
  const seen = []
  const result = await pickWorkspaceFile({ platform: 'win32', ssh: false, run: pickingRunner('D:/ws/app.code-workspace'), record: seen })
  assert.deepEqual(result, { outcome: 'picked', path: 'D:/ws/app.code-workspace' })
  // The dialog itself is part of the contract: if the filter regressed, the user
  // would be picking from every file on the host.
  assert.match(PICK_FILE_PS1, /Code Workspace \(\*\.code-workspace\)/)
  assert.match(PICK_FILE_PS1, /InitialDirectory/)
})

test('exit code 1 is the operator cancelling, which is not a failure', async () => {
  const result = await pickWorkspaceFile({ platform: 'win32', ssh: false, run: runner(1) })
  assert.deepEqual(result, { outcome: 'cancelled' })
})

test('any other exit code is unavailable with a message worth showing', async () => {
  const result = await pickWorkspaceFile({ platform: 'win32', ssh: false, run: runner(9) })
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.error, /exited 9/)
})

test('a runner that cannot start the process is unavailable, not a crash', async () => {
  const result = await pickWorkspaceFile({
    platform: 'win32',
    ssh: false,
    run: () => Promise.reject(new Error('spawn failed')),
  })
  assert.equal(result.outcome, 'unavailable')
  assert.match(result.error, /spawn failed/)
})

test('the script is invoked with -STA, because the file dialog is apartment-threaded', async () => {
  const calls = []
  await pickWorkspaceFile({ platform: 'win32', ssh: false, startDir: 'D:/ws', run: runner(1, calls) })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].args.includes('-STA'))
  assert.ok(calls[0].args.includes('-NoProfile'))
  // The starting directory is passed positionally, so no shell quoting surface.
  assert.ok(calls[0].args.includes('D:/ws'))
})

test('an empty or relative answer is refused: it is about to become a workspace root', async () => {
  const empty = await pickWorkspaceFile({ platform: 'win32', ssh: false, run: pickingRunner('') })
  assert.equal(empty.outcome, 'unavailable')
  const relative = await pickWorkspaceFile({ platform: 'win32', ssh: false, run: pickingRunner('ws/app.code-workspace') })
  assert.equal(relative.outcome, 'unavailable')
})

test('isAbsolutePath accepts the three spellings a host can produce, and nothing else', () => {
  assert.equal(isAbsolutePath('D:/ws/app.code-workspace'), true)
  assert.equal(isAbsolutePath('D:\\ws\\app.code-workspace'), true)
  assert.equal(isAbsolutePath('\\\\server\\share\\app.code-workspace'), true)
  assert.equal(isAbsolutePath('/home/edy/app.code-workspace'), true)
  assert.equal(isAbsolutePath('ws/app.code-workspace'), false)
  assert.equal(isAbsolutePath(''), false)
  assert.equal(isAbsolutePath(undefined), false)
})

test('the SSH flag is read from the environment, never assumed', () => {
  const saved = { connection: process.env.SSH_CONNECTION, tty: process.env.SSH_TTY }
  try {
    delete process.env.SSH_CONNECTION
    delete process.env.SSH_TTY
    assert.equal(reachedThroughSsh(), false)
    process.env.SSH_CONNECTION = '10.0.0.1 22 10.0.0.2 51000'
    assert.equal(reachedThroughSsh(), true)
  } finally {
    if (saved.connection === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = saved.connection
    if (saved.tty === undefined) delete process.env.SSH_TTY
    else process.env.SSH_TTY = saved.tty
  }
})
