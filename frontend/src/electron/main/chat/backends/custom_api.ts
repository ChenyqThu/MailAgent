// Sprint 4 Task #11 — Custom API chat backend.
//
// Talks to the Anthropic Messages streaming endpoint (CRS, native
// Anthropic, or any compatible /v1/messages-shape gateway). REVIEW-LOG
// C-04 hard rule: API key reads happen here in the main process; the
// renderer never sees the key bytes.
//
// 双协议支持 (Sprint 19 §D #4):
//   - Anthropic Messages 协议 (primary, default `claude-sonnet-4-6`).
//     `claude-*` / `claude:*` prefix 走 anthropicStream — 支持 prompt cache
//     (system + tools 双 cache_control 断点, 实测 ~95% 命中率).
//   - OpenAI Chat Completions 协议 (`gpt-*` / `gemini-*` / `codex-*` prefix)
//     走 openaiStream — CRS 把这些模型 routed 到 /v1/chat/completions, 协议
//     用 index-based tool_calls 增量 merge. 无 prompt cache (协议限制).
//     主要给 fallback 链 `claude-sonnet-4-6 → gpt-5.4 → claude-opus-4-7`
//     命中 gpt 时用, 不阻塞 multi-turn harness.
//
// Stream protocols:
//   - Anthropic: POST /v1/messages stream=true; `data: <json>\n\n` events
//     `message_start` / `content_block_*` / `message_delta` / `message_stop`
//     (https://docs.anthropic.com/en/api/messages-streaming)
//   - OpenAI:    POST /v1/chat/completions stream=true; `data: <json>\n\n`
//     events 含 `choices[0].delta` (content / tool_calls index-based merge)
//     + `usage` (last chunk) + `[DONE]` sentinel

import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from '../../llm_settings'
import { isKosL1HotBlockEnabled } from '../config'
import { getCachedSenderDigest } from '../../kos/sender_digest_cache'
import type {
  BackendToolDescriptor,
  ChatBackend,
  ChatStreamEvent,
  ChatStreamRequest,
  EmailContext
} from '../types'

// Anthropic `max_tokens` caps the model's RESPONSE length (not input).
// Same 4096 ceiling Sprint 3 translate.ts used; ~12k Chinese chars at
// typical token density.
const MAX_OUTPUT_TOKENS = 64000
// anthropic-beta（Anthropic /v1/messages；CRS 透传）：1M 上下文窗口 + 1h cache TTL。
const ANTHROPIC_BETA = 'extended-cache-ttl-2025-04-11,context-1m-2025-08-07'
const REQUEST_DEADLINE_MS = 60_000

// Sprint 19 — Anthropic message content can be a plain string (legacy
// single-block) or an array of content blocks (multi-block: text +
// tool_use + tool_result). Both shapes are valid in /v1/messages.
type AnthropicMessageContent = string | Array<Record<string, unknown>>

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicMessageContent
}

// Translate ChatMessage[] history into the Anthropic conversation form.
// `tool` rows are folded into the assistant content as `[tool: name]`
// breadcrumbs so the model has context for a follow-up turn without us
// having to teach Anthropic about MailAgent's tool transcript format.
//
// Sprint 19 PR-1d.1: if the caller supplied `iterHistory` (harness loop),
// short-circuit to that verbatim — it already carries multi-block
// tool_use / tool_result content that ChatMessage[] can't represent.
function buildAnthropicMessages(req: ChatStreamRequest): AnthropicMessage[] {
  if (req.iterHistory && req.iterHistory.length > 0) {
    return req.iterHistory.map((m) => ({
      role: m.role,
      content: m.content as AnthropicMessageContent
    }))
  }
  const out: AnthropicMessage[] = []
  let pendingAssistant: string[] = []
  function flushAssistant(): void {
    if (pendingAssistant.length === 0) return
    out.push({ role: 'assistant', content: pendingAssistant.join('\n').trim() })
    pendingAssistant = []
  }
  for (const m of req.history) {
    if (m.role === 'user') {
      flushAssistant()
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.status === 'aborted' || m.status === 'error') continue
      if (m.content.length > 0) pendingAssistant.push(m.content)
    } else if (m.role === 'tool') {
      // tool_call rows: keep a minimal breadcrumb so context survives.
      try {
        const data = JSON.parse(m.content) as { name?: string; detail?: string }
        pendingAssistant.push(
          `[tool: ${data.name ?? 'unknown'}${data.detail ? ' — ' + data.detail : ''}]`
        )
      } catch {
        // malformed tool row — skip
      }
    }
    // system messages currently aren't surfaced by the panel; ignore.
  }
  flushAssistant()
  // Anthropic rejects an empty messages array. If history was somehow
  // empty (shouldn't happen — dispatcher always inserts the user
  // message first), insert a placeholder so the API returns a sensible
  // error rather than a 400.
  if (out.length === 0) out.push({ role: 'user', content: '(empty)' })
  return out
}

