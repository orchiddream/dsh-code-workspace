# Design

Architecture, invariants and the deliberate limits of `dsh-code-workspace`.

## Goal

A DSH session gains the roots a VS Code window would have, driven by the same
`.code-workspace` file the user already maintains. No parallel configuration store
decides the roots — the file does — so the two can never drift apart.

## The mapping problem

DSH models a workspace as ONE canonical directory: `WorkspaceRegistry.create(path)`
realpaths its argument and rejects a relative, missing, or non-directory path. A
`.code-workspace` file is a file that *names* several directories, so the two models
do not line up directly.

The plugin resolves this the only way that keeps both sides honest:

> **cwd = the file's first `folders[]` entry that exists on disk** (the *session
> root*), and every other `folders[]` entry is an *additional root*.

`lib/workspace-file.js` exports that decision as `deriveRoot(model, fileDir)`: the
first folder whose `exists` / `isDirectory` probes do not say `false`, in file order;
when `folders` is empty, or every folder is missing or is not a directory, the answer
is the file's own directory. `loadModel` probes every folder per load, so a folder the
user adds in VS Code is seen; the derived root is one field of the load, and the cache
key is `file + NUL + rootDir` — a file cached for two different roots is two entries.
Panel and command reads always force a re-parse, so the root is recomputed on every
such read.

Three names, used consistently everywhere:

| Term | Meaning |
| --- | --- |
| **session root** / **root directory** (`rootDir`) | The directory the session is rooted at — the file's first existing folder, or the file's own directory when none qualifies. It is what is handed to `workspaceRegistry.create()` and, through the standing policy, what the sandbox fences against. |
| **file directory** (`fileDir`) | The directory holding the `.code-workspace` file. It holds the file; it is not the session root. |
| **additional root** | Every `folders[]` entry except the session root. Never the sandbox root; reachable only through the re-rooting interceptor. |

Consequences that follow from this and are not bugs:

- `workspaceRegistry` gets a real directory, so DSH's own workspace list, session
  grouping and archive logic keep working untouched.
- The file's own directory is *not* the session root, so a `.code-workspace` file
  that names only other directories yields an additional root for each of them —
  and a session rooted at the file's directory is a session with no code in it.
- A folder that resolves to the session root is not "additional" — it is already the
  sandbox root. `stateOf()` marks it `isPrimary`; `extraRootsFor()` drops it.
- The file directory is usually outside the session root, which is why the
  workspace-file write carries its own policy (see "Writing the workspace file").

### Why the file's own directory is not the root

DSH identifies a Workspace by its canonical path, not by the plugin: two sessions
whose `cwd` resolves to the same directory are two sessions of one Workspace, and a
plugin cannot make them two. So if the session root were "the directory holding the
file", every `.code-workspace` a user keeps in one folder would land on the SAME
Workspace, and the session would be rooted at a directory that holds no code — the
exact shape of `D:\home\workspace`, which holds six of them
(`test/host.test.mjs`, `LIBRARY_FILES`). Deriving the root per file is what keeps
those files apart: each gets the root it actually names.

