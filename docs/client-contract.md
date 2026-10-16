# DSH 客户端插件契约（客户端 bundle 编写指南）

适用版本：DSH 0.2.0-rc.2（Electron 桌面版，web GUI `http://127.0.0.1:19387`），DSH_HOME `C:\Users\EDY\.dsh`，profile `desktop`。

本文件的每一条结论都带 `path:line` 引用。引用来源分两类：

**A. 已安装的插件（可直接用编辑器打开）**

| 简称 | 路径 |
| --- | --- |
| `MF_CLIENT` | `C:\Users\EDY\.dsh\profiles\desktop\node_modules\dsh-multi-folder\lib\client.js`（1629 行，参考实现 A） |
| `MF_HOST` | `C:\Users\EDY\.dsh\profiles\desktop\node_modules\dsh-multi-folder\lib\index.js` |
| `MF_PKG` | `C:\Users\EDY\.dsh\profiles\desktop\node_modules\dsh-multi-folder\package.json` |
| `MF_DESIGN` | `C:\Users\EDY\.dsh\profiles\desktop\node_modules\dsh-multi-folder\docs\design.md` |
| `TRAE` | `D:\kjsjs\deepseek\dsh-plugin-openintrae\lib\client.js`（523 行，参考实现 B） |
| `TRAE_PKG` | `D:\kjsjs\deepseek\dsh-plugin-openintrae\package.json` |
| `NL` | `D:\kjsjs\deepseek\dsh-plugin-nl-theme\lib\client.js`（801 行，参考实现 C） |
| `NL_SRC` | `D:\kjsjs\deepseek\dsh-plugin-nl-theme\src\index.js` |
| `NL_PKG` | `D:\kjsjs\deepseek\dsh-plugin-nl-theme\package.json` |

**B. DSH 实现包内的文件（在 `D:\AI\DeepSeek Harness\resources\app.asar` 内，asar 内路径见下）**

读取方式（两个工具脚本已存在，用法见脚本头注释）：

```powershell
# 列出 / 导出
node D:\kjsjs\deepseek\dsh-plugin-openintrae\tools\asar.mjs "D:\AI\DeepSeek Harness\resources\app.asar" list "dsh-client-ui-slots"
node D:\kjsjs\deepseek\dsh-plugin-openintrae\tools\asar.mjs "D:\AI\DeepSeek Harness\resources\app.asar" cat "dsh-client-ui-slots/lib/index.js$" .\out
# 内容检索（contentRegex 是 JS 正则，pathRegex 可选）
node D:\kjsjs\deepseek\dsh-plugin-openintrae\tools\asar-grep.mjs "D:\AI\DeepSeek Harness\resources\app.asar" "slots\.inject" "client\.js" 3
```

`node` 可用捆绑运行时：`C:\Users\EDY\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

下文 asar 引用的写法是 `asar:dsh/node_modules/@deepseek-ai/<pkg>/<file>:<line>`，行号是**导出后的文本行号**（`asar.mjs cat` 的产物）。压缩过的 web 前端 bundle 只有 1 行，因此那一条引用标注的是「第 126 行」这一逻辑位置（用 `[System.IO.File]::ReadAllText` 定位）。

---

## 1. bundle 外壳：`window.__ModuleLoader__.load({ id, factory })`

### 1.1 最小可运行骨架

参考实现 A 的完整外壳（`MF_CLIENT:73-78` 与 `MF_CLIENT:1624-1629` 首尾合起来）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-multi-folder',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    // ... 模块体（闭包内一切副作用都在「物化」时才跑）...

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
```

参考实现 C 的变体：手写 CJS 样板全部省略，直接在 factory 里 `return plugin`（`NL:799-801`），`plugin` 是 `{ inject, apply }`（`NL_SRC:13-16`）；参考实现 B 同样 `return { inject, apply }`（`TRAE:521`）。**两种写法都合法**：模块表把 `factory(require)` 的返回值当作 exports 记录（`asar:dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js:683`，`exports: registered.factory(this.makeRequire(ownerId, edges))`），随后由 cordis Loader 从 exports 上读 `name`/`inject`/`apply`。

### 1.2 逐字段说明

| 字段 | 语义 | 证据 |
| --- | --- | --- |
| `id` | 注册键，**必须等于 package 名**（不是 `name` 字段、不是任意字符串）。加载器只删掉结尾的 `/client` 再做归一化，`<package>` 与 `<package>/client` 解析到同一行。重复注册同一 id 会抛 `duplicate factory registration`。 | `asar:.../dsh-client-modules/lib/client.js:570-576`（`stripClientSuffix` + `duplicate factory registration for`），`:98-100` |
| `factory` | 收到一个 `require` 并返回 exports 的函数。**bundle 脚本执行时只注册工厂，不跑模块体**；所有副作用（含 CSS 注入）都发生在 factory 闭包内，直到首次物化才执行。 | `asar:.../dsh-client-modules/lib/client.js:17-23`，`:670-695` |
| `factory` 返回 | 被 memoize 进 `loadCache`；**require 环会抛错**（`require cycle through "..."`），因为 factory 形式的 CJS 交不出半成品 exports。 | 同上 `:677` |
| `chunk` | 可选第三字段，只有编译产物才会用（`client.<name>.js` 分块）。手写 bundle 不要写。 | `:571-572` |

### 1.3 `require` 能 require 什么

`require` 是一个查表函数，解析顺序固定（`asar:.../dsh-client-modules/lib/client.js:697-706`）：

1. **平台种子表** `this.seed`（`new Map(Object.entries(options.staticModules))`，`:548`）——命中直接返回同一份实例；
2. **已物化的模块** `loadCache`；
3. **已注册但未物化的工厂** `factories` → 递归物化（`materialize`）；
4. 都不是 → 抛错：`require("...") missed the module table — not a platform seed word, not a materialized module, and no registered package factory`（`:705`）。

**平台种子表就是这个清单（完整、9 项）**：

```js
{ react: Ef, "react/jsx-runtime": If, "react-dom": Rf, "react-dom/client": Df,
  "@deepseek-ai/cordis": sf, "@deepseek-ai/dsh-client-store": lh,
  "@deepseek-ai/dsh-client-ui-slots": hh, "@deepseek-ai/dsh-client-ui-primitives": sE,
  "@deepseek-ai/dsh-client-ui-dockkit": XS }
```

来源：asar `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js` 第 126 行（函数 `rM()`，字节偏移 628285；该文件是压缩单行 bundle，`package.json` 里同名资产为构建产物）。参考实现 B 的注释也印证了同一事实：`react`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives` 是「平台种子模块，无需 `dsh.client.external` 边」（`TRAE:30-32`）。

`require.async(spec)` 存在（`:707-713`）：`./client.<name>.js` 形式的相对 chunk 走分块加载，其它 specifier 走 `import`。手写 bundle 不需要它。

### 1.4 加载时机

- 宿主向 `<head>` 注入：先 `window.__ModuleLoader__` 的**队列门面**（`{ mode:'queue', pendingQueue, load(reg), create(options) }`），再 application 批次的 preload，再 parser-blocking 的 bootstrap 批次脚本，最后是 `window.__DSH_BOOT__` 图。来源 `asar:.../dsh-client-modules/lib/index.js:453-494`。
- `create()` 会把队列里 `@deepseek-ai/dsh-client-modules` 那一行单独摘出来物化成 bootstrap 模块，用它导出的 `createClientModuleSystem` 构造真正的模块系统，然后把队列切成 live 模式（`asar:.../dsh-client-modules/lib/index.js:460-473`、`client.js:559-566`）。之后再 `load(...)` 就是直接进注册表。
- 因此：**bundle 顶层只允许写 `window.__ModuleLoader__.load(...)` 这一个表达式**，别在顶层读 `document`、别发请求、别注册任何东西。

### 1.5 package.json 侧声明

```jsonc
// MF_PKG:61-70
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-api-gateway",
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-input-trigger"
    ]
  }
}
```

- `platform: 'web'` 必填；`inject` 是**包名**数组，语义是「这些包对应的 bundle 必须先于本包到达」（`asar:.../dsh-client-modules/lib/client.js:656-659`，`:61-75`）。**它不是服务名**——服务名写在 bundle 自己的 `inject` 数组里，两者是两套命名空间。
- `immediately`（可选 boolean）：`TRAE_PKG:33` 与 `NL_PKG:32` 分别写了 `true`/`false`，`MF_PKG` 没写。加载器把它解析进 boot 行（`asar:.../dsh-client-modules/lib/client.js:68`、`:73`、`:138`）。**它在客户端的分支行为未验证**（浏览器侧 `client.js` 只解析不消费），需要时以宿主行为为准。
- 包还必须导出 `./client` 子路径（`MF_PKG:29-31`、`TRAE_PKG:24-26`），宿主按它取 `lib/client.js`。

---

## 2. 模块导出契约

### 2.1 `name` / `inject` / `apply`

```js
// MF_CLIENT:284-287
var name = 'dsh-multi-folder';
var inject = ['remote', 'remote.commands', 'slots', 'workspaces', 'connection', 'sessions', 'locale'];

