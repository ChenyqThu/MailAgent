// Approval stash, paused-state markers, SDK usage extraction, tool image pruning, and
// turn persistence onFinish callback (extracted from chatRun.ts).

import type { UIMessageStreamOnFinishCallback } from 'ai'

import type { AiGatewayConfig, PersistTurnInput } from './config'
import { redactAuditImages } from './tools/types'
import { isRuntimeToolDestructive, normalizeContextMode } from './tools/policy'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
import type { PreparedChatRun } from './chatRun'

/** Pick the last user UIMessage of an incoming turn (the fresh message we persist alongside the
 *  assistant reply). */
export function lastUserMessage(messages: MailAgentUIMessage[]): MailAgentUIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
}

/** Part B (island resume) — the paused tool part shape we narrow to when building a stash input. Same
 *  structural view as responseMessageAwaitsApproval / interruptMapper (avoid importing ai's generic
 *  ToolUIPart): a `tool-<name>` part in `approval-requested` state carrying an approval id + input. */
interface PausedApprovalPart {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  approval?: { id?: string }
}

/**
 * Extract the pieces the stash needs from the FIRST approval-requested part of a paused assistant
 * message: the toolCallId, the approval id (for applyApprovalResponseToMessages), the tool name
 * (derived from the `tool-<name>` part type), and the model-proposed input (a short preview for the
 * island card). Returns null when no approval-request part is present (not a paused turn). Pure —
 * exported so it is directly unit-testable.
 */
export function extractApprovalStashInput(responseMessage: MailAgentUIMessage): {
  toolCallId: string
  approvalId: string
  toolName: string
  input: unknown
} | null {
  const parts = (responseMessage as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    if (part == null || typeof part !== 'object') continue
    const p = part as PausedApprovalPart
    if (
      typeof p.type === 'string' &&
      p.type.startsWith('tool-') &&
      p.state === 'approval-requested' &&
      typeof p.toolCallId === 'string' &&
      p.toolCallId.length > 0 &&
      p.approval != null &&
      typeof p.approval.id === 'string' &&
      p.approval.id.length > 0
    ) {
      return {
        toolCallId: p.toolCallId,
        approvalId: p.approval.id,
        toolName: p.type.slice('tool-'.length),
        input: p.input
      }
    }
  }
  return null
}

/** A compact one-line preview of a tool input for the island approval card (the model-proposed
 *  action). Prefers common human-facing fields (subject / body / recipients), falls back to a clipped
 *  JSON. Never throws; caps length.
 *
 *  🔴 Everything here is the MODEL RE-TELLING ITSELF — it is the FALLBACK of
 *  resolveApprovalPreview (below), not the preferred source. Prefer adding a server-side deriver
 *  (src/services/approval_preview.py) over teaching this function about another tool's fields. */
export function approvalInputPreview(toolName: string, input: unknown): string {
  const clip = (s: string, n = 180): string => {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > n ? `${one.slice(0, n)}…` : one
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>
    const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
    const to = pick('to') || pick('recipients')
    const subject = pick('subject')
    const body = pick('body_markdown') || pick('body') || pick('content')
    const bits = [to && `→ ${to}`, subject && `「${subject}」`, body].filter(Boolean).join(' ')
    if (bits) return clip(`${toolName}: ${bits}`)
  }
  try {
    return clip(`${toolName}: ${JSON.stringify(input)}`)
  } catch {
    return toolName
  }
}

/** L4 批次1 #6 — the ONE place that decides where an approval preview line comes from: serve-api's
 *  server-derived facts first (cfg.fetchApprovalPreview → POST /api/approval/preview), the
 *  model's own args second (approvalInputPreview).
 *
 *  Why the server leg exists at all: part of a write's payload is derived server-side, so the
 *  model's args are NOT the action. An `email_draft_reply` with no `to` means "server, compute
 *  reply-all" — the surfaces that only get this one line (island card, Feishu card, record view)
 *  would show the user everything EXCEPT who the mail actually goes to.
 *
 *  🔴 fail-OPEN, deliberately: no deriver for this tool (null) / serve-api down / it threw →
 *  the old client-side line. A missing FACT degrades the card; a missing CARD blocks the user.
 *  The write itself is still gated by the ApprovalGuard + the Python write authority, neither of
 *  which trusts this string. */