The same reasoning retires the old discovery rule ("the recorded file whose
*directory* is the session directory"). With two files in one folder it returned
whichever happened to be recorded first — silently granting roots the user never
chose for that session.

## Associations, and why they are explicit

The store (`<DSH_HOME>/storages/code-workspace/index.json`) is a single JSON file,
most recent first in every list:

```jsonc
{
  "version": 2,
  "files":    ["…/api.code-workspace", …],   // the UI's recent list
  "roots":    [{ "root": "D:/home/api", "file": "…" }],
  "sessions": [{ "session": "session-…", "file": "…" }]
}
```

`roots` and `sessions` are the ASSOCIATIONS — which file governs which directory, and
which file one session picked — and they are kept apart on purpose:

- a root can be named by several files, and the panel has to be able to say *which*
  ones (`rootRecords` keeps the history, not only the winner);
- a session can pick a different one of them than its neighbour at the same root, so
  the per-session pointer must not be collapsed into the per-root record.

Both lists are capped (`MAX_ROOT_RECORDS` / `MAX_SESSION_RECORDS`, 200 each) and the
caps are applied on write, so a long-lived store cannot grow without limit.

**v1 → v2 migration.** A v1 store (`{ version: 1, files: [...] }`) is read as
`version: 2` with its `files` intact and both association lists empty. Nothing is
invented from a file's directory — the guess that made one folder of workspace files
collapse onto one workspace. The first explicit pick writes the association.

### Resolution order for one session root `C`

`resolveFileForRoot(rootDir, sessionId)` answers in four steps, and the synchronous
`knownFileSync` mirrors the first three:

1. **The file THIS SESSION picked** (`sessions`). This is why two sessions rooted at
   `C` can run different folder sets.
2. **`C`'s most recent explicit record** (`roots`), which is what a brand-new session
   inherits. A TOMBSTONE (`file: null`) here stops the search entirely.
3. **Adoption** — `C` holding EXACTLY ONE `*.code-workspace` file. Nothing is
   ambiguous, and the file is right there.
4. **Nothing**, which makes the plugin inert for that session: no prompt section, no
   interception, an empty state.

Two or more files in `C` is therefore a fail-closed tie: it grants nothing until the
user picks one. That is deliberate. The alternative — "whichever was recorded first" —
is a silent choice of roots the user never made.

### The tombstone

`forgetRoot` writes `{ root, file: null }` rather than dropping the records. A root
holding exactly one `.code-workspace` file would otherwise be re-adopted by step 3 on
the very next read, and the panel's "Unlink" button would look like a button that does
nothing. The tombstone lasts until the user picks a file for that root again
(`rememberRoot` removes it as it records the new pick).

**Consequence, stated plainly:** clearing is per-root plus per-session. It drops the
addressed root's records *for everyone* and this session's own pointer; other sessions
at that root keep their own `sessions` entries and lose only the shared default, which
the panel then reports honestly (the root has no file, and the other sessions still
name one). `forgetFile` is stronger: dropping a file from `files` also drops every
`roots` and `sessions` record that names it, because leaving them behind would
re-adopt a record the user just removed.

## The hard limit: two files, one root

DSH's own workspace identity, quoted from
`@deepseek-ai/dsh-workspace/lib/index.js` (the implementation inside the shipped
`app.asar`):

- uniqueness is string equality of canonicalized paths: *"uniqueness is string
  equality of canonicalized paths (a symlink to an existing workspace's directory
  collides), and attach-time session `cwd` checks go through the same canon"*;
- `create` canonicalizes through `realpath`, so two spellings — or a symlink and its
  target — are ONE workspace;
- `attachSession` rejects a session whose `cwd` does not resolve to exactly the
  workspace's own canonical path: `if (cwd !== this.record.path) throw new Error(…)`;
- `sessionIds` is filtered by the same test on every read:
  `this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path)`.

Therefore: **two `.code-workspace` files whose first existing folder is the same
directory ARE one DSH workspace, and no plugin can split them.** Switching between
them re-points the session's folder set and the prompt; it does not, and cannot,
create a second workspace, and DSH's workspace list will keep showing one entry.

The plugin's answer is not a fake second workspace. It is four things that are all
true of the code as it stands:

- a **deterministic per-file root** — the first folder that exists, so two files in one
  directory land on different roots whenever their folder sets differ
  (`deriveRoot`);
- an **explicit per-session association** — the session's own pick outranks the root's
  record, so two sessions at one root can run different folder sets
  (`rememberSession` / `sessionFile`);
- a **fail-closed tie** — no pick and more than one candidate grants nothing
  (`resolveFileForRoot` steps 3–4);
- the **duplicate reported** — `conflictFor` lists every other known file naming the
  same root in the host state's `conflict`, the client renders "other workspace files
  naming the same root" with one clickable row per file, and the prompt adds "Other
  .code-workspace files also name `<root>`" so the agent never assumes the folder set
  it sees is the only one that exists.

## Planes

| Half | File | Role |
| --- | --- | --- |
| Text | `lib/jsonc.js` | JSONC reader; **surgical** single-member writer |
| Model | `lib/workspace-file.js` | VS Code path rules, the derived session root (`deriveRoot`), folders CRUD, serialization. Pure, no fs |
| Editor family | `lib/editor.js` | Which VS Code-family editor this host holds, the child environment, the launch |
| Editor icon | `lib/editor-icon.js` | Associated-icon extraction for the family entries no shipped route serves |
| Host | `lib/index.js` | Discovery, the association store, caching, `tools/execute` interception, prompt section, notices, `/code-workspace`, sessionless `codeWorkspace/*` API, `@` discovery, editor and file-dialog endpoints |
| File dialog | `lib/workspace-picker.js` | The host's native `.code-workspace` file dialog, as the file-shaped sibling of the shipped directory-only picker |
| Client | `lib/client.js` | The left-column entry and its sessionless central panel, the Conversation view page, its header-button fallback for degraded compositions, session-creation dock chip and its popover, "Open In…" takeover, `@` companion group |

## Why the writer is surgical

A `parse → JSON.stringify` round trip deletes every comment, reorders nothing but
reformats everything, and would fight the user's editor on every save. `.code-workspace`
files are JSONC and users do put `// why this folder` next to entries.

`patchDocument(text, 'folders', value)` therefore:

1. parses once to learn the byte range of the `folders` member (and the file's own
   indentation style);
2. replaces exactly that range, re-indenting the new value to the member's column;
3. leaves every other byte — comments, member order, trailing commas, CRLF, a BOM —
   untouched.

Appending a missing member gives the previous last member its separating comma and
inserts above the root's closing brace, so trivia between the last member and that
brace (a trailing comment) survives. Removing a member takes its comma, or the
preceding one when it was last. All of this is pinned by `test/jsonc.test.mjs`,
including a real Trae/VS Code sample file.

## Writing the workspace file

`writeFolders` persists a new `folders` array with its **own explicit policy, rooted at
the file's own directory**:

```js
await fs.writeText(await fs.resolve(entry.file), next, undefined, undefined, {
  mode: 'workspace-write',
  workspaceRoot: entry.fileDir,
})
```

This is load-bearing, not tidiness. A `.code-workspace` file routinely lives *outside*
the root it defines — that is the whole point of a folder of `.code-workspace` files —
so rooting this write at the session root would be an OS-level access denial: the
sandbox grants write access relative to the policy's `workspaceRoot`, and the file is
not inside it. `test/host.test.mjs` pins exactly that (`D:/home/workspace` while the
session root is `D:/home/api`), and the plugin store uses the same pattern, rooted at
`storeDir()`.

The command-created file has the same shape: `coreCreate` writes the new file rooted at
the directory it creates it in, which is by construction the directory the caller was
addressing.

## Discovery

The active workspace file for a session root `C` — resolution order, tombstones and
adoption — is under "Associations, and why they are explicit" above. The operational
consequences:

- The **discovery cache** is keyed by `C`, holds only the adoption answer (a listing
  is the one source `knownFileSync` cannot compute), and lives for
  `DISCOVERY_TTL_MS` (3 s). The two association sources are read from the loaded store
  and need no cache.
- A directory with no workspace file makes the plugin **completely inert**: the prompt
  section renders the empty string, the interceptor falls through before doing any
  work, and every endpoint answers an empty state.
- The store lives outside every agent sandbox root and is written only from
  user-initiated flows.

## Caching, and why not `fs.stat`

| Cache | TTL | Why |
| --- | --- | --- |
| Model (the parsed file) | 2 s | a folder the user adds in VS Code is picked up quickly; panel and command reads force a fresh parse |
| Discovery (which file owns a directory) | 3 s | a first message is not blocked on a directory listing |
| `@` file index | 4 s | autocomplete is advisory; a rebuild is bounded to one traversal per window |

Invalidation is **time-based on purpose**. The obvious implementation — stamp the
file with `size:mtimeMs` from `fs.stat` and re-read when the stamp changes — depends
on which fields an `FsInfo` actually carries, which is not part of the plugin-facing
contract. A stamp built from absent fields is a constant, so the cache would never
invalidate and a stale root set would be pinned for the whole session. A TTL has no
such failure mode and its worst case is a bounded delay.

## Interception

A listener on the `tools/execute` around-dispatch waterfall handles `write`, `edit`,
`pwsh` and `bash`:

1. **Hydrate first, awaited.** A first call arriving before the file read resolves
   would otherwise see an empty cache, fall through to the default pipeline, and be
   fenced against the *session root* — surfacing as a spurious
   `[sandbox: file access denied under workspace-write mode]` for an ordinary write
   into another workspace folder.
2. Resolve the standing policy (`sandboxPolicy.resolve({ session })`) and canonicalize
   the target (`fs.resolve` + `fs.processPath`), so `..`, symlinks and case
   differences match correctly.
3. **User-managed guard.** Any `*.code-workspace` target, and the plugin's own store,
   are refused with an explicit message. See "Security posture".
4. If the canonical target lands inside an additional root, execute the operation with
   `{ ...standingPolicy, workspaceRoot: <that root> }`:
   - `write` / `edit` → `fs.writeText` / `fs.editText`, then `fs/observed` exactly like
     the shipped tools;
   - `pwsh` / `bash`, foreground → `shell.resolve` + the seam's foreground call;
   - `pwsh` / `bash`, background → the same re-rooted request registered through
     `ctx.jobs`, with the asynchronous launch adapted to the jobs runtime's synchronous
     hooks contract and `onExpiry: 'none'` so a background command never inherits the
     executor's deadline.
5. Anything else — unknown tools, targets outside every additional root, a missing
   optional service, an escalation request, or a failure **before** the target was
   resolved into a root — falls through to `next()`.

**Why mode parity is free:** the mode field is never touched. The sandbox backends
treat the per-call policy as fully specified and fence by `workspaceRoot` + `mode`, so
`read-only` keeps denying in an additional root exactly as in the session root.

**Ownership rule.** Once a target has been resolved into an additional root the
interception OWNS the call: a later failure is reported as that call's own error
(including the `FS_*` code, and the one-shot escalation hint for a genuine
`FS_SANDBOX_DENIED`) and never handed back to the default pipeline, which fences
against the session root and would replace a real cause — a missing `old_string`, a
locked file — with a spurious sandbox denial.

**Lazy service resolution.** `shell`, `shellEnv`, `jobs`, `commands`, `typert`,
`workspaceRegistry` and `directoryPicker` are resolved per call, never captured at
apply time: loader rows activate in dependency order, so a capture can be `undefined`.
The command and the Typert contribution ride `ctx.inject`, which fires whenever the
service appears.

## Prompt section

One global `systemPrompt.section` (`code-workspace:roots`, order 165 — after the tool
guidance range 100–129) whose text provider evaluates per assembly and renders only
for sessions that have a workspace file. Its lines:

- `workspace file: <file> (in <fileDir>)`;
- `working directory: <rootDir> — the file's FIRST existing folder, and this session's
  sandbox root` (the wording was "primary working directory" while the root was the
  file's directory);
- every folder as `label — resolvedPath`, marked `(primary)` for the one equal to the
  root and `(MISSING on disk)` when the probe said so;
- when other files name the same root:
  `Other .code-workspace files also name <root> — this session is on the one above; the
  others are …`, with the instruction to ask the user to switch in the panel. A root
  can be named by more than one file and DSH identifies a workspace by the root alone,
  so the agent must not assume the folder set it sees is the only one that exists;
- then the one-writable-root-per-command rule, the absolute-`workdir` requirement, and
  that the workspace file is user-managed.

The prompt is assembled from the cache, so `entryForSync` reads the same four-step
resolution as the async path minus adoption (which needs a listing).

For a file that failed to parse the section still renders, saying so — the Agent must
know why no folders are available rather than silently getting none.

The host state object the panel renders from carries exactly those facts:
`rootDir`, `fileDir`, `file`, `title`, `roots[]` (each with `index`, `path`, `name`,
`label`, `resolvedPath`, `exists`, `isPrimary`, `relative`), `extraRoots`, `conflict`
(the files `conflictFor` found), plus `warnings`, `error` and `indent`.

## Notices

A folder change made from inside a session arms a pending notice **only when the set
actually changed**. The next boundary consumes it — `agent/pre-step` prepends it to the
entering message batch, or `tools/post-execute` attaches it as `additionalContexts`,
whichever fires first. No turn is interrupted.

The notice's `source.kind` is the producer-owned `plugin:dsh-code-workspace`. Session
format v4 refuses the retired catch-all `kind: 'plugin'` wrapper the moment a notice is
logged, and `plugin:<plugin>` is the spelling the format's own v3→v4 migration
produces for a non-first-party producer.

`agent/created` is an awaited `serial` event, so its handler returns the hydration
promise — that is what guarantees the very first prompt assembly already lists the
folders.

## The panel's surface: a Conversation view

The panel used to have exactly one surface: a fixed-size floating overlay. Managing the
folders while reading the conversation it affects is the actual job, and a floating box
that covers the conversation — anchored, fixed width, with its own scrollbar — is the
worst shape for it.

The panel now has **two surfaces with different scopes**, and the split is the point:

| Surface | Scope | Why it exists |
| --- | --- | --- |
| The **left-column row** and the central panel it opens | app / sessionless | the only entry that needs nothing to exist yet: a profile with no workspace open can still pick a `.code-workspace` file, and that pick is what creates the workspace |
| The **Conversation view** tab | per session | the folder manager beside the conversation whose roots it decides |
| The floating popover (`shell.overlay`) | sessionless | the creation page has no session to host a tab or a panel row |

Both pages register under **one id**, `code-workspace`, and that is deliberate: a
`sidebar.panellist` id IS the `main` key it opens — the shell resolves a click through
`layout.selectPanel(id)` — and this bundle's Conversation view already answers to
`code-workspace`. So the sidebar row, the tab and `selectPanel('code-workspace')` all
address one page, and there is no second id that could drift out of step.

A **docked right-Sidebar page** was tried first and rejected: the right column is narrow,
its content is not the conversation's width, and the workspace form's action rows wrapped
into a heap. The surface the product already has for "another full page inside this
conversation" is the Conversation's own tab strip, so the panel is a **Conversation view**
now — one tab beside Chat / Trajectory / Git. The floating panel survives only as the
creation page's popover, where there is no session to host a tab.

The mechanism is the owner's own list slot:

```js
ctx.slots.register({ name: 'conversation.view', id: 'code-workspace', order: 30,
                     label: () => t('title.tab'), locale: NS }, WorkspaceView)
```

`conversation.view` is a `list` slot (scope `session`, `replaceRisk: none`), and the owner
builds the strip by walking its entries and renders exactly one entry at a time by id —
which is why the shipped Chat and Trajectory views are registered the same way, and why a
single registration is enough. Order 30 puts this tab after Chat (0) and Trajectory (10).

Three consequences are load-bearing:

- **The registration is gated on the layout service, and it waits for it.** `ctx.layout`
  is the same package's face: it declares the slot, and `selectPanel` is the only way to
  select a view. A composition without it has no tab strip to join, and registering into an
  undeclared slot throws — so the cell is registered from inside `ctx.inject(['layout'], …)`
  rather than read once at apply time. That is also why the gate is a wait and not a
  one-shot `ctx.get`: loader rows activate in dependency order, and an early read would
  cache `undefined` for the plugin's whole life.
- **The view is per session, and the page obeys that.** The owner hands each entry the
  standard session kit, so the page addresses `props.sessionId` and resolves that
  session's `cwd`. The store is shared with the overlay, so the view re-scopes it before
  rendering — otherwise a panel left on one session would address another after a switch,
  and the `/code-workspace` command would land in the wrong conversation. A session change
  also drops the previous session's state: those folders belong to a conversation the page
  is no longer showing.
- **One read per mount, with no window.** React mounts a view when its tab is selected and
  unmounts it when the user leaves, so mounting *is* the deliberate "show me the current
  state" gesture; the ⟳ button re-reads without a remount. This is deliberately simpler
  than the read window the docked page needed — an always-mounted tab could be remounted
  by its neighbours, and the window that fixed that had to be keyed by session, which is
  exactly the kind of state that grows into a bug.

### The page as a manager

The left-column entry is the app-level surface, so its page is a **list**, not a detail view:
every recorded `.code-workspace` file, most recently used first, with the rows that are
already DSH workspaces marked and the ones whose file is gone marked as such.

The row that is "active" is the **file**, not its directory. Two files can derive the same
root — DSH then treats them as one workspace — so marking by root would light up every row
and tell the user nothing; the store also carries no root for a recent record, only the file
and its directory.

Two sources are joined by path spelling because they answer different questions: the
plugin's store ("a file I have used", probed per row by `recent`) and the workspace service
("a workspace this app already has"). A workspace the plugin has no file for is still listed,
because hiding it would make the list a lie about what exists.

**Removing a record needs the file as the address**, which is why `forgetFile` exists
alongside the directory-addressed `forget`: a manager shows records the current session is
not on, and a stale record — a temporary workspace whose directory has long gone — is
exactly the entry a user wants to clear. `forgetFile` answers the refreshed list, so the
panel gets its one answer from one round trip, and the action is confirmed first because the
list has no undo.

That stale-record case is not hypothetical: the live-verification script registers a
temporary workspace through the real remote API, which permanently records its file in the
profile's store. The script now forgets it in its own teardown.

A session created in a directory with no `.code-workspace` file (or with several, which is
ambiguous by discovery) has nothing associated, and that is exactly the state where the user
needs an *action*, not a status line. So the empty state carries the actions — switch file
(browse), the host's own dialog, and create — instead of leaving them one level down inside
a file section that only exists once a file is known. Without that, removing the header
button's popover would have removed the only way to associate a workspace file from an open
session.

The browser starts at the **host home** (`remote.$host.home`), not at the session's own
directory. That is deliberate: the session directory is the one place the file has already
been shown to be absent, and a `.code-workspace` file for the repository you are working in
usually sits somewhere else entirely. Home is the closest thing to "somewhere to browse
from" that a host can name; when the host publishes none, the session directory is the
fallback.

### Where a choice is attributed, and how a duplicate is reported

Panel operations made **inside a session** ride `/code-workspace` — the session-scoped
command channel — so the host can attribute them to the session: `openFile`, `createFile`
and every folder mutation go through `runCommand(sessionId, …)` while a session exists, and
through the sessionless `codeWorkspace/*` channel only on the creation page, where there is
no session to attribute anything to. That is what makes "two sessions rooted at one
directory, each on a different workspace file" work end to end: a pick is never recorded
merely for the directory.

The remaining sessionless calls carry the session id **when there is one** — `openInEditor`
and the `@` `listFiles` source both send `sessionId` (omitted, not `undefined`, when there
is none) — because the host cannot guess which of several files naming a root the session
is on.

A root named by several files is then a fact the page must show rather than a silent tie.
The host state carries `conflict` (`conflictFor`, every other known file naming this root)
and the page renders an "other workspace files naming the same root" block: a title, one
sentence of the reason (DSH keys a workspace by its root's canonical path, so these belong
to the SAME DSH workspace), and one clickable row per file that issues
`/code-workspace use "<file>"` for this session. The prompt carries the same fact for the
agent.

### The host's own file dialog

Browsing inside the app is the fallback, not the primary gesture: what a user actually wants
is their operating system's file picker. The shipped picker seam cannot serve that — its
`native` capability opens the platform dialog with a **pick-folders** flag, and there is no
file variant of the seam to compose with — so `lib/workspace-picker.js` is the file-shaped
sibling, built the way `lib/editor-icon.js` builds its icon: a generated PowerShell script,
absolute `powershell.exe`, no shell, and an injectable runner.

Two details are load-bearing:

- **`-STA`.** The common file dialog is a COM apartment-threaded control; a Windows
  PowerShell host defaults to MTA and WinForms refuses to run it there. This is the kind of
  thing that works on one machine and dies on another, so it is pinned by a test.
- **The answer is read from a file, never from stdout.** No output parsing and no host
  encoding in the path of a value that is about to become a workspace root. A cancelled
  dialog simply leaves that file absent, which is why exit code 1 is the cancellation and
  every other non-zero code is `unavailable`.

The three outcomes are separate on purpose, because the user's next move differs:
`picked` opens the file; `cancelled` says nothing (the operator chose it — an error toast for
cancelling a dialog is noise); `unavailable` explains itself once, because the answer is
"use the browser below", and that is only discoverable if the message says so. A host over
SSH is `unavailable` by construction: a dialog would open on a screen nobody is looking at.

The dialog itself has not been opened on a real desktop yet — the decisions above are pinned
by tests with an injected runner, and the README says so rather than implying more.

Picking a file then registers its **derived root** as the DSH workspace and, when
`uiWorkspace.openWorkspace` exists, switches the current session to it — which is how an
already-open session lands on a real workspace without the user leaving the tab. A pick
made inside a session rides `/code-workspace`, not this channel, so the host attributes
it to the session: on the creation page there is no session to attribute it to, and the
choice pins the root for whoever comes next.

**The tab is the entry point, and the header button is the degraded one.** A tab is visible
for the whole session, so a header button beside it is a second entry point for one page —
noise, and the source of the bug where a click showed the page *and* a floating copy of it.
The button therefore renders only when `conversation.view` did not register (no layout
service, so no tab strip to join); in every ordinary composition it removes itself. It still
navigates through `ctx.layout.selectPanel` and reads `ctx.layout.panelInfo` so it can act as
a toggle, and `selectPanel`'s throw for an unregistered panel id is caught and changes
nothing.

**The overlay is not this button's fallback.** It was, and the fallback was wrong: the two
surfaces share one store but not one visibility rule, so a click could leave the page and a
floating copy of it on screen together. The floating panel is now only the creation page's
popover — the one place a workspace file can be picked before a session exists — and it
renders only when the store says the creation page opened it. Opening the page takes the
panel over from that popover rather than sharing the screen with it.

## Sessionless remote API

The session-creation page has no session, so the agent-scoped `commands/execute` remote
cannot serve it. The plugin opens its own namespace on the shared `/api` channel:

- a plain-object service registered with `ctx.provide('codeWorkspace', api)`, carrying
  the frozen `typertRemote` binding the gateway's `validateBinding` expects;
- a hand-written Typert contribution using `src-json` codecs and
  `invocation: { kind: 'direct' }`, registered through `ctx.inject(['typert'], …)`.

Twenty endpoints, keyed by **paths** rather than a session id: `state`, `recent`,
`forgetFile`, `open`, `forget`, `useFile`, `create`, `addFolder`, `removeFolder`,
`renameFolder`, `moveFolder`, `browse`, `makeDir`, `pick`, `pickFile`, `reveal`,
`editors`, `editorIcon`, `openInEditor`, `listFiles`.

The channel is keyed by path because the session-creation page has no session yet, but
eleven endpoints answer differently depending on *which* session asks, because a
session's own pick outranks a root's record. `openInEditor` must open the file THIS
session is on, `listFiles` must index THIS session's root set, and every endpoint that
resolves a file for a root (`state`) or records a pick (`open`, `forget`, `useFile`,
`create`, `addFolder`, `removeFolder`, `renameFolder`, `moveFolder`) has the same
dependency. All of them therefore take an **optional `sessionId`**: declared with
`acceptsUndefined: true`, which is how the shipped DSH descriptors mark a wire field a
caller may leave out — without it a missing field is a protocol error rather than
`undefined`, and the client omits it rather than sending `undefined` when there is no
session. In-session callers reach the same core through `/code-workspace`, which carries
the agent and is attributed automatically.

Without the parameter the answer is the per-ROOT association, which is exactly what a
brand-new session inherits: correct, never wrong, just not yet session-specific.

`src-json` gives JSON-safety boundary checks, not schema validation, so the service
treats every argument as hostile — type checks, a fully-qualified-path requirement,
canonicalization, and existence/directory checks all live in one shared core that the
command channel calls too, so the validation surface is identical on both.

**Spelling.** Every path the plugin *constructs* is normalized to forward slashes
(`normalizeSpelling`), so identity, dedupe, display and the store agree on every
platform. The sandbox root handed to the policy is different: it is whatever the `fs`
seam reported (`fs.processPath`), captured per folder at load time, because that is the
spelling the sandbox layer itself produced.

## Opening the workspace in an editor

The requirement is narrower than "open a folder": the editor's window must be the
same root set the session writes to, and the only way to get that from the VS Code
family CLI is to hand it the **workspace file** — `Code.exe <file.code-workspace>`,
`Trae CN.exe <file.code-workspace>`. So the target is the file, and the session root is
only the fallback for a session that has none (or whose recorded file is gone, which
the panel already marks as missing). Because a root can be named by several files, the
launch resolves the file **for the asking session** first: the sessionless endpoint
takes `sessionId` for exactly that reason, or it would have to guess which of several
files naming this root the session is on.

### Why the shipped control cannot do it, and why the takeover is -2

The shipped catalog (`@deepseek-ai/dsh-host-open-in-app`, `OPEN_IN_APP_CATALOG`) is
a compile-time table, its browser half filters ids through a matching
`APP_LABEL_KEY` map, and `POST /open-in-app/open` validates an absolute
**directory**. A deployment therefore cannot add an editor to that menu from
configuration, and cannot make any existing entry pass a file. Taking over the cell
that renders it is the only supported route, and the slots ledger makes that a
supported move rather than a hack: a `list` slot keeps one cell per id, the entry
with the LOWEST priority renders, and registering the same id at the SAME priority
throws.

`dsh-plugin-open-in-trae` took that cell at `priority: -1`. This plugin takes it at
**-2**, and that difference is deliberately load-bearing: `-1` and `0` stay
registered and valid (same id, different priority — no collision), this plugin
renders, and retiring the other plugin later is cleanup rather than a prerequisite.
Presentationally only the two directory-scoped cells are taken
(`conversation.session.header.utilities`, `sidebar.right.tab.files.actions`); the
four file-scoped `open-in-app` cells are about opening individual files and are left
alone. Every non-family application keeps its shipped name, icon, route and
behaviour; family ids are re-routed to this plugin's launcher, and VSCodium,
Trae/Trae CN are added because the shipped catalog has no entries for them.

### Proof, not conclusion

A VS Code fork installs wherever the user chose and only some of them register
`App Paths` (Trae, on the machine this was written against, is at `D:\app\Trae CN\`
with nothing but an uninstall record). So each source yields *candidates* and every
candidate must pass two proofs: the file exists, and its basename is still that
member's own executable name. A registry record — which any installer can write —
therefore cannot point the launcher at an unrelated program. The chain is
`App Paths` → uninstall records (`DisplayIcon`, then `InstallLocation`) → `PATH` →
conventional directories on Windows, and CLI names plus application bundles
elsewhere. `resolveEditors` takes its platform, environment, registry reader, `PATH`
lookup and file probe as options, so the whole chain is testable as pure decisions.

### Two traps the launch module exists to handle

**`ELECTRON_RUN_AS_NODE`.** The Harness runs as a Node-mode Electron child, so that
marker is in this process's environment. Any Electron application spawned with it
set starts as plain Node, prints nothing and exits 0 — an editor launched that way
never opens a window while the launcher reads a success. Every child environment is
scrubbed of the marker, of this Harness's identity and credentials (`DSH_*`,
`*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`), and of `NODE_OPTIONS`.

**Launch success is not process lifetime.** A GUI editor stays in the foreground for
as long as its window lives, and a second launch delegates to the running instance
and exits 0. `launchEditor` resolves from a short watch window: a spawn rejection
(`ENOENT` → `missing`) or an early nonzero exit is a failure; a child still running
at the end is unrefed and counted launched. A `missing` outcome re-resolves the
family once and retries, so an editor that was uninstalled or moved mid-session
recovers instead of failing forever.

### Icons over the channel that already exists

The shipped applications keep their shipped icon route. For the additions, the icon
is extracted from the executable (PowerShell `ExtractAssociatedIcon`, the same 32px
ceiling the shipped launcher documents), verified as a PNG of plausible size — the
API answers a generic document icon and exits 0 for a non-executable source — and
returned as an **`image/png` data URL** over the existing remote channel. That is a
deliberate trade: no new HTTP routes, no `webServer`/`connection` dependency, no
second trust fence to keep in step, at the cost of a few KB per detected editor,
cached for the plugin's life.

### Failure posture

- No detections (or an SSH-reached session) → the endpoint answers an empty family
  and the panel says why. Nothing is guessed and nothing is launched.
- The UI primitives the menu is drawn with are loaded through an optional
  `require`: without them the takeover is skipped and the shipped control stays, so
  a missing seed module can never take the panel, the dock chip or the `@` group
  down with it.
- A family id the client names that this host cannot prove is refused; the client
  can never hand the host an arbitrary executable path.

## `@` discovery
DSH's `@` provider builds exactly one searcher from the session cwd and refuses every
candidate outside it, so an additional root is unreachable through it. The plugin does
not touch that provider; it publishes `codeWorkspace/listFiles` over the files it
already has read access to and contributes a **companion** group.

- Empty query → the folders themselves, as entry points.
- Bare fragment → ranked over the *in-root relative* path. Scoring the absolute path
  would make a one-character query match every candidate, since every path on a host
  shares its prefix.
- A query containing `/` → a level listing, in either spelling (the absolute path a
  drill inserted, or a leading folder label). An ambiguous label answers nothing. Any
  `..` segment is refused outright: it would list outside every granted root while
  still claiming a granted root as the owner.
- Hidden entries are indexed but invisible to a global query, matching the shipped
  provider; `node_modules` and friends are never traversed; the walk is bounded and
  canonical-path deduplicated so a junction cannot re-enter it.
- Mentions are **absolute** paths, forward-slashed. A folder outside the workspace root
  has no relative spelling, and the prompt grammar already uses host paths.
- A discovery failure returns an empty group, never a rejection: autocomplete must not
  be able to break the composer.

## Security posture

The roots are granted by a file the user owns, so the agent must never be able to widen
its own roots by editing that file. The interceptor therefore refuses agent `write` /
`edit` against any `*.code-workspace` file and against the plugin store, with a message
that says the file is user-managed and points at the panel and the command.

**This is a tool-layer guarantee, not a sandbox guarantee.** An agent that writes a
`.code-workspace` file through a shell script is not stopped, because no path-level
check can see inside an opaque command. Because discovery adopts "the only
`.code-workspace` in the directory", such a file could in principle widen the roots.
The plugin states this rather than pretending otherwise; the residual risk is the same
one `dsh-multi-folder` carries for its config file.

## Known limitations

- **One writable root per command.** The Windows ACL runner grants a single workspace
  write SID per process tree, so a command launched elsewhere cannot create files
  inside an additional root — `git -C <root>`, `cd <root>` inside a script and
  absolute-path writes fail with an OS-level `Permission denied` carrying no sandbox
  marker. Lifting this needs an upstream change (`SandboxExecutionPolicy` carrying
  extra write roots and the ACL runner accepting several write SIDs).
- **A relative `workdir` never re-roots.** The shipped shell tools resolve it against
  the session workspace, so only an ABSOLUTE path into an additional root is
  intercepted.
- **An unparseable workspace file grants no roots.** The panel shows the syntax error
  and the Agent is told why; the user fixes it in their editor.
- **Up to a 2 s stale window.** A folder added in VS Code mid-session is picked up
  within the model TTL. During that window a write into the new folder falls through
  to the default pipeline and is refused by the session-root fence. The same window
  applies to the DERIVED ROOT: if the first existing folder changes on disk, the panel
  and the command pick that up on their forced re-read rather than mid-TTL.
- **Intercepted mutations do not participate in the `fs/write-intent` / `fs/edit-intent`
  guards** (the interception replaces the tool body), but a successful mutation does
  emit `fs/observed` with a presence observation, exactly like the shipped tools.
- **`presentationMeta` is not computed** on the short-circuit path; tool cards fall
  back to their default presentation.
- **`sandbox_permissions` escalation** on an intercepted call is passed to the default
  pipeline, which re-roots at the session root — escalation can never widen an
  additional root.
- **A background shell job is registered whenever `ctx.jobs` exists**; the plugin
  cannot read the shipped tools' per-tool `enableRunInBackground: false` config.
- **The creation-page entry uses `conversation.input.dock`, which the shell declares.**
  The panel also registers in `shell.overlay` (a click-through layer, so it opts back
  into pointer events). `conversation.hero.workspaceExtras` exists in some upstream
  builds but not in `0.2.0-rc.2`, so it is deliberately not used.
- **The View rests on the Conversation's own slot and on the layout service.** The cell is
  registered in `conversation.view` (declared by `client-ui-conversation`) and selected
  through `ctx.layout`; the registration is gated on the layout face, so a composition
  without a Conversation keeps the overlay as the panel's only surface instead of losing
  the feature. The view is also per session by construction: there is no cross-session
  page, and the creation page (no session yet) stays on the floating popover.
- **`uiWorkspace.openWorkspace` is optional.** Without it the plugin still registers
  the derived root and states so in the panel; the user picks the workspace in
  the picker.
- **The pnpm lockfile policy can block installation** on a profile that enables
  `minimumReleaseAge` and carries a recently published dependency. Unrelated to this
  plugin; the README documents the manual `link:` procedure.
- **The "Open In…" takeover rests on upstream slot ids.** It is registered against
  `conversation.session.header.utilities` and `sidebar.right.tab.files.actions` with
  id `open-in-app`; if a future shell renames either, the takeover is simply not
  rendered (the shipped control stays, and the panel buttons keep working). It also
  depends on the shipped locale namespace for its names: an application id that
  namespace does not name stays out of the list, exactly as the shipped control
  drops it.
- **No editor is configurable.** An exotic install that registers neither an
  `App Paths` entry nor an uninstall record, and that lies outside the conventional
  directories, will not be listed. Widening that means a config field (the previous
  `dsh-plugin-open-in-trae` had one); the family list is chosen over a config knob
  for now.
- **Icons for the added family members are 32px.** `ExtractAssociatedIcon` is the
  stock .NET ceiling; the shipped launcher documents the same limit. A sharper icon
  would need PE resource parsing rather than the associated-icon API.
- **Editor detection off Windows is PATH and bundle based.** Windows is the full
  implementation (registry plus conventional directories).

## Tests

`test/jsonc.test.mjs` (25), `test/workspace-file.test.mjs` (24), `test/host.test.mjs`
(50), `test/client.test.mjs` (46), `test/editor.test.mjs` (22) and
`test/workspace-picker.test.mjs` (10) — 177 cases — run with no DSH
runtime. The host tests use a fake `fs` seam, `systemPrompt`, `commands` registry and
`shell`/`jobs`; the editor tests inject the platform, environment, registry reader,
`PATH` lookup and file probe, and hand `launchEditor` a child-process double, so a test
run never starts an editor. The client test uses a minimal React shim whose hooks
resolve once per call, which turns every component into a plain function whose element
tree can be inspected and whose buttons can be clicked.

The new behaviour is pinned where it can be exercised without a DSH runtime: the
derived root and its fallbacks (`workspace-file.test.mjs`), the four-step resolution,
the tombstone, the v1 store, the per-session pick, the duplicate report and the
file-directory-rooted write (`host.test.mjs`), and the client's `sessionId`
attribution, the duplicate block and the active-FILE marking (`client.test.mjs`).

`tools/verify-instance.mjs` is the live counterpart: against a really booted throwaway
profile it checks the index injection, that the served client bundle registers this
package's factory with all three slot surfaces, the `@` source and the "Open In…"
takeover, that the `codeWorkspace/*` endpoints answer — including the two editor
refusals an unknown id must hit, neither of which launches anything — that `open`
registers the root its scratch workspace file derives (the file declares
`{ "path": "." }`, so the derived root is the scratch directory itself), that `state`
resolves a real `.code-workspace` sample with its three folders, and that a folders
write-back through the real sandboxed `fs` seam preserves comments and untouched
members. Its check is named for what it asserts —
`open registers the root the file derives as a DSH workspace` — because the scratch
file's `{ "path": "." }` is what makes that derived root equal the scratch directory.
