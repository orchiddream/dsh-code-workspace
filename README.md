# dsh-code-workspace

**English** | [中文](README.zh.md)

> VS Code–compatible multi-root workspaces for DeepSeek Harness. A `.code-workspace` file is the single source of truth: its `folders` array becomes the session's writable roots, exactly as in VS Code, Trae and Cursor.

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
| A multi-root window | Session `cwd` = the **directory holding the `.code-workspace` file**; every `folders[]` entry becomes an additional root |
| A malformed workspace file | The panel shows the exact line/column; no roots are granted (fail closed) |

A DSH workspace is a **single directory**, and `workspaceRegistry.create()` refuses anything that is not one, so opening a `.code-workspace` file means: register its directory as the DSH workspace, and treat the file's folders as extra writable roots.

---

## Requirements

- Node.js >= 20
- DeepSeek Harness `0.2.0-rc.2` (the version this was verified against)

## Install

A `desktop` profile is owned exclusively by the Electron application: `dsh plugin --profile desktop add …` is **refused outright** (`@deepseek-ai/dsh/lib/bin.js:36`). Installing from the in-app plugin manager runs pnpm, and pnpm verifies the profile's **whole** `pnpm-lock.yaml` before installing — so a lockfile containing any package younger than `minimumReleaseAge` makes *every* install fail, regardless of which plugin you are adding (see "The pnpm policy" below).

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

### The pnpm policy (why the GUI install fails)

The profile's `pnpm-workspace.yaml` carries a `minimumReleaseAgeExclude` list, which means pnpm's `minimumReleaseAge` supply-chain policy is active on this machine. That check runs over the **lockfile as a whole**, not over the package being installed, so a single "too new" entry (here `@michengai/dsh-skills-manager@1.1.21`) rejects every installation. It is a pre-existing environment condition, unrelated to `dsh-code-workspace`; the manual link above bypasses pnpm entirely and is unaffected.

### ⚠️ `dsh-multi-folder` must be disabled

Both plugins listen on the `tools/execute` waterfall and re-root the sandbox. Running both means duplicate interception and duplicate prompt injection. Remove `"dsh-multi-folder"` from `dsh.profile.bundles` (the dependency itself can stay).

---

## Usage

### Opening a workspace

Three entries, same effect:

| Entry | Where |
| --- | --- |
| **Session-creation page** | the "Code Workspace" chip above the composer, in the same band as the git-branch chip |
| **Session header** | the "Code Workspace" button beside the session title |
| **Slash command** | `/code-workspace use <path>` |

The panel can browse the filesystem for a `.code-workspace` file or create a new one. Once one is chosen, the plugin calls `workspaceRegistry.create()` to register the container directory as a DSH workspace and — when the client composition exposes `uiWorkspace` — switches the session straight to it.

Independently, **if the session's cwd holds exactly one `.code-workspace` file the plugin adopts it automatically** and records it, so in the common case there is nothing to do: just create the session in that directory. Two or more candidates is ambiguous and resolves to nothing — pick one in the panel.

### The `/code-workspace` command

```
/code-workspace                       # same as list
/code-workspace list                  # file path + every folder, numbered
/code-workspace add <path> [name]     # relative to the container dir, or absolute
/code-workspace remove <index|path|name>
/code-workspace rename <index|path> <name>
/code-workspace move <index> <toIndex>
/code-workspace use <file.code-workspace>
/code-workspace create <name>         # create in the container dir, seeded with it
/code-workspace reload                # drop the cache and re-read
```

Folders changed from inside a session are announced to the Agent at the **next message boundary** (the next user send or tool-call end) through the framework's native `notice` channel; a running turn is never interrupted.

### The panel

Opened from the session header button or the session-creation chip. It shows the workspace file path, every folder (display name, real path, primary/missing badges) and offers:

- **Add folder** — a relative or absolute path plus an optional display name; a missing or non-directory path is refused
- **Move up / down** — reorder `folders`
- **Rename** — set `folders[].name`
- **Remove**
- **Show in file manager**
- **Switch file** / **Recent** / **New workspace file** / **Unlink**

### The `@` menu

Typing `@` adds one group per folder beside the built-in workspace group. An empty query lists the folders as entry points, `@main` ranks across every root, and `@dsh-nl/src/` or `@D:/repo/src/` descends a level.

A pick inserts an **absolute-path** mention (`@D:/repo/src/main.ts`), because an additional root lies outside the primary workspace and no relative path can reach it. This is a **companion group** — the built-in menu is not modified.

---

## Permission model

### One writable root per command

The DSH sandbox (the Windows ACL runner) grants each process tree exactly **one** workspace-write SID. Therefore:

- A command whose cwd stays in the container directory **cannot** create files inside an additional root. `git -C <root>`, `cd <root>` inside a script, `git clone <url> <root>`, and absolute-path writes all fail with an OS-level `Permission denied`.
- Symmetrically, a command re-rooted to one additional root cannot write the container directory or another root in the same invocation.
- **A file-creating command MUST set `workdir` to the directory it writes into, and it must be an absolute path.** A relative `workdir` resolves against the container directory only. Changing the process directory inside the command (`Set-Location` / `cd`) does **not** widen the writable root.
- The same rules apply to background runs (`run_in_background: true`).
- Reads are unfenced and need no `workdir`.

