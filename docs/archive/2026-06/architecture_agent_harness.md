# MailAgent AI Agent Harness 架构

> ⚠️ 已归档存史（2026-07-03，S3）：本文描述的旧自研 TS harness 已被 AI SDK Gateway 完全取代并删除，当前架构真相见 [`ai-sdk-gateway-architecture.md`](../../reference/llm-agent/ai-sdk-gateway-architecture.md)。本文仅存历史参考。

> **状态**：✅ **M1 已 ship（Sprint 19, 2026-05-22/23, `feat/agent-harness` 分支）— 待 dogfood 测试后合 main 并翻默认 flag**；M2/M3/M4 计划已规划，路线图见 `docs/roadmap-post-cutover.md` §5.5
> **范围**：前端 Custom AI chat 从 single-turn 升级为 multi-turn agentic mail agent — tool calling / 跨邮件检索 / 跨 session memory（M2）
> **设计输入**：[`docs/agent-harness-design.md`](./agent-harness-design.md)（12 段工程级 ref）+ [`docs/eval/email_scenarios.md`](../../eval/email_scenarios.md)（20 scenario gate）+ `~/.claude/plans/subagent-plan-lexical-moler.md`（决策记录）+ Sprint 19 P0 调研（gbrain 内嵌评估、Karpathy LLM Wiki、Anthropic harness 最佳实践）
> **位置**：跟现有 v3 SQLite-first + Sprint 15 outbox + Sprint 16 dual-backend + v4 SQLite-SSoT 平级，是前端 Custom AI **chat 路径**的核心升级；**不影响**邮件同步主链路、LLM 分类（`src/llm_agent/`）、Notion 写回等任何后端
> **关联架构文档**：[`architecture_v4_sqlite_ssot.md`](../architecture/architecture_v4_sqlite_ssot.md)（v4 邮件 SSoT）+ CLAUDE.md "架构" 段

---

## 1. 背景与目标

### 1.1 现状（Sprint 18 ship 时）

前端 `AIChatPanel` 实际是 *single-turn LLM stream + 邮件 ctx 注入*：

- `dispatcher.runStream` 一次 `for await of backend.stream(...)`，无外循环
- `custom_api.ts` 不传 `tools` 参数，SSE 不处理 `content_block_start(tool_use)`
- `ChatStreamEvent.tool_call` 仅作占位（notion-agent 内部日志展示用）
- `chat_db.ts` v2 schema：仅 sessions + messages，无 audit / wiki / memory 表
- 58 IPC handler + 52 CLI schema + 6 webhook event 已 wire 但 chat 路径**全部没用上**
- FTS5 邮件正文索引 (`email_body_fts`) 已存在，chat 看不到

### 1.2 目标态（M4 ship 时）

```
用户："帮我查下 Bob 上次提的集成方案细节，然后起草一个简短回复说本周内确认"
  ↓
LLM iter 1: kos_query(query='Bob Acme 集成方案', scope='global')
            → KOS 返跨邮件/Notion手记/会议笔记的 page list + Bob 档案
LLM iter 2: email_body(top_hit.internal_id) (fallback: kos_query 不可用走本地)
            → ctx 收到正文
LLM iter 3: email_draft_reply(internal_id, body_markdown)
            → preview tier=edit ConfirmToolDialog 弹出
                ← 用户编辑 body → Confirm
            → IPC chat:confirmTool → main 解锁
            → createDraft → AppleScript → Mail.app 出现草稿
LLM iter 4 (optional): "草稿已写好，等你审"
            → stop_reason='end_turn' → assistant complete
```

参考 Claude Code 风格（tool registry + harness loop + 用户协作），**不走** Devin "agent 黑盒长跑"路线。**LLM Wiki 不自研、不内嵌**：M2 直接接入用户已有的 Jarvis KOS v2（gbrain fork on mac mini，公网 `kos.chenge.ink`），MailAgent 作为 KOS 的第 4 个消费者（已有 Notion Knowledge Agent / OpenClaw / Feishu signal detector）。producer 走 mail-sync 后端推 `/ingest`，consumer 走 chat agent `kos_query` / `kos_digest` tool。详见 [`kos-integration-design.md`](./kos-integration-design.md)。

