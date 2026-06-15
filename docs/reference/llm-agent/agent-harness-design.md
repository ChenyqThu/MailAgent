# AI Agent Harness — 设计文档

> Sprint 19 起点。把 Electron 前端的 AI Chat 从 *single-turn LLM stream* 升级为 **multi-turn agentic mail agent**。
>
> 本文档配合 `/Users/chenyuanquan/.claude/plans/subagent-plan-lexical-moler.md`（路线图 + 决策依据）与 `frontend/SPRINT19-AGENT-HARNESS-HANDOFF.md`（接手要点）阅读。Plan 文档 = 决策 + 时间线；本文档 = 工程级实施指南，照着写代码用。
>
> **Owner**：Sprint 19 lead。**Status**：M1 已 ship，M2 起 Wiki 部分反转方向。
>
> ## ⚠️ 2026-05-23 M2 路径反转（plan D1 撤销 → D9 新决策）
>
> 本文档 §6 (M2 builtin tool catalog 含 wiki_* 6 个 tool) / §7 (Wiki context 4 层注入) / §10 (M3 Memory expansion) 的 **wiki 自研路径已撤销**。
>
> M2 改为接入用户已有的 **Jarvis KOS v2**（gbrain fork on mac mini @ `kos.chenge.ink` + `127.0.0.1:7225`）。原 6 个本地 wiki_* tool 改为 2 个 KOS tool（`kos_query` / `kos_digest`），ingest 路径由 mail-sync 后端独占，chat agent 只读不写。
>
> **新设计权威文档**：[`docs/kos-integration-design.md`](./kos-integration-design.md) + [`frontend/SPRINT19-M2-PLAN.md`](../../../frontend/archive/2026-05/SPRINT19-M2-PLAN.md)。
>
> 本文档 §1-§5 (M1 范围：harness loop / ToolRegistry / Anthropic tool_use SSE / chat_db v3 schema / Confirmation tier) 仍是 **M1 实施的权威 ref**，不变。§6 (M1 10 个 builtin tool catalog) 不变；§6 中 "M2 +6 个 wiki tool" 部分以下读为历史。

---

## 1. Overview

### 1.1 目标态

把 Custom AI 从 *"邮件 ctx + 一次 LLM 调用"* 升级到 *"邮件智能层"*：

```
用户："这封邮件谁应该 cc，搜下我之前是怎么处理类似邀请的"
  ↓
LLM iter 1：调 email_get_ai_fields(int_id) → 看 priority/labels
            调 email_search(subject 关键词, since=30d, sender=类似)
  ↓ tool_result
LLM iter 2：调 email_body(top 候选)
  ↓ tool_result
LLM iter 3：基于历史回复模式 → 提议 email_draft_reply(to, cc, body)
  ↓ requiresConfirmation=edit → 弹 ConfirmToolDialog
  ↓ 用户编辑 body 后 ok
工具执行：draft:createDraft IPC → Mail.app 出现 draft
LLM iter 4（可选）：观察 tool_result 返回 draftId 后 → "草稿已写好，等你审"
  ↓ stop_reason=end_turn
```

### 1.2 范围

| 模块 | M1 | M2 | M3 | M4 |
|---|---|---|---|---|
| ToolRegistry + harness loop | ✅ | — | — | guards 加强 |
| Anthropic tool_use streaming | ✅ | — | — | — |
| Confirmation 三层 tier UI | ✅ | — | — | UX 精雕 |
| 10 个 builtin tool (5 读 / 3 写 / 1 草稿 / 1 AI 字段) | ✅ | — | — | — |
| FTS5 全文搜索 tool | — | ✅ | — | — |
| 附件文本化（PDF/docx/xlsx/pptx）+ attachment_fts | — | ✅ | — | — |
| LLM Wiki（SQLite + git shadow export） | — | ✅ | — | — |
| Wiki context 注入 + cache_control 集成 | — | ✅ | — | — |
| 跨 session memory（sender / project / mailbox.outbox.style scope） | — | — | ✅ | — |
| Embedding eval gate（20-30 query，gap < 15% 永久不做） | — | — | ✅ | — |
| 后台 ralph job 抽 outbox 风格 | — | — | ✅ | — |
| per-turn cost cap / per-tool rate-limit / reject-list | — | — | — | ✅ |
| default flag flip 上线 | — | — | — | ✅ |

### 1.3 非目标

- ❌ Autonomous background agent（"凌晨自动清收件箱"）
- ❌ Plugin / 第三方 tool 系统
- ❌ Silent email send（任何外发必 confirm）
- ❌ Fork notion-agent CLI（black-box fallback only）
- ❌ Custom AI 调 notion-agent 当 tool
- ❌ 多用户 wiki sharing
- ❌ Graph DB（refs_json + SQLite self-join 邮件场景够用）

---

## 2. 当前态 vs 目标态

### 2.1 当前 baseline（Sprint 19 起点）

| 维度 | 当前实现 | 文件:行号 |
|---|---|---|
| dispatcher 编排 | 单次 `for await of backend.stream(...)`，无外循环 | `dispatcher.ts:203-310` |
| ChatStreamEvent union | `chunk / tool_call / usage / done / error` 5 个成员；`tool_call` 仅占位用作"工具日志展示" | `types.ts:72` |
| Anthropic tools[] 入参 | **不传** | `custom_api.ts` |
| tool_use SSE 解析 | 无 | `custom_api.ts` |
| chat_db schema | v2，仅 sessions + messages，无 tool_call 表、无 wiki 表 | `chat_db.ts:94-184` |
| chat backend | custom-api（Anthropic 直连）+ notion-agent（CLI 子进程） | `backends/custom_api.ts` + `backends/notion_agent.ts` |
| prompt caching | backend Python 侧 `processor.py:46-66, 141-199` 命中 95%；前端 chat 路径**未配置** | — |
| FTS5 邮件正文搜索 | `EmailRepository.search_email_bodies()` + webhook `search_email_bodies` event；前端 chat 路径**未用** | `src/repository/email_repository.py:527-612` |
| 跨 session memory | **无** | — |
| 附件文本化 | 仅 docx/pptx→PDF + xlsx→CSV（无文本提取入 FTS） | `src/converter/office_converter.py` |
| embedding / vector | **无**（仓库 grep 0 结果） | — |