export async function resolveApprovalPreview(
  cfg: AiGatewayConfig,
  toolName: string,
  input: unknown
): Promise<string> {
  const fallback = approvalInputPreview(toolName, input)
  if (!cfg.fetchApprovalPreview) return fallback
  try {
    const server = await cfg.fetchApprovalPreview({ toolName, input })
    const trimmed = typeof server === 'string' ? server.trim() : ''
    return trimmed.length > 0 ? trimmed : fallback
  } catch {
    return fallback
  }
}

/** True when a finished UIMessage is PAUSED at an approval gate — it carries a tool part still in the
 *  ai@6 `approval-requested` state (awaiting the user's approve / edit / reject). Such a turn is NOT a
 *  complete turn: the assistant-ui runtime resumes it (a second /api/ai/chat request) after the user
 *  responds, and only that resume is the real, complete turn. Narrowed structurally (type starts
 *  'tool-' + state) rather than importing ai's heavy generic ToolUIPart — mirrors interruptMapper's
 *  isApprovalRequestedPart without the approval-id requirement (persistence only needs "is ANY tool
 *  still awaiting approval", not which one). */
export function responseMessageAwaitsApproval(message: MailAgentUIMessage): boolean {
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return false
  return parts.some((part) => {
    if (part == null || typeof part !== 'object') return false
    const p = part as { type?: unknown; state?: unknown }
    return (
      typeof p.type === 'string' && p.type.startsWith('tool-') && p.state === 'approval-requested'
    )
  })
}

/** R2-3 (dogfood #3 后续) — build the DISPLAY-SAFE copy of an approval-paused assistant message for
 *  eager history persistence: drop the `approval-requested` tool parts (a reloaded session must not
 *  render a dead "待确认" card — the resume guard state doesn't survive reload), keep everything the
 *  model already produced (text / reasoning / completed tool parts, which history rendering already
 *  supports). Returns null when nothing displayable remains (e.g. the model went straight to a write
 *  tool with no preamble text) — callers skip persistence entirely in that case, preserving the old
 *  "nothing stored" behaviour for content-free pauses. */
export function redactApprovalRequestedParts(
  message: MailAgentUIMessage
): MailAgentUIMessage | null {
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null
  const kept = parts.filter((part) => {
    if (part == null || typeof part !== 'object') return true
    const p = part as { type?: unknown; state?: unknown }
    return !(
      typeof p.type === 'string' &&
      p.type.startsWith('tool-') &&
      p.state === 'approval-requested'
    )
  })
  const displayable = kept.some((part) => {
    if (part == null || typeof part !== 'object') return false
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === 'text' || p.type === 'reasoning') {
      return typeof p.text === 'string' && p.text.trim() !== ''
    }
    return typeof p.type === 'string' && p.type.startsWith('tool-')
  })
  if (!displayable) return null
  return { ...(message as object), parts: kept } as MailAgentUIMessage
}

/**
 * L4 批次3 R7 — write the session's persistent「曾在审批处暂停」marker (ai_chat.db v28) when a turn
 * pauses, and clear it when a turn completes without pausing.
 *
 * Why a marker at all: the stash is gateway process memory, so after a restart a MANUAL session had
 * NO signal that it was ever paused and PendingApprovalPanel rendered nothing at all (a headless run
 * derives the same fact from derive_agent_run_state and shows the honest「已失效」notice). The marker
 * is that missing signal — and ONLY that: it carries no resume capability (see PausedApprovalMarker),
 * so a restarted approval stays un-approvable, exactly as the fail-closed stash contract intends.
 *
 * Independent of the stash leg below on purpose (its own try/catch, its own cfg hook): the marker
 * matters precisely in the world where the stash is gone.
 */
function writePausedMarker(
  cfg: AiGatewayConfig,
  sessionId: number | null,
  responseMessage: MailAgentUIMessage
): void {
  if (!cfg.setSessionPausedMarker || sessionId == null) return
  try {
    const info = extractApprovalStashInput(responseMessage)
    if (!info) return
    cfg.setSessionPausedMarker(sessionId, {
      toolCallId: info.toolCallId,
      approvalId: info.approvalId,
      toolName: info.toolName,
      // Same rule as the stash's copy: the runtime connector registry, NEVER the model's args.
      destructive: isRuntimeToolDestructive(info.toolName),
      pausedAt: Date.now()
    })
  } catch (err) {
    console.error('[ai-gateway] paused marker write failed (turn paused OK)', err)
  }
}

