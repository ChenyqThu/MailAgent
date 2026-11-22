// Extracted from ai_gateway_lifecycle.ts — chat_db turn persistence, telemetry, usage, and session creation glue.

import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

import { extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import type {
  AiGatewayConfig,
  GatewayUsageEvent,
  PersistTurnInput
} from '../../../ai-gateway/config'
import { costUsdFor } from '../../../ai-gateway/modelCost'
import { parseProviderRef } from '../../../ai-gateway/providerRef'
import type { MailAgentDomainClient } from '../../../ai-gateway/python/domainClient'
import {
  appendLlmUsageLog,
  appendMessage,
  appendToolCall,
  createAgentSession,
  createImSession,
  findAssistantMessageRowIdByUiId,
  findUserMessageRowIdByUiId,
  getFirstUserText,
  getSession,
  markSent,
  updateMessage,
  updateSessionPausedMarker,
  updateSessionTitle,
  updateToolCall
} from '../chat_db'
import { maybeNotifyChatRunFinished } from '../notification_fanout'

// ---------------------------------------------------------------------------
// D1 (connector dogfood batch) — on-disk gateway log (handlers/translate.ts 同款: app logs dir +
// JSON line via appendFileSync; logging never throws). Rationale: the gateway runs in the Electron
// MAIN process whose console goes nowhere in a packaged app, so connector manifest failures
// (fetchConnectorManifest's warnings) were invisible in the field. Scope is deliberately tiny —
// connector observability lines only, not a general logging system.
let _gwLogPathCache: string | null = null
export function gatewayLogPath(): string | null {
  if (_gwLogPathCache !== null) return _gwLogPathCache
  try {
    const dir = app.getPath('logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    _gwLogPathCache = join(dir, 'ai-gateway.log')
    return _gwLogPathCache
  } catch {
    return null
  }
}
export function gatewayLogLine(rec: Record<string, unknown>): void {
  const p = gatewayLogPath()
  if (p === null) return
  try {
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8')
  } catch {
    /* logging never throws */
  }
}

// #12 — keys（`${sessionId}:${userMessageId}`）of user messages already written eagerly at turn
// start (onTurnStart). persistTurn checks this to avoid double-writing the SAME user message
// (once eager, once in onFinish). Keyed by session+message id — NOT bare sessionId — so an
// abandoned HITL turn (approval never resolved → persistTurn never ran → key never cleared)
// cannot swallow the NEXT, different user message in the same session. Module-level so it
// survives across request handlers within one gateway lifecycle; entries are removed by
// persistTurn on the matched turn and the set resets on app restart.
export const eagerWrittenUserMessages = new Set<string>()

/** #12 — dedup key for one eagerly-written user message. */
export function eagerUserMessageKey(sessionId: number, userMessageId: string): string {
  return `${sessionId}:${userMessageId}`
}

/** harness-chat lane A (B2) — broadcast a chat event to every renderer window (the same
 *  BrowserWindow loop onServerResumeSettled used inline; extracted so persistTurn /
 *  persistPausedAssistant / the settle hook share one emitter). Best-effort: a torn-down
 *  renderer never breaks the persist that triggered the broadcast. */
export function broadcastChatEvent(channel: string, payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* renderer torn down mid-send — ignore */
    }
  }
}

/**
 * Persist one finished AI SDK turn into ai_chat.db (dual-write). Best-effort:
 * a missing sessionId means an unsaved temporary session → skip. The user message
 * (the fresh turn) and the assistant reply are each appended with their UIMessage
 * canonical JSON + the extracted legacy text; usage/model land in the row columns.
 * Prior-turn messages are NOT re-appended — the gateway only hands us the latest
 * user message, so multi-turn sessions append incrementally without duplication.
 *
 * #12 — if onTurnStart already wrote THIS turn's user message eagerly (tracked via
 * eagerWrittenUserMessages, keyed by session+message id), skip the user message here
 * to avoid duplicate rows. The key is removed after the check so the set stays bounded.
 */