### 2.2 目标态（P4 完成时）

| 维度 | 目标实现 |
|---|---|
| dispatcher 编排 | multi-turn while 循环（MAX_ITER=8 / MAX_COST_USD_PER_TURN=0.5），含 abort + cost cap + per-tool throttle |
| ChatStreamEvent union | 加 `tool_use / tool_result / pending_confirmation`，`done` 加 `stopReason` |
| Anthropic tools[] | 传 `registry.toAnthropicSchema()` 完整 array |
| tool_use SSE 解析 | content_block_start(tool_use) + input_json_delta 累积 + content_block_stop yield ToolUseEvent |
| chat_db schema | v3，加 `chat_tool_call`、`wiki_pages`、`wiki_fts`、`agent_memory_kv` 4 表 |
| 工具 dispatch | ToolRegistry + 16 个 builtin tool（10 M1 + 6 M2）+ 读并行 / 写串行 / 用户编辑 input 持久化 |
| Confirmation | 三层 tier (silent / preview / edit)，UI 弹 `ConfirmToolDialog` |
| Wiki | SQLite `wiki_pages` 表 + `wiki_fts` 全文搜索 + L1 hot block cache_control |
| FTS5 + 中文 | smart wrapper（CJK auto `*`）+ 附件文本独立 `email_attachment_fts` |
| Memory | sender / project / mailbox scope + 自驱写入 + 用户可手编 |
| cost telemetry | per-turn cost track + UI 实时显示 + 日均报告 |

---

## 3. 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Renderer (React, ipc client)                      │
│  AIChatPanel → MessageList → ToolCallRow / ConfirmToolDialog         │
│  chat:start IPC ⇄ chat:stream IPC subscribe ⇄ chat:confirmTool IPC   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ IPC
┌──────────────────────────────────▼──────────────────────────────────┐
│                Main process (Electron, node, sqlite)                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ handlers/chat.ts                                                │ │
│  │   chat:start / chat:confirmTool / chat:retryTool / chat:list*  │ │
│  └────────────────────┬───────────────────────────────────────────┘ │
│                       │                                              │
│  ┌────────────────────▼───────────────────────────────────────────┐ │
│  │ chat/dispatcher.ts → runStream (Sprint 19 重写)                │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │ while (iter < MAX_ITER && !aborted)                      │ │ │
│  │  │   collected = []                                          │ │ │
│  │  │   for await ev of backend.stream({ tools, history, ... })│ │ │
│  │  │     case 'chunk' / 'usage' / 'done' → forward             │ │ │
│  │  │     case 'tool_use' → collected.push                      │ │ │
│  │  │   if endTurn || collected.length === 0 → return           │ │ │
│  │  │   if cost > cap → forwardError(E_COST_BUDGET)             │ │ │
│  │  │   results = await dispatchTools(collected, ctx)           │ │ │
│  │  │   history = appendToolResults(history, collected, results)│ │ │
│  │  │ end loop                                                  │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────┬──────────────────┬─────────────────────────┘ │
│                       │                  │                            │
│            ┌──────────▼──────┐  ┌────────▼──────────┐                │
│            │ backends/       │  │ tools/dispatch.ts │                │
│            │  custom_api.ts  │  │ + ConfirmGate     │                │
│            │  (Anthropic     │  │ + Throttle        │                │
│            │   tool_use SSE) │  └────────┬──────────┘                │
│            └─────────────────┘           │                            │
│                                  ┌───────▼────────┐                  │
│                                  │ tools/registry │                  │
│                                  │ ToolDef catalog│                  │
│                                  └───────┬────────┘                  │
│                                          │                            │
│                          ┌───────────────┼────────────────┐          │
│                          ▼               ▼                ▼          │
│                  builtin/email.ts  builtin/write.ts builtin/wiki.ts  │
│                          │               │                │          │
│         handlers/email.ts│  handlers/write_ops.ts │  wiki/store.ts  │
│              (IPC direct)│  (IPC direct + outbox) │   (wiki_pages   │
│                          │                        │    DB CRUD)     │
│                          ▼                        ▼                  │
│              ┌─────────────────────────────────────────┐             │
│              │ ~/.mailagent/frontend/ai_chat.db (v3)   │             │
│              │   ai_chat_sessions / ai_chat_messages   │             │
│              │   chat_tool_call (audit)                │             │
│              │   wiki_pages + wiki_fts + memory_kv     │             │
│              └─────────────────────────────────────────┘             │
│                                                                      │
│              ┌─────────────────────────────────────────┐             │
│              │ data/sync_store.db (mail-sync 共享)     │             │
│              │   email_metadata / email_body / FTS5    │             │
│              │   email_attachment_text + att_fts (新)  │             │
│              └─────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 4. 核心组件设计

### 4.1 ToolRegistry interface

**文件**：`frontend/src/electron/main/chat/tools/registry.ts`（新）

