# 设计：代码工作区页（`conversation.view`）UI 重构规格

> 状态：**已实现（`dsh-code-workspace` 0.2.1，`test/client.test.mjs` 200/200 通过，真实 rc.5 实例截图复核）**。
> 目标运行时：DSH **0.2.2-rc.5**（桌面 app 实测版本），
> 插件最低声明 `dsh >= 0.2.0-rc.2`；两代主题令牌的差异一律用惰性 fallback 覆盖。
> 基线：用户截图（中文 UI，1014×561，纯白内容区）与 `lib/client.js` 当前实现。
> 范围：只改 `lib/client.js` 的**渲染与本地化代码**，以及 `test/client.test.mjs` 里
> **两行测试定位**（§5.4）；`lib/index.js`、远程 API、store、提示词、`package.json`
> 依赖与 `dsh.client.inject` 均**不动**。
>
> 证据来源：
> - 本仓库源码：`lib/client.js`（行号均指当前文件）、`test/client.test.mjs`、
>   `docs/design.md`、`docs/client-contract.md`、`docs/design-project-shells.md`。
> - rc.5 客户端包解包源码：`C:\Users\EDY\AppData\Local\Temp\app-rc5-dsh\`
>   （下称 `RC5/`；本机 app asar 抽出的 TypeScript + CSS module 源码）。
> - rc.2 安装包：`…\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
>   （`dsh-client-ui-primitives` 只随包发布 `lib/*.css` 与类型，源码在 rc.5 asar 中也不单独发布，
>   所以 primitives 的几何/令牌证据引用其 `lib/Button.module.css` 等随包文件）。
>
> 本文是**实现规格**：每个数值、每句文案都是结论；实现者不需要再做设计选择。

---

## 1. 诊断

当前页面（`PanelBody`，`lib/client.js:1817-2060`）把「标识 / 元信息 / 动作 / 列表 / 表单 /
编辑器」平铺成一列等宽文本，视觉权重与操作风险全部相同。按类别拆开：

### 1.1 信息架构

| # | 现象（证据） | 根因 | 修法（本文结论） |
| --- | --- | --- | --- |
| A1 | 文件名、根目录、文件目录、动作、文件夹列表之间只有 `marginTop: 8/10` 和零散 `<hr>`，没有分组（`1899-1952`） | 所有内容都是 `PanelBody` 的平级子节点，没有「卡片 / 分区」概念 | 改为 **页头卡片 + 分区** 结构：每个分区 = 分区标题（32px）+ 内容；分区之间 24px（§3） |
| A2 | 「工作区根目录」「文件所在目录」是 `标签 + 空格 + 路径` 的裸文本（`1900-1908`），第二行没有标签就不能说明自己是什么 | 用 `div` 拼版式，而不是字段 | 改为 **两列定义栅格**（96px 标签列 + 路径 + 复制按钮），见 §4.3 |
| A3 | 页面主标题是「代码工作区」（`1845`），和上方页签标签完全重复；真正该回答的「这是哪个工作区」只靠一行路径 | 把「页签名」误当成「页标题」 | H1 = **工作区文件名**，路径降为副标题；页签名交给页签条（§4.2） |
| A4 | 「添加文件夹」表单在文件夹列表之后、编辑器之前，既没有区段标题也没有分隔（`1998-2018`） | 表单没有归入它所服务的分区 | 表单固定在「工作区文件夹」分区内、列表卡片之下（§4.7） |
| A5 | `hint.view`（「工作区是『对话 / 轨迹 / Git』旁边的一个页签…」）每次访问都占一行（`1852`） | 把一次性说明常驻进页面 | 从渲染中移除，键保留（§5.2） |

### 1.2 视觉层级

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| B1 | 页面上只有 3 个字号：12/11/10px（`labelStyle` 默认 12，标签 11，Badge 10）。1014px 宽的页面读起来像「日志」 | 没有字号刻度 | 16/24（H1）· 13/20（分区标题、正文）· 14/22（行标题）· 12/18（元信息、路径）· 11/17（徽标）（§6.2） |
| B2 | 所有按钮同一外观：`TOKEN.fill` 灰底 + 1px 灰边 + 12px 字（`820-850`），「取消关联」只把文字染红（`829`） | `Button` 只有 `danger` 一个开关，没有主次 | 四种 variant：`primary`（实心）/`outline`（描边）/`ghost`（无底）/ 危险态（`danger` 文字 + 危险 hover），加图标按钮（§4.1） |
| B3 | 文件夹行没有 hover 高亮、没有行高概念，行与行之间只有 `borderTop`（`897-911`） | `Row` 是表格行不是列表行 | 行高 48px、圆角 8、hover 填充、主目录行常驻弱选中底（§4.6） |
| B4 | 页面背景 `bgBase`（透明）+ 纯白卡片区，没有表面层次；错误行直接压在白色上 | 没有卡片材料 | 卡片 = `card-fill` + 0.5px `border-l4` + 12px 圆角（§6.1） |
| B5 | 1014px 窗口下内容顶到边、行宽失控 | 容器只有 `padding: 16px 24px 24px`，且没有正文宽度上限意识 | 保留 `--dsh-chat-content-width` 轴（与对话正文同宽），左右留 24px（§3.1） |

### 1.3 操作可达性

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| C1 | 每个文件夹行 6 个图标按钮（`>_ ↑ ↓ ✎ ⧉ ✕`）同尺寸、同权重、无分组；`✕`（移除）紧贴 `⧉`（显示） | 动作平铺、无分组、无 tooltip 可见性 | 三组：终端 · 排序/编辑 · 危险；组间 1px 竖线；全部 28×28 图标按钮，`title` 即 tooltip（§4.6） |
| C2 | 「最近使用」「切换文件」等 6 个动作挤在一行（`1909-1916`），「取消关联」混在其中 | 没有主/次/危险层级 | 主操作 = 添加文件夹（实心）；切换文件 = 描边；其余 = ghost；取消关联 = 红色文字 + 危险 hover（§4.4） |
| C3 | 移除文件夹**没有二次确认**（`1988` 直接 `mutate('remove …')`） | 缺确认 | 移除文件夹、页面级取消关联都先 `window.confirm`（§4.6 / §4.4） |
| C4 | 没有滚动容器：文件夹多时把「添加文件夹」和编辑器支行挤出首屏 | 页面只有外层滚动 | 文件夹列表 `max-height: 400px; overflow-y: auto`（§3.5） |
| C5 | 两个输入框只有 placeholder，输入后不知道字段是什么（`2001-2016`） | 无可见标签 | 标签在上方，placeholder 改成示例（§4.7） |

### 1.4 状态与反馈

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| D1 | 错误是裸红字一行（`1855-1859`），不能关闭，和提示行只差颜色 | 没有 Banner 组件 | error/warn/info/success 四种 Banner：色点 + 8% 色调底 + 关闭（§4.5） |
| D2 | 截图里的「终端打开失败: the terminal tab did not appear」把**英文内部错误**直接给用户看（`1342-1348` + `1565`） | `terminalErrorText` 只兜底 `error.terminalFailed` | 为三种已知失败加本地化文案（`error.terminalNoTab` / `terminalNotWritable` / `terminalOtherSession`，§7.5） |
| D3 | `busy` 只是把按钮 `opacity: 0.5`，页面没有任何「正在进行」的信号 | 无 busy 表达 | 页头显示 `status.working` 文本 + 所有会写宿主的按钮禁用 + 根节点 `aria-busy`（§4.13） |
| D4 | 加载态是「加载中…」一行灰字（`1878`） | 无骨架 | 加载卡片：2 条骨架条（`bg-skeleton`）+ 加载文案（§4.13） |
| D5 | `notice` 的语义混在一起：成功（已用 VS Code 打开）与提示（这台主机打不开系统对话框）同一外观（`1860-1864`） | 无 tone | 新增 `state.noticeTone: 'info' \| 'success'`（§7.4） |
| D6 | 空状态只有一行字：无文件夹时只有 `empty.roots`（`1953-1954`），没有引导动作 | 空状态无行动 | 每个空状态给「一句解释 + 一个下一步」（§4.13 矩阵） |

### 1.5 文案

| # | 现象 | 修法 |
| --- | --- | --- |
| E1 | 原始远端错误混入 UI（D2） | 已知错误全部走本地化键；未知错误保留宿主消息（它通常是可操作的） |
| E2 | `action.recent` 被同时用作按钮和区段标题（`1911`、`2041`） | 按钮保持 `action.recent`；区段标题复用同一文案，但语义上作为 `h2` |
| E3 | 浏览列表里 `.code-workspace` 文件的徽标是动词「打开工作区文件」（`1039`） | 徽标改名词：`badge.workspaceFile`（§5.1） |
| E4 | 路径字段没有可复制的提示 | 复制按钮 + `action.copyPath` / `action.copied` |

### 1.6 可达性

| # | 现象 | 修法 |
| --- | --- | --- |
| F1 | 图标按钮只有视觉字形，`title` 是唯一的可访问名（`961-965`），且 `title` 在截图里不可见 | 图标按钮同时给 `title` 与 `aria-label`；`title` 保留（渲染树测试也依赖它） |
| F2 | 没有焦点环（`Button`/`TextInput` 只有 `outline: none`，`870-894`） | 统一焦点环：`outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, …)`，`outline-offset: -2px`（§6.3） |
| F3 | 标题用 `div`，列表用 `div`，屏幕阅读器没有结构 | 页头 `h1`、分区标题 `h2`；文件夹/管理器列表 `role="list"` + 行 `role="listitem"`；Banner `role="alert"` / `role="status"` |
| F4 | 禁用态只有 `opacity: 0.5`，仍可聚焦 | disabled 按钮用原生 `disabled`（保留 `onClick: undefined` 的既有行为，见测试 `client.test.mjs:1823`） |

---

## 2. 设计原则

### 2.0 技术路线判定：保留内联样式，**不**接 primitives

结论先行：**页面继续用 `h(...)` + 内联 `style` + `TOKEN` + `t('...')` 手写原子，不引入
`@deepseek-ai/dsh-client-ui-primitives` 的渲染路径，也不新增 cordis 服务**。

| 事实 | 证据 |
| --- | --- |
| primitives 是**平台种子模块**，只能用 `require` 拿，不是 cordis 服务；本 bundle 已经「可选 require」它，且只在「Open In…」接管里使用 | `lib/client.js:47-65`（`optionalRequire('@deepseek-ai/dsh-client-ui-primitives')`）；`docs/client-contract.md:88-94`（平台种子模块清单：react / dsh-client-store / dsh-client-ui-primitives） |
| primitives 存在性**没有保证**：组合可裁剪、测试环境用 stub 甚至不注入 | `test/client.test.mjs:101-120`（primitivesStub / `withPrimitives()`），`:1400-1419`（没有 primitives 就跳过接管） |
| 页面（`conversation.view`）必须在**任何组合**里渲染，接 primitives 就要写「有 primitives / 无 primitives」两套树，测试与视觉同步成本翻倍 | `test/client.test.mjs:457-499`（页面注册与渲染不依赖 primitives） |
| `dsh.client.inject` 列表里没有 primitives，也不该为此新增（bundle 必须零依赖可加载） | `package.json` 的 `dsh.client.inject`：`@deepseek-ai/dsh-api-gateway`, `dsh-api-remotes`, `dsh-client-connection`, `dsh-client-locale`, `dsh-client-ui-input-trigger`；`lib/client.js:69` 的 `inject` |
| 内联样式无法表达 `:hover` / `:focus-visible` / `:disabled` | 用 **本地 `useState` 原子**（`Button`/`IconButton`/行组件）实现 hover/pressed/focus 态；`disabled` 用原生属性 + opacity |

因此：**造型抄 primitives，实现不依赖 primitives**。§6 的令牌、§4 的尺寸全部取自
rc.5 自己的 CSS（`RC5/dsh-client-ui-theme/src/styles/*.css`、`RC5/dsh-client-ui-sidebar-files/**`、
`RC5/dsh-client-ui-workspace/**`、rc.2 的 `dsh-client-ui-primitives/lib/*.module.css`），
所以外观与宿主原生控件同一套几何。