/** R7 — the mirror of writePausedMarker: a turn that reaches persistence WITHOUT pausing settled the
 *  session (an approve-resume's merged turn, a reject-resume's denial turn, or a plain turn), so any
 *  older marker is stale. Best-effort. A re-paused turn never gets here (it returns early above). */
function clearPausedMarker(cfg: AiGatewayConfig, sessionId: number | null): void {
  if (!cfg.setSessionPausedMarker || sessionId == null) return
  try {
    cfg.setSessionPausedMarker(sessionId, null)
  } catch (err) {
    console.error('[ai-gateway] paused marker clear failed (turn persisted OK)', err)
  }
}

/**
 * Stash a paused approval run for server-side resume via `/api/ai/approval/decide`.
 *
 * The STASH step gates on cfg.approvalStash presence alone so in-panel decide cards,
 * Feishu approval cards, and headless agent runs can all claim/resume paused tools.
 */
function maybeStashApproval(
  cfg: AiGatewayConfig,
  run: PreparedChatRun,
  responseMessage: MailAgentUIMessage
): void {
  if (!cfg.approvalStash || !run.originalBody) return
  try {
    const info = extractApprovalStashInput(responseMessage)
    if (!info) return
    cfg.approvalStash.stash({
      toolCallId: info.toolCallId,
      approvalId: info.approvalId,
      toolName: info.toolName,
      sessionId: run.sessionId,
      body: run.originalBody,
      responseMessage,
      contextMode: normalizeContextMode(run.contextMode),
      agentRunContext: cfg.agentRunContext,
      destructive: isRuntimeToolDestructive(info.toolName)
    })
  } catch (err) {
    console.error('[ai-gateway] approval stash failed (turn paused OK)', err)
  }
}

/** Part B (harness 上岛) — collect the toolCallIds of any approval the user REJECTED in-app (a tool
 *  part in state 'approval-responded' with approval.approved === false). Scanned on the renderer's
 *  reject-resume turn (its incoming history ends with that rejected part) so makePersistOnFinish can
 *  tombstone the guard → a later island approve for the same toolCallId fails closed (finding 1,
 *  renderer-reject side). Idempotent to re-scan: a stale part whose guard record is gone → reject()
 *  no-ops. Pure structural narrowing (no ai import). */
function collectRejectedApprovalToolCallIds(messages: MailAgentUIMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    const parts = (msg as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part == null || typeof part !== 'object') continue
      const p = part as {
        type?: unknown
        state?: unknown
        toolCallId?: unknown
        approval?: { approved?: unknown }
      }
      if (
        typeof p.type === 'string' &&
        p.type.startsWith('tool-') &&
        p.state === 'approval-responded' &&
        p.approval != null &&
        p.approval.approved === false &&
        typeof p.toolCallId === 'string' &&
        p.toolCallId.length > 0
      ) {
        ids.push(p.toolCallId)
      }
    }
  }
  return ids
}

/** Part B — true when THIS turn's audit shows a tool rejected by the one-shot guard.consume
 *  (E_APPROVAL_USED): the approval was already executed on the OTHER surface (a renderer↔island
 *  approve race). The winner persisted the authoritative turn, so persisting here would double-write a
 *  bogus error turn (finding 2). Only reachable with island agent on (oneShotWrites enables consume). */
function runHasApprovalUsedError(run: PreparedChatRun): boolean {
  return run.auditEntries.some((e) => {
    if (e.status !== 'error') return false
    try {
      const o = JSON.parse(e.outputJson) as { error?: unknown }
      return o.error === 'E_APPROVAL_USED'
    } catch {
      return false
    }
  })
}

/** harness-chat lane C (07-15, research §2b/§6①-2) — true when THIS turn's audit shows a
 *  SUCCESSFUL `agent_memory_update`, or a successful `agent_profile_restore` targeting the memory
 *  doc: the user (or an approved agent proposal) just explicitly rewrote memory.md. Auto-capture is
 *  a fire-and-forget haiku merge that runs ~20-25s after every finished turn and re-digests
 *  memory.md from scratch — with no mutual exclusion it would silently re-consume/reword the
 *  content the user JUST approved, defeating the whole point of an explicit edit. `agent_profile_read`
 *  and `agent_profile_history` (silent reads) never match; a REJECTED or errored write never matches
 *  either (only `status:'ok'`). */
