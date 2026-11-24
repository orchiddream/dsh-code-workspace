# Vendored Monaco editor

These four files are a renamed subset of the published `monaco-editor` package:

| file here | upstream file |
| --- | --- |
| `monaco.js` | the editor + language bundle (`min/vs/…`, bundled by upstream) |
| `monaco.worker.js` | the worker bundle |
| `monaco.css` | the editor stylesheet |
| `codicon-37A3DWZT.ttf` | the codicon font the stylesheet references (content hash in the name is upstream's) |

- **Upstream package**: `monaco-editor@0.52.2` (Microsoft, MIT). The bundle carries its own
  banner: `Version: 0.52.2(404545bded1df6ffa41ea0af4e8ddb219…)`.
- **License**: [`LICENSE`](LICENSE) — the MIT text shipped by that package.
- **Bundled third-party components**: [`ThirdPartyNotices.txt`](ThirdPartyNotices.txt) — copied
  verbatim from the same package, as its MIT redistribution requires.

## Regenerating

If the bundle is ever replaced, take `LICENSE` and `ThirdPartyNotices.txt` from the *same*
upstream version and update the banner above:

```powershell
npm pack monaco-editor@<version> --pack-destination .tmp
tar -xzf .tmp/monaco-editor-<version>.tgz -C .tmp/monaco-license package/LICENSE package/ThirdPartyNotices.txt
Copy-Item .tmp/monaco-license/package/LICENSE lib/vendor/monaco/LICENSE -Force
Copy-Item .tmp/monaco-license/package/ThirdPartyNotices.txt lib/vendor/monaco/ThirdPartyNotices.txt -Force
```

The package's `files` field already ships everything under `lib/`, so these notices travel with
the published tarball.
