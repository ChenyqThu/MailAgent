---
name: sprint-handoff
description: 按项目 house style 生成 Sprint / 功能交接文档
user_invocable: true
---

# /sprint-handoff — 生成交接文档

按本项目惯用结构生成 handoff（参考 `frontend/SPRINT*-HANDOFF.md`、`docs/*-handoff.md`），供下一个 session / 协作者冷启动。

## 使用方式

- `/sprint-handoff` — 基于当前分支 diff + 最近 commit 自动总结
- `/sprint-handoff compose 回复转发功能` — 指定主题聚焦

## 流程

1. 收集上下文：
   - `git log --oneline main..HEAD` — 本分支 commit
   - `git diff --stat main..HEAD` — 改动范围
   - 当前 branch 名 + `git status`
2. 按以下结构生成 markdown（缺省章节留 `TODO`，**不编造**）：

   ```
   # <主题> Handoff

   ## 背景 / 目标
   ## 已 ship（每条含 commit hash + 一句话）
   ## 关键文件 / 模块
   ## 灰度 flag 状态（env 开关 + 默认值 + 启用步骤）
   ## ⚠️ 未 dogfood / 已知风险
   ## 下一步（按优先级排序）
   ## 验收命令（可复制粘贴：mailagent CLI / pytest / sqlite3）
   ```
3. 落地位置：前端功能 → `frontend/SPRINTxx-<topic>-HANDOFF.md`；后端 / 跨栈 → `docs/<topic>-handoff.md`。
4. 写完询问用户是否更新 `.claude` memory 的项目索引（MEMORY.md 加一行指针）。

## 约定

- **flag 状态必须写默认值**（true/false）+ 启用步骤，避免协作者漏开。
- 验收命令优先用 `mailagent` CLI（agent-friendly）+ `-o json | jq`。
- 「未 dogfood」章节是本项目重点——明确标哪些功能写完但没真机验证（项目里大量功能处于此状态）。