---

## 2. 整体数据流（M1 ship 后）

```
┌─────────────────────────────────────────────────────────────────────┐
│                Renderer (React, ipcRenderer + IPC)                  │
│                                                                      │
│  AIChatPanel → MessageList → ToolCallRow                            │
│      └─→ ConfirmToolDialog (preview/edit tier overlay, fixed z-50)  │
│           ← chat.pendingConfirmations queue (useEmailChat)          │
│  send / abort / confirmTool IPC + chat:stream 订阅                  │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ IPC                              
┌──────────────────────────────────▼──────────────────────────────────┐
│                Main process (Electron, node, sqlite)                 │
│                                                                      │
│  handlers/chat.ts                                                   │
│   chat:start / chat:abort / chat:listMessages / chat:editMessage    │
│   chat:confirmTool ← Sprint 19 新增                                  │
│                                                                      │
│  chat/dispatcher.ts:runStream                                       │
│   ┌─ isHarnessEnabled() && backendSupportsTools(kind) ─ true ──┐   │
│   │   ↓                                                          │   │
│   │  chat/harness.ts:runHarness                                  │   │
│   │   while (iter < MAX_ITER && !aborted):                       │   │
│   │     for await ev of backend.stream({tools, iterHistory}):    │   │
│   │       chunk → updateMessage(buffer) + forward                │   │
│   │       tool_use → collected.push + appendToolCall (pending)   │   │
│   │       usage → costUsd += / forward                           │   │
│   │       done → stopReason = ev.stopReason                      │   │
│   │       error → flip assistant 'error' + return                 │   │
│   │     stopReason==='end_turn' || !collected.length → complete │   │
│   │     costUsd > MAX_COST → E_COST_BUDGET                       │   │
│   │     dispatchTools(collected, ctx含 confirm callback)         │   │
│   │     updateToolCall(rows with output/duration)                │   │
│   │     priorTurns.push(assistant tool_use + user tool_result)   │   │
│   │   loop done → MAX_ITER → E_MAX_ITER                          │   │
│   └────────────────────────────────────────────────────────────┘   │
│   else (flag off / notion-agent kind) → legacy single-pass           │
│                                                                      │
│  chat/backends/custom_api.ts:anthropicStream                        │
│   - body.system: [TextBlock with cache_control:ephemeral]            │
│   - body.tools: registry.toAnthropicSchema() (last 加 cache_control) │
│   - SSE state machine processAnthropicEvent (Sprint 19 抽出)         │
│     content_block_start(tool_use) → pendingToolBlocks.set            │
│     content_block_delta(input_json_delta) → 拼 jsonStr               │
│     content_block_stop → JSON.parse + yield ToolUseEvent             │
│     message_delta.stop_reason → state.messageStopReason              │
│   - DoneEvent.stopReason 从 state 填                                  │
│                                                                      │
│  chat/tools/registry.ts                                              │
│   defaultToolRegistry (单例, boot 时由 registerBuiltinTools 填)      │
│   ToolDef { name, description, inputSchema, confirmationTier,        │
│             category, surface, timeoutMs, throttlePerMinute,         │
│             handler }                                                │
│                                                                      │
│  chat/tools/dispatch.ts:dispatchTools                                │
│   - silent tier → Promise.all parallel                               │
│   - preview/edit tier → await ctx.confirm(use, def) → run serial    │
│     · approved + editedInput → handler with ctx.userEditedInput     │
│     · cancelled → tool_result status='canceled'                     │
│   - 未知 tool → status='error' 含可用列表                            │
│   - per-tool timeoutMs 用 AbortController-race                       │
│                                                                      │
│  chat/tools/confirmation.ts                                          │
│   awaitConfirmation(toolUseId, sessionId, signal) ← harness 调      │
│   resolveConfirmation(toolUseId, outcome) ← chat:confirmTool IPC 调  │
│   cancelConfirmationsForSession(sessionId) ← abortChatSession 调    │
│                                                                      │
│  chat/tools/builtin/                                                 │
│   email.ts:    6 read tools (silent)                                 │
│   attachment.ts: 1 read tool (silent)                                │
│   write.ts:    3 write tools (preview / edit)                        │
│                                                                      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                       ┌───────────┴────────────┐
                       ▼                        ▼
        ┌──────────────────────────┐  ┌──────────────────────────┐
        │ ~/.mailagent/frontend/   │  │ data/sync_store.db       │
        │  ai_chat.db (v3)         │  │  (邮件 SSoT, 跟 chat 共享 │
        │  ├ ai_chat_sessions      │  │   不冲突 — chat 只读不写) │
        │  ├ ai_chat_messages      │  │  ├ email_metadata        │
        │  ├ chat_tool_call (新)   │  │  ├ email_body + FTS5     │
        │  ├ wiki_pages (M2)       │  │  ├ email_attachment      │
        │  ├ wiki_fts (M2)         │  │  └ email_outbox          │
        │  └ agent_memory_kv (M2)  │  └──────────────────────────┘
        └──────────────────────────┘
```