function apply(ctx) { /* ... */ }
```

- `inject` 是**服务名**数组（`ctx.<key>`），由该 bundle 自己声明；声明过的服务在 `apply` 执行前一定就位。
- `name` 是插件 fiber 的显示名/诊断名（用于 `registrant` 戳记与错误信息，见 `asar:.../dsh-client-ui-renderer/lib/client.js:1580`，`options.registrant ?? this.ctx.fiber?.name`）。
- **`name` 与 `inject` 可以省略**：参考实现 B 只导出 `{ inject: ['slots','locale'], apply }`（`TRAE:430`、`TRAE:521`），C 导出 `{ inject: ['theme','slots'], apply(ctx, config) }`（`NL_SRC:15-16`）。`apply` 的第二个参数是插件 Config（C 用它读用户配置：`NL_SRC:17`）。
- `apply` 是同步的；返回值被 cordis 当作 disposer 链的一部分处理。

### 2.2 `ctx.inject([...], cb)` 与 `ctx.effect(...)`

两者都是 **cordis 的 fiber 生命周期 API**，客户端闭包里可用的签名（`asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:6143-6151`）：

```
ctx.get(name: string): unknown | undefined
ctx.on(name: string, listener: Function): () => void
ctx.provide(name: string, value: unknown): () => void
ctx.effect(callback: Function, label?: string): () => void
```

**`ctx.effect(cb, label)`**：注册一个绑定到本插件 fiber 的副作用。`cb` 返回 disposer（或 disposer 数组）。插件卸载时自动回收。参考实现 A 的真实用法：

```js
// MF_CLIENT:299-301 —— 字典注册绑到 fiber，卸载即撤回
ctx.effect(function () {
  return locale.register(NS, { zh: zhDict, en: enDict });
}, 'dsh-multi-folder: client dictionaries');

// MF_CLIENT:323-329 —— 返回「清理函数」而非「资源」的第二种形态
ctx.effect(function () {
  return function () {
    var controller = activePick;
    activePick = null;
    if (controller) controller.abort();
  };
}, 'dsh-multi-folder: cancel picker on unload');
```

**`ctx.inject([...deps], cb)`**：软依赖。依赖全部就位时 `cb(scope)` 被调用（**同步**，若已就位），否则一直等待，直到它们出现或本插件卸载；`cb` 里用 `scope.effect(...)` 注册的副作用绑到同一个 fiber。参考实现 A 的真实用法：

```js
// MF_CLIENT:1559-1562
ctx.inject(['inputTriggers'], function (scope) {
  var registry = scope.inputTriggers;
  if (!registry || typeof registry.registerSource !== 'function') return;
  scope.effect(function () {
    return registry.registerSource({ /* ... */ });
  }, 'dsh-multi-folder: @ discovery source');
});
```

**区别（以及何时用哪个）**：

| | `inject: [...]` 硬依赖 | `ctx.inject([...], cb)` 软依赖 |
| --- | --- | --- |
| 缺服务时 | `apply` 根本不会跑 | `apply` 照常跑，只有那段贡献不激活 |
| 适用 | 没有它整个插件无意义（`slots`、`locale`） | 可选的增强表面（`inputTriggers`） |
| 设计文档的取舍 | — | `MF_DESIGN:296-303`、`MF_CLIENT:46-48`：shell 没有 trigger 服务时，面板等表面必须保留 |

> 客户端 SDK 明文建议：「Prefer ctx.get(name) with an undefined check; use inject only for hard dependencies.」（`asar:.../dsh-cordis-client-runner/lib/client.js:6144`）

---

## 3. 槽位注册

### 3.1 两个 API 的签名

```
// asar:.../dsh-cordis-client-runner/lib/client.js:1384-1393
ctx.slots.inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void

