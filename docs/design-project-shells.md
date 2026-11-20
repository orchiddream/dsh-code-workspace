# 设计：项目终端（每个 workspace folder 一个 DSH 内置 shell）

> 状态：**已实现（v0.2.0）。** 目标环境：DSH `0.2.0-rc.2`（本机实测版本）。
> 稳定的设计结论已折叠进 `docs/design.md` 的 `## Project shells`，上游契约证据已折叠进
> `docs/client-contract.md` 的 `§7.10`；本文保留完整的设计与取舍记录。实现与草案的差异：
> 额外增加了「新标签落在别的会话就关掉」的防御与 Windows 盘符 → MSYS 路径转换；
> 去掉了草案里的「已退出终端提示」——实现选择直接聚焦标签、由终端屏幕显示退出码；其余按本文实现。

## 1. 需求

用户原话：

> 新加一个功能，可以在工作区的每个项目里打开一个 shell 窗口……我想的是在代码工作区页签的项目列表后面这加个快捷按钮。

确认后的形态：

- **入口**：中央栏「代码工作区」页签里，**每个 folder 行**的动作组（截图里 `↑ ↓ ✎ ⧉ ✕` 那一排）新增一个快捷按钮。
- **行为**：点击后在该项目目录下打开 **DSH 自带的交互式终端**（右侧栏 `terminal` 标签页），而不是外部终端窗口。
- **不做**：外部终端启动器（Windows Terminal / PowerShell / …）、宿主新端点、提示词或工具行为改动。这个功能只影响人机交互，不向 Agent 的上下文增加任何 token。

## 2. 上游事实（recon，带证据）

这些事实决定了方案，而不是反过来。

### 2.1 DSH 内置终端是什么

`@deepseek-ai/dsh-api-terminal-controller` + `@deepseek-ai/dsh-client-ui-sidebar-terminal` 提供右侧栏的交互式 shell 标签页：PTY 由 `subprocess` 提供，xterm 渲染在浏览器，进程与屏幕存在宿主进程内（刷新页面可重连，宿主重启后不恢复）。

| 事实 | 证据 |
| --- | --- |
| 终端是**会话级**的，`remote.terminal` 的每个操作都按 Session 身份隔离 | `@deepseek-ai/dsh-api-terminal-controller/README.md:28` |
| 默认每会话最多 **8** 个终端（`maxTerminals`），已退出的终端也占配额 | 同上 `:36`；`README.md:89` |
| 用户终端以**系统用户权限**运行，与 Agent 沙箱无关 | 同上 `:30` |
| 标签类型 `terminal` 声明 `multiple: true`：每次 `openTab` 都是一只新标签，`contentId` 由 `placeTab` 随机生成（客户端 UUID），调用方无法预先指定 | `@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js:438-451`；`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:6449-6457` |
| 正文与标题**共用**同一个终端模型：`webTerminals.view(sessionId, tabId, contentId)`，键是 `(sessionId, tabId)` | `.../dsh-client-ui-sidebar-terminal/lib/client.js:375-384`；`.../dsh-api-terminal-controller/lib/client.js:722-735` |
| `view.write(data)` **只在该终端可写时**才接收输入（不是先排队） | `.../dsh-api-terminal-controller/lib/client.js:271-277` |
| `view.rename(title)` 会把标题广播给所有视图，标签标题组件读 `info.title` | `.../dsh-api-terminal-controller/lib/client.js:316-322`；`.../dsh-client-ui-sidebar-terminal/lib/client.js:224-226` |
| `openTab` 需要一个「屏上会话」；没有时抛 `sidebarRight: no session surface is mounted` | `.../dsh-client-ui-sidebar-right/lib/client.js:6393-6396`、`:6744-6752`；本仓库 `docs/client-contract.md:611-614` |
| 屏上会话 = 中央栏还是对话页（`activePanelId === null`）时选中的会话；本插件左栏 `main` 面板自己占中央栏，此时没有屏上会话 | `.../dsh-client-ui-sidebar-right/lib/client.js:9062` |

### 2.2 硬约束：终端创建不接受 `cwd`

宿主创建终端时写死：

