# 项目规则（AGENTS.md）

本仓库是 **DeepSeek Harness（DSH）插件 `dsh-project-hub`（项目工作台）** 的源码。

## 改代码前先读

- `docs/设计结论.md` —— 已确认的设计决策与边界（不改核心、不劫持数据）。
- `docs/接口约定.md` —— host 与 client 之间唯一的 HTTP 契约，改动必须先改文档再改代码。

## 约束

- 零构建：`lib/*.js` 是 ESM 纯 JS；`client/client.js` 是手写 `__ModuleLoader__` 单文件 bundle，**不要**引入打包器或 TS。
- 客户端只能 `require("react")`；禁止 import 任何 `@deepseek-ai/dsh-client-*` 包。
- 不写用户的 profile `cordis.patch.yml`、不动会话文件、不改 DSH 核心包。
- UI 只用 `--dsw-alias-*` 主题 token，不硬编码颜色。
- 改完必须跑自检并贴结果：
  ```powershell
  node scripts/test-host.mjs
  node scripts/test-client.mjs client/client.js
  node scripts/test-client-interaction.mjs client/client.js
  ```
- 客户端改动后需要 `plugin_manager(set_plugin, target="include:dsh-project-hub", enabled=false→true)` 重载插件、再刷新页面，才会下发新 bundle。
- 运行期自检：`GET http://127.0.0.1:14215/dsh-project-hub/api/health`。

## 提交前

- `node --check` 全部通过，三个测试脚本全绿；
- 更新 `docs/验收记录.md` 对应行的证据。
