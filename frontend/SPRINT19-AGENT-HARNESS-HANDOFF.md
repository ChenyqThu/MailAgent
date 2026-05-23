# Sprint 19 — AI Agent Harness（核心功能重构）

## 任务目标

把当前"无状态 prompt + 邮件 ctx"的 AI Chat 升级成真正的 **agentic 邮件助手**：
- **Tool calling** —— LLM 能调工具（搜索 / 读元数据 / 标读旗 / 拟回复 / 发送 …）
- **RAG / Retrieval** —— 跨邮件、跨线程、跨附件检索（先用 FTS5，evals 后再决定加 vector）
- **Multi-step agent loop** —— 模型自驱多轮工具调用直到完成任务
- **Memory** —— 跨 session 的用户偏好 / 邮件签名 / 风格

参考标杆：**Claude Code / Cursor agent / Devin / Computer Use**。设计风格倾向 Claude Code 的"tool registry + harness loop + 用户协作"，**不要**走 Devin 那种"agent 黑盒长跑"。

> 这是 AI-Outlook 的核心功能定位 —— 它不该只是个 chat 旁路，而应该是"邮件智能层"。前端工作量小（chat 流式渲染 + tool_call/tool_result UI），主要工程量在 **Electron main process 的 agent harness + tool layer**。

## 起点资源（按顺序读）

### 必读 — 当前 chat 路径

| 路径 | 行 | 用途 |
|---|---|---|
| `src/electron/main/chat/dispatcher.ts` | 470 | 入口 — `startChat` 拉 ctx + 跑 backend.stream，循环消费 chunk/tool_call/tool_result/error/end_turn |
| `src/electron/main/chat/types.ts` | 110 | `EmailContext`（含新加的 `notionPageId`）/ `ChatStreamEvent` union / `ChatBackend` interface |
| `src/electron/main/chat/backends/custom_api.ts` | 380 | OpenAI/Anthropic Messages 直连后端；现有 `buildSystemPrompt` 注入 ctx |
| `src/electron/main/chat/backends/notion_agent.ts` | 360 | `notion-agent` CLI 子进程后端；`enrichedPrompt = ctxHeader + userMsg` |
| `src/electron/main/chat_db.ts` | 350 | session / message 持久化 schema（v2, metadata JSON） |
| `src/shared/components/chat/AIChatPanel.tsx` | 800 | UI 入口：history 渲染、Composer、quota cooldown、context chips |
| `src/shared/components/chat/MessageList.tsx` | — | 流式 chunk 渲染（**tool_call / tool_result 已经有 UI hook**！见 dispatcher line 247+） |

### 必读 — 已有可复用基础

| 路径 | 用途 |
|---|---|
| `src/electron/main/handlers/email.ts` | 30+ ipc handler (`email:list / listEnriched / listByThread / get / body / aiFields / search / pin / unpin / …`) — **tool 实现层全部已 wire**，直接调即可 |
| `src/electron/main/handlers/write_ops.ts` | flag / archive / draft / pin 等写操作（Sprint 15 outbox 路径） |
| `src/repository/` 后端 Python | `EmailRepository.search_email_bodies()` FTS5 全文搜索 — backend webhook 已 expose `search_email_bodies` event |
| `webhook-server/app.py` | 5 个 agent-friendly event：`query_mail / fetch_mail_content / search_email_bodies / create_draft / handle_flag_changed` |
| `src/cli/commands/` Python | `mailagent` CLI 10 个 group 45+ schema — 也可以作为 tool 调用层（fork 慢 ~500ms 但 schema 严谨） |
| `mailagent debug mail-structure -o json` | 看 backend 还有哪些数据可暴露 |

### 必读 — 项目顶层

| 路径 | 用途 |
|---|---|
| `CLAUDE.md` | "LLM Agent" 段 + "v4 SQLite-SSoT" 段 + "Sprint 15 outbox" 段，了解整个数据流 |
| `frontend/DESIGN.md` | UI 规范（Sprint 18 settings shell 已就位，agent UI 应该复用） |

## 现状速查（这条 PR 之前的 baseline）

### Prompt 当前长啥样

`dispatcher.loadEmailContext(emailId)` 拉 SQLite SSoT：
```
internalId / subject / senderName / senderAddr / dateIso / bodyMarkdown(截 12k) / notionPageId
```

