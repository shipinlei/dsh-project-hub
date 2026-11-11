## 改动说明

<!-- 一句话说清这个 PR 做了什么、为什么 -->

## 类型

- [ ] feat（新功能）
- [ ] fix（缺陷修复）
- [ ] docs（文档）
- [ ] test（测试）
- [ ] refactor / chore

## 自检结果

<!-- 贴四套脚本的结果；UI 改动请附截图或 /health 的 clientEvents 证据 -->

```text
node scripts/test-host.mjs                            # __/__
node scripts/test-client.mjs client/client.js         # OK/FAIL
node scripts/test-client-interaction.mjs client/client.js
node scripts/test-client-dom.mjs client/client.js
```

## 约束确认

- [ ] 没有修改 DSH 核心包、没有写用户 profile 的 `cordis.patch.yml`、没有动会话文件
- [ ] 仍为零构建（未引入打包器 / TS / 额外前端依赖，客户端只 `require("react")`）
- [ ] UI 只用 `--dsw-alias-*` 主题 token
- [ ] 若改动 host ↔ client 接口，已先更新 `docs/接口约定.md`