```js
// @deepseek-ai/dsh-api-terminal-controller/lib/index.js:1001-1011
const handle = await subprocess.spawnTerminal({
  argv: [shell.path, ...shell.args],
  cwd: environment.cwd,          // ← 会话 workspace，不是调用方可选目录
  cols: request.cols,
  rows: request.rows,
  terminalType: 'xterm-256color',
  env: { DSH_SESSION_ID: agent.id },
  shellActivity: true,
  graceMs: this.config.disposeGraceMs,
  signal,
})
```

`TerminalCreateRequest` 只有 `shellPath? / id / cols / rows`，没有 `cwd`（`lib/types/types.d.ts:54-60`）；
`environment.cwd` 是 `agent.session.header.cwd ?? sandboxPolicy.workspaceRoot`（`lib/index.js:783`）。
`shellPath` 还必须是 `remote.terminal.shells` 发现出来的路径，不能是插件自造的包装脚本（`lib/index.js:999`）。

**结论：** 无法让内置终端直接以「附加根」为初始 cwd。唯一可走的路是：**终端创建成功后，由插件向 PTY 写入一条 `cd` 命令**。这条命令是用户敲键盘的等价物，会显示在屏幕上——这是本设计的主要代价，必须如实写进文档。

### 2.3 可以使用的客户端接口

| 接口 | 来源 | 可用性 |
| --- | --- | --- |
| `ctx.sidebarRight.openTab(kind, options)` / `focus` / `isExpanded` / `toggleExpanded` / `openTabs` | `@deepseek-ai/dsh-client-ui-sidebar-right` | 已收录于 `docs/client-contract.md §7.8`，但**必须软注入** |
| `ctx.sidebarRight.tabsIn(sessionId)` | 同上（`SidebarRightController` 的公开方法，不在 `ISidebarRight` 接口里，运行时存在） | **认领新标签的首选读法**：返回该会话已提交的 `TabRecord[]`（`{ id, kind, contentId, title }`）。不是接口成员，所以必须能力探测；读不到才退回摊平清单 |
| `ctx.sidebarRight.tabDomain.occurrence(sessionId, { id })` | 同上（公开属性） | 读一个标签的 `navigation.params`，用来识别 Agent 自己开的终端（带 `terminalId`）并跳过 |
| `ctx.sidebarRightTabs.get(kind)` / `subscribe` | 同上 | 已收录 |
| `ctx.webTerminals.view(sessionId, key, contentId, terminalId?, shellPath?)` / `launchShells` / `recover` | `@deepseek-ai/dsh-api-terminal-controller/client`（类型公开，服务名 `webTerminals`） | **未收录于本仓库 `docs/client-contract.md` §7**，属于新发现的上游事实，需要能力探测 + 失败降级 |

**摊平清单的陷阱（`0.2.2-rc.5` 实测）**：`sidebarRight.openTabs` 把**所有会话**的标签摊平成一份
（`SidebarTabInventory` 在启动时还会读 localStorage 里所有已保存的布局，包括从未在本窗口挂载的会话），
而标签 id 是**每个会话各自的计数器**（`tab1`、`tab2`…）。因此「用 tabId 做增量」在真实 profile 里几乎必然误判：
别的会话早就有 `tab2`，本会话新开的终端也叫 `tab2`，增量把它当成「已经开着」，3 秒后报
`the terminal tab did not appear`——而终端其实已经出现在右侧栏里。修法见 §4.2 与 §4.5。

`webTerminals` 服务的装配在 `dsh-web-app` 的浏览器名单里（`terminal-controller` + `ui-sidebar-terminal` 两行），
所以本机 desktop profile 一定存在；但组合可裁剪，插件不能假定它一定在。

## 3. 交互设计

### 3.1 按钮

每个 folder 行（`FolderRow` 非重命名态）的动作组：

```
>_  ↑  ↓  ✎  ⧉  ✕
```

- `>_` 放在动作组最左（最常用），tooltip / accessible name：`在 DSH 终端中打开`（en: `Open in DSH terminal`）。
- 只在**能真正打开**时出现：有屏上会话 + 终端服务齐全 + `terminal` 标签类型已注册。否则整块隐藏，不画死按钮。
- `root.exists === false` 时按钮禁用，tooltip 说明「目录不存在」。
- 正在打开时按钮禁用（同一项目重复点击合并为一次）。
- 重命名态下不出现（重命名行只保留确认/取消，现有行为不变）。