---

## 3. Schema 速查（chat_db.ts v3）

```sql
-- v2 已有 (Sprint 4-18)
CREATE TABLE ai_chat_sessions (
  id PK, email_id, backend_kind, backend_model, backend_agent_page_id,
  created_at, updated_at,
  UNIQUE(email_id, backend_kind, backend_agent_page_id)
);
CREATE TABLE ai_chat_messages (
  id PK, session_id FK CASCADE, role, content, tokens_input, tokens_output,
  cost_usd, model, status, error_message, metadata,  -- v2 metadata JSON
  created_at, updated_at
);

-- v3 新加 (Sprint 19 PR-1a)
CREATE TABLE chat_tool_call (
  id PK, message_id FK CASCADE, tool_use_id TEXT,  -- Anthropic toolu_xxx
  tool_name, input_json, user_edited_input_json, output_json,
  status CHECK ∈ (pending, confirmed, running, ok, error, canceled),
  duration_ms, confirmation_tier CHECK ∈ (silent, preview, edit),
  confirmed_at, created_at, updated_at,
  UNIQUE(message_id, tool_use_id)
);
CREATE INDEX idx_tool_call_message ON chat_tool_call(message_id);
CREATE INDEX idx_tool_call_status_inflight ON chat_tool_call(status)
  WHERE status IN ('pending','confirmed','running');

-- v3 也建好留位 (M2 才用)
CREATE TABLE wiki_pages (
  path PK, scope, slug, body_markdown, refs_json, source_messages_json,
  updated_by DEFAULT 'agent', mtime_ns, created_at, updated_at
);
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  path UNINDEXED, body_markdown,
  content='wiki_pages', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
-- 3 个 trigger (ai/ad/au) 自动 sync wiki_pages ↔ wiki_fts

CREATE TABLE agent_memory_kv (
  scope, key, value_json, source_wiki_path, created_at, updated_at,
  PRIMARY KEY (scope, key)
);
```

---

## 4. M1 Builtin Tool Catalog（10 个，PR-1b + PR-1d.1）

### Read tools (silent tier, 7 个)

| Tool | 后端接口 | 描述 |
|---|---|---|
| `email_search` | `listEmails` | 按 subject/sender/date/flag 过滤搜邮件 |
| `email_get` | `getEmail` | 单封 metadata + 附件摘要 |
| `email_body` | `getEmailBody` | markdown 正文（截 12KB） |
| `email_list_thread` | `listEmailsByThread` | 同线程所有邮件 |
| `email_search_fulltext` | `searchEmails` | FTS5 全文搜（bm25 + snippet） |
| `email_get_ai_fields` | `getAIFields` | LLM 分类结果 (priority/labels) |
| `attachment_list` | `listAttachments` | 附件列表（filename/mime/size） |

