# dsh-code-workspace

[English](README.md) | **中文**

> 为 DeepSeek Harness 提供与 VS Code / Trae / Cursor 相同的**多根工作区**：一个 `.code-workspace` 文件就是唯一事实来源，它的 `folders` 数组成为本次会话的可写根。

零构建步骤：`lib/index.js` 是纯 ESM 宿主插件，`lib/client.js` 是手写的 DSH client-modules factory bundle。

---

## 与 VS Code 的对应关系

| VS Code / Trae | 本插件 |
| --- | --- |
| `.code-workspace` 文件（JSONC） | 同一个文件，同一套语法 |
| `folders[].path` | 同；`./` / `../` 开头**永远**相对，`C:\x` / `/x` / `\\server\share` 为绝对，其余相对 |
| `folders[].name` | 同（显示名） |
| `//` 与 `/* */` 注释、尾逗号 | 同；**写回时逐字节保留**，只重写 `folders` 这一个成员 |
| 未知成员（`settings` / `extensions` / `launch` / `tasks` / `trae` / 自定义） | 原样保留，不会被丢弃 |
| 文件夹条目里的额外键（如新版的 `icon`） | 原样保留 |
| 多根窗口 | 会话 `cwd` = **`.code-workspace` 文件所在目录**（容器目录）；`folders[]` 全部作为附加根 |
| `.code-workspace` 损坏 | 面板显示具体行列号；此时不授予任何根（fail closed） |

DSH 的工作区是**单根目录**，`workspaceRegistry.create()` 也只接受存在的目录，所以映射方式是：打开一个 `.code-workspace` 文件 = 把它的所在目录注册为 DSH 工作区，文件里的 folders 变成附加可写根。

---

## 环境要求

- Node.js >= 20
- DeepSeek Harness `0.2.0-rc.2`（本机实测版本）

## 安装

`desktop` profile 由 Electron 应用独占：`dsh plugin --profile desktop add …` 会被**直接拒绝**（`@deepseek-ai/dsh/lib/bin.js:36`）。而在应用内的插件管理器里安装会走 pnpm，pnpm 会先校验 profile 的**整个** `pnpm-lock.yaml` —— 只要 lockfile 里存在任何比 `minimumReleaseAge` 更新的包，安装就会整体失败，与你装的是哪个插件无关（见下方「pnpm 策略」）。

`link:` 依赖既不需要联网也不需要包管理器，所以用仓库自带的脚本手工挂载：

```bash
node tools/profile-link.mjs install --profile desktop --dry-run   # 先看它要改什么
node tools/profile-link.mjs install --profile desktop             # 执行（自动备份 package.json）
```

它做的正是 `pnpm add link:<目录>` 会做的事，仅此三处：

1. profile `package.json` 的 `dependencies` 增加
   `"dsh-code-workspace": "link:D:/kjsjs/deepseek/dsh-multiroot-workspace"`
2. `dsh.profile.bundles` 追加 `"dsh-code-workspace"`
3. 在 `<profile>\node_modules\dsh-code-workspace` 建目录联接指向本仓库

实测：**运行中的 DSH 应用会热加载这个组合变更，不需要重启**——加完刷新一下页面，会话头部就出现「代码工作区」按钮。若入口没出现，再重启后端。

```bash
node tools/profile-link.mjs status    --profile desktop   # 查看当前状态
node tools/profile-link.mjs uninstall --profile desktop   # 卸载（只删它自己建的联接）
```

脚本是幂等的，写之前会备份 `package.json`，并且只删除能证明指向本插件的联接。

### pnpm 策略（为什么 GUI 安装会失败）

profile 的 `pnpm-workspace.yaml` 启用了 `minimumReleaseAgeExclude`，说明这台机器上 pnpm 的 `minimumReleaseAge` 策略是生效的。它校验的是 **lockfile 整体**，不是本次要装的包，所以只要 lockfile 里有一个「太新」的包（例如 `@michengai/dsh-skills-manager@1.1.21`），任何安装都会被拒。这属于既有的环境状态，与 `dsh-code-workspace` 无关；上面那条手工 link 路径完全绕过 pnpm，所以不受影响。

### ⚠️ 必须停用 `dsh-multi-folder`

两个插件都会监听 `tools/execute` 瀑布并重根沙箱。同时启用会造成重复拦截与重复的提示词注入。从 profile `package.json` 的 `dsh.profile.bundles` 里移除 `"dsh-multi-folder"` 即可（依赖可以保留）。