```typescript
import type { ToolDef, ToolCategory } from './types'

export type ToolCategory = 'read' | 'write' | 'notion' | 'meta' | 'wiki'
export type ToolSurface = 'ipc' | 'cli' | 'webhook'
export type ConfirmationTier = 'silent' | 'preview' | 'edit'

export interface ToolDef<I = unknown, O = unknown> {
  /** snake_case, Anthropic tool name 字段 */
  name: string
  /**
   * LLM 看的"何时该用"描述。≤80 token。
   * 必须 actionable："当用户问 X 时调用"。不要写实现细节。
   */
  description: string
  /** JSON Schema (Draft-07 子集 Anthropic 兼容)。用于 LLM 入参约束 + 服务端 ajv 校验 */
  inputSchema: Record<string, unknown>
  /** 可选。用于前端 preview 渲染 + post-hoc 校验 */
  outputSchema?: Record<string, unknown>
  /** silent → 静默执行；preview → 弹 dialog 让用户 ok/cancel；edit → 弹 dialog + 可编辑 input 后 ok */
  confirmationTier: ConfirmationTier
  category: ToolCategory
  surface: ToolSurface
  /** 默认 10000，超时丢 ToolResult { ok:false, code:'E_TIMEOUT' } */
  timeoutMs?: number
  /** 默认 30。每个 session 每分钟最多调几次。超限丢 E_THROTTLED */
  throttlePerMinute?: number
  /** 实际执行函数 */
  handler: (input: I, ctx: ToolExecCtx) => Promise<ToolResult<O>>
}

export interface ToolExecCtx {
  sessionId: number
  emailId: number | null
  /** 抽到 chat session 的 abort signal。tool handler 必须传给底层 fetch / db query */
  signal: AbortSignal
  /** confirmation tier=edit 时用户改过的 input。silent/preview 为 undefined */
  userEditedInput?: unknown
}

export type ToolResult<O = unknown> =
  | { ok: true; output: O; durationMs: number; truncated?: boolean }
  | { ok: false; code: string; message: string; durationMs: number }

export class ToolRegistry {
  private byName = new Map<string, ToolDef>()

  register(def: ToolDef): void {
    if (this.byName.has(def.name)) {
      throw new Error(`Tool ${def.name} already registered`)
    }
    this.byName.set(def.name, def)
  }

  get(name: string): ToolDef | undefined {
    return this.byName.get(name)
  }

  list(filter?: { categories?: ToolCategory[] }): ToolDef[] {
    const all = [...this.byName.values()]
    if (!filter?.categories) return all
    const set = new Set(filter.categories)
    return all.filter(t => set.has(t.category))
  }

  /** Anthropic /v1/messages 用的 tools[] 形态 */
  toAnthropicSchema(filter?: { categories?: ToolCategory[] }) {
    return this.list(filter).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    }))
  }

  /** OpenAI Chat Completions 用的 tools[]（function calling）形态 */
  toOpenAISchema(filter?: { categories?: ToolCategory[] }) {
    return this.list(filter).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }))
  }
}

/** App boot 时注册的单例。tests 用 createToolRegistry() 拿新 instance mock。 */
export const defaultToolRegistry = new ToolRegistry()

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry()
}
```

**注册时机**：`frontend/src/electron/main/index.ts` 在 `registerChatBackend(...)` 之后，调 `registerBuiltinTools(defaultToolRegistry)`（PR-1b 实现）。

### 4.2 Harness Loop state machine

**文件**：新建 `frontend/src/electron/main/chat/harness.ts`（PR-1d），`dispatcher.ts:runStream` 重构为薄壳调 harness 内的 `runHarness()`。

```typescript
// chat/harness.ts
const MAX_ITER = 8
const MAX_COST_USD_PER_TURN = 0.5
const MAX_TOOLS_PER_TURN = 4   // Anthropic 单 message 多 tool_use 时上限

interface RunHarnessArgs {
  sessionId: number
  assistantMessageId: number
  backend: ChatBackend
  registry: ToolRegistry
  initialHistory: ChatMessage[]
  model: string | null
  agentPageId: string | null
  emailContext: EmailContext | null
  ac: AbortController
  sink: StreamSink
}

export async function runHarness(args: RunHarnessArgs): Promise<void> {
  const { sessionId, assistantMessageId, backend, registry, ac, sink } = args
  let history = args.initialHistory
  let iter = 0
  let costUsd = 0

  // 单 backend 不支持 tools → 走 legacy single-turn
  if (!backendSupportsTools(backend.kind) || !isHarnessEnabled()) {
    return runStreamLegacy(args)
  }

  function forward(ev: ChatStreamEvent): void {
    sink.send({ sessionId, messageId: assistantMessageId, event: ev })
  }

  while (iter++ < MAX_ITER && !ac.signal.aborted) {
    const collected: ToolUseEvent[] = []
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
    let buffer = ''
    let lastUsage: UsageEvent | null = null

    try {
      for await (const ev of backend.stream({
        history,
        model: args.model,
        agentPageId: args.agentPageId,
        emailContext: args.emailContext,
        tools: registry.toAnthropicSchema(),
        signal: ac.signal
      })) {
        if (ac.signal.aborted) break
        switch (ev.type) {
          case 'chunk':
            buffer += ev.delta
            updateMessage(assistantMessageId, { content: buffer })
            forward(ev)
            break
          case 'tool_use':
            collected.push(ev)
            // 不直接 forward —— 等 dispatch 时才发 tool_result envelope
            persistToolUse(sessionId, assistantMessageId, ev)
            break
          case 'usage':
            lastUsage = ev
            costUsd += ev.costUsd ?? 0
            forward(ev)
            break
          case 'done':
            stopReason = ev.stopReason ?? 'end_turn'
            // 累计 partial content 到 message row
            updateMessage(assistantMessageId, {
              content: ev.finalContent || buffer,
              tokensInput: lastUsage?.inputTokens,
              tokensOutput: lastUsage?.outputTokens,
              costUsd: lastUsage?.costUsd,
              model: ev.model
              // status 暂不设 complete，可能还有下轮
            })
            forward(ev)
            break
          case 'error':
            forward(ev)
            updateMessage(assistantMessageId, { status: 'error', errorMessage: ev.message })
            return
        }
      }
    } catch (err) {
      if (ac.signal.aborted) {
        abortStreamingMessages(sessionId)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      forward({ type: 'error', code: 'E_BACKEND_CRASH', message })
      updateMessage(assistantMessageId, { status: 'error', errorMessage: message })
      return
    }

    // 终止条件
    if (ac.signal.aborted) {
      abortStreamingMessages(sessionId)
      return
    }
    if (stopReason === 'end_turn' || collected.length === 0) {
      updateMessage(assistantMessageId, { status: 'complete' })
      return
    }
    if (costUsd > MAX_COST_USD_PER_TURN) {
      forward({ type: 'error', code: 'E_COST_BUDGET',
        message: `turn exceeded $${MAX_COST_USD_PER_TURN.toFixed(2)} cap` })
      updateMessage(assistantMessageId, { status: 'error', errorMessage: 'cost cap' })
      return
    }
    if (collected.length > MAX_TOOLS_PER_TURN) {
      forward({ type: 'error', code: 'E_TOO_MANY_TOOLS',
        message: `model proposed ${collected.length} tools (max ${MAX_TOOLS_PER_TURN})` })
      return
    }

    // Dispatch tools（含 confirmation 阻塞、throttle、timeout）
    const results = await dispatchTools(collected, {
      sessionId,
      emailId: args.emailContext?.internalId ?? null,
      signal: ac.signal
    }, registry, sink, sessionId, assistantMessageId)

    if (ac.signal.aborted) {
      abortStreamingMessages(sessionId)
      return
    }

    // 拼接 history：assistant 这轮的 content 块 + tool_use 块 + 下一 user 块（tool_result）
    history = appendToolResultsToHistory(history, assistantMessageId, collected, results)
  }

  // 走到这里 = MAX_ITER 用完
  forward({ type: 'error', code: 'E_MAX_ITER',
    message: `harness exceeded ${MAX_ITER} iterations without end_turn` })
  updateMessage(assistantMessageId, { status: 'error', errorMessage: 'max iter' })
}
```