### Write tools (preview/edit tier, 3 个)

| Tool | Tier | 后端接口 | 描述 |
|---|---|---|---|
| `email_flag` | preview | `writeFlagDirect` | 改 is_read/is_flagged/processing_status，Sprint 16 outbox 直写 ~5ms |
| `email_archive` | preview | `writeFlagDirect` (processing_status='已完成') | 归档便利封装 |
| `email_draft_reply` | **edit** | `createDraft` | 在 Mail.app 起草 reply，AppleScript ~3-5s |

### Tool 路由（Plan D5/D6）

- 读类：直接 import `handlers/email.ts` + `handlers/attachment.ts` 的 export function（main process 内部不走 ipcMain.invoke 那是 IPC 边界专用）
- 写类：直接 import `handlers/write_ops.ts:writeFlagDirect`（Sprint 16 SSoT）+ `handlers/draft.ts:createDraft`
- 长任务 / 远程：保留通道，M1 未引入 webhook tool

---

## 5. 关键设计点

### 5.1 Prompt cache 双 breakpoint（保护 95% 命中率）

参考 `src/llm_agent/processor.py:46-66, 141-199` 的 single-breakpoint 经验：

```typescript
system: [
  { type: 'text', text: STATIC_PROMPT, cache_control: { type: 'ephemeral' } }
]
tools: [...registry.toAnthropicSchema()].map((t, i) =>
  i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
)
```

`system` 和 `tools` 是 Anthropic 两个独立 prefix segment，各自 hash；都加 cache_control 才两段都命中 cache。M2 加 L1 hot wiki block 时合并到 system 的第一个 block 内保单 breakpoint。

### 5.2 Tool use ID 跨轮稳定

Anthropic 协议要求下一轮 `tool_result.tool_use_id` 完全匹配上一轮 `tool_use.id`。`chat_tool_call.tool_use_id` UNIQUE(message_id, tool_use_id) 保证 audit + history rebuild 时按 messageId 反查能拿到原 id 串。

### 5.3 User-edited input 透传

`email_draft_reply` tier=edit 时用户改了 body_markdown → `ConfirmToolDialog` 把改后 input 传给 `chat:confirmTool` IPC → `awaitConfirmation` 解锁 → `dispatch.ts` 把 `userEditedInput` 塞进 `ToolExecCtx.userEditedInput` → tool handler 读 `ctx.userEditedInput` 优先（write.ts `effective()` helper） → 同时把 `user_edited:true` + `final_body_markdown` 写进 tool result 给 LLM 下一轮看到"用户实际发的是 X"。

### 5.4 Multi-turn history 跨 iter 维护

`harness.ts` 维护 in-memory `priorTurns: AnthropicHistoryMessage[]`：

- iter 0：`iterHistory = chatHistoryToAnthropic(initialHistory)`
- iter N 结束：append `{role:'assistant', content:[text + tool_use blocks]}` + `{role:'user', content:[tool_result blocks]}`
- iter N+1：传 `iterHistory: [...baseHistory, ...priorTurns]` 给 backend.stream
- `custom_api.ts:buildAnthropicMessages` 优先用 `iterHistory`（绕开 ChatMessage[] 转换，因为后者 content 是 string 不能表 multi-block）

### 5.5 Confirmation gate

- 主进程模块级 `_pending: Map<toolUseId, Resolver>` 持有 suspended Promise
- harness 调 `awaitConfirmation` 注册一个 entry + 异步阻塞
- renderer 弹 `ConfirmToolDialog` → 用户点 Confirm → IPC `chat:confirmTool` → `resolveConfirmation` resolve promise → harness 继续 dispatch
- abort signal 触发 → `cancelConfirmationsForSession` 把目标 session 全部 pending entry resolve `{approved:false}`（避免 dead-lock 永久挂起）

---

## 6. Env flag 矩阵（kill switches）

