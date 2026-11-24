# Vendored Monaco editor

These files are a **single-file build** of `monaco-editor@0.52.2` (Microsoft, MIT), renamed for
this plugin. They are not copied from the package's `min/vs` AMD tree — each one is a bundled
IIFE produced from the package's ESM entry points:

| file here | what it is |
| --- | --- |
| `monaco.js` | the editor + language bundle (one IIFE; the build recipe is not in this repo) |
| `monaco.worker.js` | the matching worker bundle |
| `monaco.css` | the editor stylesheet |
| `codicon-37A3DWZT.ttf` | the codicon font the stylesheet references (upstream's content hash in the name) |

The bundle carries its own provenance banner, which is how the version was pinned:

```
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Version: 0.52.2(404545bded1df6ffa41ea0af4e8ddb219…)
```

- **License**: [`LICENSE`](LICENSE) — the MIT text from `monaco-editor@0.52.2`, copied verbatim.
- **Bundled third-party components**: [`ThirdPartyNotices.txt`](ThirdPartyNotices.txt) — copied
  verbatim from the same package, as its MIT redistribution requires.

## Refreshing the notices

The two notices always come from the **same version as the bundle**. If the bundle is rebuilt,
take them from that version's package:

```powershell
npm pack monaco-editor@<version> --pack-destination .tmp
New-Item -ItemType Directory -Force -Path .tmp/monaco-license | Out-Null
tar -xzf .tmp/monaco-editor-<version>.tgz -C .tmp/monaco-license package/LICENSE package/ThirdPartyNotices.txt
Copy-Item .tmp/monaco-license/package/LICENSE lib/vendor/monaco/LICENSE -Force
Copy-Item .tmp/monaco-license/package/ThirdPartyNotices.txt lib/vendor/monaco/ThirdPartyNotices.txt -Force
```

The package's `files` field already ships everything under `lib/`, so these notices travel with
the published tarball (`npm pack --dry-run` lists them).