### 3.2 点击语义

| 场景 | 行为 |
| --- | --- |
| 该项目在本会话还没有终端 | 打开右侧栏 `terminal` 标签；把标签标题改成项目显示名；附加根自动 `cd` 到项目目录 |
| 该项目已有终端标签 | 展开右侧栏（若收起）+ 聚焦已有标签，**不新开** |
| 已有标签对应进程已退出/已关闭 | 已关闭 → 正常新开；已退出但标签仍在 → 聚焦该标签（屏幕显示退出码），不额外弹提示；关闭该标签后再点即新开 |
| 会话切换 | 终端按会话隔离：会话 B 的快捷按钮只打开/聚焦会话 B 自己的终端 |
| 主根（`isPrimary` 且等于 `state.rootDir`） | 不写 `cd`：会话根就是初始 cwd，省掉一行噪声 |
| 同一路径出现两行 | 按路径去重：两行共享同一只终端（点击聚焦同一标签） |

### 3.3 不可用时的降级

| 组合 | 表现 |
| --- | --- |
| 没有右侧栏 / 终端插件（组合被裁剪） | 功能整体不出现；面板其余部分照旧（与现有「没有 primitives 就跳过 Open In… 接管」同一姿态） |
| 左栏无会话页（`main` 面板） | 不显示按钮；在 roots 标题下加一行提示：「内置终端按会话提供：在对话页的『代码工作区』页签里，每个项目行会多一个打开终端的按钮。」 |
| 新建会话页浮层 | 同上（无会话） |
| 终端数量达到上限 | 面板 notice：「终端数量已达上限，请先关闭不用的终端（已退出的终端也占用配额）。」 |
| 打开失败（无 shell / PTY 失败 / 会话面缺失） | 面板 notice 显示本地化原因；不静默吞掉 |
| 目录不存在 | 按钮禁用，不点击 |

## 4. 客户端实现方案

> 全部改动在 `lib/client.js`（+ 字典、+ 测试、+ 文档）。宿主 `lib/index.js`、远程 API、
> store、系统提示词都**不动**：终端是浏览器 ↔ 宿主的既有通道，插件不参与传输。

### 4.1 能力桥（软注入 + 可观察状态）

```js
// 模块级，apply() 内
var shell = null            // { sidebarRight, webTerminals, sidebarRightTabs } | null
var shellListeners = []
function shellAvailable() {
  return !!(shell && shell.sidebarRight && shell.webTerminals &&
            typeof shell.sidebarRightTabs.get === 'function' &&
            shell.sidebarRightTabs.get('terminal') !== undefined)
}
function useShellAvailable() { /* useSyncExternalStore(订阅, shellAvailable, shellAvailable) */ }

if (ctx.inject) {
  ctx.inject(['sidebarRight', 'webTerminals', 'sidebarRightTabs'], function (scope) {
    if (!scope.sidebarRight || !scope.webTerminals || !scope.sidebarRightTabs) return
    shell = scope
    notifyShellAvailability()
    scope.effect(function () {                       // 类型注册可能晚于服务提供
      return scope.sidebarRightTabs.subscribe(notifyShellAvailability)
    }, 'dsh-code-workspace: terminal availability')
  })
}
```

- 三个服务缺一即视为不可用；`terminal` 类型未注册也视为不可用（`openTab` 会抛）。
- 不写进 `package.json` 的 `dsh.client.inject`：那是硬前置，写进去会让「没有终端插件的组合」连本插件都不加载。软注入 + 能力检查才是对的姿态（与 `layout`、`primitives` 的先例一致）。
- 选择器返回布尔值，引用稳定，`useSyncExternalStore` 不会自激。

### 4.2 打开流程（一次点击的时序）