**关键约束**：
- 每 iter 累积所有 tool_use 一起 dispatch（Anthropic 单条 assistant message 可含多个 tool_use block）
- 读类 tool 用 `Promise.all` 并行；写类 tool 串行（避免同一邮件并发改 flag 状态竞态）
- confirmation tier=preview/edit 时 dispatch 阻塞等用户 IPC `chat:confirmTool` 返回（见 §4.6）
- 每 iter 重新走 backend.stream（不复用 SSE 连接）—— Anthropic API 协议要求每轮 fresh request
- `appendToolResultsToHistory` 必须保留 `tool_use_id` 跨轮稳定（Anthropic 要求 `tool_result.tool_use_id` 完全匹配）

### 4.3 Anthropic tool_use SSE 解析

**文件**：改 `frontend/src/electron/main/chat/backends/custom_api.ts:anthropicStream`

**Request body 改造**：
```typescript
const body = {
  model: resolvedModel,
  system: buildSystemPromptBlocks(emailContext),  // 改：返回 Array<TextBlock> 而非 string
  messages: buildMessagesFromHistory(history),
  max_tokens: 4096,
  stream: true,
  tools: tools.length > 0 ? tools : undefined  // 空 array Anthropic 拒
}
```

**SSE event handling 新增**（在现有 `content_block_delta` text 处理旁边）：

```typescript
// 累积 in-flight tool_use blocks，indexed by SSE `index`
const pendingToolBlocks = new Map<number, { id: string; name: string; jsonStr: string }>()
let messageStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null

// content_block_start: { content_block: { type:'tool_use', id:'toolu_xx', name:'email_search', input:{} } }
case 'content_block_start': {
  const block = parsed.content_block
  if (block?.type === 'tool_use') {
    pendingToolBlocks.set(parsed.index, {
      id: block.id, name: block.name, jsonStr: ''
    })
    // 可选：yield 一个 'tool_use_start' event 给 UI 早早显示 spinner
  }
  break
}

// content_block_delta: { delta: { type:'input_json_delta', partial_json:'...' } }
case 'content_block_delta': {
  const delta = parsed.delta
  if (delta?.type === 'input_json_delta') {
    const rec = pendingToolBlocks.get(parsed.index)
    if (rec) rec.jsonStr += delta.partial_json
  } else if (delta?.type === 'text_delta') {
    // 现有 text chunk 路径不变
    yield { type: 'chunk', delta: delta.text }
  }
  break
}

// content_block_stop: index 指向某个 block，可能是 text 或 tool_use
case 'content_block_stop': {
  const rec = pendingToolBlocks.get(parsed.index)
  if (rec) {
    let input: unknown = {}
    try {
      input = rec.jsonStr.trim() === '' ? {} : JSON.parse(rec.jsonStr)
    } catch (err) {
      // 流式 JSON 偶尔残缺：用 lenient parse 或 fallback
      input = { __parse_error: String(err), __raw: rec.jsonStr }
    }
    yield {
      type: 'tool_use',
      toolUseId: rec.id,
      name: rec.name,
      input
    }
    pendingToolBlocks.delete(parsed.index)
  }
  break
}

// message_delta: { delta: { stop_reason:'tool_use', stop_sequence:null }, usage: {...} }
case 'message_delta': {
  const delta = parsed.delta
  if (delta?.stop_reason) messageStopReason = delta.stop_reason
  if (parsed.usage) {
    // Anthropic usage 在 message_delta 给最终值，partial 在 message_start
    // 这里更新累计 usage
  }
  break
}

case 'message_stop': {
  yield {
    type: 'done',
    finalContent: accumulatedText,
    model: resolvedModel,
    stopReason: messageStopReason ?? 'end_turn',
    metadata: null
  }
  break
}
```

**Prompt cache 配置**（保护 95% 命中率）：

```typescript
const tools = registry.toAnthropicSchema()
// 在最后一个 tool 加 cache_control
if (tools.length > 0) {
  tools[tools.length - 1] = {
    ...tools[tools.length - 1],
    cache_control: { type: 'ephemeral' as const }
  }
}

// system blocks 也在最后一个加 cache_control
const systemBlocks = [
  { type: 'text', text: STATIC_PROMPT },
  { type: 'text', text: HOT_WIKI_BLOCK },   // L1 hot wiki（M2 才有）
  // L2 conditional 不加 cache
  { type: 'text', text: emailContextText }
]
systemBlocks[systemBlocks.length - 1] = {
  ...systemBlocks[systemBlocks.length - 1],
  cache_control: { type: 'ephemeral' as const }
}
```