### 2.1 原则

1. **先回答「我在哪个工作区」，再给动作**：H1 = 文件名，路径 = 副标题，元信息 = 定义栅格；
   动作永远在事实之后。
2. **一个分区一个职责，同一视区一个主按钮**：有文件时唯一实心按钮是「添加文件夹」（未关联文件时是
   空状态的「切换文件」）；「切换文件」其余场合是描边；其余是 ghost；「取消关联 / 移除」是危险动作，
   永远与普通动作分开。
3. **危险动作不与常用动作相邻**：`✕` 与排序/编辑之间隔 1px 竖线 + 6px；页面级「取消关联」
   被 `margin-left: auto` 推到行尾，并先确认。
4. **信息密度靠字号与留白分层，不靠加框**：卡片只用在「一组数据」（标识、文件夹、管理器、
   冲突、最近、浏览）；动作行、编辑器按钮不加卡片。
5. **状态可读、可恢复**：任何失败给出「发生了什么 + 下一步」，成功用 success tone；
   所有 Banner 可关闭；空状态带行动；busy 禁止重复提交。
6. **主题无关**：只用 `--dsw-*` 语义令牌，每个 `var()` 带惰性 fallback；不写明暗分支；
   形状（字号/行高/间距/圆角）写死。

---

## 3. 页面结构

### 3.1 尺寸基线

| 项 | 值 | 说明 |
| --- | --- | --- |
| 内容列宽度 | `maxWidth: calc(var(--dsh-chat-content-width, 920px) + 48px)` | rc.5 正文宽度轴 `RC5/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css:468-475`（`clamp(680px, 列宽*0.64, 920px)`）；`+48` 是两侧 24px 净空，正好对齐对话的宽度拖拽手柄（同文件 `:344-365`） |
| 页面内边距 | `24px 24px 40px` | view/panel 同值；overlay 为 `12px` |
| 分区间距 | 24px（view/panel）· 16px（overlay） | `PanelBody` 根节点 `display:flex; flex-direction:column; gap: …` |
| 分区内节奏 | 标题 → 内容 8px；卡片内元素 12/16px；行间 2px | 见各组件 |
| 间距刻度 | 2 / 4 / 8 / 12 / 16 / 24 / 32 | 只准用这七个值 |
| 圆角 | 4 / 8 / 12 / 16 / 999 | `--dsw-radius-xs/sm/md/lg`；行 8，卡片 12，弹层 16，胶囊 999 |
| 控件高度 | sm 按钮 28 · 输入框 32 · 图标按钮 28 · 小图标按钮 24 · 行 48/40/32 · 分区标题 32 | rc.2 primitives：md 36/R12、sm 28/R8（`dsh-client-ui-primitives/README.md` 原文） |
| 滚动条 | 全局已被主题接管（`RC5/dsh-client-ui-theme/src/styles/scrollbar.css`），滚动容器只需 `overflow-y:auto; scrollbar-gutter:stable; margin-right:2px` | `RC5/dsh-client-ui-sidebar-files/src/client/FilesBody.module.css:178-190` |

### 3.2 线框（view：`conversation.view` 页签，`variant:'view'`）

```
┌ 外层：flex 居中，overflow:auto，scrollbar-gutter:stable ─────────────────────────────┐
│ ┌ 内容列：maxWidth = chat 宽 + 48，padding 24/24/40 ───────────────────────────────┐ │
│ │                                                                                  │ │
│ │  [error Banner]            ← 仅 state.error；可关闭                              │ │
│ │  [notice Banner]           ← 仅 state.notice；可关闭                             │ │
│ │            （两个 Banner 之间 8px；与下一分区之间 24px）                          │ │
│ │                                                                                  │ │
│ │  ┌ 卡片：工作区标识  padding 16 / radius 12 / gap 12 ────────────────────────┐   │ │
│ │  │ [18px 图标] H1 合同重构-放弃低代码.code-workspace     处理中…  [⟳]        │   │ │
│ │  │ D:/home/workspace/合同重构-放弃低代码.code-workspace            [⧉复制]    │   │ │
│ │  │ ───────────────────── 0.5px hairline ─────────────────────                │   │ │
│ │  │ 工作区根目录   D:/home/hwpro/sop_hetong   [已注册]            [⧉复制]     │   │ │
│ │  │ 文件所在目录   D:/home/workspace                              [⧉复制]     │   │ │
│ │  │ ───────────────────── 0.5px hairline ─────────────────────                │   │ │
│ │  │ [切换文件] [新建工作区文件] [最近使用] [在资源管理器中显示]   [取消关联]   │   │ │
│ │  └──────────────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                                  │ │
│ │  [warn Banner：无法解析该工作区文件]      ← 仅 value.error；不可关闭             │ │
│ │                                                                                  │ │
│ │  工作区文件夹 · 3                                                                 │ │
│ │  ┌ 卡片：列表  padding 8 / radius 12 / 行 gap 2 / maxHeight 400 滚动 ────────┐   │ │
│ │  │ ⠿ ▸ sop_hetong   [主目录]                                             │   │ │
│ │  │    D:/home/hwpro/sop_hetong                     [>_] │ [↑][↓][✎][⧉] │ [✕]  │   │ │
│ │  │ ⠿ ▸ low-code-hetong                                                    │   │ │
│ │  │    D:/home/hwpro/low-code-hetong                [>_] │ [↑][↓][✎][⧉] │ [✕]  │   │ │
│ │  └──────────────────────────────────────────────────────────────────────────┘   │ │
│ │  文件夹路径（相对或绝对）                                                        │ │
│ │  [ 例如 D:/projects/my-app                    ] [添加文件夹]                     │ │
│ │  显示名称（可选）                                                                │ │
│ │  [ 留空则显示目录名                                                 ]            │ │
│ │                                                                                  │ │
│ │  同一主目录的其它工作区文件                                                       │ │
│ │  ┌ 卡片 ─────────────────────────────────────────────────────────────────────┐   │ │
│ │  │ 说明文字（12/18）                                                         │   │ │
│ │  │ ◆ D:/lib/two.code-workspace                                               │   │ │
│ │  └──────────────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                                  │ │
│ │  在编辑器中打开                                                                   │ │
│ │  [VS Code] [Trae CN]              ← outline sm；空时一行说明                     │ │
│ │                                                                                  │ │
│ │  最近使用                                                              [✕]        │ │
│ │  ┌ 卡片：最近文件（行 40px）………………………………………………………          │   │
│ │                                                                                  │ │
│ │  浏览目录                                                              [✕]        │ │
│ │  ┌ 卡片：工具栏 + 路径 + 列表（maxHeight 260 滚动）………………………………          │   │
│ │                                                                                  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 线框（panel：左栏入口打开的 `main` 页，`ManagerBody`）

**这一页不画标识卡片。** 它的主体是管理器列表（§4.12），因为卡片上的每个动作
（取消关联 / 新增文件夹 / 项目终端）都是「对本会话说的话」，而这一页按设计没有会话：
照搬过来只能变成全局语义，并且会把列表挤出首屏。

```
┌ 外层：flex 居中，overflow:auto，scrollbar-gutter:stable ─────────────────────────────┐
│ ┌ 内容列：maxWidth = chat 宽 + 48，padding 24/24/40 ───────────────────────────────┐ │
│ │                                                                                  │ │
│ │  [error Banner] / [notice Banner]   ← 仅在读或写失败/有回执时                     │ │
│ │                                                                                  │ │
│ │  代码工作区 · N                       [切换文件] [从资源管理器选择…] [⟳]         │ │
│ │  ┌ 卡片：已记录 .code-workspace 列表（行 48px，gap 2，padding 8）…            ┐   │ │
│ │  │ ◆ app         [已注册]                                   D:/ws        [✕] │   │ │
│ │  │    D:/ws                                                                   │   │ │
│ │  └────────────────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                                  │ │
│ │  浏览目录                                                        [✕]             │ │
│ │  ┌ 卡片：工具栏 + 路径 + 列表（maxHeight 260 滚动）………………………………          │   │ │
│ │                                                                                  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- 动作只有三个，全部挤在分区标题右端（`SectionHeader.action`）：切换文件（primary）、
  从资源管理器选择…（ghost）、⟳（图标）。**没有**新建工作区文件（需要一个目录）、
  没有取消关联、没有编辑器按钮、没有文件夹区与终端提示。
- 列表每次打开都强制重读（`loadRecent(true)`），所以不会显示别处改动之前的旧状态。
- 没关联任何文件时也**不**画「未关联」空状态卡片：这一页没有"会话状态"可讲，
  空列表本身就是空状态（卡片内 `empty.workspaces` 一行）。

### 3.4 线框（overlay：新建会话页浮层，宽度 430，`variant` 未传）

分区顺序同 view；overlay 不是页签，所以**保留右上角 ✕**（关闭浮层）。内容列宽 430-24=406，
元信息栅格退化为「标签 88px + 值 + 复制」，动作行换行成 2–3 行，文件夹行动作组整体换到第二行
（`flex-wrap: wrap`，见 §4.6）。

### 3.5 滚动与粘性（结论）

- **整页只有外层一个滚动条**（`WorkspaceView` / `WorkspacePanel` 根节点 `overflow:auto`），
  页面头部**不吸顶**：上方 76px 的会话头 + 页签条已经承担了「我在哪」的定位
  （`RC5/dsh-client-ui-conversation/src/client/skeleton/ConversationRoot.module.css:23-31`），
  再吸一个头会吃掉 561px 高窗口的 1/5。
- **文件夹列表有独立滚动**：`max-height: 400px`（约 8 行），`overflow-y:auto`，
  `scrollbar-gutter:stable`，`margin-right:2px`。列表 400px 以内不出现滚动条。
- 「最近使用」列表 `max-height: 320px`（约 8 行）；「浏览目录」列表 `max-height: 260px`。
- 滚动容器统一 `overscroll-behavior: contain`。

### 3.6 分区顺序（实现即照此顺序 push）

| 位置 | view | panel（`ManagerBody`） | overlay |
| --- | --- | --- | --- |
| 1 | error Banner | error Banner | error Banner |
| 2 | notice Banner | notice Banner | notice Banner |
| 3 | 标识卡片 / 空状态 / 加载卡片 | **代码工作区（管理器，含工具组）** | 同左 |
| 4 | 工作区文件夹 | 浏览目录（条件） | 工作区文件夹 |
| 5 | 冲突区 | — | 冲突区 |
| 6 | 在编辑器中打开 | — | 在编辑器中打开 |
| 7 | 最近使用 | — | 最近使用 |
| 8 | 浏览目录 | — | 浏览目录 |
| 9 | — | — | — |

panel 不再是「view 加一个分区」：它的根节点是 `ManagerBody`，只看列表和浏览器；
`PanelBody` 只服务 view 与 overlay（标识卡片 / 文件夹 / 冲突 / 编辑器 / 最近 / 浏览）。

---

## 4. 组件规格

所有组件都在 `apply` 闭包内，用现有 `h(type, props, children)`（`lib/client.js:333-335`）。
字符串一律 `t('...')`；不新增依赖、不写 `<style>`。

### 4.1 原子组件

#### 4.1.1 `Button`（替换 `lib/client.js:820-850`）

单一尺寸 `sm`（本页不用 md）：

```
height 28, padding 0 10, gap 4, borderRadius 8,
fontSize 12, lineHeight '18px', fontWeight 400,
display inline-flex, alignItems center, justifyContent center,
boxSizing border-box, whiteSpace nowrap,
cursor: disabled ? 'not-allowed' : 'pointer',
opacity: disabled ? 0.4 : 1
```

| variant | 背景 | 文字 | 边框 | hover（非 disabled） |
| --- | --- | --- | --- | --- |
| `primary` | `TOKEN.primary`（`button-primary-fill`） | `TOKEN.onPrimary` | `0.5px solid transparent` | `TOKEN.primaryHover` |
| `outline` | `transparent` | `TOKEN.label` | `0.5px solid TOKEN.lineStrong` | 背景 `TOKEN.hover` |
| `ghost`（默认） | `transparent` | `TOKEN.label` | 无 | 背景 `TOKEN.hover`；按下 `TOKEN.pressed` |