/** Sprint 19 — Anthropic content block shape for `system` / `tools` arrays
 *  with optional prompt-cache breakpoint. `cache_control: ephemeral` tells
 *  the server "everything up to and including this block is a stable prefix;
 *  serve subsequent matching requests from cache for ~5min". We place ONE
 *  breakpoint at the tail of system + ONE at the tail of tools[] — Anthropic
 *  hashes those two prefixes independently. See processor.py:46-66, 141-199
 *  in the backend LLM agent for the same single-breakpoint pattern that
 *  scored ~95% hit-rate on the email-classification path. */
interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/** Sprint 19 — Anthropic tool descriptor with optional cache_control. */
interface AnthropicToolBlock extends BackendToolDescriptor {
  cache_control?: { type: 'ephemeral' }
}

/** Sprint 19 — Build Anthropic `system` block array with cache_control on
 *  the stable prefix.
 *
 *  Layout (PR-2f Sprint 19 M2):
 *    block 1 (stable): STATIC_PROMPT + optional L1 hot block (KOS sender
 *                      digest if MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true and
 *                      cache hit) — cache_control: ephemeral
 *    block 2 (session-specific): emailContext text — NO cache_control
 *
 *  Why split: M1 拼 STATIC + ctx 在一个 block, 整 block 是邮件-specific
 *  内容, cross-email cache miss. PR-2f 把 stable prefix (STATIC + L1) 拆
 *  出来后, 跨邮件 chat session 都能命中 stable block cache, ctx 单独 fresh
 *  compute.
 *
 *  cache_control 始终在 block 1 (stable) 末 — Anthropic prompt cache 是
 *  prefix match, breakpoint 之后的 block (block 2) 自然不参与 cache.
 */
function buildSystemBlocks(ctx: EmailContext | null): AnthropicSystemBlock[] {
  const stableText = buildStableSystemPrompt(ctx)
  const stableBlock: AnthropicSystemBlock = {
    type: 'text',
    text: stableText,
    cache_control: { type: 'ephemeral' }
  }
  if (!ctx) return [stableBlock]
  const ctxText = buildEmailContextSection(ctx)
  if (!ctxText) return [stableBlock]
  return [stableBlock, { type: 'text', text: ctxText }]
}

/** Sprint 19 — Tag the LAST tool in the array with cache_control so the
 *  entire tools[] block can be served from cache on the next turn (within
 *  the 5-min TTL). Mutates a copy of the input — caller's array stays
 *  untouched. Returns `undefined` when `tools` is empty / missing because
 *  Anthropic rejects `tools: []` (must omit the field). */
function decorateToolsWithCacheControl(
  tools: BackendToolDescriptor[] | undefined
): AnthropicToolBlock[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const copy = tools.map((t) => ({ ...t })) as AnthropicToolBlock[]
  copy[copy.length - 1] = {
    ...copy[copy.length - 1],
    cache_control: { type: 'ephemeral' }
  }
  return copy
}

function buildStaticSystemHeader(): string {
  return [
    'You are the AI assistant inside MailAgent, a macOS email client.',
    'The user is asking about the email currently open in the inbox panel.',
    'Be terse, concrete, and cite specific sentences from the email when relevant.',
    'Respond in the same language as the user message unless the user asks for translation.',
    'Use markdown when it improves readability (lists, code blocks, links). Keep prose tight.',
    '',
    '## Safety guardrails (M1 polish):',
    '- NEVER call email_flag / email_archive in a loop or against multiple emails',
    '  unless the user explicitly named the count or scope ("mark all 12 vendor',
    '  emails as read" — OK; "clean up my inbox" — NOT OK, ask for specifics).',
    '- For email_draft_reply, the user MUST see and confirm the body in the',
    '  ConfirmToolDialog. Never bypass with a different tool.',
    '- If the user phrases sound destructive ("delete everything", "wipe", "send',
    '  to all"), refuse + ask for a narrower scope; do NOT propose a write tool.',
    '- KOS / search tools (kos_query / kos_digest / email_search_fulltext /',
    '  email_search_attachments) are read-only — safe to call freely; but cap to',
    '  3 calls per turn unless the user is iteratively narrowing the search.'
  ].join('\n')
}

/** Sprint 19 PR-2f — Build the stable system-prompt prefix (STATIC + optional
 *  L1 hot block KOS sender digest). Stays cacheable across email switches
 *  for the same sender; cache_control is applied by buildSystemBlocks.
 *
 *  L1 KOS digest only injects when:
 *    - MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true (default false)
 *    - emailContext present with non-empty senderAddr
 *    - sender_digest_cache has a cached non-null entry (prefetch done +
 *      KOS returned a hit)
 *  Cache miss / null / flag off → no injection (graceful degrade).
 */