Custom AI：写进 system prompt（多轮重发，靠 cache_control 命中）。
Notion Agent：写进 user prompt 前缀（多轮 thread_id 后跳过 ctxHeader）。

### 没有的

- ❌ Tool definitions / 调用 / dispatch
- ❌ Multi-step agent loop（当前是 single-turn LLM stream）
- ❌ Retrieval（FTS5 backend 有，前端 chat 没用）
- ❌ Cross-session memory（除了 chat history 本身）
- ❌ Stop guards（max iter / cost cap）
- ❌ Tool 权限模型 / 用户确认对话

## 建议工作路径

### Phase 1 — 调研 + 设计（不要跳，2-3 天）

**输出**：`docs/agent-harness-design.md`，含：

1. **Tool catalog** — 列 20-30 个候选 tool 按"读 / 写 / 元数据 / Notion / RAG"分组
   - 必填：`name / description（给 LLM 看，要 actionable）/ input_schema / output_schema / requires_confirmation: boolean`
   - 复用已有 ipc handler / CLI / webhook event；**不重写已 wire 的能力**
2. **Confirmation model** — 哪些 tool 走 silent auto，哪些必须 UI 确认（pop confirm dialog）
   - 建议：所有写操作 + 任何会发邮件 / 发飞书 / 删数据的 — 必须确认
   - 所有读操作 — silent
   - "send_reply" 这种高 stakes — 弹 preview + confirm + 给用户编辑机会
3. **Agent loop 状态机** — 抄 Claude Code 思路：
   ```
   user_msg → model.stream(history + tools)
            ↓
    ┌── stop=tool_use → execute tools (parallel where safe) → append tool_result → loop
    └── stop=end_turn → emit done
   ```
   guards: `max_iterations: 10` / `max_cost_usd: 1.0 per turn` / 用户 abort 即停
4. **Backend 路由** — Custom AI 走 native tool_use；Notion Agent 当前 CLI 不支持 tool_use，要么 fork notion-agent，要么 v1 先只在 Custom AI 路径加 tool 能力，notion-agent 留 fallback
5. **Memory 设计** — chat_db.ts 加 `agent_memory` 表？keyed by user / mailbox / sender_email？
6. **Eval 集** — 至少 20 个真实邮件场景写成 prompt → expected behavior，跑回归

### Phase 2 — Foundation（M1，~1 周）

#### Tool layer

```typescript
// src/electron/main/chat/tools/registry.ts
export interface ToolDef<I, O> {
  name: string
  description: string  // LLM 看到的描述
  inputSchema: JsonSchema
  requiresConfirmation: boolean
  handler(input: I, ctx: ToolContext): Promise<O>
}

export interface ToolContext {
  emailId: number | null
  signal: AbortSignal
  // 给 handler 拿当前 session 信息 / 写 tool_call 事件流
}

// src/electron/main/chat/tools/builtin/
//   email_search.ts  email_get.ts  email_flag.ts  email_archive.ts
//   email_draft.ts  email_send.ts  email_set_pinned.ts
//   thread_list.ts  attachment_list.ts  attachment_fetch_text.ts
//   notion_page_get.ts  notion_page_append.ts  notion_relation_create.ts
```

每个 tool 一个文件 + unit test。Handler 直接调 `src/electron/main/handlers/email.ts` 的现有逻辑（**不要复制粘贴 SQLite 查询**）。

#### Anthropic native tool_use

修 `custom_api.ts` 把 messages API 调用从 `messages: [...]` 升级到含 `tools: [...]` ：
```typescript
const tools = registry.toAnthropicSchema()
const stream = await anthropicClient.messages.stream({
  model, system, messages, tools, max_tokens: ...
})
// 流处理：除了 content_block_delta(text) 还有 content_block_start(tool_use)
// + 累积 input_json_delta + content_block_stop → 拿到完整 tool_use
```

OpenAI compat path 同理（CRS 后端，OpenAI streaming `tool_calls` 增量）。

#### Harness loop