// asar:.../dsh-cordis-client-runner/lib/client.js:1367-1369（= SlotCore.register 的完整类型面）
ctx.slots.register(options, component): () => void
```

- `inject(key, cb)`：**只在该 slot 被「声明」时才调用 `cb`**；声明塌陷时把 effect 一起销毁；再次声明会再次调用。回调返回一个 disposer 或 disposer 的可迭代集合（迭代集合按逆序事务式安装）。来源 `asar:.../dsh-client-ui-renderer/lib/client.js:1328-1402`。返回一个幂等 disposer。
- 注册进**未声明的 slot 会抛错**，`slots.inject` 就是这个「等声明」的机制（`asar:.../dsh-client-ui-slots/lib/index.js:163-165`：`slot "..." is not declared`）。
- 参考实现一律写 `slots.inject(name, () => slots.register({ name, ... }, Component))`（`MF_CLIENT:1427-1431` 等）。

### 3.2 `register` 描述符的全部字段

`register` 接受的字段（实现见 `asar:.../dsh-client-ui-slots/lib/index.js:163-231`，用户文档见 `:3011-3027` 一类的 slot 目录条目）：

| 字段 | 类型 | 必需性 | 语义 | 证据 |
| --- | --- | --- | --- | --- |
| `name` | string | **必需** | 槽位 key，必须与 `inject` 的 key 相同 | `:164-165` |
| `id` | string | `list` 槽位必需 | 单元格 key。用新 id 就与既有条目并列；复用既有 id 就进同一个 cell（并可能顶替它） | `:182-184`，目录 `:3011-3015` |
| `order` | number | 可选（默认 0） | 同 cell 内排序，升序 | `:209`，`:1193` |
| `priority` | number | 可选（默认 0） | **不同插件间的遮蔽键**：同 `id` 同 `priority` 重复注册会抛错；`list` 槽位的排序是 `(priority, order)` 升序，最低者渲染 | `:167-172`、`:221` |
| `label` | `string \| (() => string)` | 可选 | 供 owner 投影的名字。**thunk 每次被读都重新求值**，所以本地化文本跟随活动语言而无需重新注册 | `:27-29`（`resolveSlotLabel`），`:210`，目录 `:3023-3026` |
| `key` | string | `keyed` 槽位必需 | 派发键 | `:176-178` |
| `select` | `(ownerProps) => matched` | `chain` 槽位必需 | 选择器：异步返回 `null` 表示弃权 | `:188`，renderer `:1158-1176` |
| `locale` | string | 可选 | 语言命名空间；声明后 renderer 会给组件合成 `t` seat，并在语言切换时重渲染 | renderer `:721-725` |
| `inject` | `(...args) => object` | 可选 | 该条目的业务注入；返回值被展开为组件 props，`hooks` 子表会被转成 `use<Name>` | renderer `:415-438`；示例 `TRAE:483-510` |
| `children` | `Record<key, SlotSpec>` | 可选 | 声明本条目**自己的子槽位**（`renderSlot` props 才能渲染它们） | `:191`，renderer `:732-739` |
| `store` | `defineStore(...)` 的 handle | 可选 | store seat：组件拿到 `useStore` + `actions` | renderer `:727-731` |
| `registrant` | string | 可选（一般由框架自动戳） | 诊断用注册者名 | renderer `:1580-1584` |
| `scope` / `kind` | — | **不属于 register** | 它们由**声明方**（slot 的 owner）固定，注册者不能改 | `SlotEntryDef` 见 `asar:.../dsh-cordis-client-runner/lib/client.js:2162-2163` |

`register` 返回一个**幂等 disposer**（`asar:.../dsh-client-ui-renderer/lib/client.js:1788-1791` 用 `ctx.effect` 包住，因此 fiber 卸载等于级联回收）。

### 3.3 参考实现实际用到的 slot 名单

| slot | kind / scope | 参考实现里的注册 | 用途 |
| --- | --- | --- | --- |
| `conversation.session.header.actions` | `list` / `session` | `{ name, id:'multi-folder', order:30, label:()=>t('label'), locale:NS }`，组件 `HeaderButton`（`MF_CLIENT:1427-1431`） | 会话语境下标题旁的操作按钮 |
| `shell.overlay` | `list` / `root` | 两份：`id:'multi-folder', order:100`（面板，`MF_CLIENT:1433-1437`）与 `id:'multi-folder-hero', order:200`（兜底启动器，`MF_CLIENT:1454-1458`） | 全帧浮层：固定定位面板 + 兜底按钮 |
| `conversation.input.dock` | `list` / `session` | `{ name, id:'multi-folder', order:120（DOCK_ORDER）, label:()=>t('label.heroDock'), locale:NS }`，组件 `DockChip`（`MF_CLIENT:1443-1452`） | 新建会话页、composer 卡片**正上方**的整宽行 |
| `conversation.hero.workspaceExtras` | — | `{ ..., id:'multi-folder', order:30 }`，组件 `HeroChip`（`MF_CLIENT:1463-1473`） | **rc.2 里该 slot 不存在**（见 3.4），注册永不触发 |
| `conversation.session.header.utilities` | `list` / `session` | `{ ..., id:'open-in-app', priority:-1, order:-10, locale:NS, inject }`（`TRAE:503-510`） | 用 `priority:-1` 顶替 shipped cell |
| `sidebar.right.tab.files.actions` | `list` | 同上（`TRAE:512-518`） | 文件页操作区 |
| `settings.section` | `list` | `{ name, id:SETTINGS_ID, order:55, label:()=>'主题外观' }`（`NL_SRC:155-158`） | 设置对话框的一整页 |

owner 侧清单可用 client inspect provider `Slots` 现查（见 §9.6）。

### 3.4 `conversation.hero.workspaceExtras`：rc.2 未声明

在 asar 的 slot 目录（98 个 key，`asar:.../dsh-cordis-client-runner/lib/client.js:2365-6100`，`key:` 行一览见 `:2365`–`:6074`）中**没有** `conversation.hero.workspaceExtras`。参考实现自己的注释也承认它要等一个声明它的上游版本（`MF_CLIENT:18-19`、`:1460-1462`），并且把它排在「三个候选座位」里的最优先位、靠 seat election 决定谁渲染（`MF_CLIENT:146-172`，`MF_DESIGN:369-403`）。写新插件时**不要依赖这个 slot**；用 `conversation.input.dock`（rc.2 已声明，见下）。

### 3.5 三个关键 slot 的 owner share 与渲染契约

**(a) `conversation.input.dock`**（owner 目录条目 `asar:.../dsh-cordis-client-runner/lib/client.js:3003-3060`）

- `kind: "list"`，`scope: "session"`，`summary: "Full-width entries above the composer card."`（`:3005-3007`）。
- **owner share（`props` 里由 owner 覆盖的那部分）只有两个字段**：

```ts
// :3029（目录内原始文本）
export interface InputZone {
  readonly session: SessionSnapshot
  readonly input: InputState
}
```

- 另有**标准 kit**（owner 不提供、由 scope 注入）一堆，其中最关键的是 `sessionId: SessionId`、`useSessions: UseSessions`、`useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>`、`useSession`、`useInput`、`inputActions`（`:3031-3046`）。
- **合并顺序**：`{...kit, ...injected, ...slotInjected.props, ...ownerProps}` —— **owner props 最后展开、覆盖一切**（`asar:.../dsh-client-ui-renderer/lib/client.js:763-777`）。因此读 `props.sessionId`、`props.useSessions` 属于读标准 kit，读 `props.session` / `props.input` 属于读 owner share。
- `sessionId` 的来源已确认：session scope 适配器把 `props: ["sessionId"]` 并提供 `{ sessionId: binding.sessionId }`（`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js:124`、`:128`）。
- 参考实现 B/DockChip 的真实读取方式（`MF_CLIENT:1245-1263`）：`props.t`、`props.sessionId`、`props.useSessions`、`props.useWorkspaces`、`props.session`，并且对两个 hook 做了「不是函数就退化为 `selectNothing`」的防御，以保持 hook 调用顺序稳定（`MF_CLIENT:1252-1253`，`selectNothing` 定义在 `:144`）。
- **渲染契约**：outlet 是 `display:contents`（`MF_CLIENT:61-64`；每个条目变成 composer 栈里自己的一行），所以条目**必须保持 in-flow**，不要绝对定位，否则会压到别的插件的 dock 行。参考实现用 `display:flex` + `paddingLeft:20` 对齐官方 hero 行（`MF_CLIENT:1281-1291`）。
- 共注册的 shipped 条目：`queue`(order 20)、`todo`、`goal`(order 10)（`:3052-3056`）。参考实现选 `order:120` 以避免与之争位（`MF_CLIENT:149-153`）。

**(b) `shell.overlay`**（owner 目录条目 `:4816-4871`）

- `kind: "list"`，`scope: "root"`，`summary`：「Frame-wide floating layer, above every column and outside their scroll containers.」；`ownerProps: []` —— **没有任何 owner 字段**（`:4817-4818`、`:4841`）。
- 标准 kit 只有 6 项：`useResource`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionRetainInfo`（`:4843-4851`）。**注意这里没有 `sessionId`**（root scope 没有 session 绑定）。
- **渲染契约**：这一层自身是 **click-through**（pointer-events 穿透），条目要**自己 opt-in 指针事件**；且条目之间只按自己的 `order` 排序（`:4820`）。参考实现的面板用 `position:fixed` + `zIndex:400` 显式接管点击（`MF_CLIENT:1066-1084`）。
- `root` slot 的文档明确劝阻：「DO NOT register here … For a surface of your own that floats over the whole app, register into `shell.overlay` instead (a list slot: additive, and click-through until your entry opts into pointer events).」（`:4304`）

**(c) `conversation.session.header.actions`**（owner 目录条目 `:3495-3553`）

- `kind: "list"`，`scope: "session"`，`summary`：「Title-adjacent Session actions in ascending order.」（`:3497-3499`）。
- **owner share 显式为空**：

```ts
// :3521
/** Header actions derive their state from standard Session props. */
export interface ConversationHeaderActionOwnerProps {
  /** Marker field: entries receive no owner-specific values. */
  children?: never
}
```

- 状态全从标准 kit 取，其中 `sessionId`、`useSessions`、`useSession` 同 (a)（`:3523-3539`）。参考实现 B 的 `HeaderButton` 正是只读 `props.sessionId` 与 `props.t`（`MF_CLIENT:630-633`）。

---

## 4. React 与 JSX

- **拿到 React**：`var React = require('react')`（`MF_CLIENT:78`）；`react` 在平台种子表里（§1.3），因此永远可解析。
- **没有 JSX 转换**。客户端内置符号目录里 React 的条目写得很直白：「React runtime exposed without JSX transformation.」（`asar:.../dsh-cordis-client-runner/lib/client.js:6152-6159`）。手写 bundle 一律用 `React.createElement`。
- 参考实现 A 的写法：显式别名 + 一个小工具函数，用来把 children 数组铺开：

```js
// MF_CLIENT:1055-1057
function element(type, props, children) {
  return React.createElement.apply(null, [type, props].concat(children));
}
```

  以及直接调用（`MF_CLIENT:1430`、`:1436`、`:1447`）：`function (props) { return React.createElement(HeaderButton, props); }`。
- 参考实现 B：`const React = require('react'); const h = React.createElement`（`TRAE:37-38`）。
- 参考实现 C：**防御式**取 React，取不到时只放弃设置页、主题仍然生效：