export function runHasSuccessfulMemoryWrite(run: PreparedChatRun): boolean {
  return run.auditEntries.some((e) => {
    if (e.status !== 'ok') return false
    if (e.toolName === 'agent_memory_update') return true
    if (e.toolName !== 'agent_profile_restore') return false
    try {
      const o = JSON.parse(e.outputJson) as { doc_name?: unknown }
      return o.doc_name === 'memory'
    } catch {
      return false
    }
  })
}

/** WP-15 (context 环, task 08-05) — 本回合的「上下文占用」= **末 step 的 `inputTokens`**。
 *
 *  🔴 **绝不能用 `result.usage`**：ai@7 的 usage 是**多 step 求和**（`node_modules/ai/dist/index.d.ts`
 *  "When there are multiple steps, the usage is the sum of all step usages"）。工具循环回合里每个
 *  step 都把整段 prompt 重新计一遍，求和值因此显著大于「这一刻塞进模型的上下文」——拿它画环会
 *  凭空吓人（3 个 step 的回合能虚报 3 倍）。真正的上下文占用 = 最后一次 provider 调用的 prompt
 *  token 数 = 末 step 的 `usage.inputTokens`（ai@7 的 `inputTokens` 是 prompt **总**数，
 *  `inputTokenDetails.{noCacheTokens,cacheReadTokens}` 只是它的细分 —— 不要再叠加 cacheRead）。
 *
 *  **两段式回合（审批暂停 → resume）**：暂停那一段根本不落库（makePersistOnFinish 在
 *  `responseMessageAwaitsApproval` 处早退），resume 是**另一次 streamText**，它的 `steps` 只含
 *  resume 段；而 resume 的 prompt 已经带上原始历史 + 暂停的 tool call + 其执行结果，所以「当前
 *  run 的末 step」在两段式下依然是那一刻的完整上下文 —— 不需要、也不能跨段求和（跨段求和 =
 *  同一段历史被计两次）。
 *
 *  拿不到（模型未报 usage / steps 为空 / 非有限数）→ null：前端据此**不渲染**控件，绝不猜。 */
export function lastStepContextTokens(
  steps: ReadonlyArray<{ usage?: { inputTokens?: number | undefined } }> | undefined | null
): number | null {
  if (!Array.isArray(steps) || steps.length === 0) return null
  const n = steps[steps.length - 1]?.usage?.inputTokens
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** harness-chat lane C (07-15, PRD §3) — the static warning text appended to a turn whose
 *  streamText generation ended with `finishReason === 'length'`: the model hit the maxOutputTokens
 *  ceiling mid-reply and the AI SDK closes the turn WITHOUT raising, so a truncated reply would
 *  otherwise persist silently ("fail-loud, not a silent half-written turn"). Exported for the vitest
 *  pin. */
export const LENGTH_TRUNCATION_WARNING_TEXT =
  '\n\n> ⚠️ 回复因达到模型输出长度上限被截断，内容可能不完整。'

/** Append LENGTH_TRUNCATION_WARNING_TEXT as an extra `text` part when `finishReason === 'length'`;
 *  a no-op (returns `message` unchanged) otherwise. 🔴 This only affects what gets PERSISTED
 *  (cfg.persistTurn's responseMessage) — ai@7's onEnd/onFinish fires from the terminal transform's
 *  `flush()`, i.e. AFTER every content chunk was already enqueued onto the wire (see
 *  handleUIMessageStreamFinish in ai/dist), so there is no mechanism to inject a new chunk back onto
 *  an already-drained SSE response. The warning becomes visible the next time the session is
 *  (re)loaded from chat_db, which is still strictly better than a truncated reply that looks
 *  complete forever. */
export function appendLengthTruncationWarning(
  message: MailAgentUIMessage,
  finishReason: string | undefined
): MailAgentUIMessage {
  if (finishReason !== 'length') return message
  const parts = Array.isArray(message.parts) ? message.parts : []
  return {
    ...(message as object),
    parts: [...parts, { type: 'text', text: LENGTH_TRUNCATION_WARNING_TEXT }]
  } as MailAgentUIMessage
}

export function extractSdkUsage(
  usage:
    | {
        inputTokens?: number
        outputTokens?: number
        inputTokenDetails?: {
          noCacheTokens?: number
          cacheReadTokens?: number
          cacheWriteTokens?: number
        }
      }
    | undefined
    | null
):
  | {
      inputTokens: number | null
      outputTokens: number | null
      cacheReadTokens: number | null
      cacheWriteTokens: number | null
      noCacheTokens: number | null
    }
  | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
    noCacheTokens: usage.inputTokenDetails?.noCacheTokens ?? null
  }
}

