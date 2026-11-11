# 安全策略

## 支持范围

| 版本 | 支持 |
|---|---|
| 0.1.x | ✅ |
| < 0.1.0 | ❌ |

## 报告漏洞

**请不要在公开 Issue 里报告安全问题。**

请通过 GitHub 的私密漏洞报告（仓库 → Security → Advisories → "Report a vulnerability"）提交，并尽量包含：

- 受影响版本与 DSH 版本；
- 复现步骤或最小示例；
- 影响面（是否能读写文件、是否泄露记忆/会话数据、是否需要用户交互）。

## 安全模型与边界

- DSH 插件运行在**宿主进程内**，拥有完整 Node.js 权限；本插件只做三件事：读写 `<profile>/.dsh-project-hub/state.json`、注册 7 条 HTTP 路由、读取 `AGENTS.md`/`CLAUDE.md` 预览。除此之外不写用户文件。
- `/dsh-project-hub/api/health` 仅限回环（127.0.0.1/::1）；其余路由走宿主 `connection.requestRejection` 鉴权网关；desktop profile 下按官方 `dshmarket` 的做法跳过浏览器凭证校验（页面来自 `dsh-app://`，本就没有浏览器凭证）。
- 插件不改 DSH 核心、不写会话文件、不修改用户仓库。
- 记忆作用域切换（`storageScope=workspaces`）通过官方设置服务完成，可一键回滚；切换前建议自行备份 `~/.mnemon`。

## 日志与隐私

提交 issue / PR 时，请先移除：本机用户名与绝对路径、API Key / token、会话内容、`client-events.ndjson` 里的完整记录。`/health` 只返回路径与计数，但仍请按需脱敏。