```js
// NL:15-23
let React
try {
  React = require('react')
} catch (error) {
  console.warn('[dsh-plugin-nl-theme] require("react") 失败:', error)
}
const hasReact = Boolean(React) && typeof React.createElement === 'function'
const { createElement: h, useEffect, useRef, useState } = hasReact ? React : {}
```

  并在注册前短路：`if (!hasReact) { console.warn(...); return }`（`NL_SRC:150-153`）。
- 想要 JSX/`jsx-runtime` 的话，`react/jsx-runtime` 也在种子表里（§1.3），但**没有任何参考实现用它**；是否需要构建期转换**未验证**。
- 组件可以是有状态组件，hook 直接用 `React.useEffect` / `React.useSyncExternalStore`（`MF_CLIENT:123`、`:1267`、`:639`）。

---

## 5. 本地化

### 5.1 `locale.register(NS, { zh, en })` 的确切形状

```js
// MF_CLIENT:199-201（NS 与 zh 字典开头）, 242（en 字典开头）, 299-301（注册）
var NS = 'multi-folder';
var zhDict = { 'label': '多工作目录', 'label.withCount': '多工作目录 · {count}', /* ... */ };
var enDict = { 'label': 'Multi-folder', 'label.withCount': 'Multi-folder · {count}', /* ... */ };

ctx.effect(function () {
  return locale.register(NS, { zh: zhDict, en: enDict });
}, 'dsh-multi-folder: client dictionaries');
```

服务端实现（`asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1387-1413`）：

- 第二个参数是 `string` 时按**单语言形式** `(ns, locale, dict)` 处理，是对象时按 `Object.entries` **一次注册多语言**（`:1388`）。
- locale id 必须是 BCP 47 风格标签，否则抛 `locale id "..." is not a BCP 47-style tag`（`:1389`）。
- **同一 `(ns, locale)` 重复注册会抛错**：`locale namespace "..." already has locale "..."`（`:1395`）。
- 返回值是**幂等 disposer**，按「同一字典对象」判定移除（`:1398-1412`）。
- 「双语平衡在注册时强制」是**类型层面**的（`register<N>(ns, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>)`，每次调用要求所有内建语言；`asar:.../dsh-cordis-client-runner/lib/client.js:1214-1215`）。**运行时的 `register` 只校验 locale 标签与重复，不校验 zh/en 键集合是否一致**（实现见上，未发现键平衡检查）——「en 字典与 zh 键集合逐键核对」是参考实现**自己的纪律**（`MF_CLIENT:241`）。

### 5.2 组件如何拿到 `t`

在 `register` 描述符上写 `locale: NS`，renderer 会为该条目合成一个 `t` seat：

```js
// asar:.../dsh-client-ui-renderer/lib/client.js:721-725
if (entry.locale !== void 0) {
  const face = host.locale;
  if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
  kit["t"] = localeSeat(face, entry.locale);
}
```

- `t` 的签名是 `(key, params?) => string`，**语言切换时会换成一个新的函数引用**（因此 `React.memo` 靠浅比较自然重渲染），同一 revision 内引用稳定（`:513-538`）。
- outlet 自己订阅了 locale revision，所以语言切换会让所有 outlet 重渲染（`:1098`、`:1209`、`:567-570`）。
- 插值语法是 `{name}`：`template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)`（`asar:.../dsh-client-locale/lib/client.js:1427`）。缺键时返回 key 本身，并且在 `ns !== 'common'` 时先回退到 `common` 命名空间查（`:1425`）。
- 组件里就是 `props.t`（`MF_CLIENT:633`、`:1062`、`:1247`），调用如 `t('label')`、`t('label.withCount', { count: count })`（`MF_CLIENT:1300`）。
- `inject` 返回的对象里**不要再放 `t`**：会与 locale seat 撞名并被 renderer 拒绝（`TRAE:490-491` 的注释）。

### 5.3 label thunk

```js
// MF_CLIENT:1429
{ name: 'conversation.session.header.actions', id: 'multi-folder', order: 30,
  label: function () { return t('label'); }, locale: NS }
```

- `label` 可以写成 thunk；owner 投影时用 `resolveSlotLabel` 每次读取都重新求值，所以「注册时给出的文本」会跟随活动语言，**不需要为切语言重新注册**（`asar:.../dsh-client-ui-slots/lib/index.js:20-29`；目录里的说明 `asar:.../dsh-cordis-client-runner/lib/client.js:3023-3026`）。
- `t` 本身来自 `var t = locale.bind(NS)`（`MF_CLIENT:308`），bind 的结果**每命名空间稳定**（`asar:.../dsh-cordis-client-runner/lib/client.js:1246-1252`）。
- 不使用 locale 时，label thunk 也可以返回常量：`label: () => '主题外观'`（`NL_SRC:156`）。
- **不需要 label 的 slot 可以完全不写 `label`**（`TRAE:503-510`）。

---

## 6. 两条宿主通信通道

### 6.1 会话内：`ctx.remote.commands.execute(sessionId, line, [])`

**调用**（参考实现 A，`MF_CLIENT:434-451`）：

```js
function runCommand(sessionId, line) {
  return remote.commands.execute(sessionId, line, []).then(function (envelope) {
    if (!envelope || envelope.ok !== true) {
      throw new Error('multi-folder: ' + (envelope && envelope.error !== undefined ? String(envelope.error) : 'remote call failed'));
    }
    var execution = envelope.value;
    if (execution === undefined || execution === null) {
      throw new Error('multi-folder: command did not match — is the host plugin loaded?');
    }
    var result = execution.result;
    if (!result) throw new Error('multi-folder: command returned no result');
    if (result.kind === 'error') throw new Error(result.text || 'multi-folder: command failed');
    return result.text || '';
  });
}
```

**参数（逐项确认）**：宿主 descriptor 声明 3 个参数 + 一个取消参数（`asar:dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js:4883-4936`）：

| 位置 | 名字 | wire | 类型 |
| --- | --- | --- | --- |
| 0 | `agent` | `agentId` | `SessionId`（`source: "lookup"`，即调用侧只需传会话 id） |
| 1 | `line` | `line` | `string` |
| 2 | `submittedAttachments` | `submittedAttachments` | `Array<image | file>` |
| 可选 4 | `signal` | — | `cancellation: { parameter: "signal" }`（`:4926`） |

第三个参数就是设计文档里说的「0.1.1 起 composer 图片参数」（`MF_DESIGN:326-330`、`MF_CLIENT:435-437`）。纯命令调用传 `[]`。

**返回信封**：`{ ok: true, value } | { ok: false, error }`，由 api-gateway 客户端统一构造：

```js
// asar:.../dsh-api-gateway/lib/client.js:1795-1802
if (!result.ok) return { ok: false, error: rebuiltFailure(result.error) };
return {
  ok: true,
  value: descriptor.result.mode === "strict" && descriptor.result.decode !== void 0
    ? descriptor.result.decode(result.value) : result.value
};
```

`value` 的类型（严格解码后，`asar:.../dsh-api-remotes/lib/client.js:4857-4868`）：

```ts
undefined | {
  readonly commandId: string
  readonly result: { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
                | { readonly kind: 'error'; readonly text: string }
}
```

`error` 是 `RemoteError` 实例（`isDSHRemoteError = true`、带 `code`/`message`/`details`；`asar:.../dsh-api-gateway/lib/client.js:17-43`、`:2124-2126`）。传输/载体故障也会被折进同一信封，code 为 `gateway/internal` / `gateway/cancelled`（`:2087-2101`）。

> 注意：`value === undefined` 表示**没有命令匹配这一行**，不是错误 —— 参考实现据此提示「host plugin 没装」（`MF_CLIENT:443-444`）。

### 6.2 无会话：`ctx.connection.rpc.call('/api', '<namespace>/<op>', { args })`

**调用**（参考实现 A 的封装，`MF_CLIENT:335-348`）：