**为什么双 cache_control**：tools[] 与 system[] 是两个独立 prefix segment，Anthropic 服务端各自 hash；都加 breakpoint 才能让两段都命中 cache。M1 阶段 HOT_WIKI_BLOCK 还不存在，只在 STATIC_PROMPT 末加一个即可。

### 4.4 ChatStreamEvent union 扩展

**文件**：`frontend/src/electron/main/chat/types.ts`

```typescript
// 现有保留
export interface ChunkEvent { type: 'chunk'; delta: string }
export interface ToolCallEvent { /* 现有，仅 notion-agent CLI 内部日志展示用，agent harness 不发 */ }
export interface UsageEvent { /* 现有 */ }
export interface ErrorEvent { /* 现有 */ }

// 新增 — agent harness 用
export interface ToolUseEvent {
  type: 'tool_use'
  /** Anthropic toolu_xxx，跨轮 history 必须稳定（用 chat_tool_call.tool_use_id 持久化） */
  toolUseId: string
  name: string
  input: unknown
}

export interface ToolResultEvent {
  type: 'tool_result'
  toolUseId: string
  status: 'ok' | 'error' | 'canceled'
  output?: unknown
  errorMessage?: string
  durationMs: number
}

export interface PendingConfirmationEvent {
  type: 'pending_confirmation'
  toolUseId: string
  toolName: string
  input: unknown
  preview?: string  // 1 行 human-readable 摘要
  tier: 'preview' | 'edit'
}

// 改造 — 加 stopReason
export interface DoneEvent {
  type: 'done'
  finalContent: string
  model: string | null
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens'  // 新增
  metadata?: Record<string, unknown> | null
}

export type ChatStreamEvent =
  | ChunkEvent
  | ToolCallEvent
  | ToolUseEvent
  | ToolResultEvent
  | PendingConfirmationEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent
```

**注意**：`ToolCallEvent`（现有）与 `ToolUseEvent`（新）**不是同一概念**：
- `ToolCallEvent` 是 notion-agent 后端在跑自己内部工具时给 UI 的日志摘要（status/duration/detail），仅占位
- `ToolUseEvent` 是 agent harness 路径中 LLM 真的提议调工具，dispatcher 据此 dispatch

**ChatStreamRequest 改造**：加 `tools?: ToolDef[]` 入参

```typescript
export interface ChatStreamRequest {
  // ... 现有字段
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
}
```

backend 实现根据 kind 决定如何用：
- `custom-api` (Anthropic)：透传给 /v1/messages 的 tools field
- `notion-agent` (CLI)：忽略（CLI 不支持 tool_use）

### 4.5 chat_db schema v3

**文件**：`frontend/src/electron/main/chat_db.ts`

