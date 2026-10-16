# dsh-market-console —— DSH 插件市场控制台

在 DSH 的「**设置 → 插件**」分区里，加一个能**搜索、安装、启停、卸载**第三方插件的标签页。

- 目标客户端：`DeepSeek Harness 0.2.0-rc.1`（desktop profile）
- 一个包，两个半边：Host 半边是空的（只为占一条 Loader 行），全部逻辑在 Client 半边
- 所有真实操作都走官方 `@deepseek-ai/dsh-plugin-manager` 的 Typert 远程接口
- 本插件自身**不会**出现在被管理列表或搜索结果里

---

## 1. 目录结构

```
dsh-market-console/
├── package.json          # 声明 dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 挂载声明（自己插入自己）
└── lib/
    ├── index.js          # Host 半边：空 apply()，只为占一条 Loader 行
    └── client.js         # Client 半边：设置标签页 + 全部 UI
```

---

## 2. 安装

### 2.1 解析目标 profile（**绝不写死 `web`**）

```
profile = DSH_DESKTOP_PROFILE  →  DSH_PROFILE  →  web
```

实测：`DSH_PROFILE=desktop`，`DSH_PROFILE_DIR=%USERPROFILE%\.dsh\profiles\desktop`。

### 2.2 一键脚本（推荐）

```powershell
pwsh -File scripts\install.ps1     # 或者直接双击 scripts\install.cmd
```

脚本按 §2.1 的规则解析 profile，幂等地做完下面三步（重复跑不会重复追加），
并在改动前把 `package.json` 与 `cordis.patch.yml` 备份成 `*.bak-<时间戳>`。

卸载：`scripts\uninstall.cmd`（支持 `-WhatIf` 预览、`-KeepPackage` 只摘挂载）。

> **两个已踩过的环境坑：**
> 1. 本机执行策略禁止直接运行 `.ps1`，所以附带的 `.cmd` 包装器带了
>    `-ExecutionPolicy Bypass`，双击即可。
> 2. 脚本文件必须存成**带 BOM 的 UTF-8** —— PowerShell 5.1 对无 BOM 的文件按 ANSI
>    解析，中文注释会直接导致语法错误。而**写出去的数据文件必须无 BOM**，
>    否则 DSH 的 `JSON.parse` 会炸。仓库里的文件两种情况都已处理对。

### 2.3 手工三步

```powershell
$DSH_HOME   = "$env:USERPROFILE\.dsh"
$SRC        = "<本包所在目录>"
$PROFILE    = "desktop"                       # 来自上面的解析

# ① 放进 Node 解析路径（desktop 没有自己的 node_modules，靠父层解析）
New-Item -ItemType Junction -Path "$DSH_HOME\profiles\node_modules\dsh-market-console" -Target $SRC

# ② 在 profile 的 dependencies 里登记（满足「实例只认 package.json dependencies」）
#    编辑 $DSH_HOME\profiles\$PROFILE\package.json → dependencies 加：
#      "dsh-market-console": "0.1.0"

# ③ 在 profile 的挂载文件末尾追加 insert 行
#    编辑 $DSH_HOME\profiles\$PROFILE\cordis.patch.yml → 末尾追加：
#      - insert:
#          - id: market-console
#            name: dsh-market-console
```

### 2.4 重启客户端（或者先试只刷新页面）

`cordis.patch.yml` 是启动时读的，所以**刷新页面不够**——但前提是 profile 没启用 HMR。

`@deepseek-ai/dsh-hmr` 会监听 profile manifest 和两份用户 patch；启用 HMR 时，
改完 patch 会触发**热重载**：重新组合 Loader 图，浏览器跟随更新，**不需要重启**。

本机实测（0.2.0-rc.1 / desktop）：改完 patch 后未重启，`/plugins` 路由已经能提供
本插件的 bundle，内容与源文件逐字节一致。判断办法（无需认证）：

```powershell
# rev = sha1("plugin-artifact" + "\0" + 各字段长度前缀式拼接) 取前 12 位
# 字段依次是 String(mtimeMs), String(ctimeMs), String(size)
# 命中则 HTTP 200，否则 404
```

**首次安装与卸载仍建议重启**，因为这两个动作还会改动 profile 的 `package.json`。

---

## 3. 两条必须记住的契约（踩过的坑）

### 3.1 `dsh.client.inject` 填的是**包名**，不是 cordis 服务名

`package.json` 里：

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-modules",
      "@deepseek-ai/dsh-client-ui-settings"
    ]
  }
}
```

`@deepseek-ai/dsh-client-modules` 的 `parseDshClient()` 只校验这是 `string[]`，但组合阶段会把每一项当作**模块图的排序边**（"让动态提供方先于其消费方加载"）。填 `"slots"` / `"locale"` 这类服务名，图里找不到对应 row。

**服务名写在另一个地方** —— Client 半边的 `exports.inject`：

```js
const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'modules'];
```

两者同名不同义，别搞混。官方 69 个客户端包的 `dsh.client.inject` 全是包名。

### 3.2 Client 半边的组件 props 来自 `inject` 的**展开**

`ctx.slots.register({ ..., inject: injected }, Component)` 里，`injected()` 的返回值会被
**展开成组件的 props**：

```js
// 官方 ui-settings-plugin-inventory 的写法
function PluginInventorySettingsTab({ list, presetName, resolveText, t, useClientSync, retryClient }) { ... }