```js
function remoteCall(endpoint, args, signal) {
  if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
    return Promise.reject(new Error('multi-folder: the shared RPC channel (connection service) is unavailable'));
  }
  return connection.rpc.call('/api', endpoint, { args: args }, signal).then(function (envelope) {
    if (!envelope || envelope.ok !== true) {
      var message = envelope && envelope.error !== undefined
        ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
        : 'remote call failed';
      throw new Error('multi-folder: ' + String(message).replace(/^multi-folder:\s*/, ''));
    }
    return envelope.value;
  });
}
```

**签名**（实现，`asar:dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js:1209-1232`）：

```ts
call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>
```

- 第 1 个参数是 **channel**，形状受 `/^\/[A-Za-z0-9._~-]+$/` 约束，插件用 `'/api'`（`:1201`）。
- 第 2 个参数是 **endpoint** = `'<namespace>/<op>'`，按 `/` 切段，每段受 `/^[A-Za-z0-9_$.-]+$/` 约束（`:1202`、`:1317-1320`）。注意 `multiFolder/browse` 这类**驼峰 namespace 合法**（`$`/`.`/`-` 都在字符集里）。
- 第 3 个参数是**任意 JSON payload**，实际约定是 `{ args: ... }`；同一个约定也用在 gateway 内部（`asar:.../dsh-api-gateway/lib/client.js:1792`：`connection.rpc.call("/api", endpoint, { args: prepared.args }, prepared.signal)`）。
- 第 4 个参数是可选的 `AbortSignal`，会直接透传给 `fetch`（`:1225`），并在返回后 `signal?.throwIfAborted()`（`:1229`）。

**返回信封**（`:1288-1313` 的 `parseConnectionResponse`）：

```ts
// 成功
{ ok: true,  value: <decoded> }
// 业务失败
{ ok: false, error: { code: string, message: string, details: Record<string, unknown> } }
```

**错误如何呈现**：

1. **业务失败**（宿主 handler 抛错）→ `ok:false` + `error.{code,message,details}`。参考实现只用 `error.message`（`MF_CLIENT:341-344`）。
2. **HTTP 层失败** → `call` 直接 reject：`transport failure for /api/<endpoint>: HTTP <status>`（`:1227`）。
3. **信封损坏** → reject `TypeError("connection: invalid server-response envelope")` 等（`:1289-1301`）。
4. **rpcId 不匹配** → reject（`:1230`）。
5. **目标非法**（channel/endpoint 不匹配正则）→ **同步抛** `Error`（`:1213` 调用 `assertTarget`，`:1319`），所以要在调用处 `try/catch` 或先做参数校验。
6. **`signal` 中止** → `fetch` reject（AbortError），或返回后 `throwIfAborted()` 抛出。

因此 `connection.rpc.call` 有**两种失败通道**（resolve 出 `ok:false` 的拒答 / reject 出的传输异常），而 `remote.*` 只暴露信封（它内部把 reject 折成 `ok:false`）。参考实现只在 `multiFolder/pick` 一处用了第 4 参数（`MF_CLIENT:541`），并用 `AbortController` 在关闭面板时中止（`MF_CLIENT:311-316`、`:323-329`）。

**无会话通道的宿主侧**：参考实现的 Host 半边用 `ctx.provide('multiFolder', api)` + 一个带 `typertRemote` 描述的 namespace 把端点挂到共享 `/api` 上（`MF_HOST:906-1043`、`:1696-1701`）。写新插件时必须自带这一半，并看清自己的 profile 是否装载了它（`MF_PKG:58-60` 的 bundle patch + `cordis.patch.yml`）。

---

## 7. 客户端可用的服务（按实际用到的成员）

`inject` 数组里的每个 key 就是 `ctx.<key>`。以下成员的**签名**来自 asar 的客户端服务目录（`asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1125-1666`，`SERVICE_API` 常量）与各包自己的实现/README。

### 7.1 `sessions`（`MF_CLIENT:285` 声明）

参考实现实际用到的：

| 成员 | 形状 | 证据 |
| --- | --- | --- |
| `sessions.list` | `ObservableSnapshot<SessionListSnapshot>`，即 `{ getSnapshot(), subscribe(fn) }` | 参考实现 `MF_CLIENT:1225`（`sessions.list.getSnapshot()`）、`:1340-1341`（`sessions.list.subscribe(syncHero)`）；快照引擎 `asar:dsh/node_modules/@deepseek-ai/dsh-client-store/lib/index.js:90-92`（`getSnapshot: () => api.getState(), subscribe`） |
| `sessions.list.getSnapshot().byId[id]` | 会话摘要行，字段有 `cwd`、`blank`、`running`、`promptAttempted`、`openState`、`composerPhase`(新版本才有)、`retainedBy.mainView`、`title`、`projectionValues` | `MF_CLIENT:1255-1259`、`:1573-1574`、`:1200-1206`；`byId` 由实现填充 `asar:dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js:165-166`（`ids, byId, phase, projectionsBySession`）、`:498`、`:551` |
| `sessions.list.getSnapshot().current` | 当前会话 id | `MF_CLIENT:1226` |
| `sessions.list.getSnapshot().ids` | id 有序数组 | `asar:.../dsh-api-session-controller/.../sessions/service.js:165` |
| `sessions.scope(id)` | `AgentContext \| undefined`（借用已保留的 session scope，不延长生命周期） | 目录 `asar:.../dsh-cordis-client-runner/lib/client.js:1342-1349`；真实用法 `asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:15683`（`const actx = ctx.sessions.scope(sessionId);`，宿主条目定义在同文件 `:15668`） |
| `sessions.binding(id)` | `SessionBinding \| undefined` | 目录 `:1350-1357`；真实用法 `asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-goal/lib/client.js:563`（`const binding = sessions.binding(sessionId);`，`conversation.input.dock` 的注册在同文件 `:557`） |
| `sessions.retainInfo(id)` | `ObservableSnapshot<SessionRetainInfo>` | 目录 `:1301-1309`；`ui-session` 用法 `asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js:295` |
| `sessions.refreshProjections(sessionId)` / `search(query, signal)` / `fork(opts)` | 见目录 | 目录 `:1310-1340` |

> `SessionSnapshot` 的完整字段（owner share 里 `props.session` 的类型）见 `asar:.../dsh-cordis-client-runner/lib/client.js:2142-2143`。**注意它没有 `cwd`**——`cwd` 在 `sessions.list` 的摘要行上，不在 `SessionSnapshot` 上。

### 7.2 `workspaces`（`MF_CLIENT:285` 声明）