| Flag | 默认 | 作用 | 翻转时机 |
|---|---|---|---|
| `MAILAGENT_AGENT_HARNESS` | `0` | M1 harness 主开关，off=legacy single-turn 路径不变 | P4 翻 `1`，dogfood 验证后 |
| `MAILAGENT_AGENT_WIKI` | `0` | L1 hot wiki block 注入 + wiki_* tool 暴露 | M2 ship 后翻 |
| `AGENT_ATTACHMENT_FTS` | `0` | 附件 FTS 触发器（提取 + 索引） | M2 ship 后翻 |
| `MAILAGENT_AGENT_VECTOR` | `0` | M3 末 eval gate 过才开（< 15% lift 永久不开） | M3.2 |
| `AGENT_MEMORY_AUTOWRITE` | `0` | LLM 自驱 wiki_write 允许 | M3 评估后 |
| `AGENT_MAX_ITER` | `8` | harness 单 turn 最大 iter | — |
| `AGENT_MAX_COST_USD` | `0.5` | 单 turn 最大 LLM cost | — |

---

## 7. 已交付 PR（M1，~6261 LOC，146 tests 全过）

`feat/agent-harness` 分支（尚未合 main）：

| PR | LOC | tests | 内容 |
|---|---|---|---|
| `ab00431` P0 | 1514 | — | 设计文档 + 20 scenario eval baseline |
| `1b2ff2c` PR-1a | 729 | 37 | types + chat_db v3 schema + ToolRegistry 空壳 |
| `ea51ab5` PR-1b | 1091 | 30 | 7 个读 tool + dispatch 框架 |
| `1b7ca07` PR-1c | 557 | 22 | Anthropic tool_use SSE 解析 + cache_control |
| `13d3b9f` PR-1d.1 | 1740 | 75 | harness 外循环 + 3 写 tool + confirmation 流（main） |
| `ae6f7ca` PR-1d.2 | 630 | 11 | ConfirmToolDialog + renderer IPC wire |

**待 dogfood**：开 `MAILAGENT_AGENT_HARNESS=1` 跑 20 eval scenario，记 pass rate 给 P4 准入门槛（≥70%）。详见 `frontend/SPRINT19-M1-HANDOFF.md`。

---

## 8. 跟其他系统的关联

| 系统 | 关系 |
|---|---|
| **chat_db.ts v2 (Sprint 4-18)** | 同 db 文件 (`~/.mailagent/frontend/ai_chat.db`)，v3 加 4 张新表，migration 兼容旧 v1/v2 数据 |
| **Sprint 16 outbox SSoT** | 写 tool `email_flag / email_archive` 直调 `writeFlagDirect` 走 outbox 双写（mailapp + notion）—— 跟手动 EmailRow flip 行为完全等价 |
| **Sprint 15 反向同步** | 不冲突。harness 调 writeFlagDirect 写 outbox.source='frontend_direct'，跟 Notion webhook 用的 source='notion_webhook' 走 echo prevention 不打架 |
| **`src/llm_agent/` backend LLM 分类** | 完全独立。后端 LLM 跑 single-turn 邮件分类填 AI 字段（priority/labels），chat agent 跑 multi-turn 给用户回话。两者 `LLM_API_KEY` 共享 CRS network，cost 各算各的 |
| **`webhook-server/`** | 不冲突。webhook 是 Notion automation 触发 Mail.app 反向操作；chat agent 是用户主动在前端 panel 内跟 LLM 对话 |
| **`src/cli/`** | 不调用。M1 只走 IPC handler 内部 function（main process 内部不 fork CLI 进程）；M2 长任务（resync / backfill）可能选择性引入 CLI subprocess 通道 |
| **EmailRepository FTS5 (`email_body_fts`)** | `email_search_fulltext` tool 调 `searchEmails(opts)` → 间接走 backend `EmailRepository.search_email_bodies`；M2 加中文 smart wrapper + `email_attachment_fts` |
| **DavMail / AppleScript dual backend** | 无关。harness 在 chat 层；邮件本身从哪个 backend sync 来不影响 chat agent 看正文（统一从 SQLite SSoT 读） |
| **v4 SQLite SSoT** | harness 读邮件正文 = `getEmailBody → email_body.body_markdown`（v4 SSoT），不再走 Notion API / AppleScript 重抽 |
| **Jarvis KOS v2 (gbrain fork) @ mac mini** | M2 引入：MailAgent 作为 KOS 的第 4 消费者（Notion/OpenClaw/Feishu 已在）。producer：mail-sync 邮件 sync 完异步 POST `/ingest`（path `mail/{internal_id}`）；consumer：chat agent `kos_query` / `kos_digest` tool。Endpoint：`kos.chenge.ink` 主 + `127.0.0.1:7225` 兜底。设计：[`kos-integration-design.md`](./kos-integration-design.md) |

