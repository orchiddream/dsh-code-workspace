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

> **cwd = the directory holding the `.code-workspace` file** (the *container
> directory*), and every `folders[]` entry is an *additional root*.

Consequences that follow from this and are not bugs:

- `workspaceRegistry` gets a real directory, so DSH's own workspace list, session
  grouping and archive logic keep working untouched.
- The workspace file itself lives in the session cwd, so the user can see and edit it
  from the same session.
- A folder that resolves to the container directory is not an "additional" root — it
  is already the sandbox root. `stateOf()` marks it `isPrimary`; `extraRootsFor()`
  drops it.
- A file whose folders are all *outside* the container directory (the common case for
  a container that only holds the `.code-workspace`) yields additional roots for all
  of them.

## Planes

| Half | File | Role |
| --- | --- | --- |
| Text | `lib/jsonc.js` | JSONC reader; **surgical** single-member writer |
| Model | `lib/workspace-file.js` | VS Code path rules, folders CRUD, serialization. Pure, no fs |
| Editor family | `lib/editor.js` | Which VS Code-family editor this host holds, the child environment, the launch |
| Editor icon | `lib/editor-icon.js` | Associated-icon extraction for the family entries no shipped route serves |
| Host | `lib/index.js` | Discovery, caching, `tools/execute` interception, prompt section, notices, `/code-workspace`, sessionless `codeWorkspace/*` API, `@` discovery, editor endpoints |
| Client | `lib/client.js` | Session header button, session-creation dock chip, overlay panel, "Open In…" takeover, `@` companion group |

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

## Discovery

The active workspace file for a session directory `C`:

1. a file already recorded in the plugin store whose *own* directory is `C` (the user
   opened it explicitly) — authoritative;
2. otherwise, while the discovery cache is cold, the **single** `*.code-workspace`
   file in `C`, which is then recorded;
3. two or more candidates is ambiguous and resolves to nothing. Silently picking one
   would grant roots the user never chose.

A directory with no workspace file makes the plugin **completely inert**: the prompt
section renders the empty string, the interceptor falls through before doing any
work, and every endpoint answers an empty state.

The store (`<DSH_HOME>/storages/code-workspace/index.json`) is a single JSON file
listing known workspace files, most recently opened first. It is written only from
user-initiated flows and lives outside every agent sandbox root.

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
   fenced against the *primary* root — surfacing as a spurious
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
`read-only` keeps denying in an additional root exactly as in the primary one.

**Ownership rule.** Once a target has been resolved into an additional root the
interception OWNS the call: a later failure is reported as that call's own error
(including the `FS_*` code, and the one-shot escalation hint for a genuine
`FS_SANDBOX_DENIED`) and never handed back to the default pipeline, which fences
against the primary root and would replace a real cause — a missing `old_string`, a
locked file — with a spurious sandbox denial.

**Lazy service resolution.** `shell`, `shellEnv`, `jobs`, `commands`, `typert`,
`workspaceRegistry` and `directoryPicker` are resolved per call, never captured at
apply time: loader rows activate in dependency order, so a capture can be `undefined`.
The command and the Typert contribution ride `ctx.inject`, which fires whenever the
service appears.

## Prompt section

One global `systemPrompt.section` (`code-workspace:roots`, order 165 — after the tool
guidance range 100–129) whose text provider evaluates per assembly and renders only
for sessions that have a workspace file. It lists the file, the container directory and
every folder with its primary/missing state, states the one-writable-root-per-command
rule and the absolute-`workdir` requirement, and states that the workspace file is
user-managed.

For a file that failed to parse the section still renders, saying so — the Agent must
know why no folders are available rather than silently getting none.

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

## Sessionless remote API

The session-creation page has no session, so the agent-scoped `commands/execute` remote
cannot serve it. The plugin opens its own namespace on the shared `/api` channel:

- a plain-object service registered with `ctx.provide('codeWorkspace', api)`, carrying
  the frozen `typertRemote` binding the gateway's `validateBinding` expects;
- a hand-written Typert contribution using `src-json` codecs and
  `invocation: { kind: 'direct' }`, registered through `ctx.inject(['typert'], …)`.

Fifteen endpoints, keyed by **paths** rather than a session id: `state`, `recent`,
`open`, `forget`, `useFile`, `create`, `addFolder`, `removeFolder`, `renameFolder`,
`moveFolder`, `browse`, `makeDir`, `pick`, `reveal`, `listFiles`.

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
`Trae CN.exe <file.code-workspace>`. So the target is the file, and the container
directory is only the fallback for a session that has none (or whose recorded file
is gone, which the panel already marks as missing).

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
  to the default pipeline and is refused by the primary-root fence.
- **Intercepted mutations do not participate in the `fs/write-intent` / `fs/edit-intent`
  guards** (the interception replaces the tool body), but a successful mutation does
  emit `fs/observed` with a presence observation, exactly like the shipped tools.
- **`presentationMeta` is not computed** on the short-circuit path; tool cards fall
  back to their default presentation.
- **`sandbox_permissions` escalation** on an intercepted call is passed to the default
  pipeline, which re-roots at the primary workspace — escalation can never widen an
  additional root.
- **A background shell job is registered whenever `ctx.jobs` exists**; the plugin
  cannot read the shipped tools' per-tool `enableRunInBackground: false` config.
- **The creation-page entry uses `conversation.input.dock`, which the shell declares.**
  The panel also registers in `shell.overlay` (a click-through layer, so it opts back
  into pointer events). `conversation.hero.workspaceExtras` exists in some upstream
  builds but not in `0.2.0-rc.2`, so it is deliberately not used.
- **`uiWorkspace.openWorkspace` is optional.** Without it the plugin still registers
  the container directory and states so in the panel; the user picks the workspace in
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

`test/jsonc.test.mjs` (25), `test/workspace-file.test.mjs` (22), `test/host.test.mjs`
(43), `test/client.test.mjs` (25) and `test/editor.test.mjs` (22) run with no DSH
runtime. The host tests use a fake `fs` seam, `systemPrompt`, `commands` registry and
`shell`/`jobs`; the editor tests inject the platform, environment, registry reader,
`PATH` lookup and file probe, and hand `launchEditor` a child-process double, so a test
run never starts an editor. The client test uses a minimal React shim whose hooks
resolve once per call, which turns every component into a plain function whose element
tree can be inspected and whose buttons can be clicked.

`tools/verify-instance.mjs` is the live counterpart: against a really booted throwaway
profile it checks the index injection, that the served client bundle registers this
package's factory with all three slot surfaces, the `@` source and the "Open In…"
takeover, that the `codeWorkspace/*` endpoints answer — including the two editor
refusals an unknown id must hit, neither of which launches anything — that `state`
resolves a real `.code-workspace` sample with its three folders, and that a folders
write-back through the real sandboxed `fs` seam preserves comments and untouched
members.