/** Maximum number of recent tool-output parts retaining raw `images[].data` base64 when
 *  persisting `ui_message_json` in `makePersistOnFinish` (older parts are redacted via
 *  `redactAuditImages` to prevent multi-MB base64 bloat in `ai_chat.db`). */
export const PERSISTED_TOOL_IMAGE_WINDOW = 2

/**
 * Redact `output.images[].data` on tool-output parts older than the latest
 * `maxVisualParts` visual tool calls in a persisted assistant `UIMessage`.
 * Returns the original `message` reference unchanged when within window.
 */
export function prunePersistedToolImages(
  message: MailAgentUIMessage,
  maxVisualParts = PERSISTED_TOOL_IMAGE_WINDOW
): MailAgentUIMessage {
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return message
  const visualIndices: number[] = []
  const redactedOutputs = new Map<number, unknown>()
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part == null || typeof part !== 'object') continue
    const p = part as { type?: unknown; output?: unknown }
    if (
      typeof p.type !== 'string' ||
      (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool') ||
      p.output === undefined
    ) {
      continue
    }
    const redacted = redactAuditImages(p.output)
    if (redacted !== p.output) {
      visualIndices.push(i)
      redactedOutputs.set(i, redacted)
    }
  }
  const dropCount = visualIndices.length - Math.max(0, maxVisualParts)
  if (dropCount <= 0) return message
  const toRedact = new Set(visualIndices.slice(0, dropCount))
  const nextParts = parts.map((part, idx) =>
    toRedact.has(idx) ? { ...(part as object), output: redactedOutputs.get(idx) } : part
  )
  return { ...(message as object), parts: nextParts } as MailAgentUIMessage
}

/**
 * Build the onFinish callback that persists a finished turn (ai_chat.db dual-write) — the SAME
 * persistence both endpoints use (the AG-UI mirror is a true mirror, including audit). Best-effort:
 * a write failure logs and never breaks the already-streamed reply. Aborted turns are not persisted.
 */