| 成员 | 形状 | 证据 |
| --- | --- | --- |
| `workspaces.list` | `ObservableSnapshot<WorkspaceSnapshot>`，参考实现读 `.items`（数组）与 `.archivedSessionIds` | `MF_CLIENT:1228`、`:1211`（`snapshot.items`）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`（`ctx.workspaces.list.getSnapshot().items.find(...)`）与 `.archivedSessionIds` |
| `items[i].path` / `items[i].sessionIds` | `string` / `SessionId[]` | `MF_CLIENT:1210-1219`（按 `sessionIds.indexOf(sessionId) >= 0` 反查 `path`）；`WorkspaceView` 声明 `asar:.../dsh-cordis-client-runner/lib/client.js:2270-2271` |
| `workspaces.list.getSnapshot()` 的**完整**字段 | **未验证**：asar 内没有 `WorkspaceSnapshot` 的声明文本，只能确认 `.items` / `.archivedSessionIds` | — |
| `workspaces.create({ path })` / `rename` / `delete` / `archiveSession` / `unarchiveSession` / `insertSessionBefore` | 见目录 | 目录 `:1596-1663` |

### 7.3 `remote`（`MF_CLIENT:285-286` 声明 `remote` 与 `remote.commands`）

- `remote.commands.execute(...)`：见 §6.1。
- `remote.$host`：`{ home: string | undefined, isLoopback: boolean }`，参考实现用它把宿主机 home 缩成 `~`（`MF_CLIENT:1502-1510`）。实现：`asar:.../dsh-api-gateway/lib/client.js:1628-1635`。
- 命名空间服务的装配方式：远端贡献用 `ctx.remote.$mount(contribution)` 挂载，每个 namespace 变成 `ctx.remote.<namespace>`（`asar:.../dsh-api-remotes/lib/types/client/index.js:34-46`；`remote.${namespace}` 的 key 规则见 `asar:.../dsh-api-gateway/lib/client.js:2040-2042`）。
- `remote.$on(event, listener)`（`:1647-1649`），例：`ctx.remote.$on("api-session/status", (sessionId, running) => ...)`（`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/client.js:180`）。
- 结论：**`remote.commands` 只有在 api-remotes 的贡献被挂载后才存在**。参考实现把它写进硬 `inject`（`MF_CLIENT:285`），并在 `MF_PKG:64-65` 里声明 `@deepseek-ai/dsh-api-gateway` + `@deepseek-ai/dsh-api-remotes` 为 bundle 前置。

### 7.4 `connection`

| 成员 | 形状 | 证据 |
| --- | --- | --- |
| `connection.rpc.call(channel, endpoint, payload, signal?)` | 见 §6.2 | `asar:.../dsh-client-connection/lib/client.js:1212` |
| `connection.rpc.open(channel, endpoint, payload, signal, uplink)` | 只在存在 worker-local stream 载体时出现；**只支持 `/api`** | `:1233-1237` |
| `connection.generation.getSnapshot()?.host.home` | 宿主事实 | `asar:.../dsh-api-gateway/lib/client.js:1629` |
| `connection.isLoopback` | boolean | `:1632` |
| `connection.start({ onConnected, onReconnectRequested })` / `reconnect()` | 连接生命周期 | `asar:.../dsh-api-gateway/lib/client.js:1606-1613`；README `asar:dsh/node_modules/@deepseek-ai/dsh-client-connection/README.md` |

参考实现只用了 `rpc.call`（`MF_CLIENT:339`），并做了「三项存在性判断」的防御（`MF_CLIENT:336-338`）。

### 7.5 `locale`

| 成员 | 形状 | 证据 |
| --- | --- | --- |
| `locale.register(ns, { zh, en })` | `=> () => void`（幂等 disposer） | `asar:.../dsh-client-locale/lib/client.js:1387-1413`；目录 `asar:.../dsh-cordis-client-runner/lib/client.js:1213-1224` |
| `locale.bind(ns)` | `(key, params?) => string`，每 ns 引用稳定 | `asar:.../dsh-client-locale/lib/client.js:1414-1422`；目录 `:1245-1262` |
| `locale.getSnapshot()` | `{ active, locales, revision }`（`LocaleSnapshot`） | `asar:.../dsh-cordis-client-runner/lib/client.js:1930-1931` |
| `locale.subscribe(fn)` | `=> () => void` | 目录 `:1186-1194` |
| `locale.setLocale(id)` / `addLanguage(input)` / `getLocale()` | 见目录 | 目录 `:1174-1212` |

服务 key 是 `locale` —— 实现里 `ctx.provide("locale", locale)`（`asar:.../dsh-client-locale/lib/client.js:1526`），尽管包名是 `@deepseek-ai/dsh-client-locale`。

### 7.6 `inputTriggers`

- **未在客户端服务目录中出现**（`SERVICE_API` 只覆盖 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces 八个 key，见 `asar:.../dsh-cordis-client-runner/lib/client.js:1125-1666`）。因此它的正式类型**未验证**。
- 参考实现通过 `ctx.inject(['inputTriggers'], scope => ...)` 拿到它，并**先做能力判断**：`if (!registry || typeof registry.registerSource !== 'function') return;`（`MF_CLIENT:1560-1561`）。
- 它实际调用的唯一成员是 `registerSource(source)`，source 的字段形状由参考实现给出（`MF_CLIENT:1563-1619`）：`trigger`(`'@'`)、`name`、(order)、`showGroupTitle`、`candidates(session, request) => Promise<rows>`、`onPick(pick)`、`codec`。
- 依赖它的包名：`@deepseek-ai/dsh-client-ui-input-trigger`（`MF_PKG:68`）。

### 7.7 `slots`

| 成员 | 形状 | 证据 |
| --- | --- | --- |
| `slots.inject(key, cb)` | 见 §3.1 | 目录 `asar:.../dsh-cordis-client-runner/lib/client.js:1384-1395` |
| `slots.register(options, component)` | 见 §3.2 | 目录 `:1367-1369`；实现 `asar:.../dsh-client-ui-renderer/lib/client.js:1788-1791` |
| `slots.registerFactory(options, component)` | 可复用组装体（本次任务不涉及） | 目录 `:1371-1381` |
| `slots.entries(key)` / `entriesOfSlot(key)` / `spec(key)` / `subscribe(key, fn)` / `getVersion(key)` / `snapshot(root)` / `onEntryError(fn)` | 只读检视面 | 实现 `asar:.../dsh-client-ui-renderer/lib/client.js:1517-1576` |

### 7.8 slot 组件实际收到的 props（标准 kit）

除 owner share 外，session scope 的标准 kit 固定包含（`asar:.../dsh-cordis-client-runner/lib/client.js:3031-3046` 的 slot 目录一致列出）：

```
useResource, useWorkspaces, usePanelInfo, useSessions, useSessionStatus,
useSessionRetainInfo, useChat, useConversation, useInput, inputActions,
useSession, sessionId, useProjection, useTrajectory
```

以及（条件性）：`t`（声明了 `locale` 时，renderer `:721-725`）、`useStore` + `actions`（声明了 `store` 时，`:727-731`）、`renderSlot` / `renderSlotChain` / `SessionProvider`（声明了 `children` 时，`:732-739`）、`renderFactorySlot`（`:719`）。

hook 名的生成规则是 `use` + 首字母大写（`standardHookPropName`，`asar:.../dsh-client-ui-slots/lib/index.js:7-9`）。`root` scope 只有 6 项（§3.5b）。

---

## 8. 样式

### 8.1 参考实现实际用到的 `--dsw-alias-*` 令牌

参考实现 A 把它们集中成一个 `TOKEN` 表，**每个都带惰性 fallback**（`MF_CLIENT:174-192`）：

```js
var TOKEN = {
  border:    'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
  borderSoft:'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
  surface:   'var(--dsw-alias-bg-overlay, #ffffff)',
  subtle:    'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
  fill:      'var(--dsw-alias-button-tool-bar-fill, rgba(127,127,127,0.10))',
  hover:     'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
  ink:       'var(--dsw-alias-label-primary, #1a1a1a)',
  inkSoft:   'var(--dsw-alias-label-secondary, #4a4a4a)',
  inkMuted:  'var(--dsw-alias-label-tertiary, #6b6b6b)',
  inkFaint:  'var(--dsw-alias-label-caption, #8a8a8a)',
  danger:    'var(--dsw-alias-state-error-primary, #c62828)',
  accent:    'var(--dsw-alias-brand-primary, #4c6ef5)',
  shadow:    '0 8px 24px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.18))',
};
```

13 个名字（去重后；`--dsw-alias-bg-mask-2` 在 `shadow` 里出现，源码扫描共命中 14 处）。其余参考实现用到的：

| 令牌 | 使用处 |
| --- | --- |
| `--dsw-alias-border-l4` | `TRAE`（与 `border-l2`、`interactive-bg-hover`、`label-primary`、`label-secondary` 同批，共 5 个 alias 令牌） |
| `--dsw-radius-xs` / `-sm` / `-md`、`--dsw-font-family` | `TRAE`（非 alias 前缀的通用令牌） |
| `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-button-primary-bg`、`--dsw-alias-button-primary-bg-hover`、`--dsw-alias-button-primary-fg`、`--dsw-alias-button-radius`、`--dsw-alias-button-height`、`--dsw-alias-state-danger` | `NL` / `NL` 的 `src/theme.js`、`src/page-css.js` |
| `--dsw-specific-sidebar-fill` | `NL`（`--dsw-specific-*` 是**另一族**，不是 alias） |

> ⚠️ `--dsw-alias-button-height`、`--dsw-alias-button-primary-bg`、`--dsw-alias-button-primary-fg`、`--dsw-alias-button-primary-bg-hover`、`--dsw-alias-button-radius`、`--dsw-alias-state-danger` 在 ui-theme 包中**未找到同名定义**。`NL` 是主题插件，它自己通过 `ctx.theme.overrideTokens(SOURCE, buildTokens(cfg))` **注入/覆盖**这些名字（`NL_SRC:62`），所以对普通插件不要假定它们存在——**未验证**。

### 8.2 可用令牌总表

`@deepseek-ai/dsh-client-ui-theme` 的客户端 bundle 里出现 **107 个** `--dsw-alias-*` 名字（去重，来源 `asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`，正则 `--dsw-alias-[a-z0-9-]+`）。常用的分组：

- 背景：`bg-base`、`bg-layer-1/2/3`、`bg-overlay`、`bg-mask-1/2/3`、`bg-mask-drop`、`bg-mask-photo`、`bg-skeleton`、`bg-multi-select`、`bg-module-platform`
- 文字：`label-primary`、`label-secondary`、`label-tertiary`、`label-caption`、`label-dimmed`、`label-primary-inverted`、`label-primary-dimmed`、`label-primary-foreground`、`label-primary-bluish`、`label-deep-diving`
- 边框：`border-l1`、`border-l2`、`border-l3`、`border-l4`、`border-l2-darkmode-thin`、`border-inverted`、`border-inverted2`
- 交互：`interactive-bg-hover`、`interactive-bg-active`、`interactive-bg-hover-accent`、`interactive-bg-hover-danger`、`interactive-bg-hover-solid`
- 按钮：`button-primary-fill`、`button-primary-hover`、`button-primary-dimmed`、`button-tool-bar-fill`、`button-tool-bar-hover`、`button-ghost-active-fill`、`button-elevated-fill`、`button-floating-fill`、`button-contrast-fill`、`button-info-fill`、`button-info-hover`
- 状态：`state-error-primary`、`state-error-secondary`、`state-success-primary/secondary/tertiary`、`state-warn-primary/secondary/tertiary`、`state-warn-label`、`state-business-primary/tertiary`、`state-idle-primary`
- 其它：`brand-primary`、`brand-text`、`link`、`scrollbar-*`、`toast-bg`、`toast-label`、`tooltip-bg`、`tooltip-key-bg`、`menu-group-header-fill`、`menu-icon`、`settings-card-fill`、`settings-card-stroke`、`code-diff-added/deleted`、`markdown-*`、`switch-thumb`、`turn-trigger-bg(-hover)`、`onboarding-*`、`file-diff-*`

**运行时现查**是最可靠的方式**（推荐而非可选）**：client inspect provider `Theme.listTokens` 返回当前主题的令牌名与明暗覆盖要求；`Slots.listSubTree` 返回活动 slot 树（用法见 §9.6）。本文的 107 个名字是从**构建产物**里扫出来的，可能与运行中的主题注册表有增删差异。

### 8.3 如何做到「主题无关」

参考实现的做法与理由（`MF_CLIENT:174-177`、`MF_DESIGN:412-414`）：

1. **只用 `--dsw-alias-*` 语义令牌，不写品牌色硬编码**。
2. **每个 `var(...)` 都带惰性 fallback**（第二个参数）。这样即使某个令牌在某个 composition/主题里不存在，表面依然可读，而不会变成透明或黑块。
3. **不要按明暗模式写分支**：令牌在明暗切换时自动折叠取值（`NL_SRC:57-58` 明确说明 `overrideTokens` 的层会这么做，因此无需监听 `theme/change`）。
4. **只覆盖「形状」而不是「颜色」**：字重、字号、圆角、间距可以写死；颜色一律走令牌。
5. 需要真正改主题时，用 `ctx.theme.overrideTokens(SOURCE, tokens)` 而不是给元素打内联色（`NL_SRC:62`）。
6. 注入自有 CSS 的两种真实写法：
   - `<style>` 标签 + `ctx.effect` 回收：`TRAE:451-459`（并给标签打 `tag.dataset.plugin = '...'`，见下）；
   - 内联 style 对象：参考实现 A 全程 `React.createElement('div', { style: {...} })`（`MF_CLIENT:1278-1291`）。
7. **样式标签的所有权约定**：模块系统在工厂物化时会**把所有未打 `data-plugin` 的 `<style>` 认领给当前插件**（`asar:.../dsh-client-modules/lib/client.js:492-498`，`claimStyles`）。因此自己的 `<style>` 最好显式写 `tag.dataset.plugin = '<own-id>'`（`TRAE:453`），HMR/卸载才能正确回收。
8. **不要用 `shell.overlay` 的条目去接管整屏**：那层是 click-through，条目必须自己 opt-in 指针事件（§3.5b）。

---

## 9. 坑与注意（参考实现里显式写下的东西）

按「版本适配 / 防御式判断 / 失败降级」归类。

### 9.1 版本适配

1. **`commands.execute` 的第三个业务参数**是 DSH 0.1.1 才加的 composer 图片参数，纯命令调用必须传 `[]`。`MF_CLIENT:435-437`（注释直接点名版本）。
2. **hero 阶段的判定随版本变**：新 shell 的 `SessionSnapshot` 带 `composerPhase`，旧 shell（0.1.2）没有。参考实现写了双分支：

```js
// MF_CLIENT:1198-1207
function isHeroPhase(session, blank) {
  if (!session) return false;
  if (session.composerPhase !== undefined) {
    return session.composerPhase === 'blank' && (session.openState === 'open' || blank === true);
  }
  return session.blank === true && !session.running && !session.promptAttempted
    && (blank === true || session.openState === 'open');
}
```

3. **`conversation.input.dock` 是「0.1.9 起、rc.6 声明」的座位**，`conversation.hero.workspaceExtras` 只在更新的上游存在。参考实现因此注册**三个候选座位**并自己实现座位选举（`extras` > `dock` > 兜底），保证新建会话页只出现一个入口（`MF_CLIENT:18-24`、`:146-172`、`MF_DESIGN:369-403`）。rc.2 里 `conversation.hero.workspaceExtras` **不存在**（§3.4）。
4. **`remote.commands.execute` 的返回值里 `value === undefined` 表示「没有命令匹配」**，参考实现把它翻译成「host plugin 没装吗？」而不是当成一般错误（`MF_CLIENT:443-444`）。

### 9.2 防御式判断（存在性/能力检查）

5. **`connection` 的能力三连判**，缺一就 reject 一个可读错误而不是抛 TypeError：

```js
// MF_CLIENT:336-338
if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
  return Promise.reject(new Error('multi-folder: the shared RPC channel (connection service) is unavailable'));
}
```

6. **`inputTriggers` 的能力判断**：`if (!registry || typeof registry.registerSource !== 'function') return;`（`MF_CLIENT:1560-1561`）。
7. **标准 kit 的 hook 可能缺席**：`DockChip` 对 `useSessions` / `useWorkspaces` 做 `typeof === 'function'` 判断，缺席时退化为 `selectNothing`（对 `undefined` 快照跑 selector），**目的是保持 hook 调用无条件、顺序稳定**（`MF_CLIENT:1249-1253`；`selectNothing` 在 `:142-144`）。
8. **服务本身可能缺席**：读会话/工作区快照前都判 `sessions && sessions.list`（`MF_CLIENT:1225`、`:1228`、`:1340`、`:1343`）。
9. **DOM 可能不存在**（测试环境）：`document` 探测包在 `try/catch` 里、并判 `typeof document !== 'undefined'`（`MF_CLIENT:1317-1319`、`:1348`）。
10. **React 可能拿不到**：`try { require('react') } catch` + `typeof React.createElement === 'function'`，没有 React 就跳过设置页注册（`NL:15-23`、`NL_SRC:150-153`）。
11. **依赖的 UI primitives 可能缺失**：逐一检查必需符号，缺任何一个就**放弃遮蔽 shipped 控件**（否则会把一个能用的控件换成渲染不出来的），只打 `console.warn`（`TRAE:433-449`）。
12. **`localStorage` 可能不可写**（隐私模式）：包 `try/catch` + `console.warn`（`NL_SRC:139-144`）。
13. **slot 注册失败要包 `try/catch`**，避免整个插件因一个表面挂掉（`NL_SRC:154-173`）。

### 9.3 失败降级策略

14. **读操作失败 = 空集，不是错误**：`@` 补全的发现失败一律 `return []`；注释写明「Autocomplete is advisory: a discovery failure is an empty group, never a broken composer and never a failed send.」（`MF_CLIENT:1587-1590`；决策表 `MF_DESIGN:259`）。
15. **变更失败后回读**：`mutate` 在失败时 `patch({ error })` 并**立刻 `refresh(sessionId)`**，让 UI 回到宿主真实状态（`MF_CLIENT:485-488`）。
16. **结构化状态走文本行里的标记**：宿主命令结果文本里带一行 `[MF:JSON] {...}`，客户端用正则解析；解析不到就退回「无结构化状态」而不是报错：

```js
// MF_CLIENT:135-140
function parseJsonLine(text) {
  if (typeof text !== 'string') return null;
  var m = /\[MF:JSON\]\s*(\{.*\})\s*$/s.exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}
