# dsh-code-workspace

**English** | [中文](README.zh.md)

> VS Code–compatible multi-root workspaces for DeepSeek Harness. A `.code-workspace` file is the single source of truth: the session is rooted at its **first `folders[]` entry that exists on disk**, every other folder becomes an additional root, and the same file is what "open in an editor" hands to the editor — so the window you look at shows the same folders the session writes to.

Zero build step — `lib/index.js` is plain ESM for the Host, `lib/client.js` is a hand-written DSH client-modules factory bundle.

---

## Mapping onto VS Code

| VS Code / Trae | This plugin |
| --- | --- |
| `.code-workspace` file (JSONC) | The same file, the same grammar |
| `folders[].path` | Same; a `./` or `../` prefix is **always** relative, `C:\x` / `/x` / `\\server\share` are absolute, everything else is relative |
| `folders[].name` | Same (display name) |
| `//` and `/* */` comments, trailing commas | Same; a write-back is **byte-preserving** and rewrites only the `folders` member |
| Unknown members (`settings` / `extensions` / `launch` / `tasks` / `trae` / your own) | Preserved verbatim |
| Extra keys inside one folder entry (newer VS Code writes an `icon`) | Preserved verbatim |
| A multi-root window | The session root is the **first `folders[]` entry that exists on disk**; every other folder becomes an additional root, and the file's own directory only says where the file lives |
| Opening the window from Harness | The editor is launched with the `.code-workspace` file itself: `Code.exe <file>` / `Trae CN.exe <file>` — the VS Code family's own CLI contract for "open this multi-root workspace", which the shipped "Open In…" route cannot express (it validates a directory) |
| A malformed workspace file | The panel shows the exact line/column; no roots are granted (fail closed) |

A DSH workspace is a **single directory**, and `workspaceRegistry.create()` refuses anything that is not one, so the plugin derives the session root from the file: the first folder that exists on disk, and the file's own directory only when no folder qualifies.

### Terminology

| Term | Meaning |
| --- | --- |
| **session root** / **root directory** (`rootDir`) | The directory the session is rooted at: the file's first `folders[]` entry that exists on disk, or the file's own directory when none qualifies. It is the DSH workspace directory the plugin registers and the sandbox's own root. |
| **file directory** (`fileDir`) | Where the `.code-workspace` file lives. It holds the file; it is not a root. |
| **additional root** | Every `folders[]` entry except the root. Writable through `workdir` re-rooting; see the permission model. |

Why the file's own directory is not the root: DSH identifies a workspace by its root's canonical path, so a user who keeps every `.code-workspace` file in one folder would get a session rooted at a directory holding no code, with every file in that folder collapsing onto the SAME DSH workspace. Two files that derive the same root *are* one DSH workspace and cannot be split — that part is a documented hard limit (see `docs/design.md`), and the plugin's answer is a deterministic per-file root, an explicit per-session association, a fail-closed tie, and the duplicate reported in the panel and the prompt.

---

## Requirements

- Node.js >= 20
- DeepSeek Harness `0.2.0-rc.2` (the version this was verified against)

## Install