---

## 使用

### 打开一个工作区

三种入口，效果相同：

| 入口 | 位置 |
| --- | --- |
| **新建会话页** | 输入框上方的「代码工作区」胶囊（与 git 分支胶囊同一条 dock 带） |
| **会话头部** | 会话标题栏的「代码工作区」按钮 |
| **斜杠命令** | `/code-workspace use <路径>` |

面板里可以「切换文件」浏览目录树挑选 `.code-workspace`，或「新建工作区文件」。选定后面板会调用 `workspaceRegistry.create()` 把容器目录注册为 DSH 工作区，并（若客户端组合提供了 `uiWorkspace`）直接把会话切到该工作区。

另外，**只要会话的 cwd 目录下恰好有一个 `.code-workspace` 文件，插件会自动采用它**并记录下来——所以最常见的情况下你什么都不用做，直接把该目录作为工作区开会话即可。目录下有多个候选文件时不会猜（歧义即不生效），需要在面板里明确选一个。

### `/code-workspace` 命令

```
/code-workspace                       # 等同 list
/code-workspace list                  # 文件路径 + 全部 folders（带序号）
/code-workspace add <路径> [显示名]     # 相对容器目录或绝对路径
/code-workspace remove <序号|路径|显示名>
/code-workspace rename <序号|路径> <显示名>
/code-workspace move <序号> <目标序号>
/code-workspace use <文件.code-workspace>
/code-workspace create <文件名>        # 在容器目录新建，并把当前目录写进 folders
/code-workspace reload                # 丢弃缓存，重新读文件
```

在会话内通过命令改动 folders 时，插件会在**下一个消息边界**（下一次用户发送或工具调用结束）用框架原生的 `notice` 通道通知 Agent，不会打断当前回合。

### 面板

会话头部按钮或新建会话页胶囊打开。面板显示工作区文件路径、每个 folder（显示名、真实路径、主目录/不存在标记），并提供：

- **添加文件夹**：输入相对或绝对路径，可带显示名；不存在或不是目录会被拒绝
- **上移 / 下移**：调整 `folders` 顺序
- **重命名**：设置 `folders[].name`
- **移除**
- **在资源管理器中显示**
- **切换文件** / **最近使用** / **新建工作区文件** / **取消关联**

### `@` 文件菜单

在输入框敲 `@`，除自带的工作区文件外，还会按每个 folder 显示一个分组。输入 `@` 时每个 folder 一行作为入口；输入 `@main` 在所有根里排名；输入 `@dsh-nl/src/` 或 `@D:/repo/src/` 逐层下钻。

选中插入的是**绝对路径**引用（`@D:/repo/src/main.ts`），因为附加根在主工作区之外，任何相对路径都到不了。这是**并列分组**，不改动自带菜单。

---

## 权限模型

### 每个命令只有一个可写根

DSH 沙箱（Windows ACL runner）为每个进程树只授予**一个**工作区写 SID。因此：

- cwd 停在容器目录的命令**不能**在附加根里创建文件。`git -C <根>`、脚本里 `cd <根>`、`git clone <url> <根>`、按绝对路径写文件都会以操作系统级 `Permission denied` 失败。
- 对称地，被重根到某个附加根的命令在同一次调用中不能写容器目录或别的根。
- **创建文件的命令必须把 `workdir` 设为它要写入的目录，且必须是绝对路径。** 相对 `workdir` 只会相对容器目录解析。命令内部切进程目录（`Set-Location` / `cd`）**不会**扩大可写根。
- 后台任务（`run_in_background: true`）同样规则。
- 读操作不受限，不需要 `workdir`。

这条规则会写进系统提示词，所以 Agent 知道该怎么做。

### 工作区文件由用户管理

因为 `.code-workspace` 文件决定本会话能写哪些目录，插件**拒绝 Agent 的 `write` / `edit` 写入任何 `*.code-workspace` 文件**（以及插件自己的 store）。Agent 无法通过编辑工作区文件给自己扩权 —— 请用面板或 `/code-workspace` 增删文件夹，或在编辑器里直接改。

**已知边界**：这是工具层保证，不是沙箱保证。Agent 通过 `pwsh` / `bash` 脚本间接写出一个 `.code-workspace` 文件不会被拦下（不透明命令里的路径无法做路径级检查）。同时，因为插件会采用「目录下唯一的 `.code-workspace`」，一个能创建该文件的 Agent 理论上可以借此扩大自己的根。插件在文档里明确这条边界，而不是假装关闭了它。