function buildStableSystemPrompt(ctx: EmailContext | null): string {
  let text = buildStaticSystemHeader()
  if (isKosL1HotBlockEnabled() && ctx?.senderAddr) {
    const digest = getCachedSenderDigest(ctx.senderAddr)
    if (typeof digest === 'string' && digest.length > 0) {
      const trimmed = digest.length > 4000 ? digest.slice(0, 4000) + '\n... (truncated)' : digest
      text += '\n\n--- KOS sender digest ---\n'
      text += `sender: ${ctx.senderAddr}\n`
      text += trimmed
      text += '\n--- End KOS digest ---'
    }
  }
  return text
}

/** Sprint 19 PR-2f — Build the session-specific email-context section
 *  (subject / sender / date / Notion URL / AI labels / body markdown).
 *  Lives in a separate Anthropic system block WITHOUT cache_control so
 *  the stable prefix stays hot across email switches.
 *
 *  PR-2g dogfood fix: 加 AI 字段 (ai_priority / ai_action / processing_status)
 *  让 chat agent 立即看到 LLM 已经给出的标签, 避免它先问"AI 怎么标的?"
 *  再回答, 节省一轮.
 */
function buildEmailContextSection(ctx: EmailContext): string {
  const lines: string[] = ['--- Email currently open ---']
  lines.push(`internal_id: ${ctx.internalId}`)
  if (ctx.subject) lines.push(`Subject: ${ctx.subject}`)
  if (ctx.senderName || ctx.senderAddr) {
    const name = ctx.senderName ?? ''
    const addr = ctx.senderAddr ?? ''
    lines.push(`From: ${name}${name && addr ? ' ' : ''}${addr ? `<${addr}>` : ''}`.trim())
  }
  if (ctx.dateIso) lines.push(`Date: ${ctx.dateIso}`)
  if (ctx.notionPageId) {
    const pageNoDash = ctx.notionPageId.replace(/-/g, '')
    lines.push(`Notion URL: https://www.notion.so/${pageNoDash}`)
  }
  // AI labels (LLM agent 已分类的; chat agent 据此判断优先级 + 建议动作)
  const aiBits: string[] = []
  if (ctx.aiPriority) aiBits.push(`priority=${ctx.aiPriority}`)
  if (ctx.aiAction) aiBits.push(`action=${ctx.aiAction}`)
  if (ctx.processingStatus) aiBits.push(`processing=${ctx.processingStatus}`)
  if (aiBits.length > 0) {
    lines.push(`AI labels: ${aiBits.join(' / ')}`)
  }
  lines.push('')
  if (ctx.bodyMarkdown && ctx.bodyMarkdown.length > 0) {
    lines.push('Body (markdown):')
    lines.push(ctx.bodyMarkdown)
  } else {
    lines.push('Body: (not available)')
  }
  lines.push('--- End email ---')
  return lines.join('\n')
}

/** Legacy combined form kept for tests / external readers that still call
 *  buildSystemPrompt directly. New code should use buildSystemBlocks. */
function buildSystemPrompt(ctx: EmailContext | null): string {
  const stable = buildStableSystemPrompt(ctx)
  if (!ctx) return stable
  const section = buildEmailContextSection(ctx)
  return section ? `${stable}\n\n${section}` : stable
}

/** Sprint 19 — per-stream state machine for Anthropic SSE events.
 *
 *  Why a state struct (vs locals inside the loop): the tool_use protocol
 *  requires accumulating `input_json_delta` chunks across MULTIPLE SSE
 *  events before we can emit a single ToolUseEvent. The map indexes by
 *  Anthropic's `index` (the position of the content block within the
 *  assistant message), so concurrent tool_use blocks in one assistant
 *  turn stay correctly partitioned.
 *
 *  `messageStopReason` is set by `message_delta.delta.stop_reason` and
 *  read by the surrounding generator when emitting the final DoneEvent —
 *  the harness loop branches on this ('tool_use' → run another iter,
 *  'end_turn' → stop). */
interface AnthropicStreamState {
  pendingToolBlocks: Map<number, { id: string; name: string; jsonStr: string }>
  messageStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null
  inputTokens: number
  outputTokens: number
  accumulated: string
  modelSeen: string | null
  sawError: boolean
}

function createStreamState(initialModel: string | null): AnthropicStreamState {
  return {
    pendingToolBlocks: new Map(),
    messageStopReason: null,
    inputTokens: 0,
    outputTokens: 0,
    accumulated: '',
    modelSeen: initialModel,
    sawError: false
  }
}