```
click(row)
  ├─ 若 opening 集合里已有该 pathKey → 直接返回（防重入）
  ├─ 前置检查：sessionId 存在、目录存在、能力可用
  ├─ 1. 复用：localStorage 里该 (sessionId, pathKey) 的 contentId
  │     在本会话自己的标签里找到同 contentId 的标签？
  │       ├─ 找到 → sidebarRight.focus(tab.id)；isExpanded() 为 false 时先 toggleExpanded()
  │       └─ 没找到 → 进入 2
  ├─ 2. 记录 before = 本会话标签的 contentId 集合（不是 tabId！）
  ├─ 3. sidebarRight.openTab('terminal')            // 不传 params：沿用用户记住的 shell
  ├─ 4. 认领：本会话标签里 kind==='terminal'、contentId ∉ before、且 navigation.params.terminalId 不存在
  │     （优先 sidebarRight.tabsIn(sessionId)；没有该读法时退回摊平清单但按 sessionId 过滤）
  │     （openTab 的提交是同步的，所以第 4 步通常在调用栈内就完成；3s 超时只是兜底）
  ├─ 5. 写入映射 localStorage(sessionId, pathKey → contentId)，并刷新打开状态
  ├─ 6. view = webTerminals.view(sessionId, tab.id, tab.contentId)   // 与正文/标题共用同一模型
  ├─ 7. 等 state.writable === true 且 info.state === 'running'（超时 10s → notice）
  ├─ 8. 附加根：view.write(cdCommand(info.shell, root.resolvedPath) + '\r')
  │     主根：跳过（初始 cwd 已是它）
  ├─ 9. view.rename(root.label || 目录名)          // 标签标题 = 项目名
  └─ 10. 清理监听/超时；opening 集合移除
```

要点：

- **标识用 contentId，不用 tabId**：`tabId` 是每个会话自己的计数器（`tab1`、`tab2`…），
  而清单是所有会话摊平的，两者相乘就是「刚开的终端被判成已存在」那个 bug；`contentId` 是每次打开唯一的
  `sidebar://terminal/<uuid>`，天然可做增量键。本会话自己的标签优先从 `sidebarRight.tabsIn(sessionId)` 读，
  这样即使同一个根上有多个会话也不会互相干扰。
- **提交是同步的**：`openTab` 内部 `openContent` → store commit → adoption 订阅 → inventory 更新都在返回前完成；
  上游自己的终端插件就是这么认领的（`dsh-client-ui-sidebar-terminal` 的 `openTabIn(...)` 后立刻读 `tabsIn`），
  所以不需要 sleep，也不需要「等清单刷新」。订阅 + 3s 超时是给不提供 `tabsIn` 的组合留的兜底。
- `openTab` 不返回标签 id（`placeTab` 的 `settled` 回调不对外暴露），`contentId` 是随机 UUID，不能预先构造。
- 第 7 步是**必须**的：`write()` 在不可写时直接返回，早写会被静默丢弃。
- 标题在第 9 步写：`TerminalTitle` 读 `state.info.title`，rename 会更新标签标题。
- **Agent 自己开的终端不参与认领**：那种标签带 `navigation.params.terminalId`，往里写 `cd` 会驱动 Agent 的进程；
  `tabDomain.occurrence(...).navigation.params` 可读时必须跳过它们。
- 若标签正文尚未挂载（用户恰好在别的会话/面板），`view` 仍会创建模型但只有正文挂载后才会创建进程；第 7 步的等待自然覆盖。

### 4.3 `cd` 命令构造

按终端实际 shell 分类（`state.info.shell.path` 的 basename，忽略大小写与 `.exe`）：

| shell | 命令 | 转义 |
| --- | --- | --- |
| `powershell.exe` / `pwsh.exe` | `Set-Location -LiteralPath '<path>'` | 单引号包裹；内部 `'` 写成 `''` |
| `cmd.exe` | `cd /d "<path>"` | 双引号包裹（路径里不会有 `"`） |
| 其它（bash / zsh / fish / Git Bash…） | `cd '<path>'` | 单引号包裹；内部 `'` 写成 `'\''`；Windows 盘符路径转 MSYS 形式 `D:\x` → `/d/x` |

- 不能统一成一种语法：PowerShell 与 cmd 的引号/转义规则不同，宁可分支也不要猜。
- 主根跳过 `cd`（比较 `pathKey(root.resolvedPath) === pathKey(state.rootDir)`），避免每个终端都多一行可见命令。
- 命令失败（极端的特殊字符/权限）会由 shell 自己报错在屏幕上；插件不重试、不假装成功。
- **不隐藏这条命令**：没有 API 能悄悄设置 PTY 的 cwd，伪造会有两种坏结果——要么骗用户，要么依赖未定义行为。设计选择是让 `cd` 可见，并在 README/设计里写明。