```

17. **面板只解析 `result.text`**，且 `result.kind === 'error'` 时抛 `result.text`（`MF_CLIENT:446-449`）。
18. **跨模式折叠**：新建会话页的面板（workspace 模式）在第一条消息创建会话后，靠 `useEffect([sessionId])` 折回 session 模式（`MF_CLIENT:639-647`；`MF_DESIGN:362-365`）。
19. **两级缓存**：`sessionCache`（按 sessionId，避免每次开面板都跑一次命令、往会话里落行）与 `workspaceCache`（按规范化工作区路径，走无会话通道因此不产生会话记录）（`MF_CLIENT:124-133`、`:350-357`；`MF_DESIGN:366-368`）。
20. **座位选举是插件自己的责任**：框架只会把**不同插件**在同一个 `list` 槽位上排好，不会阻止**一个插件**同时占多个备选座位。参考实现用「claim 令牌 + 只渲染最佳 claim」解决（`MF_CLIENT:55-71`、`:146-172`）。
21. **不要绝对定位 dock 行**：dock outlet 是 `display:contents`，绝对定位会静默压到邻座（`MF_CLIENT:61-64`、`:1237-1241`）。
22. **`id` 要用自己的**：新 id 与既有条目并列；复用既有 id 会进同一个 cell。`priority` 相同还会抛错（`MF_CLIENT:57-64` 与 §3.2）。
23. **`inject` 返回的对象里不要包含 `t`**：与 locale seat 撞名会触发重复 prop 错误（`TRAE:490-491`，renderer 的 `assertNoPropOverlap` 也在 `asar:.../dsh-client-ui-renderer/lib/client.js:922-923`）。

### 9.4 调试与验证手段

24. **不要试图用 `ctx.render`/`ctx.slots.renderSlot` 直接渲染子槽位**：ctx 级 `renderSlot` 只接受 `'root'`，其余会抛 `ctx-level renderSlot only renders 'root'`（`asar:.../dsh-client-ui-renderer/lib/client.js:1506-1511`）。
25. **注册进未声明的 slot 会抛错**，错误信息是 `slot "..." is not declared (a parent entry's children table must declare it)`（`asar:.../dsh-client-ui-slots/lib/index.js:164-165`）。所以对自己不确定的 slot，用 `slots.inject` 而不是 `slots.register`。
26. **entry 崩溃是被隔离的**：单个注册者抛错只会让它自己的 `data-slot-error` 出现（`asar:.../dsh-client-ui-renderer/lib/client.js:611-625`），但 **assembly 错误（缺 provider/命名空间）会重新抛出**——「a miswired shell must fail loud, not degrade into fallbacks」（`:601-609`）。

### 9.5 本次写作中遇到的坑（供后续复核）

27. `asar-grep.mjs` 会跳过「含 NUL 且不含 `require` 字面量」的条目（脚本 `:49`），所以对压缩产物的检索要用明确的 path 过滤逐个确认。
28. `asar.mjs cat` 的 `outDir` 会保留 asar 内的完整目录前缀（`dsh/node_modules/...`），导出目录不是扁平结构。

### 9.6 用 live inspect 验证自己的插件

DSH 自带只读检视 provider（`cordis_inspect_list` / `cordis_inspect_query`），可直接查运行中的 GUI：

| platform / provider / method | 用途 |
| --- | --- |
| `client` / `Slots` / `listSubTree` | 传 `{ root: "<slot key>" }` 得到该 slot 的 kind/scope/occupants/catalog；省略 root 得到整棵 slot+factory 树 |
| `client` / `Theme` / `listTokens` | 当前主题的令牌名与明暗覆盖要求 |
| `client` / `Service` / `listService` | 传 `{ service: "sessions" }` 等得到该服务的精确契约 |
| `client` / `Event` / `listEvents` | 客户端事件（`connection/reset`、`locale/change`、`slots/changed`、`theme/change`） |

> **本次未能实测**：写作时对 `client` / `Slots` / `listSubTree` 的查询返回 `Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then retry.`。因此 §3.5 的 slot 契约全部来自 asar 中的静态目录（`asar:.../dsh-cordis-client-runner/lib/client.js:2365-6100`），**未经 live 页面复核**，建议插件作者在写完后用上表复核一遍。

---

## 附：最小可用模板

```js
// lib/client.js —— 手写 client-modules factory bundle，无构建步骤
window.__ModuleLoader__.load({
  id: 'my-plugin',                       // 必须 == package.json 的 "name"
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');        // 平台种子，永远可解析
    var h = React.createElement;

    var NS = 'my-plugin';
    var zh = { 'label': '我的插件' };
    var en = { 'label': 'My plugin' };

    var name = 'my-plugin';
    var inject = ['slots', 'locale', 'sessions', 'connection'];
    // 只声明真正必须的服务：slots / locale。
    // sessions / connection 若只是可选增强，改用 ctx.inject([...], cb)。

    function apply(ctx) {
      var slots = ctx.slots, locale = ctx.locale;

      ctx.effect(function () {
        return locale.register(NS, { zh: zh, en: en });
      }, 'my-plugin: dictionaries');

      var t = locale.bind(NS);

      slots.inject('conversation.session.header.actions', function () {
        return slots.register(
          { name: 'conversation.session.header.actions', id: 'my-plugin',
            order: 200, label: function () { return t('label'); }, locale: NS },
          function MyButton(props) {         // props: sessionId + t + useSessions + ...
            return h('button', { type: 'button', onClick: function () { /* ... */ } }, props.t('label'));
          },
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
```

配套 `package.json`（对照 `MF_PKG:41-71`）：

```jsonc
{
  "name": "my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./client": { "default": "./lib/client.js" } },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

---

## 未验证清单（不要当成事实）

1. `dsh.client.immediately` 在**浏览器侧**的具体行为（宿主的解析已确认，浏览器消费分支未读到）。
2. `WorkspaceSnapshot` 的完整字段集合（只确认 `.items` 与 `.archivedSessionIds`）。
3. `inputTriggers` 的正式类型与全部成员（它不在客户端服务目录里；`registerSource` 之外都是空白）。
4. `source` 字段可能被 `dsh.client.external` 之外的机制影响的具体边界；`react/jsx-runtime` 是否需要构建期转换（种子表里有，但没有参考实现用它）。
5. §3.5 三个 slot 的 owner/渲染契约**未经 live 页面复核**（client inspect 查询超时）。
6. `--dsw-alias-button-height`、`--dsw-alias-button-primary-bg`、`--dsw-alias-button-primary-fg`、`--dsw-alias-button-primary-bg-hover`、`--dsw-alias-button-radius`、`--dsw-alias-state-danger` 不在 ui-theme bundle 的 107 个名字里；`NL` 是自己覆盖出来的。
7. `MF_PKG:41-57` 的 `dsh.compatibility.dshReleases` 里没有 `0.2.0-rc.2` 这一条（最高到 `0.2.1-alpha.2`）——本机实际跑的是 0.2.0-rc.2，说明该表的语义（是否严格门禁）**未验证**。