/** Sprint 19 — Translate one parsed Anthropic SSE event into 0+ semantic
 *  ChatStreamEvent items + mutate state. Pure-ish (mutates only the passed
 *  state; no I/O) so unit tests can drive the state machine without
 *  spinning up fetch + a real stream.
 *
 *  Anthropic stream block sequence (one assistant turn):
 *    message_start
 *    [content_block_start (text or tool_use)
 *     content_block_delta+ (text_delta or input_json_delta)
 *     content_block_stop]*           ← repeat per content block
 *    message_delta                   ← stop_reason + final usage
 *    message_stop
 *  Plus out-of-band `error` events that override the normal flow.
 */
function processAnthropicEvent(
  parsed: unknown,
  state: AnthropicStreamState
): ChatStreamEvent[] {
  const e = parsed as Record<string, unknown> & { type?: string; __done?: boolean }
  if (e.__done === true) {
    // Some gateways still emit [DONE] sentinel; Anthropic itself uses
    // message_stop — tolerate both.
    return []
  }
  switch (e.type) {
    case 'message_start': {
      const msg = (e as { message?: { usage?: { input_tokens?: number }; model?: string } })
        .message
      if (msg) {
        if (typeof msg.usage?.input_tokens === 'number') state.inputTokens = msg.usage.input_tokens
        if (typeof msg.model === 'string') state.modelSeen = msg.model
      }
      return []
    }
    case 'content_block_start': {
      const block = (e as { index?: number; content_block?: { type?: string; id?: string; name?: string } })
      const idx = block.index
      const cb = block.content_block
      if (typeof idx === 'number' && cb?.type === 'tool_use' && cb.id && cb.name) {
        state.pendingToolBlocks.set(idx, { id: cb.id, name: cb.name, jsonStr: '' })
      }
      return []
    }
    case 'content_block_delta': {
      const wrap = e as { index?: number; delta?: { type?: string; text?: string; partial_json?: string } }
      const delta = wrap.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        state.accumulated += delta.text
        return [{ type: 'chunk', delta: delta.text }]
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (typeof wrap.index === 'number') {
          const rec = state.pendingToolBlocks.get(wrap.index)
          if (rec) rec.jsonStr += delta.partial_json
        }
        // Don't yield per-fragment — the LLM is still typing the JSON.
        // ToolUseEvent emits at content_block_stop with the complete object.
      }
      return []
    }
    case 'content_block_stop': {
      const wrap = e as { index?: number }
      if (typeof wrap.index !== 'number') return []
      const rec = state.pendingToolBlocks.get(wrap.index)
      if (!rec) return [] // text block stop — nothing to flush
      let input: unknown = {}
      if (rec.jsonStr.trim().length > 0) {
        try {
          input = JSON.parse(rec.jsonStr)
        } catch (err) {
          // Streaming JSON occasionally tears (rare). Surface the raw
          // string + parse error to the LLM via the next-turn tool_result —
          // it can usually self-correct by re-issuing the tool call.
          input = {
            __parse_error: err instanceof Error ? err.message : String(err),
            __raw: rec.jsonStr
          }
        }
      }
      state.pendingToolBlocks.delete(wrap.index)
      return [
        {
          type: 'tool_use',
          toolUseId: rec.id,
          name: rec.name,
          input
        }
      ]
    }
    case 'message_delta': {
      const wrap = e as { delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
      if (wrap.usage && typeof wrap.usage.output_tokens === 'number') {
        state.outputTokens = wrap.usage.output_tokens
      }
      const sr = wrap.delta?.stop_reason
      if (sr === 'end_turn' || sr === 'tool_use' || sr === 'max_tokens') {
        state.messageStopReason = sr
      }
      return []
    }
    case 'message_stop':
      // The synthetic DoneEvent emits once at end of generator (after the
      // stream closes), so it sees the final state including stop_reason.
      return []
    case 'error': {
      const errObj = (e as { error?: { type?: string; message?: string } }).error
      state.sawError = true
      return [
        {
          type: 'error',
          code: errObj?.type ?? 'E_UPSTREAM',
          message: errObj?.message ?? 'LLM error'
        }
      ]
    }
    default:
      // Unknown event type — likely a future Anthropic addition. Forward
      // nothing (silent ignore is safer than crashing the stream on
      // protocol evolution). Sprint 19 test fixtures cover the known set.
      return []
  }
}

interface SseParseState {
  buffer: string
}

/** Parse a single chunk of text into zero or more `data: {...}` objects.
 *  Updates `state.buffer` with the unterminated remainder. */
