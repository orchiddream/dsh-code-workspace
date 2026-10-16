# dsh-code-workspace

[English](README.md) | **中文**

> 为 DeepSeek Harness 提供与 VS Code / Trae / Cursor 相同的**多根工作区**：一个 `.code-workspace` 文件就是唯一事实来源，会话根取它 `folders[]` 里**第一个在磁盘上存在的目录**，其余 folder 成为附加根；「在编辑器中打开」递给编辑器的也是同一个文件，所以你看到的窗口与会话能写的目录是同一批。

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
| 多根窗口 | 会话根 = `folders[]` 里**第一个在磁盘上存在的目录**；其余 folder 全部作为附加根，文件自己的目录只表示文件放在哪 |
| 从 Harness 打开窗口 | 用 `.code-workspace` 文件本身启动编辑器：`Code.exe <文件>` / `Trae CN.exe <文件>`，这正是 VS Code 家族「打开这个多根工作区」的 CLI 约定；官方「Open In…」路由做不到——它只接受**目录** |
| `.code-workspace` 损坏 | 面板显示具体行列号；此时不授予任何根（fail closed） |

DSH 的工作区是**单根目录**，`workspaceRegistry.create()` 也只接受存在的目录，所以插件**从文件推导**会话根：磁盘上第一个存在的 folder；一个都不存在时才退回文件自己的目录。

### 术语

| 术语 | 含义 |
| --- | --- |
| **会话根 / 工作区根**（`rootDir`） | 会话所在目录：文件里第一个在磁盘上存在的 `folders[]` 条目；都不存在时是文件自己的目录。它就是插件注册的 DSH 工作区目录，也是沙箱自己的根。 |
| **文件所在目录**（`fileDir`） | `.code-workspace` 文件放在哪里。它只是存放文件的目录，**不是根**。 |
| **附加根** | 除会话根以外的每个 `folders[]` 条目。通过 `workdir` 重根才可写，见权限模型。 |

为什么文件所在目录不做根：DSH 用根目录的规范路径识别工作区，所以把全部 `.code-workspace` 放在同一个目录的用户，会得到一个「根目录里没有任何代码」的会话，而且那个目录里的每个工作区文件都会塌进**同一个** DSH 工作区。两个文件推出来的根相同，它们就是同一个 DSH 工作区，任何插件都拆不开——这条是 `docs/design.md` 里写明的硬限制；插件的答案是：确定性的「每个文件各自的根」、显式的「每个会话各自的关联」、歧义时 fail closed，以及把重复在面板与提示词里如实报出来。

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

### ⚠️ `dsh-plugin-open-in-trae` 已被本插件取代（同时装着也无害）

那个插件靠遮蔽官方「Open In…」控件来加 Trae 一项，本插件现在对整个 VS Code 家族做同一件事，且登记在**不同的 priority** 上，所以两者可以共存、不会撞车——本插件渲染，它留在账本底下。同时装着只是冗余，随时可以退掉：

```bash
node tools/profile-link.mjs uninstall --profile desktop --package dsh-plugin-open-in-trae --dry-run
node tools/profile-link.mjs uninstall --profile desktop --package dsh-plugin-open-in-trae
```

只有 profile 以 `link:` 方式从磁盘挂载的包才允许这样退掉，所以脚本不可能把 pnpm 管理的注册表包从它的记账体系里抠出来。`status` 会在该插件仍在 bundles 里时给出提示。

---

## 使用

### 打开一个工作区

五个入口，读写的是同一个工作区文件（打开的面板形态不同，见下）：

| 入口 | 位置 |
| --- | --- |
| **左栏按钮** | 左侧栏面板列表里的「代码工作区」一行，紧挨自带的「插件」与「定时任务」——**不需要任何会话、也不需要已经打开工作区**就能点 |
| **新建会话页** | 输入框上方的「代码工作区」胶囊（与 git 分支胶囊同一条 dock 带）；它开的是浮动弹出面板，因为这一页还没有会话 |
| **页签** | 中央栏顶部「对话 / 轨迹 / Git」旁边那枚「代码工作区」页签——它会话期间一直在 |
| **会话头部（仅降级组合）** | 标题栏的「◆ 代码工作区」按钮：只在页签没能注册的组合里出现（见「面板」） |
| **斜杠命令** | `/code-workspace use <路径>` |

