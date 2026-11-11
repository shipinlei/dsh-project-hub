# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-11-11

首个公开版本。

### Added

- **项目工作台面板**：新增 `main` 面板与侧栏「项目」入口，按最近活跃排序项目卡片，项目内会话按最近更新时间倒序。
- **项目级默认设置**：按 `workspaceId` 保存 description / agentPreset / provider / model / reasoningEffort，面板「新建会话」时套用并跳转。
- **项目记忆隔离**：面板记忆条一键切换 Mnemon `storageScope=workspaces`、`runtimeUserScope=global`，支持一键回滚到全局共享。
- **项目规则预览**：按官方 `AGENTS.md` / `CLAUDE.md` 发现顺序列出全局 → 项目根 → `.local` 叠加，只读预览片段。
- **侧栏会话排列**：启动时把侧栏切到官方「按工作区（项目）」分组；兼容 Claude Code 风格皮肤的「日期视图」，并提供「不干预」开关。
- host 侧 HTTP 契约：`/dsh-project-hub/api/{state,project,rules,memory-scope,client-report,beacon,health}`，含桌面宿主鉴权放行与回环诊断接口。
- 四套自检脚本：宿主契约（21 项）、client smoke、交互链路、真实 React 18 + jsdom 离屏渲染（16 项）。

### Fixed

- 修复 `apiUrl()` 丢 query 导致 `/rules?workspaceId=` 始终 400。
- 修复客户端误用不存在的 `ctx.sessions.selectModel`，改走 `ctx.remote.session.selectModel`。
- 修复桌面宿主（`dsh-app://`）请求不带浏览器凭证导致面板 401：desktop profile 下跳过 `connection` 网关（与官方 `dshmarket` 一致）。
- 修复 `ctx.get('remote')` 未 inject 访问 `.session` 导致整次插件激活回滚、侧栏入口不出现；locale / 槽位注册改为幂等并加入诊断信标。
- 修复 HMR 热重载后宿主 locale 字典未更新（重复注册被忽略）导致新增文案显示原始 key（如 `sidebarView` / `groupByProject`）：`t()` 兜底到插件内中文文案，字典陈旧时不再露 key。