function parseSseChunk(state: SseParseState, chunk: string): unknown[] {
  state.buffer += chunk
  const out: unknown[] = []
  let idx
  while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
    const block = state.buffer.slice(0, idx)
    state.buffer = state.buffer.slice(idx + 2)
    // A block can hold multiple `data:` lines; concatenate.
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) data += line.slice(6)
      else if (line.startsWith('data:')) data += line.slice(5)
    }
    if (data.length === 0) continue
    if (data.trim() === '[DONE]') {
      out.push({ __done: true })
      continue
    }
    try {
      out.push(JSON.parse(data))
    } catch {
      // malformed — skip; the next event will resync.
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions code path (Sprint 19 §D #4)
// ────────────────────────────────────────────────────────────────────────
//
// CRS gateway routes `gpt-*` / `gemini-*` / `codex-*` to /v1/chat/completions.
// Different request shape (tools wrapped in `function`, tool_use as
// `tool_calls` array on assistant message, tool_result as separate `tool`
// role message) and different stream protocol (index-based tool_calls delta
// merge, finish_reason instead of stop_reason).

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAiToolFunctionDecl {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

/** Flatten Anthropic-style system blocks to a single text string for OpenAI
 *  `{role:'system'}`. cache_control breakpoints are dropped (OpenAI 无 prompt
 *  cache 协议). 拼接用 \n\n 分块, 跟 buildSystemPrompt legacy form 等价. */
function flattenSystemBlocksToText(blocks: AnthropicSystemBlock[]): string {
  return blocks
    .map((b) => b.text)
    .filter((t) => t && t.length > 0)
    .join('\n\n')
}

/** Translate ChatStreamRequest history + iterHistory into OpenAI-format
 *  messages. Anthropic content blocks (`tool_use` / `tool_result`) get
 *  mapped to OpenAI's flatter form: tool_use → assistant.tool_calls[],
 *  tool_result → separate role:'tool' message keyed by tool_call_id. */
function buildOpenAiMessages(req: ChatStreamRequest): OpenAiMessage[] {
  // Harness loop iterHistory takes precedence — it already has the
  // multi-block tool_use / tool_result transcript.
  if (req.iterHistory && req.iterHistory.length > 0) {
    const out: OpenAiMessage[] = []
    for (const m of req.iterHistory) {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content })
        continue
      }
      // Multi-block array form — split into OpenAI shape.
      if (m.role === 'assistant') {
        const textParts: string[] = []
        const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = []
        for (const block of m.content) {
          const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') {
            textParts.push(b.text)
          } else if (b.type === 'tool_use' && b.id && b.name) {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input ?? {})
              }
            })
          }
        }
        const msg: OpenAiMessage = { role: 'assistant' }
        if (textParts.length > 0) msg.content = textParts.join('\n')
        else msg.content = null
        if (toolCalls.length > 0) msg.tool_calls = toolCalls
        out.push(msg)
      } else if (m.role === 'user') {
        // user content array may carry tool_result blocks (sent back after
        // tool execution). Each tool_result becomes its own role:'tool' msg.
        let userText = ''
        const toolResults: Array<{ tool_use_id: string; content: string }> = []
        for (const block of m.content) {
          const b = block as { type?: string; text?: string; tool_use_id?: string; content?: unknown }
          if (b.type === 'text' && typeof b.text === 'string') {
            userText += (userText ? '\n' : '') + b.text
          } else if (b.type === 'tool_result' && b.tool_use_id) {
            const content =
              typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? {})
            toolResults.push({ tool_use_id: b.tool_use_id, content })
          }
        }
        // Order matters: tool results must appear AFTER the assistant
        // turn that emitted the tool_calls. Push tool messages first
        // (they belong to the previous assistant turn), then the user's
        // own text (next user turn).
        for (const tr of toolResults) {
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
        }
        if (userText.length > 0) out.push({ role: 'user', content: userText })
      }
    }
    return out.length > 0 ? out : [{ role: 'user', content: '(empty)' }]
  }
  // Legacy single-pass path — same shape as buildAnthropicMessages but
  // OpenAI-flavored. Tool breadcrumbs already inlined as `[tool: …]` text.
  const out: OpenAiMessage[] = []
  let pendingAssistant: string[] = []
  function flushAssistant(): void {
    if (pendingAssistant.length === 0) return
    out.push({ role: 'assistant', content: pendingAssistant.join('\n').trim() })
    pendingAssistant = []
  }
  for (const m of req.history) {
    if (m.role === 'user') {
      flushAssistant()
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.status === 'aborted' || m.status === 'error') continue
      if (m.content.length > 0) pendingAssistant.push(m.content)
    } else if (m.role === 'tool') {
      try {
        const data = JSON.parse(m.content) as { name?: string; detail?: string }
        pendingAssistant.push(
          `[tool: ${data.name ?? 'unknown'}${data.detail ? ' — ' + data.detail : ''}]`
        )
      } catch {
        /* skip */
      }
    }
  }
  flushAssistant()
  if (out.length === 0) out.push({ role: 'user', content: '(empty)' })
  return out
}

/** Translate BackendToolDescriptor[] into OpenAI function-call declarations. */
function buildOpenAiTools(
  tools: BackendToolDescriptor[] | undefined
): OpenAiToolFunctionDecl[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  }))
}