### 4.4 标签标题

- `rename(root.label || basename(resolvedPath))`：两行同名时标题会重名，这是可接受的（内容里 `cd` 路径不同）；不额外加序号，避免标题与用户在 VS Code 里看到的名字不一致。
- 用户手动重命名标签后，插件不再改名（只在首次打开时 rename 一次）。

### 4.5 去重与持久化

- 映射：`(sessionId, pathKey(path)) → contentId`。
- 只在浏览器 `localStorage` 里存（不进宿主 store，不进提示词），键：
  `dsh.code-workspace.project-shells.v1`
  值：`{ version: 1, entries: [{ sessionId, path, contentId, at }] }`，按 `at` 最近优先，上限 64 条。
- **用 `contentId` 而不是 `tabId` 做持久键**：上游明确说「layout-local tab ids only identify live view occurrences」，恢复视图复用 contentId
  （`.../dsh-api-terminal-controller/README.md:58`）。刷新后从本会话标签里按 contentId 找回当前 `tabId`，再聚焦/写入。
- **`tabId` 连「认出刚开的那一个」都不该用**：它是每个会话自己的计数器，而 `openTabs` 是所有会话摊平的清单
  （启动时还包含 localStorage 里每个已保存会话的布局）。同一个 `tab2` 在多个会话里同时存在是常态，
  按 tabId 做增量等于把「别的会话有 tab2」误读成「本次点击的 tab2 已经开着」。
  这是 `0.2.2-rc.5` 上「终端打开失败: the terminal tab did not appear」的根因：终端确实打开了，
  但标签从未被认领，于是没有 `cd`、没有改名、也没有写进这张映射；再点一次会再开一只。
- 读取时校验：条目仍在本会话的标签里才复用；stale 条目在下一次写入时清掉。storage 不可用/损坏不阻塞功能
  （try/catch，退化为每次新开）。
- 多窗口：`openTabs` 是**本窗口**的清单，另一个窗口的终端不会误聚焦；contentId 全局唯一所以不会串。

### 4.6 状态与错误

- 面板 store 复用现有 `state`：新增 `shellOpening`（对象，pathKey → true）与复用 `notice`/`error` 两个字段；`patch` 的引用比较照旧。
- 错误文案走本插件自己的字典（不翻译上游 issue 字符串）：

| key | zh | en |
| --- | --- | --- |
| `action.openTerminal` | 在 DSH 终端中打开 | Open in DSH terminal |
| `action.openTerminalBusy` | 正在打开终端… | Opening terminal… |
| `hint.terminalSession` | 内置终端按会话提供：在对话页的「代码工作区」页签里，每个项目行会多一个打开终端的按钮。 | Terminals are session-scoped: open the Code Workspace tab in a conversation and each project row gains a terminal button. |
| `hint.terminalNoDir` | 目录不存在，无法打开终端。 | The directory does not exist, so no terminal can be opened. |
| `notice.terminalOpened` | 已在 DSH 终端中打开「{name}」。 | Opened “{name}” in a DSH terminal. |
| `notice.terminalFocused` | 已切换到「{name}」的终端。 | Focused the “{name}” terminal. |
| `error.terminalUnavailable` | 这个组合没有可用的 DSH 终端。 | This composition has no usable DSH terminal. |
| `error.terminalNoSession` | 需要先在对话页打开「代码工作区」页签，才能为项目打开终端。 | Open the Code Workspace tab in a conversation before opening a project terminal. |
| `error.terminalLimit` | 终端数量已达上限，请先关闭不用的终端（已退出的终端也占配额）。 | The terminal limit is reached; close unused terminals first (exited terminals count too). |
| `error.terminalFailed` | 终端打开失败：{message} | Could not open the terminal: {message} |

zh/en 键必须一一对应（现有 `test/client.test.mjs` 的字典平衡测试会强制）。

### 4.7 组件改动点

