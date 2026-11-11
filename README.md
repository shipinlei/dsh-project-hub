# dsh-project-hub（项目工作台）

DeepSeek Harness（DSH）插件：把「项目」作为组织会话的单位 —— 一个项目 = 一个工作区目录，项目内所有会话共享记忆与设定。

> 设计决策见 [docs/设计结论.md](docs/设计结论.md)，宿主 ↔ 客户端接口契约见 [docs/接口约定.md](docs/接口约定.md)。

## 它解决什么

DSH 原生已经能按工作区（workspace）分组显示会话，但：

- 记忆是**全局一份**，所有项目混在一起；
- 模型 / 推理强度 / preset 是 profile 级，换项目不会换；
- 没有一个「项目工作台」入口，新建会话要自己选目录、重复交代项目约定。

本插件补这三块：**项目工作台视图 + 项目级默认设置 + 项目记忆作用域**，规则沿用官方 `AGENTS.md` 机制。

## 功能

侧栏新增「项目」入口，打开后是一个项目工作台：

- 项目卡片：名称、路径（点击复制）、会话数、最近活跃、项目描述、默认 preset / 模型 / 推理强度徽标；
- 展开会话列表：按最近活动倒序，点击直接打开该会话；
- 「新建会话」：在项目目录里开新会话，并套用该项目的默认 preset / 模型 / 推理强度（创建后自动 `selectModel` 并跳转）；
- 「设置」：编辑项目描述与默认设置（存 `<profile>/.dsh-project-hub/state.json`，键 = workspaceId）；
- 「项目规则」：按官方发现顺序预览 `AGENTS.md` / `CLAUDE.md`（全局 → 项目根，含 `.local` 叠加），不读不存在的文件；
- 记忆状态条：显示当前 Mnemon 记忆作用域；未隔离时一键切换为「按工作区隔离」（`storageScope=workspaces`，`runtimeUserScope=global`）；
- 侧栏会话排列：插件启动时把侧栏切到官方「按项目（工作区）」分组，组内按最近更新时间倒序（即项目内按时间排列）；若装了 Claude 风格皮肤，会先关掉它的「日期视图」（今天/昨天/星期几分段）再切分组。面板「侧栏会话排列」里可点「不干预」关闭自动切换（偏好存本插件 localStorage，默认开）。

## 边界（刻意不做）

- 不替换原生侧栏 / 会话列表（只新增一个顶层面板与侧栏入口）；
- 不劫持会话数据、不改会话文件格式；
- 不支持把会话移动到另一个项目（平台无此接口，cwd 创建后不可变）；
- 不做内置编辑器（只读预览 + 打开文件编辑）；
- 权限模式不纳入项目级设定（自动提升权限有安全含义）。

## 安装（本机 desktop profile）

官方安装方式是 `plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径：

```text
plugin_manager(action="install_bundle", target="D:\projects\dsh插件\项目组开发插件")
```

它等价于 CLI 的本地链接安装（本机安装后 `dsh.profile.bundles` 自动追加 `dsh-project-hub`）：

```powershell
dsh plugin --profile desktop add "link:D:\projects\dsh插件\项目组开发插件"
```

安装后宿主会经 HMR 重组并热加载 host 侧；**客户端面板需要刷新一次 Web GUI 页面**才出现（client 插件在页面启动时加载）。

## 记忆作用域（已切换为按项目隔离，可一键回滚）

面板顶部的记忆状态条可以一键切换；底层走官方设置服务：
`ctx.settings.mutate('mnemon', [{op:'set', path:['storageScope'], value:'workspaces'}, {op:'set', path:['runtimeUserScope'], value:'global'}], revision)`，
由官方 config editor 持久化到 profile 补丁层（`- id: mnemon`），原地生效、无需重启。

本机当前状态：**已切换**（`storageScope = workspaces`、`runtimeUserScope = global`，USER.md 保持全局）。

验证方式（免登录）：

```powershell
curl http://127.0.0.1:14215/dsh-project-hub/api/health
# → memory.storageScope = workspaces / projectScoped = true
# → client.registered = true（客户端 bundle 已被 client-modules 收录）
```

回滚：面板点「改回全局共享」，或删除 profile `cordis.patch.yml` 里的 `- id: mnemon` 行，
或用 `docs/backup/profile-cordis.patch.yml.*` 覆盖。切换前的记忆数据备份在
`C:\Users\Administrator\.dsh\backups\mnemon-<时间戳>\`。

## 开发

- 零构建：`lib/index.js`（host，ESM 纯 JS）、`client/client.js`（手写 `__ModuleLoader__` 单文件 bundle）。
- 自检：
  ```powershell
  node --check lib/state.js lib/index.js client/client.js scripts/test-host.mjs
  node scripts/test-host.mjs                              # 16 项宿主契约
  node scripts/test-client.mjs client/client.js           # bundle 加载/注册冒烟
  node scripts/test-client-interaction.mjs client/client.js  # 面板交互全链路
  # 真实 React 18 + jsdom 离屏渲染（依赖按脚本头注释装到临时目录）
  $env:PH_RENDER_MODULES="$env:TEMP\ph-render"; node scripts/test-client-dom.mjs client/client.js
  ```
- 运行期健康检查（免登录，仅回环）：`GET /dsh-project-hub/api/health`
  —— 含 `client.registered` / `client.rev`、`memory.storageScope`、`profileSource`、`clientEvents.last`。
  客户端 bundle 的实际下发地址是 `GET /plugins/??dsh-project-hub/client.js&rev=<rev>`。
- 渲染器自检：面板加载成功后客户端会 `POST /client-report`（mounted / panel-view），
  刷新页面后 `/health.clientEvents.last` 就能确认"渲染器真的加载了面板、真实数据条数"，无需人工描述。
- 重载 host 侧代码：`plugin_manager(set_plugin, target="include:dsh-project-hub", enabled=false)` 再 `true`（热重载），或重启应用。
- 客户端代码改动后：重载插件（刷新 clientModules 缓存）→ 页面刷新；改动过 client 文件后必须重新 toggle 一次才会下发新 bundle。

## 目录结构

```
package.json          # 插件清单（dsh.bundle.patch / dsh.client / engines.dsh / icon / locale）
cordis.patch.yml      # bundle 层：把插件插入加载器
lib/index.js          # host 侧 cordis 插件：状态存储 + HTTP 路由 + 记忆作用域
lib/state.js          # 状态存储与规则发现（纯函数，可单测）
client/client.js      # Web 客户端 bundle：项目工作台面板
locale/{zh,en}.json   # 插件元数据（插件管理器展示用）
icon.svg              # 插件图标
docs/                 # 设计结论、接口约定、调研参考
scripts/              # 自检脚本（test-host.mjs、asar.mjs）
```