```typescript
const CHAT_DB_VERSION = 3

// migrate() 加分支
if (current < 3) {
  db.exec(`
    -- tool call audit table
    CREATE TABLE chat_tool_call (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_json TEXT NOT NULL,
      user_edited_input_json TEXT,
      output_json TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('pending', 'confirmed', 'running', 'ok', 'error', 'canceled')),
      duration_ms INTEGER,
      confirmation_tier TEXT NOT NULL CHECK (confirmation_tier IN
        ('silent', 'preview', 'edit')),
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (message_id, tool_use_id)
    );
    CREATE INDEX idx_tool_call_message ON chat_tool_call(message_id);
    CREATE INDEX idx_tool_call_status_pending
      ON chat_tool_call(status)
      WHERE status IN ('pending', 'confirmed', 'running');

    -- LLM Wiki tables (M2 才用，v3 一次性建好留位避免后续二次 migration)
    CREATE TABLE wiki_pages (
      path TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      slug TEXT,
      body_markdown TEXT NOT NULL,
      refs_json TEXT,
      source_messages_json TEXT,
      updated_by TEXT NOT NULL DEFAULT 'agent',
      mtime_ns INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_wiki_scope_slug ON wiki_pages(scope, slug);

    -- FTS5 contentful mode: column names match content table to enable
    -- auto-join on SELECT. See src/mail/sync_store.py:471 (email_body_fts).
    CREATE VIRTUAL TABLE wiki_fts USING fts5(
      path UNINDEXED,
      body_markdown,
      content='wiki_pages',
      content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
      INSERT INTO wiki_fts(rowid, path, body) VALUES (new.rowid, new.path, new.body_markdown);
    END;
    CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
      INSERT INTO wiki_fts(wiki_fts, rowid, path, body) VALUES('delete', old.rowid, old.path, old.body_markdown);
    END;
    CREATE TRIGGER wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
      INSERT INTO wiki_fts(wiki_fts, rowid, path, body) VALUES('delete', old.rowid, old.path, old.body_markdown);
      INSERT INTO wiki_fts(rowid, path, body) VALUES (new.rowid, new.path, new.body_markdown);
    END;

    CREATE TABLE agent_memory_kv (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source_wiki_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
  `)
}
```

**新增 CRUD 接口**（添加到 `chat_db.ts`）：

```typescript
// chat_tool_call CRUD
export interface ChatToolCall {
  id: number
  message_id: number
  tool_use_id: string
  tool_name: string
  input_json: string
  user_edited_input_json: string | null
  output_json: string | null
  status: 'pending' | 'confirmed' | 'running' | 'ok' | 'error' | 'canceled'
  duration_ms: number | null
  confirmation_tier: 'silent' | 'preview' | 'edit'
  confirmed_at: number | null
  created_at: number
  updated_at: number
}
export function appendToolCall(input: {
  messageId: number; toolUseId: string; toolName: string;
  inputJson: string; confirmationTier: 'silent'|'preview'|'edit'
}): ChatToolCall
export function updateToolCall(toolCallId: number, patch: {
  status?: ChatToolCall['status']; outputJson?: string;
  durationMs?: number; userEditedInputJson?: string; confirmedAt?: number
}): void
export function listToolCallsForMessage(messageId: number): ChatToolCall[]
export function getToolCallByUseId(messageId: number, toolUseId: string): ChatToolCall | null

// wiki_pages CRUD (M2 才用，v3 schema 建好备用)
// agent_memory_kv CRUD (M2/M3 用)
```

### 4.6 Confirmation 三层 tier

| Tier | 何时用 | 例 tool | UX |
|---|---|---|---|
| `silent` | 纯读，无副作用，无 token 炸开风险 | email_get / email_body / email_search / wiki_read | 自动执行，UI 只显示折叠卡片 |
| `preview` | 可逆写、低 stake 状态变 | email_flag / email_archive / wiki_write（首次每 path） | 弹 ConfirmToolDialog 展示 input + 1 句话摘要，OK/Cancel |
| `edit` | 外发邮件 / 不可逆 / 高 stake | email_draft_reply / email_send / notion_relation_create | 弹 ConfirmToolDialog 展示 + 可编辑（如改 body 文本），OK/Cancel |

**confirmation 流程**：

```
dispatcher 收 ToolUseEvent → registry.get(name).confirmationTier?
  ├─ silent → 直接 invoke handler
  ├─ preview → 
  │   1. chat_tool_call.status = 'pending'
  │   2. forward PendingConfirmationEvent { tier:'preview' }
  │   3. 阻塞 on Promise registered in _pendingConfirms.get(toolUseId)
  │   4. 用户点 OK → IPC chat:confirmTool({ toolUseId, approved:true }) → Promise resolve
  │   5. handler 执行
  │   6. chat_tool_call.status = 'ok' / 'error' + output_json + duration_ms
  └─ edit → 同 preview 但
      4. 用户改了 input → IPC payload { toolUseId, approved:true, editedInput }
      5. chat_tool_call.user_edited_input_json = JSON(editedInput)
      6. tool result 注入 LLM 时含 { user_edited:true, original_input, final_input }
```

**IPC handler 新增**（`frontend/src/electron/main/handlers/chat.ts`）：

```typescript
ipcMain.handle('chat:confirmTool', async (_, { toolUseId, approved, editedInput }: {
  toolUseId: string
  approved: boolean
  editedInput?: unknown
}) => {
  const resolver = _pendingConfirms.get(toolUseId)
  if (!resolver) return { ok: false, error: 'not_pending' }
  _pendingConfirms.delete(toolUseId)
  resolver({ approved, editedInput })
  return { ok: true }
})

ipcMain.handle('chat:retryTool', async (_, { toolUseId }: { toolUseId: string }) => {
  // 重新触发同一 toolUseId 的 dispatch（不走 LLM 重新提议），用于 E_TIMEOUT / E_NETWORK 一次性故障
})
```

`_pendingConfirms: Map<toolUseId, (resp:{approved,editedInput?}) => void>` 在 harness.ts module-level 维护。session abort 时全部 reject 为 `E_ABORTED`。

### 4.7 Wiki context 4 层注入（M2）

```typescript
// L0 静态：永不变
const STATIC_PROMPT = `You are a mail agent. You have these tools: ...`

// L1 hot wiki：用户偏好 + index.md。≤ 6KB，mtime 变才 invalidate
const HOT_WIKI_BLOCK = WikiLoader.getHotBlock()
// 内含：
//   wiki/user/preferences.md 全文
//   wiki/index.md 全文（每页 1 行：path + scope + mtime + summary）

// L2 conditional：当前邮件 + 关联 sender/project wiki。session-specific 不 cache
const CONDITIONAL_BLOCK = buildConditionalBlock(emailContext)
// 内含：
//   当前邮件 markdown
//   wiki/sender/{from-slug}.md (如存在)
//   wiki/project/{auto-detect-slug}.md (基于邮件主题关键词模糊匹配)

// L3 LLM 自驱：LLM 调 wiki_read tool 按需拉。tool_result 进 message history 自然 cache

system: [
  { type: 'text', text: STATIC_PROMPT },
  { type: 'text', text: HOT_WIKI_BLOCK },
  { type: 'text', text: CONDITIONAL_BLOCK, cache_control: { type: 'ephemeral' } }
]
```

**cache_control 策略**（极端关键，保护 95% 命中率）：

- L0 + L1 拼一起作为稳定 prefix
- 在 L2 末尾插单 breakpoint cache_control，覆盖整个 L0+L1+L2 前缀
- 等等——L2 是 session-specific 会变！怎么 cache？

**修正方案**：

```typescript
system: [
  { type: 'text', text: STATIC_PROMPT + '\n\n' + HOT_WIKI_BLOCK,
    cache_control: { type: 'ephemeral' } },   // 单 breakpoint，覆盖 L0+L1
  { type: 'text', text: CONDITIONAL_BLOCK }   // L2 不加 cache_control，每 session 新
]
```

也就是合并 L0+L1 成一个稳定 block 加 cache_control；L2 作为第二个 block 不 cache。Anthropic 服务端 prefix match 时会从前往后找最长稳定 prefix；L0+L1 命中后 L2 自然走 fresh compute（这是 OK 的，因为 L2 内容本来就动）。

**WikiLoader 实现**（mtime-aware，类似 `src/llm_agent/prompt_loader.py:27-62`）：

```typescript
class WikiLoader {
  private cached: { mtime: number; block: string } | null = null

  getHotBlock(): string {
    const db = getChatDb()
    const row = db.prepare(`
      SELECT MAX(mtime_ns) AS m FROM wiki_pages
      WHERE path IN ('user/preferences.md', 'index.md')
    `).get() as { m: number | null }
    const mtime = row.m ?? 0

    if (this.cached?.mtime === mtime) return this.cached.block

    const prefs = db.prepare(`SELECT body_markdown FROM wiki_pages WHERE path='user/preferences.md'`)
      .get() as { body_markdown: string } | undefined
    const index = generateWikiIndex(db)  // 自动从 wiki_pages 表生成目录
    const block = `## User Preferences\n${prefs?.body_markdown ?? '(empty)'}\n\n## Wiki Index\n${index}`

    this.cached = { mtime, block }
    return block
  }

  invalidate(): void {  // wiki_write tool 后调用
    this.cached = null
  }
}
```

---

## 5. M1 Builtin Tool Catalog（10 个）

下表所有 tool 的 `inputSchema` 见 §7 详细列。

| # | Name | Surface（依赖） | Tier | Category | Description (LLM 看) |
|---|---|---|---|---|---|
| 1 | `email_search` | IPC `email:search` | silent | read | 按 subject / sender / date 搜邮件，返回 internal_id 列表 + 关键元数据 |
| 2 | `email_get` | IPC `email:get` | silent | read | 取单封邮件元数据（subject/sender/date/has_attachments）by internal_id |
| 3 | `email_body` | IPC `email:body` | silent | read | 读单封邮件 markdown 正文，可选 max_chars 截断（默认 12000） |
| 4 | `email_list_thread` | IPC `email:listByThread` | silent | read | 列同一线程下所有邮件 by thread_id |
| 5 | `email_search_fulltext` | IPC `email:search` (q) | silent | read | FTS5 全文搜索邮件正文，支持 boolean / phrase / 前缀通配 |
| 6 | `email_get_ai_fields` | IPC `email:aiFields` | silent | read | 取 LLM 已分类的 AI 字段（priority/labels/language/summary） |
| 7 | `attachment_list` | IPC `attachment:list` | silent | read | 列附件（filename/mime/size）by internal_id |
| 8 | `email_flag` | IPC `email:flag` (writeFlagDirect) | preview | write | 改 isRead / isFlagged / processingStatus（Sprint 16 outbox SSoT 路径） |
| 9 | `email_archive` | IPC `email:flag` processingStatus='archived' | preview | write | 归档邮件（设 processingStatus='archived'），从 inbox 视图移出 |
| 10 | `email_draft_reply` | IPC `draft:createDraft` | edit | write | 在 Mail.app 创建回复草稿。LLM 提供 to / subject / body_markdown，preview 让用户改 |

**tool description 风格示例**（≤ 80 token，actionable）：

```
✅ Good (email_search):
"Search emails by subject keyword, sender, or date range. Returns up to 50
matching internal_id with subject + sender + date snippet. Use when user
asks 'find emails from X about Y' or 'show me last week's mail from Z'."

❌ Bad (太底层):
"Calls IPC email:search handler which queries email_metadata table with
SQL LIKE on subject/sender fields, ordered by date_received DESC, ..."
```

---

## 6. M2 Builtin Tool Catalog（+6 个）

| # | Name | Surface | Tier | Category | Description |
|---|---|---|---|---|---|
| 11 | `email_search_attachments` | IPC new | silent | read | FTS5 搜附件文本（PDF/docx/xlsx/pptx），返回 attachment_id + internal_id + snippet |
| 12 | `wiki_read` | DB direct | silent | wiki | 读 wiki page by path（如 `sender/alice_acme_com.md`） |
| 13 | `wiki_list_index` | DB direct | silent | wiki | 列所有 wiki page + 1 行摘要 + scope + mtime |
| 14 | `wiki_search` | DB direct (wiki_fts) | silent | wiki | 全文搜 wiki 内容，返回 path + snippet + bm25 |
| 15 | `wiki_write` | DB direct | preview（首次/path） | wiki | 写 wiki page（replace/append/prepend）。LLM 提供 path + body |
| 16 | `wiki_link` | DB direct | silent | wiki | 在 wiki page 之间建双向引用（refs_json 维护） |

**`wiki_write` confirmation 特殊规则**：
- 首次写某 path → `preview` tier 必弹 dialog
- 用户在 dialog 勾"信任此 scope"（如 `sender/*`）→ 该 scope 后续写自动 `silent`
- 但 `rules/*`、`user/preferences.md`、`user/signature.md` 三个**永远** preview，不接受 silent

---

## 7. Tool inputSchema 详例（前 3 个，其余照葫芦画瓢）

### email_search

```json
{
  "type": "object",
  "properties": {
    "subject_contains": {
      "type": "string",
      "description": "Substring to match in subject (case-insensitive). Optional."
    },
    "sender_contains": {
      "type": "string",
      "description": "Substring to match in sender email or name. Optional."
    },
    "mailbox": {
      "type": "string",
      "enum": ["收件箱", "发件箱"],
      "description": "Limit to mailbox. Default: 收件箱."
    },
    "since": {
      "type": "string",
      "format": "date",
      "description": "ISO date (YYYY-MM-DD). Only emails on or after this date."
    },
    "until": {
      "type": "string",
      "format": "date",
      "description": "ISO date (YYYY-MM-DD). Only emails on or before this date."
    },
    "is_flagged": {
      "type": "boolean",
      "description": "Filter by flag status."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 20
    }
  },
  "required": []
}
```

### email_get

```json
{
  "type": "object",
  "properties": {
    "internal_id": {
      "type": "integer",
      "description": "The email's internal_id (SQLite ROWID = Mail.app id)."
    },
    "include_body": {
      "type": "boolean",
      "default": false,
      "description": "Whether to include markdown body in response. Use email_body for body only."
    }
  },
  "required": ["internal_id"]
}
```

### email_draft_reply

```json
{
  "type": "object",
  "properties": {
    "internal_id": {
      "type": "integer",
      "description": "The email to reply to. Sets thread relationship + subject prefix."
    },
    "body_markdown": {
      "type": "string",
      "description": "Reply body in markdown. Supports **bold**, *italic*, lists, code, links. User will see this in a confirmation dialog and can edit before sending."
    },
    "additional_to": {
      "type": "array",
      "items": { "type": "string", "format": "email" },
      "description": "Optional additional To recipients (beyond auto-derived from original sender)."
    },
    "additional_cc": {
      "type": "array",
      "items": { "type": "string", "format": "email" }
    }
  },
  "required": ["internal_id", "body_markdown"]
}
```

---

## 8. Env Flag Inventory

| Flag | 默认 | 作用 | 默认翻转时机 |
|---|---|---|---|
| `MAILAGENT_AGENT_HARNESS` | `0` | harness 主开关。0 → 走 legacy single-turn runStream。1 → 走多轮 harness loop | P4 翻 `1` |
| `MAILAGENT_AGENT_WIKI` | `0` | L1 hot wiki block 注入 + wiki_* tool 暴露给 LLM | P4 翻 `1` |
| `AGENT_ATTACHMENT_FTS` | `0` | 附件 FTS 触发器（提取 + 索引） | P4 翻 `1` |
| `MAILAGENT_AGENT_VECTOR` | `0` | embedding RRF 融合检索 | M3 eval gate 过才开 |
| `AGENT_MEMORY_AUTOWRITE` | `0` | LLM 自驱 wiki_write 允许（关掉 = 只 user 手写） | P4 评估后决定 |
| `AGENT_MAX_ITER` | `8` | harness 单 turn 最大循环次数 | — |
| `AGENT_MAX_COST_USD` | `0.5` | harness 单 turn 最大 LLM 成本 | — |

**读取位置**：`frontend/src/electron/main/config/agent_config.ts`（新建，集中 env 读取），各模块 import getAgentConfig() 用。

---

## 9. Rollback & Feature Flag 测试矩阵

| 场景 | 操作 | 期望行为 |
|---|---|---|
| harness 关 | `MAILAGENT_AGENT_HARNESS=0` 启动 | dispatcher.runStream 走 legacy 路径，与 Sprint 18 行为一致；chat_tool_call 表为空 |
| harness 开但 backend=notion-agent | 用户在 BackendSelector 选 Notion Agent | dispatcher 检测到 backend.kind === 'notion-agent' → 走 legacy single-turn（CLI 不支持 tool_use） |
| harness 开 backend=custom-api 但 tools 空 | registry 未注册任何 tool | backend stream 时 tools 参数省略，Anthropic 回 `stop_reason='end_turn'`，harness 一轮返回 |
| harness 开 + tools 有但 LLM 不调 | 用户问"hi" | LLM 直接回，stop_reason='end_turn'，harness 一轮返回 |
| harness 开 + tool 调用一次后结束 | 用户问"列我最近 5 封邮件" | iter 1: tool_use email_search → dispatch → tool_result；iter 2: assistant 回文字 + stop_reason='end_turn' |
| harness 开 + MAX_ITER 到顶 | LLM 死循环调 search | iter 8 末 forward E_MAX_ITER error event |
| harness 开 + 用户 cancel confirmation | 提议 email_flag 用户点 cancel | tool_result 返 `{ok:false, code:'E_USER_CANCELED'}` 给 LLM；LLM iter 2 处理（通常会回"OK 不改"） |
| harness 开 + 用户 abort（关 panel） | 切换邮件 | ac.signal 触发，所有 pending tool reject E_ABORTED；assistant message status='aborted' |

---

## 10. M3 / M4 摘要（占位，详见 plan file）

### M3：Memory expansion + Embedding eval

- 加 wiki tool 真正写入路径：sender / project / mailbox.outbox.style scope
- 后台 ralph job（独立进程或 Electron 后台 timer）每周一次抽 outbox 风格更新 mailbox.outbox.style
- Settings 页加 `WikiBrowser.tsx` 让用户浏览 / 手编 wiki page
- 写 `docs/eval/embedding_gate.md` + `tests/eval/agent_retrieval_baseline.py`
- 20-30 query 跑 FTS5-only vs FTS5+vector RRF 对比；P@5 lift < 15% → 永久不做 vector
- 若过 gate：lancedb（无 native build）+ text-embedding-3-small + RRF k=60

### M4：Guards + Polish + Rollout

- per-tool throttlePerMinute 实施
- system prompt reject-list（"禁止批量改 flag 除非用户明示"）
- UI 折叠卡片精雕（多 tool 时显示 "(3 tools used) [expand]"）
- 每日 cost telemetry 报告（类似 `LlmStats` 但针对 chat agent）
- CLAUDE.md 加 "AI Agent Harness" 段落
- 默认 flag flip（5 个 kill switch 翻 `1`）
- 1 周 dogfood 期 + bug fix

---

## 11. References

- Plan file: `/Users/chenyuanquan/.claude/plans/subagent-plan-lexical-moler.md`
- Handoff: `frontend/SPRINT19-AGENT-HARNESS-HANDOFF.md`
- 现有 prompt cache 经验：`src/llm_agent/processor.py:46-66, 141-199`（单 breakpoint 策略）
- 现有 mtime-aware 缓存：`src/llm_agent/prompt_loader.py:27-62`
- 现有 retry queue 模式：`src/llm_agent/store.py:21-59, 108-140`
- FTS5 schema 参考：`src/mail/sync_store.py:460-517`（含 trigger 写法）
- Anthropic tool use docs：https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Anthropic prompt caching：https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Karpathy LLM Wiki gist（2026-04，参考思想，落地形式不同）
- gbrain：https://github.com/garrytan/gbrain（混合检索 + 自动化知识工程参考）

---

## 12. Open Questions（待 P1 实施过程中解决）

1. **Anthropic CRS gateway 是否支持 tool_use + cache_control 同时**？需要 P1 PR-1c 写一个最小 test 验证。
2. **OpenAI 协议 fallback** 何时实施？当前 fallback 链 `claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7`，如果命中 gpt-* 但 tools 不为空，client.py 必须能转 OpenAI Chat Completions tool_calls 协议。P1 暂不做，留 P2 一起补。
3. **history 序列化形态**：assistant 消息的 content 块如何在 chat_db 表示（`ai_chat_messages.content` 是 plain text，无法表 multi-block）？方案：assistant message 的 content 仍存 final text，tool_use blocks 单独存 chat_tool_call 表，history rebuild 时 join 拼回。
4. **Wiki path slug 规则中心化**：`sender/alice@acme.com.md` 需替换 @ 和 .。规则统一在 `chat/wiki/slug.ts`，禁止 LLM 自己拼 path。
5. **附件文本提取依赖**：`pypdf` / `python-docx` / `python-pptx` 都是 pure-Python 但加进 requirements.txt 会让 PyInstaller bundle 大 ~10MB。可接受。