export function persistTurn(turn: PersistTurnInput): void {
  if (turn.sessionId == null) return
  // #12 — skip the user message iff THIS message (matched by id) was written eagerly at turn
  // start. The HITL resume turn re-sends the same user message (same id) → matched, not
  // duplicated；a NEW message after an abandoned approval turn has a fresh id → still persisted.
  let eagerWritten = false
  if (turn.userMessage) {
    const key = eagerUserMessageKey(turn.sessionId, turn.userMessage.id)
    eagerWritten = eagerWrittenUserMessages.has(key)
    if (eagerWritten) {
      eagerWrittenUserMessages.delete(key)
    }
  }
  let userMessageRowId: number | null = null
  if (!eagerWritten && turn.userMessage) {
    userMessageRowId = appendMessage({
      sessionId: turn.sessionId,
      role: 'user',
      content: extractTextFromUIMessage(turn.userMessage),
      status: 'complete',
      uiMessageJson: JSON.stringify(turn.userMessage)
    }).id
  } else if (turn.userMessage) {
    userMessageRowId = findUserMessageRowIdByUiId(turn.sessionId, turn.userMessage.id)
  }
  const queuedRowIds = turn.userMessage?.metadata?.queuedInputDispatch?.rowIds
  if (userMessageRowId != null && Array.isArray(queuedRowIds) && queuedRowIds.length > 0) {
    markSent(turn.sessionId, queuedRowIds, userMessageRowId)
    broadcastChatEvent('chat:queued-input-changed', { sessionId: turn.sessionId })
  }
  // R2-3 — upsert by UIMessage id: if the approval pause already persisted a redacted copy of this
  // assistant message (persistPausedAssistant, same merged id on resume), REPLACE that row with the
  // final full message instead of appending a duplicate. DB-backed lookup（json_extract '$.id'）——
  // survives app restarts, no in-memory state. Normal turns: lookup misses（one cheap per-session
  // SELECT）→ append as before.
  const pausedRowId = findAssistantMessageRowIdByUiId(turn.sessionId, turn.responseMessage.id)
  const turnCostUsd = turn.usage ? costUsdFor(turn.model, turn.usage, turn.protocol) : null
  const cacheReadTokens = turn.usage?.cacheReadTokens ?? null
  const cacheWriteTokens = turn.usage?.cacheWriteTokens ?? null
  let assistantId: number
  if (pausedRowId != null) {
    updateMessage(pausedRowId, {
      content: extractTextFromUIMessage(turn.responseMessage),
      status: 'complete',
      model: turn.model,
      tokensInput: turn.usage?.inputTokens ?? null,
      tokensOutput: turn.usage?.outputTokens ?? null,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: turnCostUsd,
      // WP-15 (context 环) — 暂停那一段没有落过占用（早退不 persistTurn），resume 在这里补写。
      contextTokens: turn.contextTokens ?? null,
      uiMessageJson: JSON.stringify(turn.responseMessage)
    })
    assistantId = pausedRowId
  } else {
    assistantId = appendMessage({
      sessionId: turn.sessionId,
      role: 'assistant',
      content: extractTextFromUIMessage(turn.responseMessage),
      status: 'complete',
      model: turn.model,
      tokensInput: turn.usage?.inputTokens ?? null,
      tokensOutput: turn.usage?.outputTokens ?? null,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: turnCostUsd,
      // WP-15 (context 环) — 末 step 的 inputTokens（≠ tokensInput 的多 step 求和）。
      contextTokens: turn.contextTokens ?? null,
      uiMessageJson: JSON.stringify(turn.responseMessage)
    }).id
  }
  // Phase 03a/03b — write a chat_tool_call audit row per tool call, keyed to the assistant
  // message. Read tools carry no tier → 'silent', no approval columns (03a). Write tools
  // (03b) carry their confirmation_tier + approval_status/approval_hash/user_edited (the
  // executed-after-approval audit; fields ≥ legacy dispatch).
  for (const tc of turn.toolCalls ?? []) {
    const { id } = appendToolCall({
      messageId: assistantId,
      toolUseId: tc.toolUseId,
      toolName: tc.toolName,
      inputJson: tc.inputJson,
      confirmationTier: tc.confirmationTier ?? 'silent',
      status: tc.status
    })
    updateToolCall(id, {
      outputJson: tc.outputJson,
      durationMs: tc.durationMs,
      ...(tc.userEditedInputJson !== undefined
        ? { userEditedInputJson: tc.userEditedInputJson }
        : {}),
      ...(tc.approvalStatus !== undefined ? { approvalStatus: tc.approvalStatus } : {}),
      ...(tc.approvalHash !== undefined ? { approvalHash: tc.approvalHash } : {}),
      // Phase 04a — the A2UI render payload the rich card showed (ui_payload_json audit).
      // Present when the tool has a registered card (rich cards always on since S3).
      ...(tc.uiPayloadJson !== undefined ? { uiPayloadJson: tc.uiPayloadJson } : {}),
      // Phase 04b — outbound-send content hash + idempotency key (email_prepare_send only).
      ...(tc.contentHash !== undefined ? { contentHash: tc.contentHash } : {}),
      ...(tc.idempotencyKey !== undefined ? { idempotencyKey: tc.idempotencyKey } : {}),
      // S2 W1 — exec whitelist rule id (approval_status='auto_whitelist').
      ...(tc.whitelistRuleId !== undefined ? { whitelistRuleId: tc.whitelistRuleId } : {})
    })
  }
  // harness-chat lane A (B2) — every COMPLETED-turn persist broadcasts 'chat:turn-persisted' so a
  // renderer can (a) reload a session whose detached run finished in the background and (b) refresh
  // the history lists' unread badges (updated_at just bumped). A NEW event (not
  // 'chat:session-updated') so the island-settle handler's 3-value status union stays untouched.
  // Best-effort: a broadcast failure never breaks the persist that already landed.
  //
  // codex r2 [C] — the payload carries the run's ActiveRunRegistry runId (threaded through
  // PersistTurnInput from the /api/ai/chat register / the /decide resume lease) so the renderer's
  // settle door can dedup PER RUN instead of by time window (two legit consecutive settles both
  // reload). null = an unleased persist (headless agent run / hand-built harness cfg) — the
  // renderer then never drops it.
  try {
    broadcastChatEvent('chat:turn-persisted', {
      sessionId: turn.sessionId,
      status: 'finished',
      runId: turn.runId ?? null
    })
  } catch (err) {
    console.error('[ai-gateway] chat:turn-persisted broadcast failed (persist landed OK)', err)
  }
  // task 08-20-notification-center M2 批 B4 — 通知中心双写（broadcast 本体一字不动）。
  // 判据（M3 C3 起：turn.detached + origin='agent' 排除）与写实边界见
  // maybeNotifyChatRunFinished 头注（notification_fanout.ts）；getSession 注入让判定留在
  // 纯可测模块里。
  maybeNotifyChatRunFinished(turn, getSession)
}