| 位置 | 改动 |
| --- | --- |
| `FolderRow`（`lib/client.js:875-918`） | 新增可选按钮 `>_`（`props.canOpenTerminal` 才渲染）；`props.terminalBusy` 禁用；`props.onOpenTerminal` |
| `PanelBody`（`:1263` 起） | 把 `snapshot.sessionId`、`shellAvailable()`、`openProjectTerminal()`、`shellOpening` 传给每个 `FolderRow`；无会话时在 roots 区加一行提示 |
| `apply()` | 增加 §4.1 的能力桥；注册/清理订阅 |
| 新增函数 | `openProjectTerminal(root)`（§4.2）、`cdCommand(shell, path)`（§4.3）、`projectShellMap()`（§4.5） |
| 字典 | §4.6 的键 |

不改：`conversation.view` 注册、槽位、Open In… 接管、`@` 菜单、宿主插件、远程 API、store。

### 4.8 为什么不做别的方案

| 备选 | 否决理由 |
| --- | --- |
| 外部终端窗口（Windows Terminal / PowerShell…） | 用户明确要 DSH 自带 shell；且外部窗口在 DSH 之外，与「工作区页签里点一下」的入口语义不符 |
| 新增宿主端点做 PTY 代理 | 宿主已经有完整的用户终端服务；插件再开一套会绕过它的配额/恢复/清理，等于重造轮子 |
| 在面板里内嵌自绘终端（xterm + 自建流） | 客户端 bundle 零构建、无 xterm 依赖；xterm 只存在于 sidebar-terminal 的私有 chunk 里，不可复用 |
| 插件自带 shell 包装脚本作为 `shellPath` | 上游只接受 `shells()` 发现出来的路径（`lib/index.js:999`），装不进去 |
| 把 `cd` 藏起来（清屏/伪造 prompt） | 骗人且易碎；设计选择可见、可解释 |

## 5. 测试计划

测试沿用现有思路：**不需要 DSH 运行时**，在 `test/client.test.mjs` 里注入假的
`sidebarRight` / `webTerminals` / `sidebarRightTabs`，用最小 React shim 检查渲染树并模拟点击。

假件形状：

```js
sidebarRight: {
  openTab(kind, options) { calls.push(['openTab', kind, options]); addTab(nextRecord()) },
  openTabs: { getSnapshot, subscribe },
  focus(tabId), isExpanded(), toggleExpanded(), close(tabId),
}
webTerminals: { view(sessionId, key, contentId) { return fakeView } }  // fakeView: state{getSnapshot,subscribe}, write, rename
sidebarRightTabs: { get: (kind) => kind === 'terminal' ? { kind } : undefined, subscribe: () => () => {} }
```

新增用例（约 12 个）：

1. 有会话 + 服务齐全时，每个 folder 行出现 `在 DSH 终端中打开` 按钮；无服务/无会话时不出现，且面板其余部分不坏。
2. 无会话的左栏面板不渲染按钮，并显示 `hint.terminalSession`。
3. 点击主根：`openTab('terminal')` 被调用一次；`view` 收到 `(session-1, tabId, contentId)`；**不写 `cd`**；`rename` 用项目名。
4. 点击附加根（PowerShell）：可写后写入 `Set-Location -LiteralPath 'D:/other'` + `\r`。
5. 引号表：路径含空格/单引号/中文时三种 shell 各自的转义。
6. 第二次点击同一项目：不再 `openTab`，改为 `focus(tabId)`；右侧栏收起时先展开。
7. 映射存在但标签已关闭：下一次点击重新 `openTab`。
8. 刷新恢复：localStorage 里有 contentId 且 `openTabs` 里有同 contentId 的标签 → 只聚焦，不新开。
9. 终端上限：view 状态 `issue: 'terminalLimit'` → 显示 `error.terminalLimit`，不静默。
10. 打开超时/失败：view 状态 `phase: 'failed'` → 显示 `error.terminalFailed` 并清理监听。
11. 会话不匹配防御：新标签落在别的 session → `close(tabId)` + 报错。
12. 字典平衡 + 既有 177 用例全绿（新增按钮不能改变既有渲染断言）。

另外：