export function makePersistOnFinish(
  cfg: AiGatewayConfig,
  run: PreparedChatRun,
  opts?: {
    /** task 08-20-notification-center M3 C3 — 客户端是否已断开。🔴 **必须是 getter，不能是布尔
     *  快照**：断开可以发生在构造 onFinish 之后、turn 落库之前的任意时刻（drain 中途关面板正是
     *  本功能要覆盖的场景），构造时求值恒得 false。省略 = 调用点不提供该信号（见 PersistTurnInput
     *  .detached）。 */
    isClientGone?: () => boolean
  }
): UIMessageStreamOnFinishCallback<MailAgentUIMessage> {
  return async ({ responseMessage, isAborted, finishReason }) => {
    if (isAborted || !cfg.persistTurn) return
    // Part B (harness 上岛, finding 1) — a renderer REJECT tombstones the guard so a later island
    // approve for the SAME toolCallId fails closed. This is derived from the INCOMING history
    // (run.rawMessages ends with the paused tool part transitioned to approval-responded+approved:false),
    // INDEPENDENT of whether THIS turn then re-pauses at ANOTHER approval gate — so it must run BEFORE
    // the re-pause early return below. (codex re-review edge case: a reject-of-A whose resume immediately
    // requests approval-B would otherwise skip tombstoning A → a stale island approve of A slips
    // through.) 07-15 owner拍板 (island-independent approvals): gated by serverResumeEnabled (the
    // lifecycle sets it unconditionally — the in-panel decide card is a second approval surface even
    // with the island off) with islandAgentEnabled kept as the legacy fallback gate.
    if (cfg.serverResumeEnabled) {
      for (const id of collectRejectedApprovalToolCallIds(run.rawMessages)) cfg.rejectApproval?.(id)
    }
    // dogfood #3 (HITL 授权重复/卡 loading) — a turn PAUSED at an approval gate still finishes the
    // UIMessage stream (onFinish fires), but it is NOT a complete turn: the client resumes it after
    // approving. Persisting here double-writes — the resume's onFinish re-persists the SAME
    // lastUserMessage (a duplicate `user` row, since the resume's rawMessages still END with the
    // original user message) PLUS a second, complete `assistant` row. A reloaded session then shows the
    // whole turn twice with a stuck "待确认" card. Skip: the resume request carries `originalMessages`,
    // so ITS responseMessage is the MERGED full turn (pre-approval tool calls + executed result),
    // persisted exactly once. Also skips capture — an approval-paused partial is not a complete turn to
    // extract memory from; the resume's onFinish captures the finished turn.
    //
    // R2-3 (v1.1.0 dogfood) — a never-approved turn used to store NOTHING, so switching back to the
    // session showed only the user message. New: hand a display-safe REDACTED copy (approval parts
    // stripped, see redactApprovalRequestedParts) to cfg.persistPausedAssistant. The lifecycle stores
    // it keyed by the UIMessage id and the resume's persistTurn REPLACES that row (same merged id) —
    // no duplicates, no dead pending card. Hook omitted → byte-identical to the old skip.
    if (responseMessageAwaitsApproval(responseMessage as MailAgentUIMessage)) {
      if (cfg.persistPausedAssistant) {
        try {
          const redacted = redactApprovalRequestedParts(responseMessage as MailAgentUIMessage)
          if (redacted) {
            cfg.persistPausedAssistant(
              run.sessionId,
              prunePersistedToolImages(redacted),
              run.modelId,
              run.runId ?? null
            )
          }
        } catch (err) {
          console.error('[ai-gateway] persistPausedAssistant failed (pause still streamed OK)', err)
        }
      }
      maybeStashApproval(cfg, run, responseMessage as MailAgentUIMessage)
      // R7 (L4 批次3) — third self-contained leg: the durable「曾暂停」marker, so a manual session
      // can render the honest expired notice after the stash above is gone (gateway restart).
      writePausedMarker(cfg, run.sessionId, responseMessage as MailAgentUIMessage)
      // Phase 4 WP-4B — paused turns are not written to ai_chat_messages yet (only redacted preview);
      // if never resumed/abandoned they would become dark spend. Record usage best-effort here.
      if (cfg.recordUsageEvent) {
        try {
          const pausedUsage = extractSdkUsage(
            await Promise.resolve(run.result.usage).catch(() => undefined)
          )
          if (pausedUsage) {
            cfg.recordUsageEvent({
              surface: 'paused_turn',
              model: run.modelId,
              protocol: run.protocol,
              ...pausedUsage,
              status: 'ok'
            })
          }
        } catch {
          /* best-effort */
        }
      }
      return
    }
    if (cfg.serverResumeEnabled && runHasApprovalUsedError(run)) return
    const usage = extractSdkUsage(await Promise.resolve(run.result.usage).catch(() => undefined))
    // WP-15 (context 环) — 上下文占用另取**末 step** 的 inputTokens（`usage` 是多 step 求和，
    // 语义不同，见 lastStepContextTokens）。与 usage 同样 best-effort：拿不到 → null → 前端不渲染。
    const steps = await Promise.resolve(run.result.steps).catch(() => undefined)
    // harness-chat lane C (07-15, PRD §3) — finishReason==='length' fail-loud: append a visible
    // warning to what gets PERSISTED (see appendLengthTruncationWarning's doc comment for why this
    // can't reach the already-streamed wire). No-op for every other finish reason.
    const persistedResponseMessage = prunePersistedToolImages(
      appendLengthTruncationWarning(responseMessage as MailAgentUIMessage, finishReason)
    )
    const turn: PersistTurnInput = {
      sessionId: run.sessionId,
      model: run.modelId,
      protocol: run.protocol,
      userMessage: lastUserMessage(run.rawMessages),
      responseMessage: persistedResponseMessage,
      usage,
      contextTokens: lastStepContextTokens(steps),
      toolCalls: run.auditEntries,
      // codex r2 [C] — per-run settle dedup: the broadcast carries this runId to the renderer.
      runId: run.runId ?? null,
      // M3 C3 — 求值时刻是**此刻**（turn 落库前），不是 makePersistOnFinish 的构造时刻。
      detached: opts?.isClientGone?.() === true
    }
    try {
      await cfg.persistTurn(turn)
    } catch (err) {
      // persistence is best-effort — a write failure must not break the streamed reply.
      console.error('[ai-gateway] persistTurn failed (turn streamed OK)', err)
    }
    // R7 (L4 批次3) — this turn finished WITHOUT pausing, so the session is no longer「等人」:
    // drop any marker (a resume's merged turn lands here, as does a plain turn after an abandoned
    // pause). Runs after persistTurn for the same reason capture does — never before the truth.
    clearPausedMarker(cfg, run.sessionId)
    // M1c — auto-capture 触发（fire-and-forget，**永不 await**）。红线：capture 端点的网络/抽取
    // 延迟绝不阻塞已流式完成的 reply；回调 return void（不 return promise 给我们 await），失败由
    // 回调内部自吞。仅当 MAILAGENT_MEM0_CAPTURE 开时由 lifecycle 注入；否则 undefined → ?. 短路 =
    // 字节级 flag-off（这一行在 flag-off 下是纯 no-op，无行为变化）。try/catch 兜底：即便回调
    // 实现同步抛（本不该），也绝不破坏已流式完成的 reply。
    //
    // harness-chat lane C (07-15, research §2b/§6①-2) — capture ↔ explicit-edit mutual exclusion
    // (Node half): skip the trigger entirely when THIS turn's audit shows a successful
    // agent_memory_update / agent_profile_restore(memory) — the user just explicitly (re)wrote
    // memory.md via an approved tool call, and a ~20-25s-later capture re-digest would otherwise
    // silently reword/shrink what they just approved. The Python half (capture_turn's cooldown
    // window) is the second, cross-session layer — this one only covers THIS turn.
    //
    // P2-2 (codex r1) — a finishReason==='length' turn is a TRUNCATED reply, and `turn` above
    // carries the appended UI warning text: neither the half-finished inference nor the literal
    // warning line may be distilled into memory.md (mem0 would fossilize them into the stable
    // prefix injected on every future turn). Skip capture for the truncated turn entirely —
    // persistTurn above still ran, so the fail-loud history is intact.
    //
    // T4 (design M6) — a group speaker run never captures: 群里的内容是其他 agent 的半可信输出，
    // 而 memory.md 是恒注入单聊每一轮的稳定前缀 —— 抽进去就是让一个群污染主 agent 自己的人格。Structural guard: today's group paths never attach this
    // onFinish (see PreparedChatRun.groupSpeakerRun); the day one does, capture stays off.
    if (
      run.groupSpeakerRun !== true &&
      !runHasSuccessfulMemoryWrite(run) &&
      finishReason !== 'length'
    ) {
      try {
        cfg.captureTurnMemory?.(turn)
      } catch (err) {
        console.error('[ai-gateway] captureTurnMemory threw (turn streamed OK)', err)
      }
    }
    // P4 auto compact is deliberately scheduled after persistence and memory capture, but remains
    // fire-and-forget: detached drain awaits this onFinish before releasing the session lease, so
    // awaiting compact here would extend the E_RUN_ACTIVE window by an entire model call. The
    // injected callback defers its active-run check until the lease is released and self-swallows
    // every failure. P5 dispatch ordering is guaranteed by the lifecycle post-turn serial chain.
    try {
      cfg.maybeAutoCompact?.(turn)
    } catch (err) {
      console.error('[ai-gateway] maybeAutoCompact threw (turn streamed OK)', err)
    }
    // 0903 —— 排队追问的 drain 曾经挂在这里（onFinish 末尾），于是只有「跑到了收尾回调」的那些
    // 终止路径会 drain：drain 自己抛 / pipe 同步抛 / abort 都到不了这一行，那条路上排队的追问就
    // 无限期躺在队列里。触发点已收敛到 ActiveRunRegistry.release()（每条终止路径的唯一交汇处），
    // 见 activeRuns.ts 的 onSessionIdle。这里不再有第二个触发点。
  }
}
