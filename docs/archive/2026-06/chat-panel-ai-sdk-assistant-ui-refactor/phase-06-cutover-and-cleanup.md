# Phase 06 — Cutover & Cleanup

> status: planning
> last-verified: 2026-06-22
> goal: 将新会话默认切到 AI SDK Gateway + assistant-ui，并清理 legacy chat view 主路径。

## 1. 目标

Phase 06 是默认切流和收尾阶段。前提是 Phase 01-04 已经通过 dogfood，Phase 05 AG-UI mirror 可选完成但不阻塞主线。

最终稳定态：

```txt
AIChatPanel
  → assistant-ui Thread / Tool UI / Composer
  → AI SDK Runtime
  → Node AI SDK Gateway
  → Python MailAgent domain services
```

Legacy 保留范围：

```txt
legacy ChatStreamEvent adapter
legacy session reader
legacy runtime rollback flag
```

不再作为默认新会话路径。

## 2. Cutover 前置条件

必须全部满足：

- assistant-ui shell 已覆盖基础对话、编辑、重试、停止、历史、popout。
- AI SDK Gateway pure text + read tools + write preview tools 稳定。
- 高风险工具审批已通过 hash / expiry / idempotency 测试。
- UIMessage 持久化与旧会话读取均通过。
- Electron / Web 各完成 dogfood scenario。
- `MAILAGENT_CHAT_RUNTIME=legacy` 可一键回滚。

## 3. 默认切流步骤

### C6.1 新会话默认 AI SDK

打开：

```txt
MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=1
MAILAGENT_CHAT_RUNTIME=ai-sdk
MAILAGENT_ASSISTANT_UI_PANEL=1
```

规则：

- 新建会话 `backend_kind='ai-sdk'`。
- 旧 `custom-api` / `notion-agent` session 按原 backend_kind 读取。
- 如果 Gateway health 不可用，新会话入口自动降级到 legacy，并显示非阻断提示。

### C6.2 旧会话兼容

读取策略：

```txt
ui_message_json exists
  → render as UIMessage
else legacy fields exist
  → legacyMessageMapper → UIMessage
```

旧 session 可以继续聊天吗？建议：

- `notion-agent` 旧 session：只读或提示“新开 AI SDK 会话继续”。
- `custom-api` 旧 session：可继续 legacy runtime，直到 cleanup 后统一迁移。
- 用户可一键“复制到新会话继续”。

### C6.3 Tool registry 权威切换

- 新 session 只使用 AI SDK Gateway tools。
- Legacy tools 仅服务旧 session / rollback。
- Tool schema fixture 留一份共享测试，防止行为漂移。

## 4. Cleanup 范围

可删除 / 下线主路径：

```txt
frontend/src/shared/components/chat/MessageList.tsx      # legacy main path
frontend/src/shared/components/chat/Composer.tsx         # legacy main path
frontend/src/shared/components/chat/ConfirmToolDialog.tsx # legacy main path
```

但不立即删除：

```txt
frontend/src/shared/hooks/useEmailChat.ts                # legacy compatibility
frontend/src/shared/chat/runtime.ts                      # rollback + old sessions
frontend/src/shared/chat/harness.ts                      # rollback + parity tests
frontend/src/shared/chat/tools/*                         # legacy tools until archive
```

推荐两步：

1. Phase 06a：从产品主路径移除 legacy UI。
2. Phase 06b：dogfood 一段时间后归档 legacy harness。

## 5. 数据迁移

### 5.1 Schema

新增字段已经在前序 phase 落地：

```txt
ai_chat_messages.ui_message_json
chat_tool_call.approval_id
chat_tool_call.approval_status
chat_tool_call.approval_content_hash
chat_tool_call.ui_payload_json
```

### 5.2 Backfill

提供脚本：

```txt
frontend/scripts/chat/backfill-ui-messages.ts
```

行为：

- 对缺失 `ui_message_json` 的 legacy messages 生成 UIMessage JSON。
- 不覆盖已有 UIMessage。
- dry-run 输出统计。
- 失败行记录但不中断。

### 5.3 Search / history compatibility

如果 history list 仍依赖 `content` 字段：

- 新会话继续双写 `content_text_legacy`。
- 后续搜索 / preview 改读 `ui_message_json` 后再考虑删除 legacy content。

## 6. 观测与告警

新增诊断面板指标：

```txt
AI Gateway health
AI Gateway version
active chat runtime
UIMessage persistence enabled
last stream error code
tool approval pending count
tool approval expired count
legacy fallback count
```

日志：

```txt
logs/ai-gateway.log
logs/chat-runtime.log
```

## 7. 回滚

### 7.1 快速回滚

```txt
MAILAGENT_CHAT_RUNTIME=legacy
MAILAGENT_ASSISTANT_UI_PANEL=0
MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=0
```

### 7.2 部分回滚

只回滚 high-risk tools：

```txt
MAILAGENT_AI_SDK_WRITE_TOOLS=0
MAILAGENT_AI_SDK_HIGH_RISK_APPROVAL=0
```

只回滚 A2UI cards：

```txt
MAILAGENT_A2UI_TOOL_CARDS=0
```

只停 AG-UI：

```txt
MAILAGENT_AG_UI_MIRROR=0
```

## 8. 删除条件

legacy 主路径删除前必须满足：

- AI SDK runtime 新会话连续 dogfood 7 天无 P0/P1。
- 外发审批、Notion sync、draft reply 三类复杂工具稳定。
- 所有旧 session 可读取。
- 回滚路径仍可通过 feature flag 恢复。
- `acceptance-checklist.md` 全部完成。

## 9. 验收

- 默认新会话走 AI SDK Gateway。
- 旧会话可读，不丢历史。
- assistant-ui 是唯一产品聊天视图层。
- 高风险工具无静默执行路径。
- Gateway 不可用时有明确降级提示。
- `pnpm typecheck` / `pnpm test` / E2E 全通过。

## 10. 归档

Phase 06 完成后：

- 把本专项文档中仍然描述“怎么做”的阶段文档归档或标记 completed。
- 将最终稳定架构提炼到 `docs/reference/llm-agent/` 或 `frontend/ARCHITECTURE.md`。
- 如果新增常青文档，按 `docs/DOC-GUIDE.md` 更新 `CLAUDE.md` 文档地图。