- `tools/verify-instance.mjs` 增加一条**bundle 标记**断言（客户端 bundle 里出现 `webTerminals` / 项目终端标记字符串），证明真实实例服务的是新 bundle。真实浏览器里的点击仍属人工验证（与现有对话视图的说明一致）。
- 人工验证清单：Windows desktop 实测 3 个 folder（含中文名、含空格）；主根/附加根；再点聚焦；关闭后重开；刷新恢复；第 9 只终端触发上限；切换会话；左栏无会话页提示；SSH 接入（内置终端在宿主上运行，和外部编辑器不同，**不需要** SSH 降级）。

## 6. 文档与发布

| 文件 | 改动 |
| --- | --- |
| `README.zh.md` / `README.md` | 新增「每个项目打开 DSH 终端」小节：入口、cd 的代价、会话级/8 只上限、系统用户权限、无会话页不可用 |
| `docs/design.md` | 实现后折叠稳定的设计结论（一节 `Project shells`） |
| `docs/client-contract.md` | 新增 `§7.10 webTerminals`：服务名、`view/write/rename`、`(sessionId,key)` 身份、`write` 只在可写时生效、证据行号；并注明它未列入 `SERVICE_API` 八项目录，必须能力探测 |
| `docs/design-project-shells.md` | 本文（实现后删除或折叠） |

版本：`0.2.0`（向后兼容的新功能），`0.2.1` 修正 rc.5 的标签认领与「Open In…」接管（见 §11）。发布到 npm 与装进 desktop profile 由用户执行。

## 7. 风险与已知边界

1. **`cd` 可见**：终端的 `info.cwd` 仍是会话根；屏幕上会先出现一条 `cd` 命令。这是上游没有 per-terminal cwd 的直接后果。
2. **会话级**：终端只属于当前会话；换会话不会看到别的会话的终端，左栏无会话页完全不可用。
3. **每会话 8 只上限**（可被部署配置改），已退出终端也占配额。
4. **权限**：用户终端以系统用户身份运行，**不受 Agent 沙箱约束**，能在任何可写目录（包括附加根之外）操作。这是 DSH 的既有设计，不是本插件绕过；README 必须写明。
5. **依赖非契约服务**：`webTerminals` 未收录于本仓库的客户端契约文档，属于「类型公开但未在 `SERVICE_API` 目录」的地带；上游改形状时可能失效。护栏：三重能力检查 + `try/catch` + 失败降级为「不出现按钮/报错」，不能把面板或插件带崩。
6. **刷新后的映射**：依赖 contentId 在布局里被持久化；布局被清空/换浏览器窗口时映射失效，退化为新开一只终端。
7. **同名项目**：两个 folder 标签同名时终端标题也同名。
8. **不做**：外部终端、shell 选择菜单（沿用用户的终端记忆选择/默认 shell）、终端分组、快捷键。

## 8. 实施阶段

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P1 | 能力桥 + `FolderRow` 按钮 + `openTab` 认领 + 聚焦复用 + 字典 + 用例 1/3/6/12 | 客户端 ~120 行，测试 ~120 行 |
| P2 | wait-writable、`cd` 构造、rename、失败/上限/超时、持久化映射 + 用例 4/5/7-11 | 客户端 ~150 行，测试 ~130 行 |
| P3 | 文档（README/design/client-contract）+ verify 标记 + 人工实测 | — |

**实施前建议**：先把当前工作区里已暂存的性能改动（`lib/client.js`、`lib/index.js`、`test/client.test.mjs` 的缓存/并行/队列优化）单独提交，避免和新功能混在一个 diff 里。

## 9. 验收标准

- [ ] 截图里每个项目行都出现 `>_` 按钮（仅在有会话且终端可用时）。
- [ ] 点击附加根：右侧栏出现标题为项目名的终端，屏幕显示 `cd` 后落在项目目录（PowerShell 实测）。
- [ ] 点击主根：不出现 `cd`，直接落在会话根。
- [ ] 再点：聚焦同一标签；关闭后重点：新开。
- [ ] 刷新页面：终端标签与进程存活，再点聚焦而不是重复开。
- [ ] 第 9 只终端：面板显示上限提示，不崩。
- [ ] 左栏无会话页：没有按钮，有一行解释。
- [ ] 禁用终端插件的组合：功能整体消失，面板其余功能不受影响。
- [ ] `npm test` 全绿（177 + 新增）。
- [ ] 真实实例 bundle 带标记，且人工验证通过。