```typescript
// dispatcher.ts runStream 改造为多轮
async function runStream(args: RunStreamArgs) {
  let iter = 0
  while (iter < MAX_ITER) {
    iter++
    const events = backend.stream({ history, tools, ctx })
    let toolCalls: ToolCall[] = []
    for await (const ev of events) {
      if (ev.type === 'tool_use') toolCalls.push(ev)
      else forward(ev)
    }
    if (toolCalls.length === 0) return  // end_turn
    // 执行 tools（per-tool confirmation 如有）
    const results = await Promise.all(toolCalls.map(tc => runTool(tc, ctx)))
    // append tool_result 进 history 继续下轮
    appendToolResultMessages(history, results)
  }
  forward({ type: 'error', code: 'E_MAX_ITER', message: '...' })
}
```

#### UI

- `MessageList.tsx` 已 hook tool_call event（dispatcher 已发），加 tool_result rendering：折叠的 "[tool_name] → 结果 X 行" 卡片，点开看 detail
- Confirmation: 加 `ConfirmToolDialog` 组件，handler 收到 `requires_confirmation=true` 的 tool 时不直接跑，先发 `pending_confirmation` 事件给前端，前端弹对话框，用户 OK 才回 IPC 跑

### Phase 3 — Retrieval（M2，~3-5 天）

#### 先 FTS5（已经有）

Tool: `email_search_fulltext(query, mailbox?, since?, limit?)` → 调 `EmailRepository.search_email_bodies` → 返回 hits[]。
Bonus tool: `email_search_recent(filter)` → list mailbox 最近 N 天的邮件。

Custom AI / Notion Agent 都能从 tool 拿到搜索结果，再决定要不要进一步 `email_get(id)` 看正文。

#### Vector RAG（先评估再做）

- 选 embedding：`text-embedding-3-small` (1536 dim, $0.02/1M tok) 或 `voyage-3` 或本地 BGE
- 存储：`sqlite-vss` extension（已 ship better-sqlite3 加载）或 lancedb（独立进程）
- chunking：一封邮件 = 一个 doc (subject + body markdown 前 N 字)；不分段（邮件本来就短）
- 增量：mail-sync v4 双写已经能给我们 hook 点
- Hybrid: FTS5 BM25 + cosine RRF 融合

**先做 eval**：跑 20 个真实查询，比"只 FTS5" vs "FTS5 + vector"的命中差距。如果 < 15% 差距，**先不做 vector**，复杂度不值。

### Phase 4 — Memory（M3，~3 天）

#### 短期记忆：context compaction

session history > N tokens 时 summarize 前半段（参考 Claude Code 的 compaction）。
存到 `chat_message.metadata.compaction_summary`。

#### 长期记忆：cross-session

新表 `agent_memory(scope, key, value, created_at, updated_at)`，scope 例：
- `user.preferences` — "我习惯简短回复 / 用 sign-off X"
- `sender.{email}` — 该联系人风格 / 我们历史互动
- `mailbox.outbox.style` — 抽我历史发件草稿的写作风格

写入方式：用 `memory_write(scope, key, value)` 工具让 LLM 决定写什么。**不要后台自动总结** —— LLM 知道哪些值得记。

### Phase 5 — Guards + Polish（M4，~2 天）

- max iterations / cost cap / abort 信号
- per-tool rate limit（避免 model 暴跑 search 100 次）
- cost / token tracking 同 `llm_processing` 表
- 错误 tool_result 让 model 学会自我修正
- 拒绝执行 list（"不要发 email 给 multiple_recipients_unknown_to_user"）
- 系统 prompt 模板化（每次 user msg 前注入 ctx + tools + guard rules）

## 不要做的

- ❌ **不要从零写 LLM 路由**。复用现有 `custom_api.ts` / `notion_agent.ts` 框架，加 tool layer 即可。
- ❌ **不要 fork mailagent CLI 到 frontend**。直接调 `src/electron/main/handlers/` 的现有 ipc，那一层已经是 thin wrapper 直读 SQLite + 调 outbox。
- ❌ **不要做 plugin system**。10-20 个 tool 时 hard-code 在 `tools/builtin/` 比 plugin/registry 框架好维护。等到 30+ tool 或第三方需要扩展时再抽。
- ❌ **不要让 agent 静默发邮件**。任何"会让用户被联系人看到结果"的操作必须 confirmation。
- ❌ **不要做 autonomous background agent**（"agent 凌晨自己清理收件箱"）—— 用户没要求，scope 爆炸，rollback 难。先做交互式。
- ❌ **不要把 notion_agent 包成 tool 暴露给 custom_api**（"让 Claude 调 Jarvis"）—— 双 LLM 调用炸 cost。
- ❌ **不要复制粘贴 prompts/email_inbox.md** —— 那是 mail-sync LLM 分类的 prompt，跟 chat agent 风格 / 目标完全不同。