/** Sprint 19 §D #4 — per-stream state for OpenAI tool_calls delta merge.
 *  OpenAI tool_calls come as `delta.tool_calls[]` chunks with an `index`
 *  and incremental `function.arguments` string. Index-keyed map merges
 *  the fragments; finalize on `finish_reason='tool_calls'` (or stream end). */
interface OpenAiStreamState {
  pendingToolCalls: Map<number, { id: string; name: string; argsStr: string }>
  finishReason: 'stop' | 'tool_calls' | 'length' | null
  inputTokens: number
  outputTokens: number
  accumulated: string
  modelSeen: string | null
  sawError: boolean
  /** Once finalize flushed tool_use events we don't re-flush on stream end. */
  toolsFlushed: boolean
}

function createOpenAiStreamState(initialModel: string | null): OpenAiStreamState {
  return {
    pendingToolCalls: new Map(),
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    accumulated: '',
    modelSeen: initialModel,
    sawError: false,
    toolsFlushed: false
  }
}

/** Flush all pendingToolCalls into ToolUseEvent[] (called on finish_reason
 *  ='tool_calls' or as a safety on stream end if still pending). */
function flushOpenAiToolCalls(state: OpenAiStreamState): ChatStreamEvent[] {
  if (state.toolsFlushed || state.pendingToolCalls.size === 0) return []
  const events: ChatStreamEvent[] = []
  // Iterate sorted by index so multi-tool turns dispatch in deterministic order.
  const entries = Array.from(state.pendingToolCalls.entries()).sort((a, b) => a[0] - b[0])
  for (const [, rec] of entries) {
    let input: unknown = {}
    if (rec.argsStr.trim().length > 0) {
      try {
        input = JSON.parse(rec.argsStr)
      } catch (err) {
        input = {
          __parse_error: err instanceof Error ? err.message : String(err),
          __raw: rec.argsStr
        }
      }
    }
    events.push({
      type: 'tool_use',
      toolUseId: rec.id,
      name: rec.name,
      input
    })
  }
  state.pendingToolCalls.clear()
  state.toolsFlushed = true
  return events
}

function processOpenAiEvent(
  parsed: unknown,
  state: OpenAiStreamState
): ChatStreamEvent[] {
  const e = parsed as Record<string, unknown> & { __done?: boolean }
  if (e.__done === true) {
    // Stream sentinel — flush any unfinalized tool_calls (defensive).
    return flushOpenAiToolCalls(state)
  }
  // Top-level error envelope (some gateways send these inline).
  const topErr = (e as { error?: { type?: string; message?: string } }).error
  if (topErr) {
    state.sawError = true
    return [
      {
        type: 'error',
        code: topErr.type ?? 'E_UPSTREAM',
        message: topErr.message ?? 'LLM error'
      }
    ]
  }
  const choices = (e.choices as Array<Record<string, unknown>> | undefined) ?? []
  const usage = e.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  if (usage) {
    if (typeof usage.prompt_tokens === 'number') state.inputTokens = usage.prompt_tokens
    if (typeof usage.completion_tokens === 'number') state.outputTokens = usage.completion_tokens
  }
  if (typeof (e as { model?: unknown }).model === 'string') {
    state.modelSeen = (e as { model: string }).model
  }
  if (choices.length === 0) return []
  const choice = choices[0]
  const delta = (choice?.delta as Record<string, unknown> | undefined) ?? {}
  const out: ChatStreamEvent[] = []
  // Text content delta.
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    state.accumulated += delta.content
    out.push({ type: 'chunk', delta: delta.content })
  }
  // Tool calls delta (index-based merge).
  const toolCallsDelta = delta.tool_calls as
    | Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    | undefined
  if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
    for (const tc of toolCallsDelta) {
      const idx = typeof tc.index === 'number' ? tc.index : 0
      let rec = state.pendingToolCalls.get(idx)
      if (!rec) {
        rec = { id: tc.id ?? '', name: '', argsStr: '' }
        state.pendingToolCalls.set(idx, rec)
      }
      if (tc.id && !rec.id) rec.id = tc.id
      if (tc.function?.name && !rec.name) rec.name = tc.function.name
      if (typeof tc.function?.arguments === 'string') {
        rec.argsStr += tc.function.arguments
      }
    }
  }
  // finish_reason: 'stop' | 'tool_calls' | 'length' | null
  const finishReason = choice?.finish_reason as string | null | undefined
  if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'length') {
    state.finishReason = finishReason
    if (finishReason === 'tool_calls') {
      out.push(...flushOpenAiToolCalls(state))
    }
  }
  return out
}