**左栏那一行是唯一"什么都不用先有"的入口**：它是 `sidebar.panellist` 里的一格（`id` 为 `code-workspace`、order 5，排在「插件」0 与「定时任务」10 之间），点击时由外壳调用 `layout.selectPanel('code-workspace')`；而这个 id 同时是本插件 `main` 那一格的 key，也是对话视图用的 id——所以左栏按钮、对话页签、以及那个面板 id **指向同一个页面**，不会出现两份需要同步的东西。这一页是**无会话**的：它通过共享 RPC 通道读宿主，所以能在任何会话存在之前就注册工作区。

**页签是会话内的主入口**：它会话期间一直可见，所以再放一个头部按钮就是同一个页面的第二个入口，既多余、又正是「页面和浮着的副本同时出现」那个 bug 的来源。因此头部按钮只在 `conversation.view` 没能注册时渲染（例如组合里没有布局服务，没有可加入的页签条）；那种组合下它用 `ctx.layout.selectPanel('code-workspace')` 打开页面、已经在那一页时用 `selectPanel(null)` 回到「对话」，并且**没有浮层降级**——打不开就什么都不做，不再弹浮窗。

面板里可以「切换文件」浏览目录树挑选 `.code-workspace`，或「新建工作区文件」。选定后面板会调用 `workspaceRegistry.create()` 把**该文件推导出的会话根**（它第一个存在的 folder）注册为 DSH 工作区，并（若客户端组合提供了 `uiWorkspace`）直接把会话切到该工作区。会话内的选择走 `/code-workspace` 命令通道，所以它归属于做出选择的那个会话：两个根在同一目录的会话可以各用一个不同的工作区文件。

**「从资源管理器选择…」** 直接打开**主机自己的文件对话框**（过滤 `*.code-workspace`），常见情况下根本不用碰插件自带的浏览器。宿主的目录选择器 seam 只认目录（它的 `native` 能力是用 pick-folders 标志开平台对话框），所以这是它的"文件版兄弟"：同样用绝对路径的 `powershell.exe` 跑一个生成的脚本，加 `-STA`（通用文件对话框是公寓线程的），选中路径写在文件里读回来而不是解析 stdout。三种结果都有意义：选到路径就打开；**取消**保持沉默（那是操作者的选择）；**不可用**只解释一次——非 Windows，或操作者不在主机屏幕前（SSH）——同时下面的目录浏览器原地可用。这个对话框是"主机桌面"的事，SSH 下刻意不弹。

**还没关联任何文件时，页面本身就是选择器。** 会话目录下没有 `.code-workspace`（或有多个、无法自动判定）时，面板会直接列出**切换文件**与**新建工作区文件**两个按钮——你不需要"先在对的目录开会话"。什么都还没关联时，浏览起点是**主机 home 目录**而不是会话自己的目录，因为要找的文件通常在别处；一旦已经关联了文件，**切换文件**与主机文件对话框就从**该文件所在目录**起步，所以把工作区文件集中放在一个目录的用户不必每次都从会话根目录重新导航过去。选中之后，它推导出的会话根会被注册为 DSH 工作区，并在 `uiWorkspace` 可用时把**当前这个会话**切过去——这就是"已经开着的会话如何落到一个真实工作区上"的路径，全程不用离开这个页签。

另外，**只要会话的 cwd 目录下恰好有一个 `.code-workspace` 文件，插件会自动采用它**并记录下来——那种情况下你什么都不用做。目录下有多个候选文件时不会猜（歧义即不生效），需要在面板里明确选一个。所以一个装着多个工作区文件的目录本身不授予任何根：每个文件有自己的根，只有明确的选择才决定某个会话用哪一个。当同一个根被多个文件命名时，面板会如实说出来——「同一主目录的其它工作区文件」，每个文件一行、可点击切换，提示词里也同样写明——因为 DSH 按根的规范路径识别工作区，这些文件属于同一个 DSH 工作区，只有显式的「每个会话各自的选择」才能把它们分开。