---

## 工作原理

| 层 | 位置 | 职责 |
| --- | --- | --- |
| JSONC | `lib/jsonc.js` | 解析注释/尾逗号/BOM；**外科式**改写单个顶层成员，其余字节不动 |
| 工作区模型 | `lib/workspace-file.js` | VS Code 路径规则、folders 增删改序重命名、序列化；纯函数，无 fs |
| 宿主 | `lib/index.js` | 发现与缓存、`tools/execute` 重根拦截、提示词注入、通知、`/code-workspace` 命令、无会话 `codeWorkspace/*` 远程 API、`@` 发现 |
| 客户端 | `lib/client.js` | 会话头部按钮、新建会话页 dock 胶囊、浮层面板、`@` 同伴分组 |

- **发现**：会话 cwd 目录 → 已记录的文件（指针）优先，否则「恰好一个 `.code-workspace`」自动采用；两个及以上视为歧义，不生效。
- **缓存**：模型 2s、目录发现 3s、`@` 索引 4s。刻意**不用 `fs.stat` 元数据**做失效判断——`FsInfo` 的字段不属于插件面向的契约，用不靠谱的字段做戳可能永远不变化，把根集合钉死整个会话。面板与命令的读取一律强制重读。
- **拦截**：`write` / `edit` / `pwsh` / `bash` 的目标落在附加根内时，用 `{ ...standingPolicy, workspaceRoot: <该根> }` 直接执行，**不改 mode**，所以 `read-only` 依旧拒绝、`workspace-write` 放行、`danger-full-access` 放行。后台命令按同样策略注册到 `ctx.jobs`。
- **无会话通道**：`ctx.provide('codeWorkspace', api)` + 手写 `src-json` Typert 描述符，按**路径**而非 session id 取参，所以还没有会话的新建会话页也能读写工作区文件。
- 配置/指针存储在 `<DSH_HOME>/storages/code-workspace/index.json`（在 Agent 沙箱之外，且被写保护）。

---

## 开发与测试

```bash
npm test          # = node --test "test/**/*.test.mjs"
```

四个测试文件，共 103 个用例，**不需要 DSH 运行时**：用假的 `fs` seam、假的 `systemPrompt`、假 `commands`、假 `shell`/`jobs`，客户端用最小 React shim（hook 单次求值 + 递归展开函数组件），所以可以直接检查渲染树并模拟点击。

```bash
node test/jsonc.test.mjs            # JSONC 解析与注释保留改写
node test/workspace-file.test.mjs   # VS Code 路径规则与 folders 增删改
node test/host.test.mjs             # 发现、拦截重根、拒绝、命令、远程 API、@ 发现
node test/client.test.mjs           # bundle 契约、槽位注册、面板交互、@ 源
```

### 实机验证

`tools/verify-instance.mjs` 可以对一个**真实启动的** DSH 实例做端到端校验（索引注入、客户端 bundle 是否被服务、`codeWorkspace/*` 端点、以及真实沙箱下 folders 写回与注释保留）：

```bash
# 用一个一次性 profile，不碰你的 desktop profile
dsh cwsverify --from-default-profile web --dump-config      # 先用 --dump-config 确认组合树
# 手动 link 后启动（--port 0 让系统选空闲端口）
dsh --profile cwsverify --port 0 --no-open
node tools/verify-instance.mjs "http://127.0.0.1:<port>/?token=<token>"
```

本机 `0.2.0-rc.2` 上该脚本 25/25 全通过。

---

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主插件 |
| `lib/client.js` | 客户端 factory bundle |
| `lib/jsonc.js` | JSONC 解析 + 注释保留改写 |
| `lib/workspace-file.js` | `.code-workspace` 模型与路径规则 |
| `cordis.patch.yml` | profile patch 层，插入 `dsh-code-workspace` 行 |
| `test/` | 无需 DSH 运行时的行为测试 |
| `tools/profile-link.mjs` | 不经过 pnpm 把插件挂载进 / 卸载出 DSH profile |
| `tools/verify-instance.mjs` | 真实实例端到端校验 |
| `tools/probe-index.mjs` | 导出一个实例的索引，检查 bundle 注入 |
| `docs/client-contract.md` | DSH 0.2.0-rc.2 客户端插件契约（逐条带行号出处） |
| `docs/design.md` | 架构与不变量 |

## 许可证

MIT