- `props.danger === true`：文字/图标 `TOKEN.danger`；ghost 时 hover 背景 `TOKEN.hoverDanger`；
  outline 时边框不变（危险只由文字表达）。**本页只有 ghost 危险按钮**。
- `props.title` 原样传给 `<button title>`（tooltip）；`props.ariaPressed` 写到 `aria-pressed`。
- `disabled` 时 `onClick` 必须为 `undefined`（既有行为，测试 `client.test.mjs:1823` 断言）。
- hover/按下用组件内 `React.useState` + `onMouseEnter/Leave/Down/Up` 计算样式；
  焦点环见 §6.3。

#### 4.1.2 `IconButton`（新增，放在 `Button` 之后）

```
width 28, height 28, padding 0, display inline-flex,
alignItems/justifyContent center, border none, borderRadius 8,
background transparent, color TOKEN.labelDim,
fontSize 13, lineHeight 1, cursor ...
```

- `props.children` 是字形文本（`>_`、`↑`、`↓`、`✎`、`⧉`、`✕`、`⟳`、`⠿`）或 SVG。
  终端的 `>_` 必须包一层 `span`：`fontFamily: TOKEN.mono, fontSize: 12, lineHeight: '18px'`
  —— 渲染树测试要求该按钮的文本**恰好**是 `>_`（`client.test.mjs:1660`、`:1668`、`:1823`、
  以及 `rowByPath`/`terminalButton` 辅助函数 `:1524-1538`）。
- 28px 变体：默认；24px 变体用于路径复制、Banner 关闭（`props.small === true` → 24×24，圆角 8）。
- hover：背景 `TOKEN.hover`，图标色 `TOKEN.label`；danger：hover 背景 `TOKEN.hoverDanger`、色 `TOKEN.danger`。
- `title` 与 `aria-label` 都写 `props.title`（屏幕阅读器与鼠标悬停都可读）。
- `disabled` → 原生 `disabled`、`opacity .4`、`onClick: undefined`。
- 焦点环同 §6.3。

#### 4.1.3 `TextInput`（替换 `lib/client.js:870-895`）

```
height 32, padding '0 8px', boxSizing border-box,
border '0.5px solid ' + TOKEN.lineStrong, borderRadius 12,
background TOKEN.field, color TOKEN.label,
fontSize 14, lineHeight '22px',
outline none
```

- 焦点（`onFocus`）：边框色 `TOKEN.accent`；失焦还原。
- placeholder 色 `TOKEN.labelDimmed`（占位符在任何主题都读得出来）。
- 透传 `dataField` → `data-field` 属性（测试定位用，见 §5.4）。
- Enter 触发 `props.onEnter`（保留既有行为）。

#### 4.1.4 `Badge`（替换 `lib/client.js:852-868`）

几何照 primitives Tag（`dsh-client-ui-primitives/lib/Tag.module.css`）：

```
display inline-flex, alignItems center, borderRadius 999,
padding '1px 8px', fontSize 11, lineHeight '17px', fontWeight 500, whiteSpace nowrap
```

| tone | 背景 | 文字 | 用途 |
| --- | --- | --- | --- |
| `info` | `color-mix(in srgb, TOKEN.accent 10%, transparent)` | `TOKEN.accent` | 主目录 |
| `success` | `color-mix(in srgb, TOKEN.success 10%, transparent)` | `TOKEN.success` | 已注册 |
| `warning` | `color-mix(in srgb, TOKEN.warn 12%, transparent)` | `TOKEN.warn` | 不存在 |
| `outline` | transparent + `0.5px solid TOKEN.lineStrong` | `TOKEN.labelFaint` | 工作区文件 |
| `neutral` | 背景 `var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.08))` | `TOKEN.labelDim` | 备用 |

#### 4.1.5 `SectionHeader`（新增）

```
height 32, display flex, alignItems center, gap 8, marginBottom 8
h2: fontSize 13, lineHeight '20px', fontWeight 500, color TOKEN.label
计数值/副标题: fontSize 12, lineHeight '18px', color TOKEN.labelFaint
右侧动作: gap 8（可选，本页只有「最近使用 / 浏览目录」用关闭按钮）
```

标题用 `h('h2', …)`；计数值紧跟标题（`marginLeft: 2px`）。右侧关闭按钮 = `IconButton`，`title = action.close`。

#### 4.1.6 `Card`（新增）

```
background TOKEN.card,
border '0.5px solid ' + TOKEN.lineStrong,
borderRadius 12, boxSizing border-box
```

`props.padding`：列表卡片 `8`，内容卡片 `16`（默认 16）。

#### 4.1.7 `Banner`（新增）

```
display flex, alignItems flex-start, gap 8,
padding '8px 8px 8px 12px', borderRadius 8, boxSizing border-box,
border '0.5px solid ' + color-mix(in srgb, <tone> 30%, transparent),
background color-mix(in srgb, <tone> 8%, transparent),
fontSize 12, lineHeight '18px'
```

| tone | 色点 | 背景 | 边框 | 文字 | 图标/角色 |
| --- | --- | --- | --- | --- | --- |
| `error` | `TOKEN.danger` | `color-mix(in srgb, TOKEN.danger 8%, transparent)` | 同色 30% | `TOKEN.danger` | `role="alert"` |
| `warning` | `TOKEN.warn` | warn 8% | warn 30% | `TOKEN.warn` | `role="alert"` |
| `info` | `TOKEN.accent` | accent 8% | accent 30% | `TOKEN.label` | `role="status"` |
| `success` | `TOKEN.success` | success 8% | success 30% | `TOKEN.label` | `role="status"` |

- 色点：8×8 圆点（`borderRadius: 999`，`flex:'none'`，`marginTop: 5`）。
  **不引入图标依赖**：色点就是状态图标（与 rc.5 `StateDot` 的 `done/warning/error/ongoing` 同一形状语言），
  颜色由 tone 决定。
- 文案 `flex:1; minWidth:0; overflowWrap:'anywhere'`。
- 关闭按钮（`props.dismissible === true`）：`IconButton` 24px，字符 `✕`，`title = action.close`。
- `error` / `notice` 可关闭（`onDismiss` → `patch({error:null})` / `patch({notice:null, noticeTone:'info'})`）；
  parse 警告由 `value.error` 派生，**不可关闭**。

#### 4.1.8 `EmptyState`（新增，卡片内容态）

```
display flex, flexDirection column, gap 8, padding 24
h2: fontSize 16, lineHeight '24px', fontWeight 500, color TOKEN.label
body: fontSize 13, lineHeight '20px', color TOKEN.labelDim
actions: display flex, gap 8, flexWrap wrap, marginTop 4
```

#### 4.1.9 `CopyPath` / `useCopyText`（新增）

- `useCopyText()`：`{ copied, copy(text) }`；`copy` 调
  `navigator.clipboard.writeText`（先判空：`typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'`，
  不可用则静默 no-op，绝不抛错）；成功后 `copied=true`，1200ms 后复位（`setTimeout` 在 `useEffect` 清理）。
- 渲染：`IconButton small`，字符 `copied ? '✓' : '⧉'`，
  `title/aria-label = copied ? t('action.copied') : t('action.copyPath')`。
- **必须放在路径值之后**（渲染树文本顺序受测试 `client.test.mjs:1167` 约束，见 §5.3）。

### 4.2 工作区标识卡片 `IdentityCard`

卡片 padding 16，内部 `display:flex; flexDirection:column; gap:12`。

**行 1（标题行）**：`display:flex; alignItems:center; gap:8; minWidth:0`

| 元素 | 规格 |
| --- | --- |
| 图标 | 复用 `WorkspacePanelIcon`（`lib/client.js:2385-2416`），尺寸 18，颜色 `TOKEN.labelFaint`，`flex:'none'` |
| `h1` | 文件名 = `value.file ? lastSegment(value.file) : t('title.none')`（`lastSegment` 见 `lib/client.js:3306-3309`）；`fontSize 16, lineHeight '24px', fontWeight 500, color TOKEN.label`；`flex:1; minWidth:0`；`overflow:hidden; textOverflow:ellipsis; whiteSpace:nowrap`；`title = value.file` |
| busy 文本 | `snapshot.busy` 时在右侧：`status.working`，12/18，`TOKEN.labelFaint`，`flex:'none'` |
| 刷新按钮 | `IconButton` 字符 `⟳`，`title = action.refresh`，`disabled = busy` |
| 关闭按钮 | 仅 `!inView`（overlay）：`IconButton` 字符 `✕`，`title = action.close`，`onClick = closePanel` |

**行 2（文件路径）**：`display:flex; alignItems:center; gap:4; minWidth:0`（`value.file` 为空时整行不渲染）
- 路径文本：`fontFamily TOKEN.mono, fontSize 12, lineHeight '18px', color TOKEN.labelDim`，
  `flex:1; minWidth:0; ellipsis`，`title = value.file`，`userSelect:'text'`。
- `CopyPath(value.file)`。

**分隔线**：`height:0; borderTop:'0.5px solid ' + TOKEN.line`，`margin:'0 -16px'`（贯穿卡片内边距）。

**元信息栅格**（§4.3）。

**分隔线**（同上）。

**动作行**：`display:flex; flexWrap:wrap; alignItems:center; gap:8`

| 顺序 | 按钮 | variant | 出现条件 | 行为（沿用现有函数） |
| --- | --- | --- | --- | --- |
| 1 | `action.openOther`（切换文件） | `outline` | `value` 存在 | `patch({showBrowse:true}); browseTo(fileBrowseStart())`（`lib/client.js:1910`） |
| 2 | `action.create`（新建工作区文件） | `ghost` | 同上 | `patch({showRecent:false}); createFile()`（`:1914`） |
| 3 | `action.recent`（最近使用） | `ghost` + `ariaPressed = snapshot.showRecent` | 同上 | `patch({showRecent: !showRecent}); loadRecent(true)`（`:1911`） |
| 4 | `action.reveal`（在资源管理器中显示） | `ghost` | `value.file` 存在 | `reveal(value.file)`（`:1912`） |
| 5 | `action.useWorkspace`（打开该工作区） | `ghost` | `value.workspace` 存在 | `enterWorkspace(value)`（`:1913`） |
| 6 | `action.forget`（取消关联） | `ghost` + `danger`，`marginLeft:'auto'` | 总是（`value` 存在） | 先 `window.confirm(t('confirm.unlink'))`，确认后 `mutate('use ""', 'useFile', {file:''})`（`:1915`） |

按钮语义排序是为了「主/次/导航/危险」四层；`disabled = snapshot.busy`（危险动作也一样）。

### 4.3 元信息区

`display:grid; gridTemplateColumns:'96px minmax(0,1fr) auto'; columnGap:8; rowGap:8; alignItems:center`。

| 行 | 标签（12/18 `TOKEN.labelFaint`） | 值（mono 12/18 `TOKEN.label`） | 徽标 | 复制 | 条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | `label.rootDir`（工作区根目录） | `value.rootDir` | `[主目录]`（tone info，**总是**：这一行就是会话主根）+ `[已注册]`（tone success，`value.workspace` 时） | 有 | `value.rootDir` 存在 |
| 2 | `label.fileDir`（文件所在目录） | `value.fileDir` | — | 有 | `value.fileDir && value.fileDir !== value.rootDir` |

- 徽标与值间距 6px；值列 `minWidth:0; ellipsis; title=路径; userSelect:'text'`。
- 文件夹行里的「主目录」徽标是**列表内**的主根标记，与这里语义一致、位置不同（两处都保留：
  一处回答「会话根是哪个」，一处回答「列表里这可移动的主根是哪个」）。
- **不要**在标签与值之间插入任何文本节点（复制按钮必须在值之后），原因见 §5.3。