**「取消关联」写入的是墓碑（`file: null`）而不是直接删记录**：如果一个根下只有一个工作区文件，删掉记录会让它在下一次读取时立刻被自动采用，按钮看起来就像什么都没做。墓碑会清掉这个**根的**记录（对所有会话生效），但同一个根下的其它会话仍保留各自的会话指针；面板之后会如实显示该根没有关联文件。

### `/code-workspace` 命令

```
/code-workspace                       # 等同 list
/code-workspace list                  # 文件路径 + 文件所在目录 + 全部 folders（带序号）
/code-workspace add <路径> [显示名]     # 相对**文件所在目录**或绝对路径
/code-workspace remove <序号|路径|显示名>
/code-workspace rename <序号|路径> <显示名>
/code-workspace move <序号> <目标序号>
/code-workspace use <文件.code-workspace>
/code-workspace use                   # 不带参数：清掉本会话的关联
/code-workspace create <文件名>        # 在会话根目录新建，并把该根写进 folders
/code-workspace reload                # 丢弃缓存，重新读文件
```

在会话内通过命令改动 folders 时，插件会在**下一个消息边界**（下一次用户发送或工具调用结束）用框架原生的 `notice` 通道通知 Agent，不会打断当前回合。

### 面板

页面就是中央栏顶部那枚「代码工作区」页签（会话期间一直在）；新建会话页胶囊打开浮动面板（`shell.overlay`）。两种形态共用**同一个面板主体**，显示的内容与操作完全一致：工作区文件路径、它推导出的**工作区根目录**、当它与该根不同时的**文件所在目录**、每个 folder（显示名、真实路径、主目录/不存在标记），以及当这个根被多个文件命名时的「同一主目录的其它工作区文件」区块（每个文件一行、可点击切换）。操作有：

- **添加文件夹**：输入相对或绝对路径，可带显示名；不存在或不是目录会被拒绝
- **上移 / 下移**：调整 `folders` 顺序
- **重命名**：设置 `folders[].name`
- **移除**
- **在资源管理器中显示**
- **在编辑器中打开**：本机能证明存在的每个 VS Code 家族编辑器一个按钮（见下）
- **切换文件** / **最近使用** / **新建工作区文件** / **取消关联**

工作区列表标记的是**当前文件**而不是目录：两个文件可以推出同一个根，DSH 把它们当作同一个工作区，所以按根标记会把所有行都点亮、等于什么都没说。

#### 对话视图（中央栏页签）

页面作为 `conversation.view` 槽位里的一格注册：`slots.register({ name: 'conversation.view', id: 'code-workspace', order: 30, label: () => '代码工作区', locale: NS }, WorkspaceView)`。这个槽位就是中央栏顶部那条「对话 / 轨迹 / Git」页签条背后的清单槽——属主（client-ui-conversation）遍历槽位里的条目生成页签，并按 id 一次只渲染一个，所以**一次注册就够了**；order 30 排在自带的「对话」（0）与「轨迹」（10）之后。切成这一页后：

- 页面占满「对话」自己的视图区，不再有第二个栏：内容收在「对话」正文那同一列阅读宽度里（取 `--dsh-chat-content-width` 这个令牌，未定义时有兜底默认值；一张工作区表单拉满宽窗口很难读），超出的部分由页面内部滚动。
- 关闭由页签条负责，所以这一页**不带标题栏的 ✕**，取而代之的是一行提示：「工作区是「对话 / 轨迹 / Git」旁边的一个页签；点回「对话」即可继续聊天。」标题「代码工作区」旁的 ⟳ 刷新按钮保留，和浮动面板里一样。
- 页面是**按会话**的：属主把标准的 session kit 交给这一格，所以页面读 `props.sessionId` 与那个会话的 `cwd`。会话切换会把这份共享的面板状态重新指向新会话，并丢掉上一个会话的状态——否则在会话 A 打开、切到会话 B 之后，`/code-workspace` 就会打进另一个对话。
- React 在这一页的页签被选中时挂载它、用户离开时卸载它，所以每次挂载读一次就正是「把当前状态给我看」；不再有读窗口或节流。要强制重读，用 ⟳。