## 关键决策点（接手前要拍板）

1. **Tool 暴露的 surface 用 IPC handler 还是 CLI subprocess？**
   - IPC handler：~ms 级延迟，schema 弱（手维护），耦合 Electron main
   - CLI subprocess：~500ms fork startup，schema 严谨（45+ JSON Schema），可独立 audit
   - **建议**：读类用 IPC（高频），写类（draft / send / archive）用 CLI（已有 long-task contract / dry-run / exit codes）
2. **Custom AI Anthropic vs OpenAI 优先级？**
   - Anthropic tool_use 协议成熟、cache_control 支持
   - OpenAI function_calling 用户基数大但增量字符串拼装麻烦
   - **建议**：M1 只做 Anthropic，OpenAI 在 M2 末加
3. **Notion Agent 怎么办？**
   - 当前 CLI 不支持 tool_use；要么 fork、要么前端劫持（让前端先调 tool 把结果塞进 enrichedPrompt 再发给 notion-agent CLI）—— 后者是过渡方案
   - **建议**：M1 不动 Notion Agent，让用户切到 Custom AI 用 tool 模式；M3 再考虑改造
4. **Memory schema 放 chat_db.ts 还是单独 DB？**
   - chat_db.ts 跟随 session 走，干净
   - 但 agent_memory 跨 session 跨 backend，跟单 session 强耦合不舒服
   - **建议**：单独表 `agent_memory` 放 chat_db.ts，schema migration v3
5. **是否做 eval harness？**
   - **强烈建议做**。20 个真实场景跑 baseline → 加 tool → 加 retrieval 各阶段对比。否则一改就退化没人知道。

## Deliverables checklist

- [ ] `docs/agent-harness-design.md` Phase 1 设计文档
- [ ] `src/electron/main/chat/tools/registry.ts` + 5+ tools 实现
- [ ] `dispatcher.ts` 改造支持多轮 tool loop + stop guards
- [ ] `custom_api.ts` Anthropic tool_use 流处理
- [ ] `MessageList.tsx` tool_call / tool_result UI（折叠卡片 + 详情展开）
- [ ] `ConfirmToolDialog` 组件 + 写类 tool 走确认流
- [ ] `chat_db.ts` schema v3 + `agent_memory` 表
- [ ] eval 集（≥ 20 场景）+ harness
- [ ] cost / token 计费集成 `llm_processing`
- [ ] CLAUDE.md 加"AI Agent Harness"段，文档当前 tool catalog + 调用方式

## 参考

- [Anthropic tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use) — schema + streaming protocol
- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — system prompt + tools 都可 cache
- [Claude Code 公开 blog](https://www.anthropic.com/news/claude-3-5-sonnet) 提到的 harness pattern
- [Cursor agent](https://www.cursor.com/blog) 系列博文 — multi-step planning
- 本仓库 `src/llm_agent/` — 邮件分类 LLM 的成熟做法（cache 命中率 95%，可借鉴 cache_control 配置）
- 本仓库 `webhook-server/app.py` 的 `search_email_bodies` event — 已经是个 agent-friendly 接口范本

## 当前 (Sprint 19 PR 前) 已 ship 的局部改动

这次 PR 改的小步骤（可视为 Sprint 19 的 Day 0 准备工作）：

| 文件 | 改动 | 用意 |
|---|---|---|
| `src/electron/main/chat/types.ts` | `EmailContext` 加 `notionPageId` | 让 Notion Agent 能定位邮件 Notion 镜像页 |
| `src/electron/main/chat/dispatcher.ts:loadEmailContext` | SQL 查 `m.notion_page_id` | 填上面字段 |
| `src/electron/main/chat/backends/notion_agent.ts:formatEmailContextHeader` | header 多输出 `internal_id / Notion page_id / Notion URL` | Notion Agent 可直接操作页面 |
| `src/electron/main/chat/backends/custom_api.ts:buildSystemPrompt` | system prompt 加 `internal_id / Notion URL` | Custom AI 能引用 Notion 链接给用户 |

这些是**短期 polish**，不是 agent harness 重构本身的内容。重构从 Phase 1 设计文档开始。