### 4.4 主操作 / 次要操作 / 危险操作

| 层级 | 组件 | 出现位置 | 视觉 |
| --- | --- | --- | --- |
| 主 | `添加文件夹` | 添加表单 | `primary` 实心（`button-primary-fill` + 白字） |
| 次（第一层） | `切换文件`、`上级`、每个编辑器按钮 | 标识卡片动作行 / 浏览工具栏 / 编辑器分区 | `outline` 描边 |
| 次（第二层） | `新建工作区文件`、`最近使用`、`在资源管理器中显示`、`打开该工作区`、`新建文件夹`、`从资源管理器选择` | 动作行 / 浏览工具栏 | `ghost` |
| 行内 | 终端、上移、下移、重命名、显示、移除 | 文件夹行 | `IconButton` 28 |
| 行内（弱） | 复制路径、关闭区段、关闭 Banner | 路径行 / 分区标题 / Banner | `IconButton` 24 |
| 危险 | `取消关联`（页面级）、`移除`（文件夹）、`取消关联`（记录） | 动作行 / 行尾部 / 管理器行 | `danger` + 确认 |

- **不得**在同一视区出现两个 `primary`：有文件时唯一主按钮是「添加文件夹」；未关联文件时没有添加表单，
  空状态里的「切换文件」才是主按钮（二者不会同时渲染）。
- 危险动作必须与普通动作分开：页面级靠 `marginLeft:auto`；行级靠分隔线 + 6px 组间距。

### 4.5 错误 / 提示条

位置：`PanelBody` 最前（标识卡片之前），顺序 error → notice，两者之间 8px，与后续内容 24px。

| 来源 | tone | 可关闭 | 渲染位置 |
| --- | --- | --- | --- |
| `state.error` | `error` | 是 | 页面最前 |
| `state.notice` | `state.noticeTone`（`success`/`info`） | 是 | error 之后 |
| `value.error`（工作区文件解析失败） | `warning` | 否 | 标识卡片之后 |
| 无 | — | — | 不渲染（不留空位） |

- 关闭 `error`：`patch({ error: null })`；关闭 `notice`：`patch({ notice: null, noticeTone: 'info' })`。
- 错误文案已本地化（§7.5），不再出现裸英文内部错误。

### 4.6 文件夹列表

**只读模式（单文件夹工作区，没有 `.code-workspace` 文件）**：`FolderList` 以
`snapshot.snapshot.file` 判断可管理性。没有文件时，唯一一行来自
`singleFolderRoot(rootDir)`（会话根，`path:'.'`、`isPrimary:true`），于是：不渲染拖拽把手、
行内没有任何编辑动作，`⋯` 菜单只保留「在 DSH 终端中打开」（有会话且终端服务可用时）与
「在资源管理器中显示」，上移 / 下移 / 重命名 / 移除全部不出现，添加文件夹表单也不渲染——
这些动作都写工作区文件，而没有文件可写。行的展开与文件点击与多根情况完全相同。

#### 4.6.1 分区

- `SectionHeader`：`label.roots`（工作区文件夹）+ `label.folderCount`（`{count} 个文件夹`，12/18 `TOKEN.labelFaint`）。
- 列表卡片（`Card padding:8`）→ 行；行数 > 8 时列表卡片内部滚动（`maxHeight:400`）。
- 列表为空：卡片内一行 `empty.roots`（13/20 `TOKEN.labelDim`，`padding:'12px 10px'`），
  添加表单仍然在下面（行动可达）。

#### 4.6.2 行 `FolderRow`（替换 `lib/client.js:913-968`）

```
display flex, alignItems center, gap 8, boxSizing border-box,
minHeight 48, padding '6px 10px', borderRadius 8,
background: root.isPrimary ? TOKEN.pressed : 'transparent',
hover: !isPrimary 时 TOKEN.hover,
flexWrap: 'wrap'   // overlay 窄宽度下动作组换行
```

| 列 | 宽度 | 内容 |
| --- | --- | --- |
| 拖拽把手 | 12（常驻，不参与文本） | 6 点 SVG（2 列 × 3 行，r=1，currentColor），颜色 `TOKEN.labelFaint`，`cursor:grab`，`title = action.dragFolder`，`opacity: 0`，行 hover / 行内聚焦时 `opacity: 1`；`draggable` 只在此元素上 |
| 文件夹图标 | 16 | `FolderGlyph`（16×16 描边，`strokeWidth:1.2`，`stroke:'currentColor'`，颜色 `TOKEN.labelFaint`） |
| 文本列 | `flex:1; minWidth:0`，纵向 gap 2 | 名称行 + 路径行 |
| 动作组 | `flex:'none'` | 见 4.6.3 |

名称行：`display:flex; alignItems:center; gap:6; minWidth:0`
- 名称 = `String(root.label || '')`，14/22、`fontWeight:500`、`TOKEN.label`、ellipsis；
- `root.isPrimary` → `Badge tone="info"`：`badge.primary`（主目录）；
- `root.exists === false` → `Badge tone="warning"`：`badge.missing`（不存在）。

路径行：`String(root.resolvedPath || '')`，mono 12/18、`TOKEN.labelFaint`、ellipsis，`title = resolvedPath`。

#### 4.6.3 行内动作组

```
display flex, alignItems center, gap 2, flex:'none'
```

顺序（从左到右）：

1. `>_` 终端（条件：`props.canOpenTerminal`）——语义、禁用、tooltip 全部沿用现状：
   `title` 为 `hint.terminalNoDir` / `action.openTerminalBusy` / `action.openTerminal`，
   `disabled = terminalBusy || terminalDisabled`，`onClick = onOpenTerminal`。
2. 分隔线（终端存在时）：`width:1, height:14, background:TOKEN.lineStrong, margin:'0 4px', flex:'none'`。
3. `↑`（`title=action.up`，`disabled=first`）、`↓`（`title=action.down`，`disabled=last`）、
   `✎`（`title=action.rename`）、`⧉`（`title=action.reveal`），间距 2。
4. 分隔线（同上）。
5. `✕`（`title=action.remove`，danger）——点击先 `window.confirm(t('confirm.removeFolder', {name}))`，
   确认后调用既有 `onRemove`。

- 所有图标按钮 `disabled` 时同样禁用并 `opacity .4`。
- 重命名态：文本列换成 `TextInput`（`value=props.renameValue`，placeholder 用 `field.folderName`），
  动作组换成 `[确定 primary] [取消 ghost]`（对应 `action.confirm` / `action.cancel`），不显示拖拽把手、
  终端和其余动作，行高保持 48。

#### 4.6.4 拖拽排序（使用既有 `moveFolder` 端点，不改宿主）

- 状态只存在于列表组件本地：`useState` 保存 `{ from, over, edge }`（`edge:'before'|'after'`）。
- `grip onDragStart`：`dataTransfer.effectAllowed='move'`，`dataTransfer.setData('text/plain', String(index))`；
  `disabled`/重命名/`busy` 时 `draggable=false`。
- 行 `onDragOver`：`preventDefault()`；用 `event.currentTarget.getBoundingClientRect()` 与
  `event.clientY` 比较，`clientY < rect.top + rect.height/2` → `before`，否则 `after`；
  拖到自身不显示落点。
- 落点指示：`boxShadow: 'inset 0 2px 0 ' + TOKEN.accent`（before）或
  `inset 0 -2px 0`（after），**不改变行高**。
- `onDrop`：计算目标索引（`before` 用目标索引，`after` 用目标索引 +1，向下拖动时减 1），
  与源索引相同则 no-op；否则 `mutate('move ' + from + ' ' + to, 'moveFolder', { address: String(from), toIndex: to })`。
- 键盘等价物就是 `↑` / `↓`（不做 ARIA drag pattern）。

#### 4.6.5 目录树列（`TreeNode`）

树与它所属的文件夹行共用一套列，每深一级加 16px；树行左侧画 `depth + 1` 个 16px 空单元格，
每个带 1px `TOKEN.borderSoft` 左边框当引导线：

| 列 | x（从列表左缘起算） |
| --- | --- |
| 文件夹行 caret = 第一级的引导线 | 10（行内缩进）+ 12（把手）+ 6（行间距）= **28** |
| 第一级 caret = 第二级的引导线 | 28 + 16 = **44** |
| 第一级图标 / 名称 | 62 / **84**（第二级再各 +16） |

- 文件夹行 `gap` 取 6 而不是 8，28 就是从这里来的；树行**不设** flex `gap`，caret 与图标各自带
  `marginRight:6`，否则 gap 会把每个引导格挤出自己的列。
- 文件夹展开体 `paddingLeft:22`（+ 行内 6 = 28）：树从文件夹的列往右走一级，而不是反过来挂到左边——
  旧实现按 `depth` 单独算缩进，子项起点反而在父行左侧。
- 树行留 16px 图标位：目录 `FolderGlyph`、文件走平台的 `FileTypeIcon`（`@deepseek-ai/dsh-client-ui-primitives`，
  按完整文件名 → 前缀/后缀 → 扩展名分类，出彩色技术图形）；primitives 缺席的组合退回本包的 `FileGlyph`，
  不会把图标列留空。「最近使用」的行用同一个 helper。
- 文件的字号与颜色：12.5/22 `TOKEN.labelDim`；目录同字号但 `fontWeight:500`、`TOKEN.label`。
- 加载 / 空 / 截断提示落在它所替代那一级的名称列：根级 `paddingLeft:62`，嵌套 `78 + depth*16`。

#### 4.6.6 引用到对话（`⤴`）

页面**不做**拖拽到对话：页面内拖拽只携带字符串，而 composer 的投递入口只认 `Files`，拖过去会被忽略；
真正拖文件/文件夹进对话是桌面版的系统级拖放（`__DSH_HOST_PATHS__` 路径桥 → `@path` 引用）。这一页给的是
语义等价的入口：

- 出现条件：该 surface 拿到了 composer 的 `inputActions` 且**有会话**（`snapshot.sessionId`）。新建会话页的
  浮层没有会话，因此不出现——不是渲染了不能用。
- 文件夹行：动作组里常驻 `⤴`（`IconButton`，`title = action.quote`）。
- 树行：行右侧 `⤴`，**hover 才出现**（`opacity:0→1`，`pointerEvents` 同步为 `none`，否则不可见的命中区
  会吃掉本该给行的点击）。它在行按钮内部，所以是 `span[role=button]` + `stopPropagation`，与 caret 同一做法。
- 点击：`captureInsertion()` 取当前选区 → `formatMention(path, 'file')`（目录先补尾斜杠，得到闭合引号）→
  按草稿在 caret 前是否已有空白决定前置空格 → `insertText(mention + ' ', span)`。
- 失败：选区取不到或修订已过期（正在发送）时给 `notice.quoteBusy`；路径含控制字符/引号时给
  `notice.quoteUnsupported`。

#### 4.6.7 动作行打开的分区（切换文件 / 最近使用 / 新建工作区文件）

- 分区渲染在**动作行正下方**（`IdentityCard` 的 `pickers`），不再渲染在整页末尾：这一页比视口高，
  渲染在末尾时打开的分区落在折叠线以下，用户看到的就是"按了没反应"。
- 无卡片的状态（未关联 / 加载 / 读取失败）没有动作行，分区回到页面级，位置在空状态卡片之后。
- 分区在卡片内用 `flat` 材质（不再套一层 `Card`），避免卡片套卡片。
- `新建工作区文件` 是内联表单（名称 + 创建 / 取消，`data-field="create-name"`，Enter 提交），
  **不再用 `window.prompt`**：Electron 的渲染进程没有 prompt 委托，旧实现点了只会抛错、什么都不发生。
  名称走既有 `create` 命令 / 端点，宿主会自己补 `.code-workspace` 后缀。

#### 4.6.8 折叠详情（`compact`）

- 从树上点开文件预览时 `patch({ compact: true })`：**路径行、动作行、pickers 一起收起**，卡片只留标题行
  与「工作区文件夹」树——读数的时候这些管理控件只是在占高度。