两种形态的差异只有标题栏这一处：对话视图由页签条负责关闭，浮层面板（`shell.overlay`）保留 ✕。**浮层不是对话视图的降级路径**：浮层只留给新建会话页——那里还没有会话，只能用浮动弹出面板挑 `.code-workspace` 文件；它只在 store 标记为「由创建页打开」时绘制，别处的面板状态画不出它来。打开对话视图时还会顺手把创建页那个浮层收掉，所以同一个面板不会同屏出现两次。

**已知边界**：对话视图需要会话——属主交来的 session kit 是它取会话根的唯一来源（`props.sessionId` → 该会话的 `cwd`），所以新建会话页（还没有会话）用不了它，只能用浮动弹出面板。这一页同时落在上游两件事上：`conversation.view` 槽位让它被页签条认领，`ctx.layout`（也就是声明这个槽位的包）负责选中它。没有布局服务时这一格完全不注册，那时才会渲染会话头部按钮作为降级入口；即使注册成功，`selectPanel` 若拒绝这个 id，按钮点击也只是不生效。

### 在编辑器中打开工作区

两个入口，同一种行为：编辑器打开的是**工作区文件**。

| 入口 | 位置 |
| --- | --- |
| **面板** | 面板里的「在编辑器中打开」：本机能证明存在的编辑器各一个按钮 |
| **「Open In…」菜单** | 官方会话头部 / 文件树控件，由本插件接管（见下） |

家族成员，按面板显示顺序（也就是自动选择的顺序）：

`VS Code` · `VS Code Insiders` · `VSCodium` · `Cursor` · `Windsurf` · `Trae` / `Trae CN`

- 已关联 `.code-workspace` 文件时，启动方式是 `<编辑器> <文件.code-workspace>`：打开的多根窗口里的目录，正是本会话的根集合。把工作区文件作为参数是 VS Code 家族自己的 CLI 约定，而这恰恰是官方「Open In…」路由表达不了的——它只接受绝对**目录**，所以官方那几个 VS Code 条目永远只能开出单文件夹窗口。
- 没有关联文件时退回打开会话根目录。按钮的 tooltip 会写明可执行文件与目标，所以点之前就能看到这种降级。
- 只有**被文件系统证明两次**的编辑器才会被列出：文件真实存在，且文件名仍然属于该成员（`Code.exe`、`Code - Insiders.exe`、`VSCodium.exe`、`Cursor.exe`、`Windsurf.exe`、`Trae.exe`、`Trae CN.exe`）。注册表与 `PATH` 只提供候选，不下结论。
- Windows 是完整实现：`App Paths` → 卸载记录（`DisplayIcon`，其次 `InstallLocation`）→ `PATH` → 常见安装目录。macOS / Linux 走 `PATH` 上的 CLI 名称 + 应用包。
- 经 SSH 连进来的会话报告「没有编辑器」：浏览器那一端不是主机。

**接管官方「Open In…」控件。** 官方目录是编译期写死的表，浏览器半边还有自己的 id→文案映射，所以部署无法通过配置往那个菜单加编辑器。因此本插件在两个目录作用域的格子上登记**同一个 slot id**（`open-in-app`）——`conversation.session.header.utilities` 与 `sidebar.right.tab.files.actions`——priority 用 **-2**。槽位账本对同 id 只渲染 priority 最低的那条，所以本插件胜出，而官方注册仍活在底下（停用本插件，官方控件原样回来），`dsh-plugin-open-in-trae` 的 -1 也依然合法。其余应用的名字、图标、路由与行为全部保持官方实现；只有家族成员被改派到本插件的启动器，而 `VSCodium`、`Trae` / `Trae CN` 是官方目录里根本没有的条目。若 shell 没有提供绘制菜单所需的 UI primitives，接管整体跳过，官方控件保持不动。

记住的选择存在浏览器本地键 `dsh.code-workspace.editor`；官方插件拥有的快捷键（`Ctrl+Alt+O`）刻意不动。

### `@` 文件菜单

在输入框敲 `@`，除自带的工作区文件外，还会按每个 folder 显示一个分组。输入 `@` 时每个 folder 一行作为入口；输入 `@main` 在所有根里排名；输入 `@dsh-nl/src/` 或 `@D:/repo/src/` 逐层下钻。