This rule is injected into the system prompt, so the Agent knows it.

### The workspace file is user-managed

Because a `.code-workspace` file decides which directories this session may write, the plugin **refuses agent `write` / `edit` against any `*.code-workspace` file** (and against its own store). An agent therefore cannot widen its own roots by editing the workspace file — add or remove folders from the panel, the command, or your editor.

**Known boundary**: this is a tool-layer guarantee, not a sandbox guarantee. An agent that writes a `.code-workspace` file through a script (`pwsh` / `bash`) is not stopped, because no path-level check can see inside an opaque command. And since the plugin adopts "the only `.code-workspace` in the directory", an agent able to create such a file could in principle exploit that. The plugin documents this boundary rather than pretending to close it.

---

## How it works

| Layer | File | Responsibility |
| --- | --- | --- |
| JSONC | `lib/jsonc.js` | Parse comments / trailing commas / BOM; **surgically** rewrite one top-level member and leave every other byte alone |
| Workspace model | `lib/workspace-file.js` | VS Code path rules, folders add/remove/reorder/rename, serialization; pure functions, no fs |
| Host | `lib/index.js` | Discovery and caching, `tools/execute` re-rooting, prompt injection, notices, `/code-workspace`, the sessionless `codeWorkspace/*` remote API, `@` discovery |
| Client | `lib/client.js` | Session header button, session-creation dock chip, overlay panel, `@` companion group |

- **Discovery**: the session cwd → a recorded file wins; otherwise a directory holding exactly one `.code-workspace` adopts it. Two or more candidates is ambiguous and grants nothing.
- **Caching**: model 2 s, discovery 3 s, `@` index 4 s. `fs.stat` metadata is deliberately **not** used for invalidation — the fields an `FsInfo` carries are not part of the plugin-facing contract, so a stamp built from them could silently never change and pin a stale root set for a whole session. Panel and command reads always force a fresh parse.
- **Interception**: when a `write` / `edit` / `pwsh` / `bash` target lands in an additional root, the call is serviced with `{ ...standingPolicy, workspaceRoot: <that root> }`. The **mode is never touched**, so `read-only` still denies, `workspace-write` still allows, and `danger-full-access` still allows. Background runs register with `ctx.jobs` under the same policy.
- **Sessionless channel**: `ctx.provide('codeWorkspace', api)` plus hand-written `src-json` Typert descriptors, keyed by **path** rather than a session id, so the session-creation page — which has no session yet — can read and edit the workspace file.
- Config and the file pointers live in `<DSH_HOME>/storages/code-workspace/index.json`, outside every agent sandbox root and under a write guard.

---

## Development and tests

```bash
npm test          # = node --test "test/**/*.test.mjs"
```

Four files, 103 cases, **no DSH runtime required**: a fake `fs` seam, a fake `systemPrompt`, a fake `commands` registry, fake `shell`/`jobs`, and a minimal React shim on the client side (hooks resolve once per call and function components are expanded recursively), so the rendered tree can be inspected and clicks simulated directly.

```bash
node test/jsonc.test.mjs            # JSONC parsing and comment-preserving rewrites
node test/workspace-file.test.mjs   # VS Code path rules, folders CRUD
node test/host.test.mjs             # discovery, re-rooting, refusals, command, remote API, @ discovery
node test/client.test.mjs           # bundle contract, slot registrations, panel interaction, @ source
```

### Live verification

`tools/verify-instance.mjs` checks a **really booted** DSH instance end to end (index injection, whether the client bundle is served, the `codeWorkspace/*` endpoints, and a folders write-back through the real sandbox with comment preservation):

```bash
# a throwaway profile, so your desktop profile is never touched
dsh cwsverify --from-default-profile web --dump-config      # confirm the composed tree first
# link manually, then boot (--port 0 picks a free port)
dsh --profile cwsverify --port 0 --no-open
node tools/verify-instance.mjs "http://127.0.0.1:<port>/?token=<token>"
```

On `0.2.0-rc.2` this script passes 25/25.

---

## Layout

| Path | Purpose |
| --- | --- |
| `lib/index.js` | Host plugin |
| `lib/client.js` | Client factory bundle |
| `lib/jsonc.js` | JSONC reader + comment-preserving writer |
| `lib/workspace-file.js` | `.code-workspace` model and path rules |
| `cordis.patch.yml` | Profile patch layer inserting the `dsh-code-workspace` row |
| `test/` | Behaviour tests, no DSH runtime |
| `tools/profile-link.mjs` | Link / unlink the plugin into a DSH profile without pnpm |
| `tools/verify-instance.mjs` | End-to-end checks against a live instance |
| `tools/probe-index.mjs` | Dump one instance's index and report bundle injection |
| `docs/client-contract.md` | The DSH 0.2.0-rc.2 client-plugin contract, citation-anchored |
| `docs/design.md` | Architecture and invariants |

## License

MIT