- 标题行最左是 chevron（`action.collapseDetails` / `action.expandDetails`），手动可逆；状态存在 store 里，
  重渲染、切页签都保持。折叠时不再渲染 `pickers`，所以「刚打开的分区」也跟着收起，不会留在屏上。
- 只在 `inView`（对话视图）生效：新建会话页的浮层整张卡就是挑文件的界面，动作行是它唯一入口，
  那里永远展开、也不画 chevron。

### 4.7 添加文件夹表单

位置：文件夹列表卡片之后，与卡片间距 12；不在卡片内，直接放在页面背景上。

结构（纵向 gap 12）：

```
[label 12/18 TOKEN.labelDim]  文件夹路径（相对或绝对）          ← t('field.folderPath')
[TextInput flex:1 data-field="add-path" placeholder=field.folderPath.hint] [Button primary 添加文件夹]
[label 12/18 TOKEN.labelDim]  显示名称（可选）                  ← t('field.folderName')
[TextInput data-field="add-name" placeholder=field.folderName.hint]
```

- 第一行 `display:flex; gap:8; alignItems:center`：输入框 `flex:1; minWidth:0`，按钮 `flex:'none'`。
- 标签是 12/18、`TOKEN.labelDim` 的 `div`（`display:block; marginBottom:4`），**不是** `<label>`
  （无 `htmlFor` 需求；给 input 加同文案的 `aria-label` 即可）。
- `添加文件夹`：`variant='primary'`，`disabled = busy || String(snapshot.addPath||'').trim() === ''`；
  `onClick = submitAdd`（`lib/client.js:2062-2068`，行为不变）。
- 两个输入 Enter 均 `submitAdd`（`TextInput` 的 `onEnter`）。
- 校验：空路径 = 按钮禁用（无内联错误文案）；路径合法性由宿主判定，失败走 error Banner；
  提交成功后字段清空（既有行为）。
- busy 时两个输入框 `disabled`。
- **不做「隐藏 / 展开」**：表单只有两行，而它是本页唯一的主操作入口；折叠它要多一次点击并新增
  `addOpen` state。列表很长时靠文件夹列表的 400px 滚动保证表单在视口内（§3.5），不需要折叠。

### 4.8 在编辑器中打开

- `SectionHeader`：`label.editors`（在编辑器中打开）。
- `editors === null` → 一行 `status.loading`（12/18 `TOKEN.labelFaint`）。
- `editors.length === 0` → 一行说明（13/20 `TOKEN.labelDim`）：
  `editorsSsh ? hint.editorSsh : hint.noEditor`。
- 否则按钮行：`display:flex; gap:8; flexWrap:wrap`，每个编辑器一个 `outline` 按钮，
  文本 = `editor.label`（如「VS Code」「Trae CN」），`disabled = busy`，
  `title` 公式保持不变：`t('action.editor') + ' — ' + editor.label + '\n' + executable + '\n' + target`
  （测试断言 title 同时含可执行文件与目标，`client.test.mjs:1353-1354`）。
- 单击 → `openInEditor(editor.id)`（`:772-797`）；成功 notice tone = `success`。

### 4.9 同一主目录的其它工作区文件（条件：`value.conflict.length > 0`）

- `SectionHeader`：`label.conflict` + 数量。
- 卡片（padding 16，gap 8）：
  - 说明：`hint.conflict`（13/20 `TOKEN.labelDim`）；
  - 行列表（gap 2）：每行高 32、`padding '5px 10px'`、圆角 8、hover `TOKEN.hover`、`cursor:pointer`；
    内容 = 文件路径（mono 12/18，`TOKEN.link`，ellipsis，`title = 路径`），
    **`key` 必须等于文件路径字符串**（测试 `client.test.mjs:1172` 用 `nodeByKey` 取行）；
    点击 → `openFile(other)`。

### 4.10 最近使用（条件：`snapshot.showRecent`）

- `SectionHeader`：`action.recent` + 右侧 `IconButton` `✕`（`title=action.close`，
  `onClick: patch({showRecent:false})`）。
- 卡片（padding 8；列表 `maxHeight:320; overflowY:auto; scrollbarGutter:stable; marginRight:2`）：
  数据 = `(snapshot.recent||[]).filter(item => item.exists !== false)`（沿用现有过滤）。
  - 每行：`minHeight 40, padding '9px 10px', borderRadius 8, hover TOKEN.hover, cursor:pointer`；
    标题 = `String(item.title || item.file)`（14/22 `TOKEN.label`，ellipsis），
    目录 = `item.fileDir`（12/18 `TOKEN.labelFaint`，ellipsis，`marginLeft:8`）；
    `key=item.file`，`title=item.file`，点击 → `openFile(item.file)`。
  - 空：`empty.recent`（12/18 `TOKEN.labelFaint`，`padding:'3px 10px'`）。
- 打开时标识卡片里的「最近使用」按钮为按下态（`TOKEN.pressed` 底 + `TOKEN.label` 字）。

### 4.11 浏览目录（条件：`snapshot.showBrowse`）

- `SectionHeader`：`label.browse` + 右侧 `IconButton` `✕`（`title=action.close` →
  `patch({showBrowse:false})`）。
- 卡片（padding 0；内部三段）：
  1. 工具栏 `padding '8px 8px 4px'; display:flex; gap:8; alignItems:center; flexWrap:wrap`：
     `上级`（outline，`disabled=!browse.parent`，`onClick: browseTo(browse.parent)`）、
     `新建文件夹`（ghost，`makeDir`）、`从资源管理器选择`（ghost，`pickNativeFile`，`disabled=busy`）、
     当前路径（mono 12/18 `TOKEN.labelFaint`，`flex:1; ellipsis`，`title=browse.path`）。
     测试按文本找「上级」「从资源管理器选择」（`client.test.mjs:975`、`:1052`），**按钮文字不得改**。
  2. 列表：`marginTop:0; padding:'0 4px 8px'; maxHeight:260; overflowY:auto; scrollbarGutter:stable; marginRight:2`。
     `browse === null` → `status.loading`（12/18 `TOKEN.labelFaint`，`padding:'3px 10px'`）。
     每行：`minHeight 32, padding '5px 10px', borderRadius 8, display:flex, gap:6, alignItems:center,
     cursor:pointer, fontSize 14, lineHeight '22px'`，hover `TOKEN.hover`；
     - 前缀字形：目录 `▸`、工作区文件 `◆`（16px 宽，`TOKEN.labelFaint`）；
     - 名称（`flex:1; ellipsis`；工作区文件 `fontWeight:500`）；
     - 工作区文件 → `Badge tone="outline"`：`badge.workspaceFile`（工作区文件）；
     - `key = entry.path`（测试 `client.test.mjs:1214`）；目录 → `browseTo(entry.path)`，
       工作区文件 → `openFile(entry.path)`。
  3. 空列表：`hint.noFile`（12/18 `TOKEN.labelFaint`，`padding:'3px 10px'`）。
- overlay 430px 下工具栏换行，路径 `flex-basis:'100%'`（`flexWrap` 自然换行即可）。

### 4.12 代码工作区管理器（panel 页的全部内容）

- 位置：`ManagerBody`（左栏 `main` 页），**不是** `PanelBody` 的一个变体；`PanelBody` 只服务
  view / overlay。panel 不再画标识卡片、文件夹区、冲突区、编辑器按钮与最近使用区。
- 根节点：`h('div',{role:'main','aria-busy':busy,...})`，`gap: 16`；子节点 = 两个 Banner（§4.11）
  + 管理器分区（+ 浏览目录分区，条件）。
- `SectionHeader`：`label.workspaces`（代码工作区）+ `label.workspaceCount`（`{count} 个文件`）+
  **右端工具组**（`ManagerTools`，一个 `div` 内三个控件，gap 6，`flex:none`）：
  - `切换文件`：`Button variant="primary"`，`disabled = busy`，点击 `patch({showRecent:false})` 后
    `browseTo(fileBrowseStart())`；
  - `从资源管理器选择…`：`Button`（ghost），点击 `pickNativeFile`；
  - `⟳`：`IconButton`，`title = action.refresh`，点击 `loadRecent(true)` + `refresh()`。
  - **没有** `新建工作区文件`（新建需要一个目录，这一页没有会话可提供）、没有取消关联、
    没有编辑器按钮：它们都属于会话面，留在 view / overlay。
- 数据：`snapshot.recent`（已记录文件）+ `readOpenWorkspaces()`（已注册工作区）。
- 挂载时 `loadRecent(true)`（强制重读）+ `refresh()`：列表是这一页的全部内容，不能显示别处改动之前的旧缓存。
- 卡片（padding 8，行 gap 2）：
  - **已记录文件行**（`WorkspaceRow` 重写，替换 `lib/client.js:1592-1637`）：
    `minHeight 48, padding '6px 10px', borderRadius 8, display:flex, alignItems:center, gap:8,
    cursor:pointer, title = item.file`（测试按 title 取行，`client.test.mjs:906`），
    选中态（当前 `snapshot.snapshot.file` 同路径）背景 `TOKEN.pressed`，hover `TOKEN.hover`。
    列：
      - 标记字形：`◆`（active）/`◇`，16px 宽，active 用 `TOKEN.accent`，否则 `TOKEN.labelFaint`；
      - 文本列（flex:1，gap 2）：标题 14/22 `TOKEN.label`（active 时 500，非 active 400），
        `Badge tone="success"` `badge.open`（已注册，`readOpenWorkspaces()[pathKey(item.file)]` 存在时）、
        `Badge tone="warning"` `badge.missing`（`item.exists === false`）；目录 12/18 `TOKEN.labelFaint`，ellipsis；
      - 动作：`IconButton` 24px `✕`，`danger`，`title = action.forget`（取消关联），
        `onClick(event)` 先 `event.stopPropagation()` 再 `forgetFileAt(item.file)`（内部 `window.confirm(t('confirm.forget') + '\n' + file)`）。
    点击行 → `openFile(item.file)`。
  - **仅有已注册工作区、没有文件的行**：同样 48px，`◇` + 路径（mono 12/18 `TOKEN.labelDim`，ellipsis）+ `Badge success badge.open`；
    `title=path`，点击 → `openWorkspaceDirectory(path)`（`:426-437`）。
  - 空（`allRows.length === 0`）：`empty.workspaces`（13/20 `TOKEN.labelDim`，`padding:'12px 10px'`）。
    注意判定是**行数为零**而不是「已记录文件为零」：一个只有已注册工作区的列表不该先说「还没记录过任何文件」。

### 4.13 空状态 / 加载 / busy 矩阵