选中插入的是**绝对路径**引用（`@D:/repo/src/main.ts`），因为附加根在会话根之外，任何相对路径都到不了。这是**并列分组**，不改动自带菜单。

---

## 权限模型

### 每个命令只有一个可写根

DSH 沙箱（Windows ACL runner）为每个进程树只授予**一个**工作区写 SID。因此：

- cwd 停在会话根的命令**不能**在附加根里创建文件。`git -C <根>`、脚本里 `cd <根>`、`git clone <url> <根>`、按绝对路径写文件都会以操作系统级 `Permission denied` 失败。
- 对称地，被重根到某个附加根的命令在同一次调用中不能写会话根或别的根。
- **创建文件的命令必须把 `workdir` 设为它要写入的目录，且必须是绝对路径。** 相对 `workdir` 只会相对会话根解析。命令内部切进程目录（`Set-Location` / `cd`）**不会**扩大可写根。
- 后台任务（`run_in_background: true`）同样规则。
- 读操作不受限，不需要 `workdir`。

这条规则会写进系统提示词，所以 Agent 知道该怎么做。

### 工作区文件由用户管理

因为 `.code-workspace` 文件决定本会话能写哪些目录，插件**拒绝 Agent 的 `write` / `edit` 写入任何 `*.code-workspace` 文件**（以及插件自己的 store）。Agent 无法通过编辑工作区文件给自己扩权 —— 请用面板或 `/code-workspace` 增删文件夹，或在编辑器里直接改。

**已知边界**：这是工具层保证，不是沙箱保证。Agent 通过 `pwsh` / `bash` 脚本间接写出一个 `.code-workspace` 文件不会被拦下（不透明命令里的路径无法做路径级检查）。同时，因为插件会采用「目录下唯一的 `.code-workspace`」，一个能创建该文件的 Agent 理论上可以借此扩大自己的根。插件在文档里明确这条边界，而不是假装关闭了它。

### 两个文件同一个根，拆不开

DSH 里一个 Workspace 的身份就是它根目录 `realpath` 规范化后的路径，所以两个 `.code-workspace` 文件如果第一个存在的 folder 是同一个目录，它们**就是**同一个 DSH 工作区，任何插件都拆不开。本插件不假装能拆。它做的是：

- **确定性的「每个文件各自的根」**：取第一个存在的 folder，所以同一目录里的两个文件只要 folder 集合不同，落的根就不同；
- **显式的「每个会话各自的关联」**：会话自己选过的文件优先于这个根的记录，所以同一个根下的两个会话可以跑不同的 folder 集合；
- **歧义时 fail closed**：没有显式选择又有多个候选时，一个都不授予；
- **把重复如实报出来**：面板里的「同一主目录的其它工作区文件」（每个文件一行、可点击）和系统提示词里都会写明，Agent 因此不会以为它看到的就是唯一存在的 folder 集合。

---

## 工作原理

| 层 | 位置 | 职责 |
| --- | --- | --- |
| JSONC | `lib/jsonc.js` | 解析注释/尾逗号/BOM；**外科式**改写单个顶层成员，其余字节不动 |
| 工作区模型 | `lib/workspace-file.js` | VS Code 路径规则、folders 增删改序重命名、序列化，以及 `deriveRoot`（文件里第一个存在的 folder）；纯函数，无 fs |
| 编辑器家族 | `lib/editor.js` | 本机装了哪些 VS Code 家族编辑器（一律先证明、不假设）、Electron 编辑器需要的子进程环境、以及「启动成功」与「编辑器存活」解耦的启动逻辑 |
| 编辑器图标 | `lib/editor-icon.js` | 官方没有图标路由的家族成员，从可执行文件提取关联图标；产物校验不通过就当作没有 |
| 文件对话框 | `lib/workspace-picker.js` | 用**主机自己的文件对话框**选 `.code-workspace`——宿主那个只认目录的选择器 seam 的文件版兄弟；三种结果（picked / cancelled / unavailable）、runner 可注入、任何测试都不会真弹对话框 |
| 宿主 | `lib/index.js` | 发现与缓存、`tools/execute` 重根拦截、提示词注入、通知、`/code-workspace` 命令、无会话 `codeWorkspace/*` 远程 API、`@` 发现、编辑器与文件对话框端点 |
| 客户端 | `lib/client.js` | 左栏入口与它打开的无会话中央面板、`conversation.view` 的页签本体、仅在降级组合里出现的会话头部按钮、新建会话页 dock 胶囊与它的浮层面板、「Open In…」接管、`@` 同伴分组 |