---

## 9. M2/M3/M4 计划摘要

详见 [`docs/agent-harness-design.md`](./agent-harness-design.md) §M2-M4 + `~/.claude/plans/subagent-plan-lexical-moler.md` §5-Phase 路线图。

### M2 — KOS Integration + retrieval 升级（~3-4 周）

**决策反转（2026-05-23）**：原 plan "M2 自研 SQLite wiki" 已撤销，改为接入用户已有的 **Jarvis KOS v2**（gbrain fork on mac mini @ `kos.chenge.ink` + `127.0.0.1:7225`）。MailAgent 作为 KOS 的第 4 个消费者（Notion Knowledge Agent / OpenClaw / Feishu signal detector 之后）。完整设计见 [`kos-integration-design.md`](./kos-integration-design.md)。

| 子 PR | 范围 |
|---|---|
| PR-2a | FTS5 中文 smart wrapper（CJK auto `*` 通配） — **本地 fallback**，KOS 不可达时 chat 仍能用 |
| PR-2b | 附件文本化（`pypdf` / `python-docx` / `python-pptx` / xlsx CSV）+ `email_attachment_fts` + worker queue + `email_search_attachments` tool — **本地 fallback** |
| PR-2c | **KOS client** (TS + Py) + .env config (`KOS_BASE_URL` / `KOS_FALLBACK_URL` / `KOS_API_KEY` / `MAILAGENT_KOS_ENABLED`) + health check + retry + circuit breaker + boot-time fallback URL 切换 |
| PR-2d | **Producer pipeline**：mail-sync `_sync_single_email_v3` 完 Notion sync 后异步 `KOSClient.ingest`；payload = 全文 markdown + frontmatter (`path: mail/{internal_id}` + `scope: mail-agent`)；priority floor 过滤 (`KOS_INGEST_PRIORITY_FLOOR=normal`)；KOS 不可达不阻塞主同步 |
| PR-2e | **Consumer tools**：`kos_query` + `kos_digest` 加 `defaultToolRegistry`（silent tier, category=meta）；替换原 plan 的 6 个本地 wiki_* tool |
| PR-2f | **L1 hot block 注入**：chat 启动时若 emailContext.senderAddr 存在 → 异步 `kos_digest(people/{sender_slug})` 注入 system block；保留 cache_control 双 breakpoint |
| PR-2g | dogfood + eval 跑 + CLAUDE.md / architecture doc 更新 |

**保留**（PR-1a 已建好留位）：chat_db v3 的 `wiki_pages` / `wiki_fts` / `agent_memory_kv` 表保留但**不主动写**；M3 可评估是否做"KOS 不可达时的离线缓存层"。

**KOS 自带能力直接复用**（不重写）：
- 自动 typed-link 提取（`emailed_with` / `works_at` / `attended` 等，零 LLM）
- 知识图谱多跳遍历 + backlink-boosted ranking
- 混合检索：vector (HNSW) + BM25 + RRF + ZeroEntropy rerank
- `## Facts` 围栏 → typed metric columns + temporal trajectory
- 夜间 consolidate / 矛盾检测 / 引用修复（KOS cron 系统自跑）
- entity 跨域合并（邮件里 `bob@acme.com` 跟 Notion 手记里 `[[people/bob-acme]]` 合一）