| 状态 | 判定 | 渲染 | 必须含有的文本 |
| --- | --- | --- | --- |
| 未关联文件 | `!snapshot.rootDir`（仅 view / overlay） | 空状态卡片（padding 24）：`title.none`（16/24 500）+ `hint.noWorkspace`（13/20）+ 动作行 `[切换文件 primary] [新建工作区文件 ghost] [从资源管理器选择 ghost]`。**panel 不画这张卡片**：它的空就是空列表 | `未关联 .code-workspace 文件`、`这个会话还没有关联 .code-workspace 文件` |
| 加载中 | `rootDir && snapshot === null && busy`（仅 view / overlay） | 加载卡片：2 条骨架条（宽 40% 与 72%，高 12 与 10，圆角 4，背景 `TOKEN.skeleton`，gap 8）+ `status.loading`（12/18 `TOKEN.labelFaint`） | `加载中…` |
| 无数据 | `rootDir && snapshot === null && !busy`（仅 view / overlay） | 无数据卡片（padding 16）：一行 `hint.noFile`（13/20 `TOKEN.labelDim`）；这是宿主对当前目录**返回空**的诚实状态（也覆盖「有目录但没有被读取到」） | `该目录下没有 .code-workspace 文件。`（**测试 `client.test.mjs:578` 依赖此分支**） |
| 读取失败 | `snapshot.error` | error Banner（可关闭），两种主体共用 | 宿主消息已本地化/保留 |
| 文件无法解析 | `value.error` | warning Banner（不可关闭），位于标识卡片之后（仅 view / overlay） | `warning.parse` + `value.error.message` |
| 无文件夹 | `roots.length === 0` | 卡片内 `empty.roots` + 添加表单仍在（仅 view / overlay，且仅有工作区文件时） | `该工作区文件里还没有 folders。` |
| 单文件夹工作区（无文件） | `value.file === null` 且 `rootDir` 存在 | 标识卡片不变（H1 = `title.none`），卡片内照常出现「工作区文件夹 · 1」分区：会话根作为唯一一行，只读（见 §4.6），可展开成目录树 | `未关联 .code-workspace 文件`、目录树 |
| 无编辑器 | `editors.length === 0` | 编辑器分区一行说明（仅 view / overlay） | `hint.noEditor` 或 `hint.editorSsh` |
| 无最近记录 | `showRecent && recent(过滤后) === []` | `empty.recent`（仅 view / overlay） | `暂无记录` |
| 浏览目录为空 | `showBrowse && entries === []` | `hint.noFile`（panel 的浏览分区同样如此） | `该目录下没有 .code-workspace 文件。` |
| 管理器列表为空 | panel 且 `allRows.length === 0`（无已记录文件、也无已注册工作区） | `empty.workspaces` | `还没有记录过任何 .code-workspace 文件` |
| 无终端服务 | `!shellAvailable()` | **不渲染任何终端相关文本/按钮** | —（测试 `client.test.mjs:1669` 断言终端按钮不出现） |
| busy | `snapshot.busy` | 根节点 `aria-busy="true"`；标题行右侧 `status.working`；所有会写宿主的按钮 `disabled`；输入框 `disabled`；`⟳` 禁用 | `处理中…` |

### 4.14 无文件时的浏览 / 最近使用 / 新建

未关联文件时「空状态卡片」的三个动作就是唯一入口；`showBrowse` / `showRecent` 仍按 4.10 / 4.11 渲染在其后。
overlay（430px）同样适用（测试 `client.test.mjs:578`、`:758`、`:1247-1251` 覆盖）。

---

## 5. 文案清单

命名沿用现有键风格（`action.*` / `label.*` / `hint.*` / `error.*` / `confirm.*` / `badge.*` / `status.*` / `field.*`）。
**zh 与 en 必须同键集**（测试 `client.test.mjs:501-511` 断言 `Object.keys(zh).sort()` 与 `en` 全等）。

### 5.1 新增键（zh / en）

| key | zh | en | 用途 |
| --- | --- | --- | --- |
| `field.folderPath.hint` | `例如 D:/projects/my-app` | `e.g. D:/projects/my-app` | 路径输入框 placeholder |
| `field.folderName.hint` | `留空则显示目录名` | `Leave empty to show the directory name` | 名称输入框 placeholder |
| `label.folderCount` | `{count} 个文件夹` | `{count} folders` | 分区标题计数（`t(..., {count})`） |
| `label.workspaceCount` | `{count} 个文件` | `{count} files` | 管理器分区计数 |
| `status.working` | `处理中…` | `Working…` | busy 指示 |
| `action.copyPath` | `复制路径` | `Copy path` | 复制按钮 title/aria-label |
| `action.copied` | `已复制` | `Copied` | 复制成功 1.2s 的 title/aria-label |
| `action.dragFolder` | `拖动排序` | `Drag to reorder` | 拖拽把手 title |
| `confirm.removeFolder` | `从工作区文件里移除「{name}」？其它文件夹不受影响，之后可以重新添加。` | `Remove “{name}” from the workspace file? Other folders are unaffected, and you can add it back later.` | 行内移除确认 |
| `confirm.unlink` | `取消关联后，本会话不再使用这个工作区文件（文件本身不会被删除）。` | `The session will stop using this workspace file. The file itself is not deleted.` | 页面级取消关联确认 |
| `badge.workspaceFile` | `工作区文件` | `workspace file` | 浏览列表徽标 |
| `error.terminalNoTab` | `终端打开失败：终端标签没有出现，可能被侧栏设置隐藏了。请再试一次；仍然失败就刷新页面。` | `Could not open the terminal: the terminal tab did not appear. It may be hidden by your sidebar settings. Try again, and refresh the page if it keeps failing.` | 替换裸英文（截图问题） |
| `error.terminalNotWritable` | `终端打开失败：终端已创建，但一直没有进入可输入状态。请关闭该标签后再试。` | `Could not open the terminal: it was created but never became writable. Close that tab and try again.` | 已知失败 |
| `error.terminalOtherSession` | `终端打开失败：终端开到了另一个会话，已关闭。请回到那个会话的「代码工作区」页签再试。` | `Could not open the terminal: it opened in another session and was closed. Open the Code Workspace tab for the right session and try again.` | 已知失败 |

> `error.*` 三条都必须以「终端打开失败」开头：既有测试断言 `/终端打开失败/`（`client.test.mjs:1795`、`:1810`）。

### 5.2 复用 / 语义变化（文案本身不改）

| key | zh | 新用途 |
| --- | --- | --- |
| `field.folderPath` | `文件夹路径（相对或绝对）` | 从 **placeholder** 改成 **可见标签**（§4.7） |
| `field.folderName` | `显示名称（可选）` | 从 placeholder 改成可见标签；重命名输入框仍作 placeholder |
| `action.recent` | `最近使用` | 动作按钮 + 最近分区 `h2` |
| `action.remove` | `移除` | 文件夹行 `✕` 的 `title`（测试按 title 精确匹配，见 §5.3） |
| `action.forget` | `取消关联` | 管理器行 `✕` 的 `title`（同上） |
| `action.close` | `关闭` | Banner / 分区关闭按钮的 `title` |
| `action.editor` | `在编辑器中打开` | 编辑器按钮 tooltip 前缀（公式不变） |
| `badge.open` | `已注册` | 管理器行 + 根目录元信息 |
| `badge.primary` | `主目录` | 文件夹行 |
| `badge.missing` | `不存在` | 文件夹行 + 管理器行 |
| `label.roots` / `label.workspaces` / `label.browse` / `label.editors` / `label.rootDir` / `label.fileDir` / `label.conflict` | 原样 | 分区标题 / 字段标签 |
| `hint.*` / `empty.*` / `notice.*` / `status.loading` | 原样 | 原语义 |

**从渲染中移除、但保留键**（字典平衡测试只要求 zh/en 键集相等，不要求使用）：
`hint.view`、`label.file`、`title`（页签名仍由 `label` / `title.tab` 承担）。

### 5.3 测试断言的文案（**不得改动**）

下表是 `test/client.test.mjs` 直接断言或用来定位控件的文案/结构。实现时必须保留：

| 断言位置 | 断言内容 | 实现要求 |
| --- | --- | --- |
| `:549-550` | `主目录`、`工作区文件夹` 出现在页面文本 | 文件夹行 Badge + `label.roots` 分区标题 |
| `:578` | `该目录下没有 .code-workspace 文件。` 出现在 **view** 树里 | 两个分支都要出这句：① `rootDir && snapshot===null && !busy` 的「无数据卡片」；② 浏览区空列表 `hint.noFile`。只保留 ② 会挂测试 |
| `:679`、`:1076`、`:1128` | `buttonByTitle(tree, '移除')` | 文件夹行移除按钮 `title` 必须**恰好** `t('action.remove')` |
| `:727` | `node.props.title === '取消关联'` 且点击后 `confirmations.length === 1` | 管理器行 unlink 按钮 `title` 必须**恰好** `t('action.forget')`；**页面级「取消关联」按钮不得设置同名 `title`**（否则首个匹配变成页面级按钮，点错） |
| `:778`、`:970`、`:1010`、`:1044`、`:1211`、`:1251` | `buttonByLabel(..., '切换文件')` | 空状态与标识卡片都提供文本含「切换文件」的 `<button>` |
| `:975`、`:1017`、`:1046` | `buttonByLabel(..., '从资源管理器选择')` | 浏览工具栏按钮文字不变 |
| `:1052` | `buttonByLabel(..., '上级')` | 浏览工具栏按钮文字不变 |
| `:1092`、`:1103` | `input.props.placeholder.includes('文件夹路径')` | **本文唯一要求修改的两行测试**，见 §5.4 |
| `:1096` | `buttonByLabel(..., '添加文件夹')` | 主按钮文字不变 |
| `:1167` | `/文件所在目录 D:\/lib/` | 标签与路径之间**不能插入文本节点**（复制按钮放值之后） |
| `:1169` | `同一主目录的其它工作区文件` | `label.conflict` 作分区标题 |
| `:1172` | `nodeByKey(tree, 'D:/lib/two.code-workspace')` 可点击 | 冲突行 `key` 必须等于文件路径 |
| `:1214` | `nodeByKey(tree, 'D:/ws/app.code-workspace')` 可点击 | 浏览行 `key = entry.path` |
| `:803`、`:847` | panel 页面含 `代码工作区` | 管理器分区标题 = `label.workspaces`；panel 页整页都是管理器（`ManagerBody`），不再画标识卡片 |
| `:852`、`:853` | `已注册`、`不存在` | 徽标文案 |
| `:735` | `还没有记录过任何` | `empty.workspaces` |
| `:755` | `还没有关联 .code-workspace 文件` | `hint.noWorkspace` |
| `:1349` | `在编辑器中打开` | 编辑器分区标题 |
| `:1350`、`:1379` | `buttonByLabel(..., 'VS Code')` / `'Trae CN'` | 编辑器按钮文本 = `editor.label` |
| `:1353-1354` | 按钮 `title` 含 `Code.exe` 与 `app.code-workspace` | 保留 title 公式 |
| `:1363` | `已用 VS Code 打开` | `notice.opened` notice |
| `:1390`、`:1397` | `未检测到 VS Code 系列编辑器`、`通过 SSH 访问` | `hint.noEditor` / `hint.editorSsh` |
| `:1660`、`:1668`、`:1823`、`:1843` | 终端按钮文本**恰好** `>_`；`disabled` 时 `onClick === undefined` | 见 §4.1.2 / §4.6.3 / §4.13 |
| `:906` | 管理器行 `title === 'D:/other/team.code-workspace'` 且点击打开 | 管理器行 `title = item.file` |
| `:1823` | 禁用终端按钮 `title` 含 `目录不存在` | 沿用 `hint.terminalNoDir` |

### 5.4 本文要求修改的两行测试

`field.folderPath` 从 placeholder 变为标签后，两处按 placeholder 定位输入框的断言必须改成按
`data-field` 定位（`TextInput` 需透传 `dataField`）：

```js
// test/client.test.mjs:1092
- const pathInput = inputsIn(tree).find((input) => input.props.placeholder.includes('文件夹路径'))
+ const pathInput = inputsIn(tree).find((input) => input.props['data-field'] === 'add-path')

// test/client.test.mjs:1103
- const cleared = inputsIn(tree).find((input) => input.props.placeholder.includes('文件夹路径'))
+ const cleared = inputsIn(tree).find((input) => input.props['data-field'] === 'add-path')
```

除这两行外，**不改动任何既有测试**。若实现过程中发现必须改动其它断言，视为设计偏差，
需要回到本文修订，而不是顺手改测试。

---

## 6. 样式令牌表

### 6.1 `TOKEN` 表（替换 `lib/client.js:299-315`）

保留旧键名（`HeaderButton` `:2332-2361` 与 `DockChip` `:2498-2537` 仍在用
`fill`/`label`/`labelDim`/`hover`/`borderSoft`），新增语义键。所有 `var()` 都带惰性 fallback；
fallback 的浅色值取 rc.5 `design-platform.css` 的浅色定义。