- **发现**：会话根为 `C` 时，当前文件依次是（1）**本会话**选过的文件；（2）`C` 最近的一条显式记录——若那条是墓碑则到此为止；（3）**自动采用**：`C` 下恰好一个 `.code-workspace`；（4）什么都没有，此时插件对该会话完全失效。两个及以上候选视为歧义（fail closed）。旧规则「记录里目录等于 `C` 的那个文件」已经删掉：一个目录里有多个文件时，它返回的是碰巧先被记录的那个。
- **缓存**：模型 2s、目录发现 3s、`@` 索引 4s。刻意**不用 `fs.stat` 元数据**做失效判断——`FsInfo` 的字段不属于插件面向的契约，用不靠谱的字段做戳可能永远不变化，把根集合钉死整个会话。面板与命令的读取一律强制重读，所以每次这样的读取都会重算推导出的根；对话视图随页签被选中而挂载、用户离开而卸载，每次挂载读一次就正是「把当前状态给我看」，不再有客户端读窗口或节流。
- **拦截**：`write` / `edit` / `pwsh` / `bash` 的目标落在附加根内时，用 `{ ...standingPolicy, workspaceRoot: <该根> }` 直接执行，**不改 mode**，所以 `read-only` 依旧拒绝、`workspace-write` 放行、`danger-full-access` 放行。后台命令按同样策略注册到 `ctx.jobs`。
- **无会话通道**：`ctx.provide('codeWorkspace', api)` + 手写 `src-json` Typert 描述符，按**路径**而非 session id 取参，所以还没有会话的新建会话页也能读写工作区文件。`sessionId` 是可选附加参数（`acceptsUndefined: true`），出现在十一个答案可能取决于「哪个会话问的」的端点上——`state`、`open`、`forget`、`useFile`、`create`、`addFolder`、`removeFolder`、`renameFolder`、`moveFolder`、`openInEditor`、`listFiles`。不带它时答案就是「每个根的关联」，也正是新会话会继承的那一个。
- **状态对象**：`rootDir`、`fileDir`、`file`、`title`、`roots[]`（每项带 `isPrimary`，只有与会话根相同的那一个为 true）、`extraRoots`、`conflict`（同样命名这个根的其它文件），外加 `warnings`、`error`、`indent`。
- **打开编辑器**：`codeWorkspace/editors` 报告本机能证明的家族（懒解析一次并缓存，SSH 会话直接判空）；`codeWorkspace/openInEditor` 取会话根、解析出该根的工作区文件，然后以 `<编辑器> <文件>`（没有文件时退回 `<编辑器> <会话根目录>`）detached 启动。图标经 `codeWorkspace/editorIcon` 以 data URL 内联返回，因此本插件不需要自己的 HTTP 路由，也就不必再引入 `webServer` / `connection` 依赖。
- 配置/关联存储在 `<DSH_HOME>/storages/code-workspace/index.json`（在 Agent 沙箱之外，且被写保护）。store 形状是 `{ version: 2, files, roots: [{ root, file }], sessions: [{ session, file }] }`，都按最近优先排列，每个列表上限 200 条。v1 的 store 会保留它的 `files`、但不会凭空造出关联；第一次显式选择才会写下关联。

---

## 开发与测试

```bash
npm test          # = node --test "test/**/*.test.mjs"
```

六个测试文件，共 177 个用例，**不需要 DSH 运行时**：用假的 `fs` seam、假的 `systemPrompt`、假 `commands`、假 `shell`/`jobs`、假编辑器宿主机（注册表、`PATH`、文件集全部注入）、可注入的对话框 runner（所以没有任何测试会真的弹出文件选择框），客户端用最小 React shim（hook 单次求值、递归展开函数组件），所以可以直接检查渲染树并模拟点击。

