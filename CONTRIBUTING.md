# 贡献指南

感谢参与 `dsh-project-hub`。本仓库是 DeepSeek Harness（DSH）的第三方插件，遵循以下约定。

## 硬约束（请不要绕过）

1. **不改 DSH 核心**：不修改 `@deepseek-ai/*` 包、不写用户的 profile `cordis.patch.yml`、不动会话文件。
2. **零构建**：`lib/*.js` 是 ESM 纯 JS；`client/client.js` 是手写 `__ModuleLoader__` 单文件 bundle。不要引入打包器、TypeScript 或构建产物。
3. **客户端依赖最小化**：只允许 `require("react")`；不得 import 任何 `@deepseek-ai/dsh-client-*` 包。
4. **主题 token**：UI 只用 `--dsw-alias-*` CSS 变量，不硬编码颜色。
5. **接口先改文档**：host ↔ client 的 HTTP 契约以 [docs/接口约定.md](docs/接口约定.md) 为唯一来源，先改文档再改代码。

## 开发环境

- Node.js ≥ 20（本机验证用 22 / 26）；
- DSH 0.2.x（desktop profile 已实测 0.2.2-rc.1）；
- 无需任何构建步骤，改动即生效。

## 自检（提交前必须全绿）

```powershell
node --check lib/state.js lib/index.js client/client.js scripts/test-host.mjs
node scripts/test-host.mjs                                  # 宿主契约
node scripts/test-client.mjs client/client.js               # bundle 冒烟
node scripts/test-client-interaction.mjs client/client.js   # 面板交互
# 真实 React 18 + jsdom 离屏渲染（依赖装到临时目录）
mkdir %TEMP%\ph-render; cd %TEMP%\ph-render; npm i react@18.3.1 react-dom@18.3.1 jsdom@24
$env:PH_RENDER_MODULES="$env:TEMP\ph-render"; node scripts/test-client-dom.mjs client/client.js
```

改动客户端后，重新加载插件并刷新页面再手工确认：

```text
plugin_manager(action="set_plugin", target="include:dsh-project-hub", enabled=false)
plugin_manager(action="set_plugin", target="include:dsh-project-hub", enabled=true)
```

## 提交与 PR

- 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:` / `fix:` / `docs:` / `test:` / `chore:` / `refactor:`；
- 一个 PR 只做一件事，附带：改动说明、自检输出（贴结果）、必要时更新 `docs/验收记录.md` 的证据；
- UI 改动请附截图或 `GET /dsh-project-hub/api/health` 的 `clientEvents.last` 证据；
- 新增依赖前先确认「零构建 + 只用 react」是否仍然成立。

## 目录约定

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host cordis 插件：路由、状态、记忆作用域 |
| `lib/state.js` | 状态存储与规则发现纯函数 |
| `client/client.js` | 手写客户端 bundle：面板 + 侧栏入口 |
| `docs/` | 设计结论、接口契约、验收记录、截图 |
| `scripts/` | 自检脚本与只读 asar 提取工具 |

## 报告问题

- 普通 bug / 功能建议：GitHub Issues；
- 安全相关问题：不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。