Published on npm as [`dsh-code-workspace`](https://www.npmjs.com/package/dsh-code-workspace).

### Into the desktop app

Settings → **Plugins** → **Add plugin** → `dsh-code-workspace` → Install → Enable now. Leave the registry at pnpm's own or the **mainland-China mirror** (`registry.npmmirror.com`, synced automatically); do not put a GitHub URL in the registry field, or pnpm re-resolves the whole profile against it and every install fails.

A `desktop` profile is owned exclusively by the Electron application: `dsh plugin --profile desktop add …` from a terminal is **refused outright** (`@deepseek-ai/dsh/lib/bin.js:36`), so the in-app page is the supported route.

### Into any other profile

```bash
dsh plugin --profile web add dsh-code-workspace
```

A Git address (`github:orchiddream/dsh-code-workspace`) works too, but DSH pre-checks GitHub with `git ls-remote` and pnpm then re-resolves the profile at the chosen registry, so that route needs working HTTPS to github.com.

### From a checkout (development)

A `link:` dependency needs neither the network nor a package manager, so mount it with the script this repo ships:

```bash
node tools/profile-link.mjs install --profile desktop --dry-run   # see exactly what it would change
node tools/profile-link.mjs install --profile desktop             # do it (backs up package.json first)
```

It performs precisely what `pnpm add link:<dir>` would have done, and nothing else:

1. `dependencies["dsh-code-workspace"] = "link:D:/kjsjs/deepseek/dsh-multiroot-workspace"` in the profile's `package.json`
2. `"dsh-code-workspace"` appended to `dsh.profile.bundles`
3. a directory junction at `<profile>\node_modules\dsh-code-workspace` pointing at this repo

Measured behaviour: **a running DSH application hot-applies this composition change — no restart needed.** Reload the page and the "Code Workspace" button is in the session header. If the entry does not appear, restart the backend.

```bash
node tools/profile-link.mjs status    --profile desktop   # current state
node tools/profile-link.mjs uninstall --profile desktop   # remove it (only the junction it created)
```

The script is idempotent, backs up `package.json` before writing, and only removes a junction it can prove points at this plugin.

### The pnpm supply-chain policy

DSH profiles run pnpm with a fresh-release hold (`minimumReleaseAge`, 24 h here). Two consequences:

- A version published minutes ago stays installable: pnpm exempts it and appends it to `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`.
- Every install first verifies the **whole** lockfile against that policy, and pnpm honours **only the first rule per package name** ([pnpm#732](https://github.com/pnpm/pnpm/issues/732)). If the file carries two rules for one name the second is ignored, and the profile is locked out of every installation until they are merged:

  ```yaml
  minimumReleaseAgeExclude:
    - dsh-ide-git@0.18.4 || 0.18.5 || 0.18.6
  ```

  The plugin market merges duplicate rules automatically before its own runs; a hand-edited profile may need the merge. This is environment state, unrelated to `dsh-code-workspace`.

### ⚠️ `dsh-multi-folder` must be disabled

Both plugins listen on the `tools/execute` waterfall and re-root the sandbox. Running both means duplicate interception and duplicate prompt injection. Remove `"dsh-multi-folder"` from `dsh.profile.bundles` (the dependency itself can stay).

### ⚠️ `dsh-plugin-open-in-trae` is superseded (and harmless meanwhile)

That plugin adds Trae to the shipped "Open In…" menu by shadowing that control's cell. This plugin now does the same job for the whole VS Code family, at a **different priority**, so the two can coexist without colliding — this one renders, the other stays registered underneath. Running both is only redundant; retire the other one when you are ready:

```bash
node tools/profile-link.mjs uninstall --profile desktop --package dsh-plugin-open-in-trae --dry-run
node tools/profile-link.mjs uninstall --profile desktop --package dsh-plugin-open-in-trae
```

A foreign package is retired only when the profile links it from disk (a `link:` dependency), so the script can never pull a registry package out from under pnpm. `status` now prints a note when the superseded plugin is still bundled.

---

## Usage

### Opening a workspace

Five entries, one workspace file:

| Entry | Where |
| --- | --- |
| **The left column** | a "Code Workspace" row in the sidebar panel list, beside the shipped Plugins and Scheduled-tasks rows — **openable with no session and no workspace** |
| **Session-creation page** | the "Code Workspace" chip above the composer, in the same band as the git-branch chip |
| **The panel's tab** | the "Code Workspace" tab beside Chat / Trajectory / Git, for the whole life of the session |
| **Session header** | the same action as a header button — present only in a composition where that tab could not register |
| **Slash command** | `/code-workspace use <path>` |

The left-column row is the one entry that needs nothing else to exist: it is a `sidebar.panellist` cell (`id` `code-workspace`, order 5 — between Plugins at 0 and Scheduled tasks at 10) whose click runs the shell's `layout.selectPanel('code-workspace')`, and that id is also the key of this bundle's `main` cell and of its Conversation view. So the sidebar row, the Conversation tab and that panel id all address **one page**, and the page is sessionless: it reads the host over the shared RPC channel and can register a workspace before any session exists.

The panel can browse the filesystem for a `.code-workspace` file or create a new one. Once one is chosen, the plugin calls `workspaceRegistry.create()` to register that file's **derived root** — its first existing folder — as a DSH workspace and — when the client composition exposes `uiWorkspace` — switches the session straight to it. Inside a session the pick rides the `/code-workspace` channel, so the choice is attributed to the session that made it: two sessions rooted at the same directory can each run a different workspace file.

**Choose in Explorer…** opens the host's own file dialog, filtered to `*.code-workspace`, so the common case does not need the in-app browser at all. The shipped picker seam only answers directories (its native capability opens the platform dialog with a pick-folders flag), so this is the file-shaped sibling: a generated PowerShell script over the same absolute `powershell.exe`, with `-STA` because the common file dialog is apartment-threaded, and the chosen path read from a file rather than parsed out of stdout. Three answers, all meaningful: a path is opened; a **cancel** is silent, because it is the operator's choice; **unavailable** explains itself once — non-Windows, or the operator is not at the host's screen (SSH) — and the in-app browser below stays right there. The dialog is a host-desktop affair; over SSH it deliberately does not appear.

**With nothing associated yet, the page is the picker.** A session created in a directory that holds no `.code-workspace` file (or that holds several) shows the panel's empty state with **Switch file** and **New workspace file** right there — you do not have to create the session in the right directory first. With nothing to go on, the browser starts at the **host home**, not at the session's own directory, because the file you are looking for is usually somewhere else; once a file IS associated, **Switch file** and the host dialog start at that file's own directory instead, so a user who keeps their workspace files together switches between them without navigating back each time. Picking one registers its derived root as the DSH workspace and, when `uiWorkspace` is available, switches the current session to it — which is how an already-open session ends up on a real workspace without leaving the tab.

Independently, **if the session's cwd holds exactly one `.code-workspace` file the plugin adopts it automatically** and records it, so in that case there is nothing to do: just create the session in that directory. Two or more candidates is ambiguous and resolves to nothing — pick one in the panel. The same directory full of several workspace files therefore grants nothing on its own: each file has its own root, and only an explicit pick decides which one a session is on. A root that is named by more than one file says so in the panel — "other workspace files naming the same root", one clickable row per file, and the same fact in the prompt — because DSH keys a workspace by its root's canonical path, so those files are one DSH workspace and only an explicit per-session choice keeps them apart.

**Unlink** clears the association with a **tombstone** (`file: null`), rather than by dropping the record: a root holding exactly one workspace file would otherwise be re-adopted on the very next read and the button would look like it does nothing. The tombstone clears the *root's* records for everyone, while other sessions at that root keep their own per-session pointers; the panel then reports honestly that the root has no file.

### The `/code-workspace` command

```
/code-workspace                       # same as list
/code-workspace list                  # file path + its directory + every folder, numbered
/code-workspace add <path> [name]     # relative to the FILE's directory, or absolute
/code-workspace remove <index|path|name>
/code-workspace rename <index|path> <name>
/code-workspace move <index> <toIndex>
/code-workspace use <file.code-workspace>
/code-workspace use                   # no argument: clear this session's association
/code-workspace create <name>         # create in the root directory, seeded with it
/code-workspace reload                # drop the cache and re-read
```

Folders changed from inside a session are announced to the Agent at the **next message boundary** (the next user send or tool-call end) through the framework's native `notice` channel; a running turn is never interrupted.

### The panel

Two surfaces, one body. The panel's page is a **Conversation view** — a tab beside the shipped Chat / Trajectory / Git tabs, at the top of the centre column. The tab is the entry point: it is visible for the whole session. The session-creation chip opens the same body as a floating popover, because that page has no session yet — and that popover is the creation page's only surface.

| Surface | Opened by | Notes |
| --- | --- | --- |
| **Conversation view** | its tab in the strip | cell `code-workspace` (order 30) in the list slot `conversation.view`; per session |
| **Floating popover** (`shell.overlay`) | the session-creation chip | the same body on the sessionless channel: the one place a `.code-workspace` file can be picked before a session exists |

The view belongs to the session it is drawn for, and it addresses that session's own directory — so a panel left on one session never drives another. React mounts it when its tab is selected and unmounts it when the user leaves, so one read per mount is exactly "show me the current state"; the ⟳ button re-reads on demand.

The session header button exists **only in the degraded composition** where that cell could not register — there the tab does not exist and the button is the only way into the page. When the tab is there the button removes itself: two entry points for one page is noise, and a header click that also opened a floating copy of the page was worse than a click that does nothing.

Every surface shows the workspace file path, the **workspace root** it derives, the file's own directory when it differs from that root, every folder (display name, real path, primary/missing badges) and, when the root is named by more than one file, an "other workspace files naming the same root" block with one clickable row per file. It offers:

- **Add folder** — a relative or absolute path plus an optional display name; a missing or non-directory path is refused
- **Move up / down** — reorder `folders`
- **Rename** — set `folders[].name`
- **Remove**
- **Show in file manager**
- **Open in editor** — one button per VS Code-family editor found on the host (see below)
- **Switch file** / **Recent** / **New workspace file** / **Unlink**

The workspace list marks the **active file**, not the directory: two files can derive the same root — DSH then treats them as one workspace — so marking by root would light up every row and tell the user nothing.

#### The Conversation view (the tab in the centre column)

The page registers as one cell in the `conversation.view` slot: `slots.register({ name: 'conversation.view', id: 'code-workspace', order: 30, label: () => 'Code Workspace', locale: NS }, WorkspaceView)`. That slot is the list behind the Chat / Trajectory / Git strip — its owner walks the entries and renders one at a time by id, so one registration is enough, and order 30 puts it after the shipped Chat (0) and Trajectory (10). Once it is selected:

- The page fills the Conversation's own view area, so there is no second column: its content is held to the Conversation's own reading width (`--dsh-chat-content-width`, with a fallback) and it scrolls internally.
- Closing is the tab strip's job, so this page carries **no ✕**; a hint line takes its place. The ⟳ button beside the title stays, as in the floating panel.
- The page is **per session**: the owner hands the cell the standard session kit, so it reads `props.sessionId` and that session's `cwd`. Switching sessions re-points the shared panel state and drops the previous session's state — otherwise a panel opened on session A would send `/code-workspace` into session B.
- React mounts this when its tab is selected and unmounts it when the user leaves, so one read per mount is exactly "show me the current state" — no read window and no throttle. The ⟳ button forces a re-read.

Two surfaces, one difference: the tab strip closes the Conversation view, while the floating panel (`shell.overlay`) keeps its ✕. **The overlay is not the view's fallback path**: it is the creation page's alone — that page has no session, so a floating popover is the only way to pick a `.code-workspace` file there. It draws only when the store says the creation page opened it, and opening the Conversation view closes it, so one panel never appears twice on screen.

**Known boundary**: the Conversation view needs a session — the owner's session kit is its only source for the session root (`props.sessionId` → that session's `cwd`), so the session-creation page cannot use it and falls back to the floating popover. It also rests on two upstream facts: `conversation.view` gets the cell claimed by the tab strip, and `ctx.layout` (the package that declares that slot) selects it. Without the layout service the cell does not register at all, and only then does the session-header button render as the degraded entry point; and even when the cell registers, a `selectPanel` that refuses this id leaves a header click doing nothing.

### Opening the workspace in an editor

Two entries, one behaviour: the editor opens the **workspace file**.

| Entry | Where |
| --- | --- |
| **Panel section** | "Open in editor" in the panel: one button per editor this host can prove |
| **"Open In…" menu** | The shipped session-header and file-tree control, which this plugin takes over (see below) |

The family, in the order the panel offers it and the automatic choice follows it:

`VS Code` · `VS Code Insiders` · `VSCodium` · `Cursor` · `Windsurf` · `Trae` / `Trae CN`

- With a `.code-workspace` file associated, the launch is `<editor> <file.code-workspace>`: the multi-root window whose folders are exactly this session's roots. A workspace-file path argument is the family's own CLI contract, and it is precisely what the shipped "Open In…" route cannot express — that route validates an absolute **directory**, so every shipped VS Code entry can only ever open a single-folder window.
- Without one, the session root is opened instead. The button's tooltip names the executable and the target, so the fallback is visible before the click.
- An editor is listed only when the file system proves it **twice**: the file exists, and its basename is still that member's own executable name (`Code.exe`, `Code - Insiders.exe`, `VSCodium.exe`, `Cursor.exe`, `Windsurf.exe`, `Trae.exe`, `Trae CN.exe`). Registry records and `PATH` supply candidates, never conclusions.
- Windows is the full implementation: `App Paths`, uninstall records (`DisplayIcon`, then `InstallLocation`), `PATH`, then the conventional install directories. macOS and Linux use the CLI names on `PATH` plus the application bundles.
- An SSH-reached session reports no editors at all: the browser's desktop is not the host's.

**The "Open In…" takeover.** The shipped catalog is a compile-time table and its browser half filters ids through its own label map, so a deployment cannot add an editor to that menu from configuration. This plugin therefore registers the *same slot id* (`open-in-app`) on the two directory-scoped cells — `conversation.session.header.utilities` and `sidebar.right.tab.files.actions` — at **priority -2**. The slots ledger renders the lowest priority per id, so this cell wins while the shipped registration stays live underneath (dispose this plugin and the shipped control returns untouched) and `dsh-plugin-open-in-trae`'s -1 registration stays valid. Every other application keeps its shipped name, icon, route and behaviour; only the family ids are re-routed to this plugin's launcher, and `VSCodium`, `Trae`/`Trae CN` are added because the shipped catalog has no entries for them at all. If the shell does not publish the UI primitives the menu is drawn with, the takeover is skipped entirely and the shipped control stays in place.

The remembered editor is stored per browser under `dsh.code-workspace.editor`; the keyboard shortcut the shipped plugin owns (`Ctrl+Alt+O`) is deliberately untouched.

### The `@` menu

Typing `@` adds one group per folder beside the built-in workspace group. An empty query lists the folders as entry points, `@main` ranks across every root, and `@dsh-nl/src/` or `@D:/repo/src/` descends a level.

A pick inserts an **absolute-path** mention (`@D:/repo/src/main.ts`), because an additional root lies outside the session root and no relative path can reach it. This is a **companion group** — the built-in menu is not modified.

---

## Permission model

### One writable root per command

The DSH sandbox (the Windows ACL runner) grants each process tree exactly **one** workspace-write SID. Therefore:

- A command whose cwd stays in the session root **cannot** create files inside an additional root. `git -C <root>`, `cd <root>` inside a script, `git clone <url> <root>`, and absolute-path writes all fail with an OS-level `Permission denied`.
- Symmetrically, a command re-rooted to one additional root cannot write the session root or another root in the same invocation.
- **A file-creating command MUST set `workdir` to the directory it writes into, and it must be an absolute path.** A relative `workdir` resolves against the session root only. Changing the process directory inside the command (`Set-Location` / `cd`) does **not** widen the writable root.
- The same rules apply to background runs (`run_in_background: true`).
- Reads are unfenced and need no `workdir`.

This rule is injected into the system prompt, so the Agent knows it.

### The workspace file is user-managed

Because a `.code-workspace` file decides which directories this session may write, the plugin **refuses agent `write` / `edit` against any `*.code-workspace` file** (and against its own store). An agent therefore cannot widen its own roots by editing the workspace file — add or remove folders from the panel, the command, or your editor.

**Known boundary**: this is a tool-layer guarantee, not a sandbox guarantee. An agent that writes a `.code-workspace` file through a script (`pwsh` / `bash`) is not stopped, because no path-level check can see inside an opaque command. And since the plugin adopts "the only `.code-workspace` in the directory", an agent able to create such a file could in principle exploit that. The plugin documents this boundary rather than pretending to close it.

### Two files with the same root cannot be split

A Workspace's identity in DSH is its root directory's `realpath`-canonicalised path, so two `.code-workspace` files whose first existing folder is the same directory **are** one DSH workspace, and no plugin can split them. The plugin does not pretend otherwise. What it does instead:

- a **deterministic per-file root** — first existing folder, so two files in one directory land on different roots whenever their folder sets differ;
- an **explicit per-session association** — the file a session picked wins over the root's record, so two sessions at one root can run different folder sets;
- a **fail-closed tie** — no explicit choice and more than one candidate grants nothing;
- the **duplicate reported** in the panel ("other workspace files naming the same root", one clickable row per file) and in the system prompt, so the agent never assumes the folder set it sees is the only one that exists.

---

## How it works

| Layer | File | Responsibility |
| --- | --- | --- |
| JSONC | `lib/jsonc.js` | Parse comments / trailing commas / BOM; **surgically** rewrite one top-level member and leave every other byte alone |
| Workspace model | `lib/workspace-file.js` | VS Code path rules, folders add/remove/reorder/rename, serialization, and `deriveRoot` (the file's first existing folder); pure functions, no fs |
| Editor family | `lib/editor.js` | Which VS Code-family editor this host holds (proved, never assumed), the child environment an Electron editor needs, and a launch whose success is decoupled from the editor's lifetime |
| Editor icon | `lib/editor-icon.js` | One executable's associated icon for the family entries no shipped route serves; verified payload or nothing |
| File dialog | `lib/workspace-picker.js` | The host's own file dialog for a `.code-workspace` file — the file-shaped sibling of the shipped directory-only picker; three outcomes (picked / cancelled / unavailable), injectable runner, no dialog in any test |
| Host | `lib/index.js` | Discovery and caching, `tools/execute` re-rooting, prompt injection, notices, `/code-workspace`, the sessionless `codeWorkspace/*` remote API, `@` discovery, the editor and file-dialog endpoints |
| Client | `lib/client.js` | The left-column entry and its sessionless central panel, the Conversation view page, its header-button fallback (degraded compositions only), the session-creation dock chip and its popover, the "Open In…" takeover, `@` companion group |

- **Discovery**: for a session rooted at `C`, the active file is (1) the file THIS SESSION picked, (2) `C`'s most recent explicit record — a tombstone there stops the search — (3) **adoption**: `C` holding exactly one `.code-workspace` file, (4) nothing, which makes the plugin inert for that session. Two or more candidates is a fail-closed tie. The old rule — "the recorded file whose *directory* is `C`" — is gone: with several files in one folder it returned whichever happened to be recorded first.
- **Caching**: model 2 s, discovery 3 s, `@` index 4 s. `fs.stat` metadata is deliberately **not** used for invalidation — the fields an `FsInfo` carries are not part of the plugin-facing contract, so a stamp built from them could silently never change and pin a stale root set for a whole session. Panel and command reads always force a fresh parse, so the derived root is recomputed on every such read.
- **Interception**: when a `write` / `edit` / `pwsh` / `bash` target lands in an additional root, the call is serviced with `{ ...standingPolicy, workspaceRoot: <that root> }`. The **mode is never touched**, so `read-only` still denies, `workspace-write` still allows, and `danger-full-access` still allows. Background runs register with `ctx.jobs` under the same policy.
- **Sessionless channel**: `ctx.provide('codeWorkspace', api)` plus hand-written `src-json` Typert descriptors, keyed by **path** rather than a session id, so the session-creation page — which has no session yet — can read and edit the workspace file. `sessionId` is an optional extra parameter (`acceptsUndefined: true`) on the eleven endpoints whose answer can depend on which session asked — `state`, `open`, `forget`, `useFile`, `create`, `addFolder`, `removeFolder`, `renameFolder`, `moveFolder`, `openInEditor`, `listFiles`. Without it the answer is the per-root association, which is exactly what a new session inherits.
- **State**: one host state object — `rootDir`, `fileDir`, `file`, `title`, `roots[]` (each with `isPrimary`, true only for the folder equal to the root), `extraRoots`, `conflict` (the other files naming this root), plus `warnings`, `error` and `indent`.
- Config and the associations live in `<DSH_HOME>/storages/code-workspace/index.json`, outside every agent sandbox root and under a write guard. The store is `{ version: 2, files, roots: [{ root, file }], sessions: [{ session, file }] }`, most recent first, capped at 200 records per list. A v1 store keeps its `files` and invents no association; the first explicit pick writes one.

---

## Development and tests

```bash
npm test          # = node --test "test/**/*.test.mjs"
```

Six files, 177 cases, **no DSH runtime required**: a fake `fs` seam, a fake `systemPrompt`, a fake `commands` registry, fake `shell`/`jobs`, a fake host for the editor family (registry, `PATH` and file set injected), an injected dialog runner (so no test can open a real file picker), and a minimal React shim on the client side (hooks resolve once per call and function components are expanded recursively), so the rendered tree can be inspected and clicks simulated directly.

```bash
node test/jsonc.test.mjs              # 25 — JSONC parsing and comment-preserving rewrites
node test/workspace-file.test.mjs     # 24 — VS Code path rules, folders CRUD, the derived root
node test/host.test.mjs               # 50 — discovery, the store, re-rooting, refusals, command, remote API, @ discovery, editor guards
node test/client.test.mjs             # 46 — bundle contract, slot registrations, panel interaction, the duplicate-root block, Open In… takeover, @ source
node test/editor.test.mjs             # 22 — family resolution, proof-before-launch, child environment, launch outcomes, icons
node test/workspace-picker.test.mjs   # 10 — the host file dialog's three outcomes, its injected runner
```

Nothing in the editor tests launches an editor: the resolver's registry, `PATH` and file probes are injected, and `launchEditor` is handed a child-process double.

### Live verification

`tools/verify-instance.mjs` checks a **really booted** DSH instance end to end (index injection, whether the client bundle is served — including the "Open In…" takeover markers, the `codeWorkspace/*` endpoints and the two editor refusals an unknown id must hit, that `open` registers the derived root of a scratch workspace file, and a folders write-back through the real sandbox with comment preservation):

```bash
# a throwaway profile, so your desktop profile is never touched
dsh cwsverify --from-default-profile web --dump-config      # confirm the composed tree first
# link manually, then boot (--port 0 picks a free port)
dsh --profile cwsverify --port 0 --no-open
node tools/verify-instance.mjs "http://127.0.0.1:<port>/?token=<token>"
```

Measured on `0.2.0-rc.2`: **30/30** — the 25 checks it made before the editor feature, plus the five added with it (the served bundle carries the takeover, `codeWorkspace/editors` answers the family, and the two refusals an unknown id must hit). It never launches an editor: both editor calls it makes are refusals by construction. Its scratch workspace file declares `{ "path": "." }`, so the root the plugin derives from it is that scratch directory itself, and the check named `open registers the root the file derives as a DSH workspace` asserts that derived root rather than the directory holding the file.

The Conversation view page is **not covered by that script** (it asserts host endpoints and bundle markers, not rendered UI): its registration, its entry point, its toggle, its degraded no-op and its per-session scoping are pinned by `test/client.test.mjs`. Rendering it inside a real Conversation tab strip has not been observed in a live browser yet. The same holds for the left-column row and the host file dialog: their registrations, their decisions and their fallbacks are pinned by tests, but the dialog itself has not been opened on a real desktop yet.

---

## Layout

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Host plugin |
| `lib/client.js` | Client factory bundle |
| `lib/jsonc.js` | JSONC reader + comment-preserving writer |
| `lib/workspace-file.js` | `.code-workspace` model, path rules, and `deriveRoot` — the file's first existing folder |
| `lib/editor.js` | VS Code-family discovery, child environment, launch |
| `lib/editor-icon.js` | Executable icon extraction for the family entries without a shipped icon route |
| `lib/workspace-picker.js` | The host's own file dialog for a `.code-workspace` file, as the file-shaped sibling of the shipped directory-only picker |
| `cordis.patch.yml` | Profile patch layer inserting the `dsh-code-workspace` row |
| `test/` | Behaviour tests, no DSH runtime |
| `tools/profile-link.mjs` | Link / unlink the plugin into a DSH profile without pnpm; `--package` retires a superseded one |
| `tools/verify-instance.mjs` | End-to-end checks against a live instance |
| `tools/probe-index.mjs` | Dump one instance's index and report bundle injection |
| `docs/client-contract.md` | The DSH 0.2.0-rc.2 client-plugin contract, citation-anchored |
| `docs/design.md` | Architecture and invariants |

## License

MIT