### M3 — Memory expansion + Embedding eval（~5-7 天）

- sender / project / mailbox.outbox.style scope 写入逻辑
- 后台 ralph job 抽 outbox 风格
- 20-30 query benchmark 跑 FTS5-only vs FTS5+vector RRF 对比 — **hard gate**：lift < 15% 永久不做 vector
- gate 过才接 lancedb（独立文件，无 native build 噩梦）

### M4 — Guards + Polish + Rollout（~3-5 天）

- per-tool throttlePerMinute 实施
- system prompt reject-list
- MessageList ToolCallRow 升级渲染 `chat_tool_call` audit row（折叠卡片）
- 每日 cost telemetry
- 默认 flag flip + 1 周 dogfood
- CLAUDE.md 更新（已 ship）

---

## 10. 关键文件清单（M1 ship 范围）

```
docs/
  agent-harness-design.md     ← 工程级 ref 设计（12 段）
  eval/email_scenarios.md     ← 20 scenario gate
  architecture_agent_harness.md ← 本文档（ship 状态）

frontend/src/electron/main/chat/
  dispatcher.ts               ← runStream 加 harness gate (PR-1d.1)
  types.ts                    ← ToolUseEvent / ToolResultEvent /
                                 PendingConfirmationEvent /
                                 AnthropicHistoryMessage 等 (PR-1a/1c/1d.1)
  config.ts                   ← env flag inventory (新 PR-1d.1)
  harness.ts                  ← runHarness 外循环 (新 PR-1d.1)
  backends/custom_api.ts      ← tool_use SSE + cache_control (PR-1c)
  tools/
    registry.ts               ← ToolRegistry (新 PR-1a)
    dispatch.ts               ← dispatchTools (新 PR-1b + PR-1d.1)
    confirmation.ts           ← pending promise gate (新 PR-1d.1)
    builtin/
      index.ts                ← registerBuiltinTools 入口 (新 PR-1b/1d.1)
      email.ts                ← 6 个 email read tool (新 PR-1b)
      attachment.ts           ← attachment_list (新 PR-1b)
      write.ts                ← 3 个 write tool (新 PR-1d.1)

frontend/src/electron/main/
  chat_db.ts                  ← v3 schema + ChatToolCall CRUD (PR-1a)
  handlers/chat.ts            ← chat:confirmTool IPC (PR-1d.1)
  index.ts                    ← boot wire registerBuiltinTools (PR-1d.1)

frontend/src/shared/
  api/types.ts                ← ChatStreamEvent + ChatApi 镜像 (PR-1d.2)
  api/ElectronApi.ts          ← confirmTool 实现 (PR-1d.2)
  api/HttpApi.ts              ← confirmTool stub (PR-1d.2)
  hooks/useEmailChat.ts       ← pendingConfirmations + confirmTool (PR-1d.2)
  components/chat/
    AIChatPanel.tsx           ← 集成 ConfirmToolDialog (PR-1d.2)
    ConfirmToolDialog.tsx     ← 新组件 (PR-1d.2)

frontend/tests/                ← 146 tests (chat_db + dispatcher +
                                 custom_api + tools + harness +
                                 confirmation + ConfirmToolDialog)
```

---

## 11. 待办（M1 → M2 衔接）

- [ ] **Dogfood 测试**：开 `MAILAGENT_AGENT_HARNESS=1`，跑 `docs/eval/email_scenarios.md` 20 scenario，记 baseline pass rate
- [ ] MessageList ToolCallRow 升级渲染 `chat_tool_call` audit row（P4 polish，非阻塞）
- [ ] OpenAI 协议 tool_calls 增量支持（M2 末，给 gpt-* fallback model）
- [ ] M2.1 启动：FTS5 中文 smart wrapper