| TOKEN 键 | 值（rc.5 变量 + fallback） | rc.5 依据 | 用途 |
| --- | --- | --- | --- |
| `bgBase` | `var(--dsw-alias-bg-base, transparent)` | `design-platform.css:177` | 页面底色（透明，露出会话底） |
| `surface` / `overlay` | `var(--dsw-alias-bg-overlay, #ffffff)` | `:191` | 浮层表面（`panelStyle`） |
| `card` | `var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-2, #ffffff))` | `:220`（rc.5 新增；rc.2 没有 → 落到 layer-2） | 卡片背景 |
| `field` / `layer` | `var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))` | `:181` | 输入框 / 次级表面 |
| `subtle` | `var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))` | `:182` | 备用 |
| `hover` | `var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,0.06))` | `:242`（深色 `:394`） | 行 / 按钮 hover |
| `pressed` | `var(--dsw-alias-interactive-bg-active, rgba(38,49,72,0.10))` | `:238` | 选中行 / 按下按钮 / 主目录行 |
| `hoverDanger` | `var(--dsw-alias-interactive-bg-hover-danger, rgba(236,19,19,0.05))` | `:240` | 危险按钮 hover |
| `line` | `var(--dsw-alias-border-l3, rgba(0,0,0,0.12))` | `:198` | 0.5px 分隔线 |
| `lineStrong` | `var(--dsw-alias-border-l4, rgba(0,0,0,0.16))` | `:199` | 卡片 / 输入框边框 |
| `lineFaint` | `var(--dsw-alias-border-l1, rgba(0,0,0,0.04))` | `:196` | 极淡描边 |
| `borderSoft` | `var(--dsw-alias-border-l2, rgba(0,0,0,0.10))` | `:197` | 兼容旧键（入口 chip 边框） |
| `border` | `var(--dsw-alias-border-l2, rgba(0,0,0,0.10))` | `:197` | 兼容旧键（浮层边框） |
| `label` | `var(--dsw-alias-label-primary, #1a1a1a)` | `:259` | 主文字 |
| `labelDim` | `var(--dsw-alias-label-secondary, #4a4a4a)` | `:260` | 次级文字 |
| `labelFaint` | `var(--dsw-alias-label-tertiary, #6b6b6b)` | `:262` | 元信息 / 图标 |
| `labelCaption` | `var(--dsw-alias-label-caption, #8a8a8a)` | `:250` | 最弱文字（备用） |
| `labelDimmed` | `var(--dsw-alias-label-dimmed, #b8b8b8)` | `:253` | placeholder |
| `onPrimary` | `var(--dsw-alias-label-primary-foreground, #ffffff)` | `:257` | 主按钮文字 |
| `primary` | `var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1a1a1a))` | `:215` | 主按钮底 |
| `primaryHover` | `var(--dsw-alias-button-primary-hover, #3a3a3a)` | `:216` | 主按钮 hover |
| `accent` | `var(--dsw-alias-state-business-primary, #4d6bfe)` | `:277` | 焦点环 / 主目录徽标 / 活动标记 |
| `link` | `var(--dsw-alias-link, #4d6bfe)` | `:264` | 冲突文件链接 |
| `success` | `var(--dsw-alias-state-success-primary, #1f9d55)` | `:291` | 成功点 / 已注册徽标 |
| `warn` | `var(--dsw-alias-state-warn-primary, #b7791f)` | `:295` | 不存在徽标 / 解析警告 |
| `danger` | `var(--dsw-alias-state-error-primary, #d93f3f)` | `:288` | 错误 / 危险动作 |
| `skeleton` | `var(--dsw-alias-bg-skeleton, rgba(0,0,0,0.04))` | `:192` | 加载骨架 |
| `tintError` | `color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)` | Tag 的 10% 用法（`dsh-client-ui-primitives/lib/Tag.module.css`） | 错误 Banner 底 |
| `tintWarn` | `color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)` | 同上 | 警告 Banner 底 |
| `tintInfo` | `color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent)` | 同上 | 信息 Banner 底 |
| `tintSuccess` | `color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)` | 同上 | 成功 Banner 底 |
| `radiusXs` | `var(--dsw-radius-xs, 4px)` | `RC5/.../base.css:18-23` | 骨架条 |
| `radiusSm` | `var(--dsw-radius-sm, 8px)` | 同上 | 行 / 按钮 |
| `radiusMd` | `var(--dsw-radius-md, 12px)` | 同上 | 卡片 / 输入框 |
| `radiusLg` | `var(--dsw-radius-lg, 16px)` | 同上 | 浮层 |
| `mono` | `var(--dsw-font-markdown-code-font-family, var(--ds-font-family-code, "SF Mono", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace))` | `RC5/.../gradient-shadow-text.css`（`--dsw-font-markdown-code-font-family: var(--ds-font-family-code)`）+ `base.css:11-13` | 路径 / 终端字形 |
| `focus`（拼在 `outline` 里） | `var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe))` | `RC5/.../focus.css:3-12` | 焦点环 |
| `shadow` | `var(--dsw-elevation-prominent, 0 0 0 0.5px rgba(0,0,0,0.16), 0 3px 8px rgba(0,0,0,0.04))` | `RC5/.../gradient-shadow-text.css:5-46` | 浮层投影 |
| `radius` | `var(--dsw-radius-lg, 16px)` | 同上 | 兼容旧键（浮层圆角） |

> ⚠ 旧 `TOKEN.radius` 用的是 `--dsw-alias-border-radius-base`，**rc.2 与 rc.5 的 theme 都没有这个变量**
> （在 rc.5 全部 CSS/TS 中检索为 0 命中），所以它一直在用 8px fallback。本文改成真实存在的
> `--dsw-radius-*`。旧 `TOKEN.borderSoft` 的 fallback 由 `0.20` 收敛到 `0.10`，与 rc.5 `border-l2` 一致。

### 6.2 字号 / 行高 / 控件（写死，不走 `--dsh-content-font-size`）

| 角色 | 字号/行高/字重 | rc.5 依据 |
| --- | --- | --- |
| 页标题 H1 | 16 / 24 / 500 | `--dsw-font-base-strong-16`（`gradient-shadow-text.css` 字体刻度） |
| 分区标题 h2 | 13 / 20 / 500 | `--dsw-font-xs-strong-13` |
| 行标题 | 14 / 22 / 400（活动/主目录 500） | `--dsw-font-s-14` / `s-strong-14` |
| 正文 / 空状态正文 | 13 / 20 / 400 | `--dsw-font-xs-13` |
| 元信息 / 路径 / Banner | 12 / 18 / 400 | `--dsw-font-xxs-12` |
| 徽标 | 11 / 17 / 500 | primitives Tag（`font-size: 11px; line-height: 17px; font-weight: 500`） |
| 按钮（sm） | 12 / 18 / 400 | primitives Button `.sm` |
| 输入框 | 14 / 22 / 400 | primitives Input `.input` |
| 终端字形 `>_` | 12 / 18 / 400 mono | 与按钮一致 |

### 6.3 交互态

| 态 | 规则 |
| --- | --- |
| hover | 行 / ghost / outline / 图标按钮：背景 `TOKEN.hover`；主按钮：`TOKEN.primaryHover`；危险按钮：`TOKEN.hoverDanger` + `TOKEN.danger` 色；行内 `IconButton` hover 同时图标色转 `TOKEN.label` |
| 按下 | ghost：`TOKEN.pressed`；主按钮：不加额外态（`:active` 在浏览器里由底色变化覆盖） |
| 选中（常驻） | 主目录行 / 管理器当前文件行：`TOKEN.pressed`；最近使用 toggle 按钮：`TOKEN.pressed` + `aria-pressed="true"` |
| 焦点 | `outline: TOKEN.focus; outlineOffset: -2px`（按钮 / 行），输入框用 `borderColor: TOKEN.accent` 代替 outline；仅在 `event.currentTarget.matches(':focus-visible')` 时显示（鼠标点击不显示焦点环）；行内控件沿用原生 Tab 顺序 |
| 禁用 | 原生 `disabled` + `opacity: 0.4` + `cursor: not-allowed`；`onClick` 置 `undefined` |
| 滚动 | 容器 `overflow-y:auto; scrollbar-gutter:stable; overscroll-behavior:contain`；列表容器 `margin-right:2px`（rc.5 通用约定，`FilesBody.module.css:178-190`） |

### 6.4 主题 / 深色

- 不写 `data-ds-dark-theme` 分支；所有颜色走 alias 令牌，主题切换自动折叠。
- 卡片在深色下由 `card-fill`（rc.5 深色 `:372` = neutral-850）与 `value` 底色区分；
  在只有 rc.2 令牌的环境里，`card` 落到 `bg-layer-2`（深色下为 neutral-850），仍可区分。
- `color-mix` 在 rc.5 与 rc.2 的 Electron/Chromium 中均可用（宿主自己的 Tag/Tooltip 就在用）。
- 浮层背景用 `bg-overlay`，投影用 `--dsw-elevation-prominent`（深色下描边自动换 l3）。

### 6.5 禁止

- 禁止硬编码品牌色（`#4d6bfe` 只能出现在 fallback 里）。
- 禁止 `rgba(0,0,0,…)` 直接写在组件里（fallback 表除外）。
- 禁止按明暗分支。
- 禁止给元素加 `boxShadow` 只为了「看起来有层次」——层次靠卡片 + 分隔线 + 留白。

---

## 7. 实现映射

全部改动在 `lib/client.js`。`lib/index.js`、远程 API、`package.json`、`cordis.patch.yml` **零改动**。

### 7.1 原子与 helper（新增 / 重写）

| 函数 | 位置 | 动作 |
| --- | --- | --- |
| `TOKEN` | `:299-315` | 按 §6.1 替换 |
| `useInteractive`（新） | 原 `labelStyle` 位置（`:816-818`，该函数删除后占用） | 返回 `{ hover, pressed, focus, handlers }`；`focus` 仅在 `:focus-visible` 时置真 |
| `focusRing`（常量） | 同上 | `{ outline: TOKEN.focus, outlineOffset: -2 }` |
| `Button` | `:820-850` | 重写（§4.1.1）；保留 `danger`、`title`、`disabled → onClick:undefined` 语义 |
| `IconButton`（新） | `Button` 之后 | 28/24 图标按钮（§4.1.2） |
| `Badge` | `:852-868` | 重写（§4.1.4） |
| `TextInput` | `:870-895` | 重写（§4.1.3），加 `dataField` 透传 |
| `SectionHeader`（新） | `Row` 位置附近 | §4.1.5 |
| `Card`（新） | 同上 | §4.1.6 |
| `Banner`（新） | 同上 | §4.1.7 |
| `EmptyState`（新） | 同上 | §4.1.8 |
| `useCopyText` + `CopyPath`（新） | 同上 | §4.1.9 |
| `FolderGlyph`（新） | `FolderRow` 之前 | 16px 文件夹描边图标（路径可抄 `WorkspacePanelIcon` 的 folder path，`lib/client.js:2398-2403`） |
| `Row` | `:897-911` | **删除**：只被 `FolderRow` 使用，行样式改由 `FolderRow` 自己持有 |
| `labelStyle` | `:816-818` | **删除**：全部 25 处调用点都在本次重写范围内（`FolderRow`/`BrowseView`/`WorkspaceRow`/`WorkspaceList`/`EditorSection`/`PanelBody`），新组件按 §6.2 显式写 `fontSize/lineHeight/color` |

### 7.2 页面层

| 函数 | 位置 | 动作 |
| --- | --- | --- |
| `WorkspaceView` | `:2278-2318` | 只改外层与内容列样式：`maxWidth` fallback 760→920；`padding:'24px 24px 40px'`；外层加 `scrollbarGutter:'stable'` |
| `WorkspacePanel` | `:2453-2491` | 同上（padding 已是 `24 24 32`，改为 `24 24 40`） |
| `PanelBody` | `:1817-2060` | **整体重写**：按 §3.6 顺序组装分区；根节点 `:2059` 改成 `h('div', { role:'main', 'aria-busy': busy ? 'true' : undefined, style:{display:'flex', flexDirection:'column', gap: inView||inPanel ? 24 : 16} }, children)` |
| `panelStyle` | `:2099-2117` | 换成 `§3.4` 的值：`width:430, maxWidth:'calc(100vw - 32px)', maxHeight:'calc(100vh - 96px)', overflow:'auto', padding:12, background:TOKEN.overlay, border:'0.5px solid '+TOKEN.lineStrong, borderRadius:TOKEN.radiusLg, boxShadow:TOKEN.shadow, pointerEvents:'auto', zIndex:400` |
| `OverlayPanel` | `:2131-2135` | 不用改结构（PanelBody 自带列布局） |
| `submitAdd` | `:2062-2068` | 不改 |
| `createFile` / `openFile` / `browseTo` / `reveal` / `loadRecent` / `mutate` / `refresh` | `:654-812`、`:530-601` | 不改 |
| `HeaderButton` / `DockChip` | `:2332-2361` / `:2498-2537` | **不改**（入口 chip 已是原生几何，见 §9） |