```bash
node test/jsonc.test.mjs              # 25 —— JSONC 解析与注释保留改写
node test/workspace-file.test.mjs     # 24 —— VS Code 路径规则、folders 增删改、推导会话根
node test/host.test.mjs               # 50 —— 发现、store、拦截重根、拒绝、命令、远程 API、@ 发现、编辑器守卫
node test/client.test.mjs             # 46 —— bundle 契约、槽位注册、面板交互、重复根区块、Open In… 接管、@ 源
node test/editor.test.mjs             # 22 —— 家族解析、先证明再启动、子进程环境、启动结果、图标
node test/workspace-picker.test.mjs   # 10 —— 主机文件对话框的三种结果与可注入 runner
```

编辑器相关测试不会启动任何编辑器：解析器的注册表 / `PATH` / 文件探针全部注入，`launchEditor` 拿到的是子进程替身。

### 实机验证

`tools/verify-instance.mjs` 可以对一个**真实启动的** DSH 实例做端到端校验（索引注入、客户端 bundle 是否被服务——含「Open In…」接管标记、`codeWorkspace/*` 端点、未知 id 必须撞上的两条编辑器拒绝、`open` 会把临时工作区文件推导出的根注册为 DSH 工作区，以及真实沙箱下 folders 写回与注释保留）：

```bash
# 用一个一次性 profile，不碰你的 desktop profile
dsh cwsverify --from-default-profile web --dump-config      # 先用 --dump-config 确认组合树
# 手动 link 后启动（--port 0 让系统选空闲端口）
dsh --profile cwsverify --port 0 --no-open
node tools/verify-instance.mjs "http://127.0.0.1:<port>/?token=<token>"
```

本机 `0.2.0-rc.2` 实测 **30/30**：编辑器功能加入前的 25 项，加上随它新增的 5 项（bundle 里带上了接管、`codeWorkspace/editors` 答出家族、未知 id 必须撞上的两条拒绝）。脚本不会启动任何编辑器——它发的两次编辑器调用按构造都是拒绝。它的临时工作区文件里写的是 `{ "path": "." }`，所以插件从它推导出的根就是那个临时目录本身，`open registers the root the file derives as a DSH workspace` 这一条断言的就是这个根，而不是文件所在的目录。

这个脚本**不覆盖浏览器里画出来的面板**：它断言的是宿主端点和 bundle 标记，不是渲染出来的界面。对话视图的页面注册、入口切换、无布局服务时不动作与会话归属由 `test/client.test.mjs` 钉住；这一页在真实中央栏里画出来的样子**尚未在浏览器中实测**。左栏那一行与主机文件对话框同理：注册、决策与降级都由测试钉住，但**对话框本身还没有在真实桌面上弹过一次**。

---

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主插件 |
| `lib/client.js` | 客户端 factory bundle |
| `lib/jsonc.js` | JSONC 解析 + 注释保留改写 |
| `lib/workspace-file.js` | `.code-workspace` 模型、路径规则与 `deriveRoot`（文件里第一个存在的 folder） |
| `lib/editor.js` | VS Code 家族识别、子进程环境、启动 |
| `lib/editor-icon.js` | 官方无图标路由的家族成员：可执行文件图标提取 |
| `lib/workspace-picker.js` | 用主机自己的文件对话框选 `.code-workspace`——宿主那个只认目录的选择器 seam 的文件版兄弟 |
| `cordis.patch.yml` | profile patch 层，插入 `dsh-code-workspace` 行 |
| `test/` | 无需 DSH 运行时的行为测试 |
| `tools/profile-link.mjs` | 不经过 pnpm 把插件挂载进 / 卸载出 DSH profile；`--package` 可退掉被取代的插件 |
| `tools/verify-instance.mjs` | 真实实例端到端校验 |
| `tools/probe-index.mjs` | 导出一个实例的索引，检查 bundle 注入 |
| `docs/client-contract.md` | DSH 0.2.0-rc.2 客户端插件契约（逐条带行号出处） |
| `docs/design.md` | 架构与不变量 |

## 许可证

MIT