async function* openaiStream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
  const apiKey = await getLlmApiKey()
  if (!apiKey) {
    yield {
      type: 'error',
      code: 'E_NO_LLM_KEY',
      message: 'LLM API key not configured — set it in Settings or LLM_API_KEY env'
    }
    return
  }
  const baseUrl = getLlmBaseUrl()
  const model = req.model ?? getLlmModel()
  const systemText = flattenSystemBlocksToText(buildSystemBlocks(req.emailContext))
  const userMessages = buildOpenAiMessages(req)
  const messages: OpenAiMessage[] =
    systemText.length > 0
      ? [{ role: 'system', content: systemText }, ...userMessages]
      : userMessages
  const tools = buildOpenAiTools(req.tools)

  const timeoutAc = new AbortController()
  const timer = setTimeout(() => timeoutAc.abort(), REQUEST_DEADLINE_MS)
  const onParentAbort = (): void => timeoutAc.abort()
  if (req.signal.aborted) {
    clearTimeout(timer)
    yield { type: 'error', code: 'E_ABORTED', message: 'request aborted before send' }
    return
  }
  req.signal.addEventListener('abort', onParentAbort, { once: true })

  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages,
    stream: true,
    // Backend client.py uses stream_options.include_usage too; CRS honors it
    // by emitting a final chunk with usage even when tool_calls are present.
    stream_options: { include_usage: true }
  }
  if (tools) requestBody.tools = tools

  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // CRS gateway accepts either `x-api-key` or `Authorization: Bearer`
        // for OpenAI-protocol models; send Bearer (standard for /v1/chat).
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: timeoutAc.signal
    })
  } catch (err) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    if (req.signal.aborted) return
    yield {
      type: 'error',
      code: 'E_UPSTREAM',
      message: `LLM fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
    return
  }

  if (!response.ok) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    yield {
      type: 'error',
      code: response.status === 429 ? 'E_QUOTA' : 'E_UPSTREAM',
      message: `LLM API ${response.status}`
    }
    return
  }
  if (!response.body) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    yield { type: 'error', code: 'E_UPSTREAM', message: 'LLM response had no body' }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const sseState: SseParseState = { buffer: '' }
  const state = createOpenAiStreamState(model)

  try {
    while (true) {
      if (req.signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      const parsedEvents = parseSseChunk(sseState, text)
      for (const parsed of parsedEvents) {
        const out = processOpenAiEvent(parsed, state)
        for (const ev of out) yield ev
      }
    }
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }

  if (req.signal.aborted) return
  if (state.sawError) return

  // Safety flush: if stream ended without an explicit `tool_calls` finish
  // reason but tools are pending (some upstreams omit finish_reason on the
  // last chunk when usage arrives separately), emit them now.
  for (const ev of flushOpenAiToolCalls(state)) yield ev

  yield {
    type: 'usage',
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    costUsd: null,
    model: state.modelSeen
  }
  // Map OpenAI finish_reason → DoneEvent.stopReason (same enum the harness
  // branches on). 'tool_calls' → 'tool_use' (LLM wants tools); 'length' →
  // 'max_tokens'; null / 'stop' → 'end_turn'.
  const stopReason: 'end_turn' | 'tool_use' | 'max_tokens' =
    state.finishReason === 'tool_calls'
      ? 'tool_use'
      : state.finishReason === 'length'
        ? 'max_tokens'
        : 'end_turn'
  yield {
    type: 'done',
    finalContent: state.accumulated,
    model: state.modelSeen,
    stopReason
  }
}

async function* anthropicStream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
  const apiKey = await getLlmApiKey()
  if (!apiKey) {
    yield {
      type: 'error',
      code: 'E_NO_LLM_KEY',
      message: 'LLM API key not configured — set it in Settings or LLM_API_KEY env'
    }
    return
  }
  const baseUrl = getLlmBaseUrl()
  const model = req.model ?? getLlmModel()
  const messages = buildAnthropicMessages(req)
  // Sprint 19 — system 改 blocks 数组以承载 cache_control 断点;
  // tools 数组同样在最后一个加 cache_control (双 prefix 缓存).
  const systemBlocks = buildSystemBlocks(req.emailContext)
  const tools = decorateToolsWithCacheControl(req.tools)

  const timeoutAc = new AbortController()
  const timer = setTimeout(() => timeoutAc.abort(), REQUEST_DEADLINE_MS)
  // Compose the parent signal (orchestrator-owned, fires on user cancel /
  // email switch) with the deadline signal so either can cut the request.
  const onParentAbort = (): void => timeoutAc.abort()
  if (req.signal.aborted) {
    clearTimeout(timer)
    yield { type: 'error', code: 'E_ABORTED', message: 'request aborted before send' }
    return
  }
  req.signal.addEventListener('abort', onParentAbort, { once: true })

  // Sprint 19 — `tools` is omitted when empty (Anthropic rejects `tools: []`).
  const requestBody: Record<string, unknown> = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemBlocks,
    messages,
    stream: true
  }
  if (tools) requestBody.tools = tools

  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA
      },
      body: JSON.stringify(requestBody),
      signal: timeoutAc.signal
    })
  } catch (err) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    if (req.signal.aborted) return
    yield {
      type: 'error',
      code: 'E_UPSTREAM',
      message: `LLM fetch failed: ${err instanceof Error ? err.message : String(err)}`
    }
    return
  }

  if (!response.ok) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    // Sprint 4 review (codex high): upstream gateways occasionally echo
    // request headers (including an `Authorization: Bearer …`) into 4xx
    // / 5xx HTML error pages. Forwarding the raw body to the renderer
    // would leak those bytes into the IPC envelope. Stick to status
    // codes; the main-process log still has the body for triage.
    yield {
      type: 'error',
      code: response.status === 429 ? 'E_QUOTA' : 'E_UPSTREAM',
      message: `LLM API ${response.status}`
    }
    return
  }

  if (!response.body) {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    yield { type: 'error', code: 'E_UPSTREAM', message: 'LLM response had no body' }
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const sseState: SseParseState = { buffer: '' }
  const state = createStreamState(model)

  try {
    while (true) {
      if (req.signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      const parsedEvents = parseSseChunk(sseState, text)
      for (const parsed of parsedEvents) {
        // processAnthropicEvent mutates state + returns 0..N semantic events
        // (chunk / tool_use / error). Yield them in order; never await an
        // unrelated callback between iterations so abort latency stays low.
        const out = processAnthropicEvent(parsed, state)
        for (const ev of out) yield ev
      }
    }
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onParentAbort)
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }

  if (req.signal.aborted) return
  // Sprint 4 review (codex M-2): once an Anthropic `error` event landed
  // mid-stream, don't paper over it with a trailing usage/done — the
  // assistant row would flip back to `complete` and lose the error.
  if (state.sawError) return

  yield {
    type: 'usage',
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    costUsd: null,
    model: state.modelSeen
  }
  yield {
    type: 'done',
    finalContent: state.accumulated,
    model: state.modelSeen,
    // Sprint 19 — harness loop branches on stopReason:
    //   'tool_use' → next iter (LLM wants to call tools)
    //   'end_turn' → terminate (assistant said its piece)
    //   'max_tokens' → forward as 'end_turn' for legacy callers but log
    // Fallback to 'end_turn' when upstream omitted message_delta (older
    // gateways occasionally do this); a missing stop_reason can never mean
    // "more to come" — message_stop already fired.
    stopReason: state.messageStopReason ?? 'end_turn'
  }
}

export class CustomApiBackend implements ChatBackend {
  readonly kind = 'custom-api' as const

  async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
    // Sprint 19 §D #4 — route by model-family prefix:
    //   claude-* / claude:*  → Anthropic Messages (prompt cache 双断点)
    //   gpt-* / gemini-* / codex-*  → OpenAI Chat Completions (index-merge tool_calls)
    //   其他 → E_MODEL_UNSUPPORTED
    // Backend kind is the only stable signal; the harness gate uses the same
    // routing (dispatcher.ts) so multi-turn works on both paths.
    const model = req.model ?? getLlmModel()
    if (isAnthropicModel(model)) {
      yield* anthropicStream(req)
      return
    }
    if (isOpenAiCompatibleModel(model)) {
      yield* openaiStream(req)
      return
    }
    yield {
      type: 'error',
      code: 'E_MODEL_UNSUPPORTED',
      message: `Model "${model}" not supported (expected claude-* / gpt-* / gemini-* / codex-*).`
    }
  }
}

function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-') || model.startsWith('claude:')
}

// Sprint 19 §D #4 — CRS gateway routes non-Anthropic providers through
// /v1/chat/completions. Mirror backend `_OPENAI_PROTO_PREFIXES` in
// src/llm_agent/client.py:43; new model families that speak OpenAI proto
// (e.g. claude code 之外的) should land here.
const OPENAI_PROTO_PREFIXES = ['gpt-', 'gemini-', 'codex-']

function isOpenAiCompatibleModel(model: string): boolean {
  const lower = model.toLowerCase()
  return OPENAI_PROTO_PREFIXES.some((p) => lower.startsWith(p))
}

// Test-only — exposed so unit tests can exercise the SSE parser + state
// machine without reaching for a private symbol or standing up fetch.
export const __testing = {
  parseSseChunk,
  buildAnthropicMessages,
  buildSystemBlocks,
  buildSystemPrompt,
  buildStableSystemPrompt,
  buildEmailContextSection,
  decorateToolsWithCacheControl,
  createStreamState,
  processAnthropicEvent,
  isAnthropicModel,
  // Sprint 19 §D #4 — OpenAI path test surface.
  flattenSystemBlocksToText,
  buildOpenAiMessages,
  buildOpenAiTools,
  createOpenAiStreamState,
  processOpenAiEvent,
  flushOpenAiToolCalls,
  isOpenAiCompatibleModel
}