### 7.3 分区 → 函数映射

| 分区 | 函数 | 现状 | 动作 |
| --- | --- | --- | --- |
| 标识卡片 | `IdentityCard`（新） | 无（逻辑散在 `PanelBody:1887-1918`） | 新函数；把 `:1887-1918` 的读取与动作搬进来 |
| 元信息栅格 | `IdentityCard` 内 | `:1899-1908` | 重写 |
| 错误/提示 | `Banner` + `PanelBody` | `:1855-1864` | 换组件 + dismiss |
| 文件夹列表 | `FolderList`（新） + `FolderRow`（重写） | `:1950-1996` / `:913-968` | 新列表组件持有拖拽本地状态；行按 §4.6 重写 |
| 添加表单 | `AddFolderForm`（新） | `:1998-2018` | 新函数 |
| 编辑器 | `EditorSection` | `:1774-1806` | 原地重写样式（分区标题用 `SectionHeader`） |
| 冲突 | `ConflictSection`（新） | `:1925-1948` | 新函数 |
| 最近使用 | `RecentSection`（新） + `RecentRow`（新） | `:2038-2057` | 新函数 |
| 浏览目录 | `BrowseSection`（新） + `BrowseView`（重写） | `:2031-2036` / `:1006-1058` | 浏览区段外壳 + 列表重排 |
| 代码工作区管理器 | `ManagerBody`（新）+ `ManagerTools`（新）+ `WorkspaceList`（重写） + `WorkspaceRow`（重写） | `:1702-1762` / `:1592-1637`（`forgetFileAt` `:1647-1659` 不改） | 按 §4.12；panel 页的根节点是 `ManagerBody`，`PanelBody` 不再有 panel 分支 |
| 空状态 | `EmptyWorkspace`（新） | `:1866-1876` | 新函数（仅 view / overlay） |
| 加载态 | `LoadingCard`（新） | `:1877-1878`（`busy ? status.loading : hint.noFile`） | 新函数，**保留 busy / 非 busy 两个分支**（非 busy 的 `hint.noFile` 被测试 578 依赖） |
| 终端解说行 | — | 已删 | 管理器页不再画文件夹区，`hint.terminalSession` 没有落点，键与渲染一并移除 |

### 7.4 新增 state 字段

在 `state`（`:342-368`）的 `notice` 之后加：

```js
/** `notice` 的语义：成功操作 = success，说明/提示 = info。 */
noticeTone: 'info',
```

`patch` 站点（**每个写 `notice` 的地方都必须同时写 tone**，否则上一次的 success 会串色）：

| 行 | 现状 | 改为 |
| --- | --- | --- |
| `:689` | `patch({ notice: t('workspace.registered') + … })` | `+ noticeTone: 'success'` |
| `:693` | `patch({ notice: …, error: … })` | `+ noticeTone: 'success'` |
| `:790` | `patch({ busy:false, notice: t('notice.opened', …) })` | `+ noticeTone: 'success'` |
| `:996` | `patch({ busy:false, error:null, notice: t('hint.noNativePicker') + … })` | `+ noticeTone: 'info'` |
| `:1448` | `patch({ error:null, notice: t('notice.terminalFocused', …) })` | `+ noticeTone: 'success'` |
| `:1481` | `patch({ error:null, notice: t('notice.terminalOpened', …) })` | `+ noticeTone: 'success'` |
| `:628`、`:2240`、`:2437` | `notice: null` | 同时 `noticeTone: 'info'` |

其它 UI 状态（拖拽、复制反馈、hover/focus）**一律放组件本地 `useState`**，不进共享 store，
避免 `useSyncExternalStore` 因无关重渲染抖动。

禁止新增与宿主/命令通道有关的 state。

### 7.5 `terminalErrorText` 本地化映射（`:1342-1348`）

这三条错误文本由本 bundle 自己产生（下表前三行），映射是纯客户端的：

| 内部消息（本文件产生） | 位置 | 映射到 |
| --- | --- | --- |
| `the terminal tab did not appear` | `:1565` | `t('error.terminalNoTab')` |
| `the terminal did not become writable` | `:1395` | `t('error.terminalNotWritable')` |
| `the terminal opened in another session` | `:1507` | `t('error.terminalOtherSession')` |
| 其它 / PTY 失败 | — | 保持 `t('error.terminalFailed', { message })`（测试 `:1795` 断言「终端打开失败：no shell on this host」） |
| `terminal-limit` | `:1335-1339` | 保持 `t('error.terminalLimit')`（测试 `:1785`） |

判定顺序：先 `code === 'terminal-limit'`，再按消息正则，最后兜底。

### 7.6 实施顺序（建议，便于逐步跑测试）

1. `TOKEN` + 原子（Button/IconButton/Badge/TextInput/Banner/Card/SectionHeader/EmptyState/Copy）——只改样式，不改结构，跑 `npm test` 应全绿（测试渲染树只关心文本/标题/onClick）。
2. 文案键 + `terminalErrorText` + `noticeTone`——跑测试。
3. `PanelBody` 拆分区（标识 / 空状态 / 加载 / 文件夹 / 表单 / 编辑器 / 冲突 / 最近 / 浏览），保持所有既有 onClick 与文案——跑测试。
4. `WorkspaceList` / `WorkspaceRow` 重写——跑测试。
5. 拖拽排序 + 复制反馈——手工验收。
6. 按 §5.4 改两行测试——`npm test` 全绿。

---

## 8. 验收标准

### 8.1 渲染树断言（可直接写进 `test/client.test.mjs`）

- `textOf(tree)` 含 H1 文件名（如 `app.code-workspace`），且**不再**含 `hint.view` 文案。
- 文件夹行：`nodesWhere(tree, n => n.type === 'div' && textOf(n).includes('D:/ws') && buttonsIn(n).some(b => textOf(b) === '>_'))` 每行恰好 1 个终端按钮（既有 `rowByPath` 辅助函数继续可用）。
- 每个 `IconButton` 的 `props.title` 非空；`buttonByTitle(tree,'移除').props.onClick` 触发前调用 `window.confirm`（测试可断言 `confirmations.length`）。
- `buttonByTitle(tree,'取消关联')` 仍是管理器行的 unlink（**不是**页面级按钮）。
- 添加表单：`inputsIn(tree)` 中存在 `props['data-field'] === 'add-path'` 与 `'add-name'`；`buttonByLabel(tree,'添加文件夹').props.disabled` 在路径为空时为 `true`。
- `panel` 树含 `代码工作区`、`切换文件`、`从资源管理器选择`，且**不含** H1 / `工作区根目录`（那是 view / overlay 的标识卡片）；`view` 树不含管理器行。
- busy 时：`nodesWhere(tree, n => n.props && n.props['aria-busy'] === 'true')` 非空；添加按钮 `disabled === true`。
- error 时：存在 `role="alert"` 的 Banner 且含错误文案；点击关闭后下一渲染不再出现。
- 未关联文件时（view / overlay）：空状态含 `切换文件` / `新建工作区文件` / `从资源管理器选择` 三个按钮，点击 `切换文件` 触发 `codeWorkspace/browse`。panel 上则是列表自己的空文案，不出现这张卡片。

### 8.2 视觉 / 交互清单（人工）

1. 1014×561：首屏能看到「标识卡片 + 工作区文件夹前 3 行 + 添加表单」，页面无横向滚动。
2. 层级：H1 明显最大；分区标题可扫读；页面只有「添加文件夹」是实心按钮；「取消关联」在行尾且为红色文字。
3. 文件夹行：hover 有底色；主目录行常驻浅底 + 主目录徽标；`✕` 与其它动作之间有竖线；每个图标按钮悬停出现 tooltip。
4. 动作分组：终端在最左；排序/重命名/显示在中间组；移除在最右危险组。
5. 添加文件夹：两个字段有可见标签；路径为空时主按钮禁用；Enter 提交；提交中两个输入框与按钮禁用。
6. 错误：制造一次终端失败（关掉右侧栏或断开会话），Banner 显示**中文**原因，可关闭，关闭后不残留。
7. 成功：打开编辑器 → 绿色成功 Banner（12/18），可关闭。
8. 空状态：无文件夹、无编辑器、无最近、空目录四种都能看到解释 + 下一步。
9. 键盘：Tab 能走遍所有按钮与输入框；焦点环 2px 可见（鼠标点击不出现）；Enter 提交表单；`Esc` 不拦截（浮层 ✕ 仍可点）。
10. 主题：浅色/深色切换后文字、卡片、Banner、徽标、hover 都可读；无硬编码白/黑块。
11. 430px 浮层：内容不横向溢出；动作行换行整齐；文件夹行动作组换到第二行仍可用。
12. 滚动：文件夹 12 个时列表内部滚动（max 400），「添加文件夹」与编辑器分区仍在视口内。
13. 拖拽：hover 出现把手；拖到另一行上下半区出现 2px 蓝线；放下后顺序变化并发出 `moveFolder`（`/code-workspace move …`）；`↑/↓` 依然可用。
14. 复制：点路径后的复制按钮，1.2s 内图标变 `✓` 且 tooltip 为「已复制」，剪贴板内容是完整路径。

### 8.3 状态矩阵（逐项勾）

未关联 / 加载中 / 读取失败 / 解析失败 / 正常 / 无文件夹 / 无编辑器 / 无编辑器（SSH） / 无最近 / 空目录 /
无已记录工作区 / 无屏上会话（终端提示） / 无终端服务（无提示无按钮） / busy / error 可关闭 / notice 双 tone /
hover / pressed / focus-visible / disabled / 重命名态 / 拖拽中。

### 8.4 回归

```bash
npm test          # node --test "test/**/*.test.mjs"
```

除 §5.4 的两行外不得修改测试；测试全绿后手工走 §8.2。

---

## 9. 不做的事

- **不新增依赖**，不新增对 `@deepseek-ai/dsh-client-ui-primitives` 组件的使用（现有「Open In…」接管里的
  `optionalRequire` 保留不动）；不新增 `dsh.client.inject` 条目；不引入 `<style>` 全局样式（理由见 §2.0）。
- **不改宿主**：`lib/index.js`、`lib/editor.js`、`lib/workspace-file.js`、远程 API、
  store、系统提示词、`cordis.patch.yml` 全部不动；页面只消费既有数据与既有端点。
- **不改入口 chip**：`HeaderButton` / `DockChip` / 「Open In…」接管保持现状（已是 rc.5 几何）。
- **不改交互语义**：哪个按钮发哪条命令、`openFile`/`createFile`/`mutate` 的通道选择、
  `terminal` 的 cd 行为、`WorkspaceView` 的 session scope（`syncPanelScope`）都不变。
- **不改浮层宽度**：`shell.overlay` 仍是 430px（创建页弹层的既有约束）。
- **不做列表虚拟化 / 搜索 / 多选 / 右键菜单**：文件夹数量是 VS Code 级别（个位数到十几），
  没有虚拟化必要；搜索属于新功能，不在本次视觉重构内。
- **不删键**：只新增键；`hint.view` / `label.file` / `title` 保留在字典里（键集平衡测试）。
- **不顺手改测试**：除 §5.4 两行外，任何测试失败都视为实现偏差，回到本文修订。
- **不依赖 `:hover` / `:focus-visible` CSS**：内联样式做不到，统一用组件本地 state 实现；
  因此 hover 效果在渲染树测试里不会出现（测试不依赖视觉态）。