## 10. 待确认

1. 按钮字形与位置：`>_` 在最左，可改（`❯` / `⌨` / 放在 `✎` 之后）。
2. 无会话页：现在设计是「隐藏按钮 + 一行提示」；也可以改成「显示禁用按钮 + tooltip」。
3. 再次点击：现在设计是「聚焦已有终端」；若你更想「每次都新开」，只需去掉去重。
4. 是否也加一个「在终端中打开会话根」的全局按钮（面板顶部动作行），还是只保留行内快捷按钮。
5. `cd` 可见这个代价你是否接受（替代方案只有外部终端窗口）。

## 11. 实测修正（DSH `0.2.2-rc.5`，桌面应用）

本节记录上线后**在真实桌面应用里**复现、定位并修掉的两个问题；它们都不改变上面的设计结论，只把「认领」的标识与一个插槽细节改对。

### 11.1 「终端打开失败: the terminal tab did not appear」

**现象**：点击项目行的 `>_`，面板红字报 `终端打开失败: the terminal tab did not appear`，但右侧栏其实已经多了一只终端标签；
再点一次会再开一只，没有 `cd`、没有改名。

**复现**（rc.5 真实实例，Playwright 驱动，非模拟）：一个新会话刚开第一只终端拿到 `tab2`；
把 localStorage 里**另一个会话**的已保存布局写成同样含 `tab2`（合法的 `{ layout, minted: 2 }`）后点击 `>_`：

| 观测 | 修复前 | 修复后 |
| --- | --- | --- |
| 面板提示 | `终端打开失败：the terminal tab did not appear` | `已在 DSH 终端中打开「dsh-multiroot-workspace」。` |
| 右侧栏终端 | 1 只（已打开，但未被认领） | 1 只（被认领） |
| `localStorage` 映射 | 空（下次点击会再开一只） | 写入 contentId |

**根因**：`openTabs` 是所有会话摊平的清单，`tabId` 却是每个会话自己的计数器；旧代码用 `before[tab.tabId]`
做增量，别的会话的 `tab2` 让本次新开的 `tab2` 被永远跳过。3 秒计时器随后报的其实是「没认领到」，
而不是「没打开」。上游自己的终端插件用的是 `tabsIn(sessionId)` + contentId，本插件现在同构。

**修法**：`sessionTabs(sessionId)`（优先 `sidebarRight.tabsIn`，退回摊平清单并按 `sessionId` 过滤）+
按 `contentId` 做增量 + 同步认领 + 跳过 `params.terminalId` 的 Agent 终端；不再关闭任何别会话的标签。
`test/client.test.mjs` 新增了「同一 `tabId` 出现在两个会话」的回归用例（`scopedRead` 两种读法各一条）
与「Agent 终端不被认领」用例。

### 11.2 「Open In…」接管在 rc.5 上抛错

**现象**：浏览器控制台 `TypeError: Cannot read properties of undefined (reading 'openInAppFamily')`，
`slot entry crashed in 'conversation.session.header.utilities'`——接管控件把宿主原本的「Open In…」挡掉了，
自己却没渲染出来，用户等于丢了那个控件。

**根因**：rc.5 不再把注册方自己塞进 `inject` 返回值里的 `hooks` 包原样交给组件（`props.hooks` 变成槽位自己的
钩子容器），而旧代码只从 `props.hooks` 取清单/选择/启动三个 store。

**修法**：接管用的控制器提升为插件级单例（`openInAppRuntime`），组件先读 `props.hooks.*`，
读不到就用单例；`useMenuStore(store, fallback)` 对缺失/形状不对的 store 返回兜底值而不是抛错。
这样「宿主照旧传」和「宿主不传」两种组合都能渲染，槽位错误不会再连累官方控件。

### 11.3 仍然成立的上游边界

- 终端创建接口仍没有 `cwd`（`TerminalCreateRequest` 无该字段），`cd` 依旧是唯一诚实做法。
- 终端标签的 `multiple: true` 在 rc.5 仍在，所以「每个 folder 一只标签」成立，contentId 每次打开唯一。
- `tabsIn` / `tabDomain` 不在 `ISidebarRight` 接口里，属于实现上的公开成员：必须能力探测，读不到时退回摊平清单。