export type TurnPersistenceHooks = Pick<
  AiGatewayConfig,
  | 'onTurnStart'
  | 'persistPausedAssistant'
  | 'setSessionPausedMarker'
  | 'persistTurn'
  | 'captureTurnMemory'
  | 'getTitleContext'
  | 'saveSessionTitle'
  | 'onServerResumeSettled'
  | 'fetchAgentRunSpec'
  | 'createAgentSession'
  | 'createImSession'
  | 'recordUsageEvent'
>

export function buildTurnPersistenceHooks(deps: {
  domain: MailAgentDomainClient
  captureTurnMemoryEnabled: boolean
  serverResumeEnabled: boolean
  customAgentsEnabled: boolean
  imFeishuEnabled: boolean
}): TurnPersistenceHooks {
  return {
    // #12 (dogfood session-history) — eager-persist: write the user message at turn START so the
    // session appears in history even when the first turn is HITL-paused and onFinish skips
    // persistTurn. eagerWrittenUserMessages（module-level Set，keyed `${sessionId}:${messageId}`）
    // coordinates with persistTurn to prevent double-writing when both paths fire.
    onTurnStart: (sessionId, userMessage) => {
      if (sessionId == null || !userMessage) return
      // R7 (L4 批次3) — a new turn on this session supersedes any older「曾暂停」marker (the owner
      // moved on, or this IS the renderer's resume). Without it the honest expired notice would
      // linger for the whole new turn — the marker otherwise only clears at that turn's onFinish.
      try {
        updateSessionPausedMarker(sessionId, null)
      } catch (err) {
        console.warn('[ai-gateway] onTurnStart paused-marker clear failed (turn continues)', err)
      }
      const key = eagerUserMessageKey(sessionId, userMessage.id)
      // Skip if THIS message was already eagerly written. Happens on the HITL resume turn:
      // rawMessages still ends with the original user message (same id), so lastUserMessage()
      // returns it again — writing it would duplicate. The key is still present because the
      // paused turn skipped persistTurn (never cleared it). A NEW message after an abandoned
      // approval has a different id → not skipped (message-id keying, not bare sessionId).
      if (eagerWrittenUserMessages.has(key)) return
      try {
        // MEDIUM-1 (rebase 复审) — the Set is only a fast path: an ISLAND /decide resume's
        // persistTurn dedups against it AND deletes the key, so a later renderer resume of the
        // same (stale) approval card reaches here with an empty Set → appending would duplicate
        // the user row (E_APPROVAL_USED only skips persistTurn, not this eager write). Make the
        // eager write DB-idempotent: a (session, ui id, role='user') hit → re-seed the fast path
        // and skip. Also covers the pre-existing #12 edge where a gateway RESTART empties the Set.
        if (findUserMessageRowIdByUiId(sessionId, userMessage.id) != null) {
          eagerWrittenUserMessages.add(key)
          return
        }
        appendMessage({
          sessionId,
          role: 'user',
          content: extractTextFromUIMessage(userMessage),
          status: 'complete',
          uiMessageJson: JSON.stringify(userMessage)
        })
        eagerWrittenUserMessages.add(key)
      } catch (err) {
        // Best-effort: if eager write fails, persistTurn's onFinish will write the user
        // message as a fallback — NOT adding to set so persistTurn doesn't skip it.
        console.error('[ai-gateway] onTurnStart eager persist failed (persistTurn will retry)', err)
      }
    },
    // R2-3 — 审批暂停轮的 assistant 消息 eager 落库（chatRun 已剥离 approval-requested part 的
    // display-safe 副本）。upsert by UIMessage id：resume 的 persistTurn 以同一 merged id REPLACE
    // 该行 → 无重复行、无僵死「待确认」卡；user 行已由 onTurnStart eager 写过。best-effort。
    persistPausedAssistant: (sessionId, redactedMessage, modelId, runId) => {
      if (sessionId == null) return
      try {
        const existing = findAssistantMessageRowIdByUiId(sessionId, redactedMessage.id)
        if (existing != null) {
          updateMessage(existing, {
            content: extractTextFromUIMessage(redactedMessage),
            model: modelId,
            uiMessageJson: JSON.stringify(redactedMessage)
          })
        } else {
          appendMessage({
            sessionId,
            role: 'assistant',
            content: extractTextFromUIMessage(redactedMessage),
            status: 'complete',
            model: modelId,
            uiMessageJson: JSON.stringify(redactedMessage)
          })
        }
        // B2 — a pause is ALSO new content (the redacted turn + a claimable approval): broadcast
        // status:'paused' so an open panel re-probes /approval/pending (in-panel card, B3) and the
        // history lists refresh their unread badges. codex r2 [C] — runId rides along (see the
        // persistTurn broadcast above) so the renderer settle door dedups per run.
        broadcastChatEvent('chat:turn-persisted', {
          sessionId,
          status: 'paused',
          runId: runId ?? null
        })
      } catch (err) {
        console.error('[ai-gateway] persistPausedAssistant write failed (best-effort)', err)
      }
    },
    // R7 (L4 批次3) — the durable「曾暂停」marker, on the SAME chat_db channel as the redacted persist
    // above (no HTTP). Write on pause / clear on a settled turn; the stash itself stays process-memory
    // (see AiGatewayConfig.setSessionPausedMarker for why persisting it is deliberately out of scope).
    setSessionPausedMarker: (sessionId, marker) => {
      try {
        updateSessionPausedMarker(sessionId, marker)
      } catch (err) {
        console.warn('[ai-gateway] paused marker persist failed (best-effort)', err)
      }
    },
    persistTurn,
    // M1c — auto-capture 触发（MAILAGENT_MEM0_CAPTURE，默认开 —— 2026-07-02 cutover，env 显式
    // false 为应急回退）。开时注入 fire-and-forget 回调：
    // 抽取 turn 的 user+assistant 文本 POST serve-api /chat/memory/capture（mem0.add 自动抽取）。
    // 🔴 红线：回调 return void（绝不让 gateway onFinish await）+ 错误自吞 → capture 慢/失败绝不
    // 阻塞已流式 reply。关时 undefined → 字节级 flag-off（onFinish 的 ?. 短路）。capture 是纯后端
    // 行为（renderer 无感，toast 由 M1d SSE 驱动）→ 此 flag 不需 renderer mirror / vite define。
    captureTurnMemory: deps.captureTurnMemoryEnabled
      ? (turn) => {
          const userText = turn.userMessage ? extractTextFromUIMessage(turn.userMessage) : ''
          const assistantText = extractTextFromUIMessage(turn.responseMessage)
          if (!userText && !assistantText) return // 空 turn 不打扰后端
          // 30s 上限：mem0 抽取通常几秒；fire-and-forget 下无超时 = 挂死的 serve-api 连接会留
          // idle socket。AbortSignal.timeout 触发 → _req 抛 AbortError → 下方 .catch 吞。
          void deps.domain
            .captureMemory(
              { userText, assistantText, sessionId: turn.sessionId },
              AbortSignal.timeout(30_000)
            )
            .catch((err) => {
              console.error('[ai-gateway] auto-capture post failed (turn streamed OK)', err)
            })
        }
      : undefined,
    // Phase 10b — configurable LLM auto-title. getTitleContext reads ai_chat.db (current title + first
    // user message); a non-null title = already-named (manual rename / prior auto-title) so the endpoint
    // skips regeneration → manual titles never overwritten. saveSessionTitle persists via
    // updateSessionTitle (no updated_at bump → history order stable). Always wired here; the renderer's
    // opt-in setting (default off) is the real gate — it only POSTs /api/ai/title when enabled.
    getTitleContext: (sessionId) => {
      const session = getSession(sessionId)
      if (!session) return null
      return { title: session.title ?? null, firstUserText: getFirstUserText(sessionId) }
    },
    saveSessionTitle: (sessionId, title) => updateSessionTitle(sessionId, title),
    // Part B (dogfood live-refresh) — an island /decide server-side resume settled a persisted
    // session (completed / rejected / error). Broadcast to every renderer window (events_bridge
    // 同款 broadcast 手法) so an OPEN chat panel showing the stale approval card reloads its
    // messages from ai_chat.db. Off (default) → undefined → server.ts 的 ?. 短路，字节级 inert。
    //
    // S4 W3 (ADR-003 D4) — when this settled session is a HEADLESS agent run (origin='agent'), also
    // write the terminal approval decision back to its async_jobs row so the ledger can distinguish
    // "等审批" from "成功完成": look up the session's agent_job_id (chat_db, main-process) → POST
    // serve-api /agent-runs/{jobId}/approval-state. status→state: rejected→rejected, else→approved
    // (the user's DECISION was approve; a post-approval tool error doesn't change that the approval
    // was granted). Best-effort (fire-and-forget); only when custom agents are on.
    //
    // S6 W2 (P8) — wired whenever server-side resume is live (island OR custom agents), NOT island-only:
    // an IN-APP /decide from the record view must broadcast chat:session-updated so the open panel
    // live-refreshes (task item 5) AND settle the agent's async_jobs approval-state. Both flags off →
    // undefined → server.ts's ?. short-circuits (byte-identical).
    onServerResumeSettled: deps.serverResumeEnabled
      ? (sessionId: number, status: 'completed' | 'rejected' | 'error') => {
          broadcastChatEvent('chat:session-updated', { sessionId, status })
          if (deps.customAgentsEnabled) {
            try {
              const session = getSession(sessionId)
              if (session?.origin === 'agent' && session.agent_job_id) {
                const jobId = Number(session.agent_job_id)
                if (Number.isInteger(jobId)) {
                  const state = status === 'rejected' ? 'rejected' : 'approved'
                  void deps.domain
                    .settleAgentApprovalState(jobId, state)
                    .catch((err) =>
                      console.error('[ai-gateway] agent approval-state settle failed', err)
                    )
                }
              }
            } catch (err) {
              console.error('[ai-gateway] agent approval-state lookup failed', err)
            }
          }
        }
      : undefined,
    // Built-in matter/contact headless venues are always available after the 2026-08-19 cutover.
    fetchAgentRunSpec: (jobId: number, claimToken: string) =>
      deps.domain.fetchAgentRunSpec(jobId, claimToken),
    // Pre-create the ai_chat.db session a headless run persists into. A create failure returns null
    // (the run streams but persists nothing) rather than throwing → the endpoint degrades gracefully.
    createAgentSession: (input: {
      agentId: string
      jobId: number
      title: string
      triggerId?: string | null
      triggerKind?: string | null
      triggerFiredAt?: number | null
      /** P4 (D7) — Matter-anchored session for a follow-up run; omitted → general anchor. */
      anchor?: { type: 'matter'; id: number }
      /** L4 批次3 (CHAT_DB v28) — the 行动项 an item-dispatch run executes. */
      itemId?: number | null
    }) => {
      try {
        return createAgentSession(input)
      } catch (err) {
        console.error('[ai-gateway] createAgentSession failed (run will be unsaved)', err)
        return null
      }
    },
    // Stage 2 PR-1 (task 08-01 messenger) — the im_chat entrypoint gate + its session hook.
    // imFeishuEnabled gates POST /api/ai/im-chat registration (off → 404, byte-identical);
    // createImSession pre-creates the origin='im' ai_chat.db session on a conversation's first
    // turn. A create failure returns null (the run streams unsaved — mirrors createAgentSession's
    // degradation) rather than throwing.
    createImSession: deps.imFeishuEnabled
      ? () => {
          try {
            return createImSession()
          } catch (err) {
            console.error('[ai-gateway] createImSession failed (run will be unsaved)', err)
            return null
          }
        }
      : undefined,
    recordUsageEvent: (ev: GatewayUsageEvent): void => {
      try {
        const parsed = parseProviderRef(ev.model)
        const costUsd = costUsdFor(
          ev.model,
          {
            inputTokens: ev.inputTokens ?? null,
            outputTokens: ev.outputTokens ?? null,
            cacheReadTokens: ev.cacheReadTokens ?? null,
            cacheWriteTokens: ev.cacheWriteTokens ?? null,
            noCacheTokens: ev.noCacheTokens ?? null
          },
          ev.protocol
        )
        appendLlmUsageLog({
          surface: ev.surface,
          providerId: parsed.providerId,
          model: ev.model,
          protocol: ev.protocol ?? null,
          tokensInput: ev.inputTokens ?? null,
          tokensOutput: ev.outputTokens ?? null,
          cacheReadTokens: ev.cacheReadTokens ?? null,
          cacheWriteTokens: ev.cacheWriteTokens ?? null,
          costUsd,
          latencyMs: ev.latencyMs ?? null,
          status: ev.status ?? 'ok',
          errorCode: ev.errorCode ?? null
        })
      } catch (err) {
        console.warn('[ai-gateway] recordUsageEvent failed (best-effort)', err)
      }
    }
  }
}