// 于是本插件也直接解构
function MarketConsoleTab({ t, data, resolveText, availableRegistries }) { ... }
```

**不要**写成 `function Tab(props) { const x = props.injected() }` —— 那样 `t` 是
`undefined`，`t('...')` 直接抛 TypeError，标签页白屏。

另外 `hooks: { clientSync }` 会被系统转成 `useClientSync` 这样的 **hook prop**；普通字段原样传递。

---

## 4. 功能

### 已安装视图

- 插件条目（`listPlugins`）与组合包（`listBundles`）分组展示
- 每条显示：标题、模块名、版本、描述、启用状态、fiber 阶段（等待/加载/运行中/启动失败/卸载中）
- **插件条目**：开关直接调 `setPluginEnabled(entryId, enabled)`
- **组合包**：开关调 `setBundleEnabled(name, enabled)`；卸载调 `removeBundle(name)`，**二次确认**后才执行
- 本地过滤框（名称 / 模块 / 条目 id）

### 官方标记与筛选

- **「官方」徽章** —— 标题旁边标出 DSH 自带的插件。判定规则（`isOfficialPackage`）：
  - `@deepseek-ai/*` —— DSH 自家发布的包；
  - `cordis:*` —— cordis 框架内置插件，**协议限定名**，磁盘上没有对应目录，只能按前缀认；
  - 第三方（`dsh-whale-widget`、本插件自己）不带徽章。
- **「隐藏官方」开关** —— 已安装视图工具栏里。打开后列表只剩自己装的第三方插件，
  下方给出「已隐藏 N 个官方插件」，分组计数变成 `已显示 / 总数`。
- **偏好持久化** —— 开关状态写进 `localStorage`（`dsh-market-console/prefs`），重开不用再点一次。
- **搜索视图同样带官方徽章，但不受这个开关影响** —— 发现新插件时把官方包一并藏掉没有意义。

### 插件备注

每张卡片（插件条目与组合包）底下都有一条备注行：

- **内置说明** —— **196 条**一句话中文描述，覆盖**全部 loader 条目**（脚本核过零遗漏）：
  - **客户端包**（67 个）逐条人工精简，从各包 `README.zh.md` 的 `description` frontmatter 出发，
    把「面向用户与维护者的 web GUI 客户端模块系统说明：宿主侧组合启动图并提供插件 bundle…」
    压成「客户端模块系统：扫描已启用的插件，把它们的浏览器代码组合起来送进页面。」
  - **host 侧插件**（128 个）批量提取后按规则收紧：剥掉「面向 XXX 的 YYY 说明，用于选择、配置或排查…」
    这类模板腔，只留主干。
  - **cordis 框架内置插件**（`cordis:include` / `cordis:group` / `cordis:timer` / `cordis:loader`）——
    它们是协议限定名，不对应磁盘上的包，只能手写。
  - 外加鲸鱼挂件与本插件自身。
  - 数据是代码里的 `BUILTIN_NOTES`，key 用 Loader 条目的 moduleName。
- **自己改** —— 点「编辑」写自己的备注，保存立即生效，标注为「我的备注」。
- **恢复内置** —— 改过的备注可一键恢复成内置说明。实现上是**直接删键**而不是存空值，
  这样以后内置文案改版还能重新显示出来。
- **存储** —— `localStorage` 的 `dsh-market-console/notes`，纯本机界面偏好：
  不碰插件本身、不碰 profile、不产生任何 Host 侧写入。
- **优先级** —— 用户备注 > 内置说明 > 提示添加。内置文案改版不会覆盖你写的东西。

### 发现视图（npm 搜索）

- 客户端直连 npm registry 的 `/-/v1/search`（该端点返回 `Access-Control-Allow-Origin: *`，无需 Host 代理）
- 关键词：`keywords:dsh-plugin <你的词>`
- registry 可切换，兜底顺序：`registry.npmjs.org` → `registry.npmmirror.com`，失败自动换下一个
- 400ms 防抖
- 已安装的包标记「已安装」，不显示安装按钮

### 安装链路（M2）

```
inspect(spec)  →  人话化 problem  →  installBundle(spec, { requestId, registry, approvedBuilds })
                →  waitForInstall(requestId)  →  application 处理
```

- `refused` 的 7 种 `problem` 全部映射成中文人话
- `restart-required` 会**显式提示重启**（并说明刷新页面无效）
- 构建脚本待批准（`packageResult.pendingBuilds`）→ 列出准确包名 → 用户确认 → 带 `approvedBuilds` 重试
- 安装中可 `cancelInstall(requestId)`
- 版本门控拒绝时列出不兼容的依赖

### 写操作错误码（12 种）

`management-required` · `unaddressable` · `unknown-plugin` · `invalid-spec` · `ambiguous-install` ·
`not-bundle` · `not-removable` · `stop-profile` · `bundle-in-use` · `stale-approval` ·
`incompatible-version` · `operation-error` —— 全部有中文映射。

---

## 5. 自身排除（C4）

`SELF_PACKAGE = 'dsh-market-console'`，并且下列模块在列表和搜索里都标记为**只读**：

| 类别 | 模块 |
|---|---|
| 自身 | `dsh-market-console` |
| 其他市场 | `dsh-unified-market` · `dsh-plugin-shop` |
| 插件管理基础设施 | `@deepseek-ai/dsh-plugin-manager` · `dsh-host-plugin-inventory` · `dsh-client-ui-plugin-manager` · `dsh-client-ui-settings-plugin` · `dsh-api-remotes` · `dsh-client-modules` |
| DSH 运行底座 | `@deepseek-ai/dsh-base` · `@deepseek-ai/dsh-web-app` · `@deepseek-ai/cordis` |

只读项的开关与卸载按钮是禁用的。判定用**段边界匹配**，所以 `dsh-baseball` 不会被误判成 `dsh-base`。

---

## 6. 故障排查

### 界面里没有「插件市场」标签页

按顺序查：

1. **挂载行在不在**

   ```powershell
   Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Pattern "market-console"
   ```

   没有 → 补上 §2.2 的第 ③ 步。DSH 大版本更新时可能重写这个文件（鲸鱼插件中过这招）。

2. **包在不在 Node 解析路径上**

   ```powershell
   Test-Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-market-console\lib\client.js"
   ```

3. **重启了没有** —— `cordis.patch.yml` 只在启动时读取。

4. **看 Host 启动日志**里有没有 `client-modules: ... failed to compose` 或
   `client bundle not found` / `declares dsh.client but exports no "./client" bundle`。

### 标签页出现了但一片空白

多半是 Client 半边抛异常。在 DSH 窗口按 `Ctrl+Shift+I` 打开开发者工具看 Console。
最常见的是 §3.2 的 props 契约问题。

### 装完没反应

`application: 'restart-required'` —— 需要重启客户端。UI 里会明确提示。

### 搜索搜不到东西

registry 不可达。UI 里换 registry，或检查该 registry 是否支持 `/-/v1/search` 端点。

---

## 7. 卸载

1. 从 profile 的 `cordis.patch.yml` 删掉那个 `insert` 块
2. 从 profile 的 `package.json` 的 `dependencies` 删掉 `dsh-market-console`
3. 删掉 `profiles/node_modules/dsh-market-console` 链接
4. 重启客户端

---

## 8. 自检与诊断

`scripts/diagnose.cjs` 一条命令走完「静态安装 → host 运行实例」全链路，逐项给结论和修复建议：

```powershell
node scripts\diagnose.cjs              # 全量
node scripts\diagnose.cjs --offline    # 只做不依赖运行实例的检查
node scripts\diagnose.cjs --url http://127.0.0.1:19387
```

它检查四组内容：

1. **C1 / C3** — profile 按 `DSH_DESKTOP_PROFILE → DSH_PROFILE → DSH_PROFILE_DIR → web` 解析，包在 Node 解析路径上
2. **包清单** — `package.json` 可解析、`dsh.client.platform === 'web'`、`exports["./client"]` 指向真实文件
3. **挂载登记** — profile 的 `dependencies` 与 `cordis.patch.yml` 挂载行
4. **运行实例**（不需要认证，`/plugins` 与 `/plugins/events` 都是公开的）
   - HMR 的 SSE 端点读实时组合图，确认 row 在里面、编入了 batch
   - 复刻 `artifactRevision`（`sha1("plugin-artifact\0" + …)` 取前 12 位）算 rev，与图里的比对
   - 真实取一次 bundle，核对字节
   - **元数据缓存检测**：图里的 `inject` 若与 `package.json` 对不上，说明 `dsh-client-modules` 缓存了声明（见下）

> 最后那条缓存检测是踩出来的：`dsh-client-modules` 把 `dsh.client` 声明**按 Loader specifier 缓存**。
> 单纯改 `package.json` 不会热生效 —— 但只要 `lib/client.js` 有变化，`dsh-client-hmr` 的 bundle 监视
> 就会调 `clientModules.rebuilt()`，重新组合时**顺带重读** `package.json`。所以「改完 `package.json`
> 再 touch 一下 `client.js`」就能免重启生效（实测：改 client.js 后图中 inject 立刻与 package.json 对齐）。
>
> 两者别搞混——`package.json` 的 `dsh.client.inject` 是模块加载顺序边（包名），
> `client.js` 的 `exports.inject` 才是 cordis 服务依赖（服务名），后者才是真正门控插件挂载的那个。

## 9. 离线测试

历史离线测试（模块契约/渲染/C4 等 86 项、装机完整性 C1–C6 53 项、安装/卸载脚本闭环 29 项）当时放在开发机的临时目录里，**未随本仓库发布**。现在可复跑的自检入口是上一节的 `scripts/diagnose.cjs`。

---

## 10. 许可

MIT
