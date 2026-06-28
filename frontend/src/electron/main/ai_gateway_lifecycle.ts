// chat-panel P4 Phase 02 — Electron lifecycle for the embedded AI SDK Gateway.
//
// This is the IMPURE wrapper around the pure gateway core (src/ai-gateway/server.ts).
// It supplies the three environment-specific pieces the core leaves injectable:
//   1. provider key + base URL + model — from llm_settings (keytar/env, main-only).
//      🔴 Provider-key path = (A) Gateway connects to the provider directly
//      (architecture §13.6). The key lives ONLY here in main; it is passed to the
//      gateway core as cfg.apiKey and NEVER crosses into the renderer (the renderer
//      only ever learns the loopback gateway PORT via ?aiGatewayPort=). Option (B)
//      — routing through serve-api /api/llm-proxy — was rejected for Phase 02: the
//      embedded gateway already runs in the same trusted main process that owns the
//      keytar entry, so an extra Python hop buys no isolation and would need a body
//      translation shim ({protocol,body} vs anthropic-native).
//   2. persistTurn — the ai_chat.db dual-write (ui_message_json canonical + the
//      extracted legacy content), via chat_db.ts (better-sqlite3, main-only).
//   3. lifecycle — start on a resolved port, /health poll, close on app quit.
//
// flag-gated by MAILAGENT_AI_SDK_GATEWAY (index.ts dynamic-imports this module only
// when the flag is 'true'), so flag-off the heavy `ai` deps never load.

import { app } from 'electron'

import { startAiGatewayServer, type AiGatewayHandle } from '../../ai-gateway/server'
import { resolveAiGatewayPort, type PersistTurnInput } from '../../ai-gateway/config'
import { MailAgentDomainClient } from '../../ai-gateway/python/domainClient'
import { buildGatewayTools } from '../../ai-gateway/tools'
import { ApprovalGuard } from '../../ai-gateway/security/approval'
import { buildToolA2UIPayload } from '../../shared/assistant/tools/a2ui'
import { extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import {
  appendMessage,
  appendToolCall,
  getFirstUserText,
  getLastTurnTexts,
  getSession,
  updateSessionTitle,
  updateToolCall
} from './chat_db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'
import { resolveApiPort } from './backend_lifecycle'
import { getLocalApiToken } from './local_token'
// Phase 06 (context injection) — the standing-context provider fetches the SAME serve-api
// /chat/config the legacy runtime uses, projecting the system-prompt fields for the gateway.
import { request } from '@shared/api/http_client'
import type { HttpPlatformConfig } from '@shared/chat/http_platform'
import type { GatewaySystemPromptConfig } from '../../ai-gateway/systemPrompt'
import { masterNewSessionDefaultOn } from './ai_gateway_flags'

let _handle: AiGatewayHandle | null = null

/** Mirror electron readEnvBool: only '1'/'true' (case-insensitive) → true; unset →
 *  the supplied default; any other non-empty value → false. */
function envBool(key: string, def: boolean): boolean {
  const raw = process.env[key]
  if (raw == null || raw === '') return def
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * Persist one finished AI SDK turn into ai_chat.db (dual-write). Best-effort:
 * a missing sessionId means an unsaved temporary session → skip. The user message
 * (the fresh turn) and the assistant reply are each appended with their UIMessage
 * canonical JSON + the extracted legacy text; usage/model land in the row columns.
 * Prior-turn messages are NOT re-appended — the gateway only hands us the latest
 * user message, so multi-turn sessions append incrementally without duplication.
 */
function persistTurn(turn: PersistTurnInput): void {
  if (turn.sessionId == null) return
  if (turn.userMessage) {
    appendMessage({
      sessionId: turn.sessionId,
      role: 'user',
      content: extractTextFromUIMessage(turn.userMessage),
      status: 'complete',
      uiMessageJson: JSON.stringify(turn.userMessage)
    })
  }
  const assistant = appendMessage({
    sessionId: turn.sessionId,
    role: 'assistant',
    content: extractTextFromUIMessage(turn.responseMessage),
    status: 'complete',
    model: turn.model,
    tokensInput: turn.usage?.inputTokens ?? null,
    tokensOutput: turn.usage?.outputTokens ?? null,
    uiMessageJson: JSON.stringify(turn.responseMessage)
  })
  // Phase 03a/03b — write a chat_tool_call audit row per tool call, keyed to the assistant
  // message. Read tools carry no tier → 'silent', no approval columns (03a). Write tools
  // (03b) carry their confirmation_tier + approval_status/approval_hash/user_edited (the
  // executed-after-approval audit; fields ≥ legacy dispatch).
  for (const tc of turn.toolCalls ?? []) {
    const { id } = appendToolCall({
      messageId: assistant.id,
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
      // Present only when MAILAGENT_A2UI_TOOL_CARDS is on AND the tool has a card.
      ...(tc.uiPayloadJson !== undefined ? { uiPayloadJson: tc.uiPayloadJson } : {}),
      // Phase 04b — outbound-send content hash + idempotency key (email_prepare_send only).
      ...(tc.contentHash !== undefined ? { contentHash: tc.contentHash } : {}),
      ...(tc.idempotencyKey !== undefined ? { idempotencyKey: tc.idempotencyKey } : {})
    })
  }
}

/** Poll /health until it answers ok (or attempts exhausted). Confirms the embedded
 *  server is actually accepting connections before we log it ready. Non-fatal. */
async function pollHealth(port: number, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return true
      }
    } catch {
      /* not up yet — retry */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

// Phase 06 (context injection) — TTL-cached /chat/config projection for the gateway system prompt.
// Fetched from the SAME serve-api endpoint the legacy runtime uses (request() handles the envelope
// unwrap); a busy session reuses the cache so we don't refetch per turn. A fetch failure → null so
// the gateway degrades to context-light (SOUL fallback) rather than breaking the turn — this
// provider is CONTRACTED to never throw (chatRun trusts it returns null on failure).
const CONTEXT_CONFIG_TTL_MS = 15_000
let _systemPromptCache: { at: number; value: GatewaySystemPromptConfig | null } | null = null

async function getSystemPromptConfig(
  apiBase: string,
  localToken: string | null
): Promise<GatewaySystemPromptConfig | null> {
  const now = Date.now()
  if (_systemPromptCache && now - _systemPromptCache.at < CONTEXT_CONFIG_TTL_MS) {
    return _systemPromptCache.value
  }
  let value: GatewaySystemPromptConfig | null = null
  try {
    const cfg = await request<HttpPlatformConfig>(apiBase, 'GET', '/chat/config', {
      headers: localToken ? { 'X-MailAgent-Local-Token': localToken } : {}
    })
    value = {
      standingContext: cfg.standingContext ?? null,
      userContext: cfg.userContext ?? null,
      memorySummary: cfg.memorySummary ?? null,
      kosConfigured: cfg.kosConfigured ?? false
    }
  } catch (err) {
    console.warn('[ai-gateway] /chat/config fetch failed — context-light system prompt', err)
    value = null
  }
  _systemPromptCache = { at: now, value }
  return value
}

/**
 * Start the embedded AI SDK Gateway in the Electron main process. Reads the LLM
 * config from llm_settings, wires persistTurn → chat_db, listens on the resolved
 * port, /health-polls, and registers a before-quit close. Idempotent: a second
 * call while running is a no-op. Returns the listening port (or null on failure).
 */
export async function startEmbeddedAiGateway(): Promise<number | null> {
  if (_handle) return _handle.port
  const apiKey = await getLlmApiKey()
  // Phase 03a — domain client → Python serve-api READ endpoints (loopback +
  // same-machine local token, mirrors the renderer's auth leg). The read-tool
  // registry binds to it; the gateway core never reaches SQLite directly.
  const domain = new MailAgentDomainClient({
    baseUrl: `http://127.0.0.1:${resolveApiPort()}/api`,
    localToken: getLocalApiToken()
  })
  // Phase 03b — one ApprovalGuard per gateway process (the id/hash/expiry domain guard;
  // its record store must survive between the two HTTP calls of an approval round-trip,
  // so it is created ONCE here and bound into every request's write-tool factory). It is
  // the AUTHORITATIVE write gate.
  //
  // 🔴 We do NOT pass streamText `experimental_toolApprovalSecret` on the native
  // assistant-ui path: ai@6's addToolApprovalResponse drops the request signature before
  // the resume call, so a signed approval would fail missing-signature on the second POST.
  // The domain ApprovalGuard (toolCallId + input hash + expiry, surviving across the two
  // HTTP calls) plus the send tool's Python-side double guard already gate every write.
  const approvalGuard = new ApprovalGuard()
  // Phase 04a — MAILAGENT_A2UI_TOOL_CARDS gates the rich tool cards. Backend side it (a) stamps
  // the A2UI render payload into the write-tool audit (ui_payload_json) and (b) is the toggle
  // the renderer mirrors (per-flag vite define) to mount the cards. Off → byte-identical to 03b.
  // Phase 06a — DEFAULT now follows the NEW_SESSION_DEFAULT master (mirrors the renderer's
  // isA2uiToolCardsEnabled) so the cutover ships the rich cards by default; an explicit env wins.
  const a2uiEnabled = envBool('MAILAGENT_A2UI_TOOL_CARDS', masterNewSessionDefaultOn())
  // Phase 04b — MAILAGENT_AI_SDK_SEND_TOOL gates the high-risk email_prepare_send tool. The HMAC
  // signing secret for its approval token is the per-session local API token (getLocalApiToken),
  // which the Python serve-api also knows (env MAILAGENT_LOCAL_API_TOKEN) → no new key. Off
  // (default) → no send tool, byte-identical to 04a. Must be on together with the gateway +
  // write tools to take effect (buildGatewayTools only adds it under writeToolsEnabled).
  // Phase 06a — DEFAULT follows the master too (cutover ships the send tool, behind its double
  // guard + human approval); an explicit MAILAGENT_AI_SDK_SEND_TOOL still wins (independent rollback).
  const sendToolEnabled = envBool('MAILAGENT_AI_SDK_SEND_TOOL', masterNewSessionDefaultOn())
  // Phase 05 — MAILAGENT_AG_UI_MIRROR gates the AG-UI interop mirror endpoint (POST /api/ai/agui/
  // chat). Off (default) → the route is not registered, byte-identical to 04b. It is a pure旁路: it
  // reuses the SAME streamText + tools + double-guard approval as /api/ai/chat (no new write path),
  // only re-encoding the output as an AG-UI event stream. It does NOT affect the AI SDK runtime.
  const aguiMirrorEnabled = envBool('MAILAGENT_AG_UI_MIRROR', false)
  // Phase 06 — MAILAGENT_AI_SDK_CONTEXT_INJECTION gates the standing-context system prompt + the
  // renderer sending the typed AgentContextSnapshot + session reload. On → the gateway assembles the
  // system from /chat/config + the snapshot (reusing the legacy stable prefix via the provider); off
  // → body.system passthrough, byte-identical to 04b/05. Independent one-flag rollback.
  // Phase 06a — the DEFAULT now follows the NEW_SESSION_DEFAULT master so the cutover ships
  // standing-context parity (the renderer's isAiSdkContextInjectionEnabled mirrors the same master);
  // an explicit env still wins. (When the gateway is started via an explicit MAILAGENT_AI_SDK_GATEWAY
  // =true dogfood with master off, this stays off unless the injection flag is set — old per-flag UX.)
  const contextInjectionEnabled = envBool(
    'MAILAGENT_AI_SDK_CONTEXT_INJECTION',
    masterNewSessionDefaultOn()
  )
  const apiBase = `http://127.0.0.1:${resolveApiPort()}/api`
  const handle = await startAiGatewayServer({
    port: resolveAiGatewayPort(),
    baseUrl: getLlmBaseUrl(),
    apiKey,
    model: getLlmModel(),
    persistTurn,
    // M1c — auto-capture 触发（MAILAGENT_MEM0_CAPTURE，默认关）。开时注入 fire-and-forget 回调：
    // 抽取 turn 的 user+assistant 文本 POST serve-api /chat/memory/capture（mem0.add 自动抽取）。
    // 🔴 红线：回调 return void（绝不让 gateway onFinish await）+ 错误自吞 → capture 慢/失败绝不
    // 阻塞已流式 reply。关时 undefined → 字节级 flag-off（onFinish 的 ?. 短路）。capture 是纯后端
    // 行为（renderer 无感，toast 由 M1d SSE 驱动）→ 此 flag 不需 renderer mirror / vite define。
    captureTurnMemory: envBool('MAILAGENT_MEM0_CAPTURE', false)
      ? (turn) => {
          const userText = turn.userMessage ? extractTextFromUIMessage(turn.userMessage) : ''
          const assistantText = extractTextFromUIMessage(turn.responseMessage)
          if (!userText && !assistantText) return // 空 turn 不打扰后端
          // 30s 上限：mem0 抽取通常几秒；fire-and-forget 下无超时 = 挂死的 serve-api 连接会留
          // idle socket。AbortSignal.timeout 触发 → _req 抛 AbortError → 下方 .catch 吞。
          void domain
            .captureMemory(
              { userText, assistantText, sessionId: turn.sessionId },
              AbortSignal.timeout(30_000)
            )
            .catch((err) => {
              console.error('[ai-gateway] auto-capture post failed (turn streamed OK)', err)
            })
        }
      : undefined,
    // Phase 04a — apply an edit-tier UI edit to a pending approval (the resolve side-channel).
    // applyEdit overlays the editable fields onto the original input (identity pinned) WITHOUT
    // touching the ai@6 history input, so the signed approval stays valid on replay. Throws an
    // ApprovalError (.code) on not-found / expired / not-editable → typed HTTP from server.ts.
    resolveEditedApproval: (toolCallId, editedFields) => {
      const rec = approvalGuard.applyEdit(toolCallId, editedFields)
      return { approvalId: rec.approvalId, toolName: rec.toolName }
    },
    // Phase 05 — AG-UI mirror flag + its approval-request enricher. The enricher is READ-ONLY
    // (approvalGuard.peek — never mutates / consumes) and only surfaces what a client needs to render
    // the interrupt card (risk / reason / expiry + optional A2UI). NO token / secret leaves main.
    aguiMirrorEnabled,
    // Phase 06 — inject the standing-context provider ONLY when the flag is on. Off → omitted →
    // prepareChatRun uses body.system (byte-identical to 05). The provider never throws (returns
    // null → context-light) so a /chat/config blip can't break a turn.
    systemPromptProvider: contextInjectionEnabled
      ? () => getSystemPromptConfig(apiBase, getLocalApiToken())
      : undefined,
    resolveApprovalRequest: aguiMirrorEnabled
      ? (info) => {
          const rec = approvalGuard.peek(info.toolCallId)
          if (!rec) return null
          const input = rec.editedInput ?? rec.input
          const a2ui = a2uiEnabled
            ? (buildToolA2UIPayload(rec.toolName, { args: input, risk: rec.risk }) ?? undefined)
            : undefined
          return {
            toolCallId: rec.toolCallId,
            toolName: rec.toolName,
            input,
            approval: {
              id: rec.approvalId,
              risk: rec.risk,
              reason: `${rec.toolName} needs your approval before it runs (${rec.risk}-tier).`,
              expiresAt: new Date(rec.expiresAt).toISOString()
            },
            ...(a2ui ? { a2ui } : {})
          }
        }
      : undefined,
    // Factory: the gateway builds the tools per request bound to a fresh audit collector
    // (closure). Read tools always; the five approval-gated write tools only when
    // MAILAGENT_AI_SDK_WRITE_TOOLS is on (Phase 06a: default follows the cutover master; vitest /
    // no-define → off → byte-identical to 03a read-only). `approvalMode` (PART 2) comes from the
    // request body (default 'always'); 'auto-reversible' lets reversible preview writes skip the
    // card. The blocking send always asks regardless (safety floor in auditedSendTool).
    buildTools: (collector, approvalMode) =>
      buildGatewayTools(
        {
          domain,
          kosTimeDecayEnabled: envBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true),
          writeToolsEnabled: envBool('MAILAGENT_AI_SDK_WRITE_TOOLS', masterNewSessionDefaultOn()),
          approvalGuard,
          a2uiEnabled,
          // Phase 04b — the send tool needs the approval guard (write tools) + the signing secret
          // (local API token). Both already constructed above; off by default.
          sendToolEnabled,
          sendSigningSecret: getLocalApiToken(),
          // M0 — restore the four memory tools (lost at the v0.20.0 cutover). DEFAULT follows the
          // NEW_SESSION_DEFAULT master (like write/send) so the desktop default runtime can read /
          // write durable user facts again; an explicit MAILAGENT_AI_SDK_MEMORY_TOOLS wins
          // (independent rollback). memory_write/delete bind to the same approvalGuard.
          memoryToolsEnabled: envBool('MAILAGENT_AI_SDK_MEMORY_TOOLS', masterNewSessionDefaultOn()),
          // PART 2 — auto-approval mode from the request body (default 'always' when absent).
          approvalMode
        },
        collector
      ),
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
    // dogfood-3 (follow-ups) — read the last completed turn (last user + last assistant message) for
    // dynamic next-question suggestions. Always wired; the route is per-turn best-effort (the renderer
    // POSTs after each completed turn, ai-sdk path only).
    getFollowupContext: (sessionId) => getLastTurnTexts(sessionId)
  })
  _handle = handle
  const healthy = await pollHealth(handle.port)
  console.log(
    `[ai-gateway] embedded gateway listening on http://127.0.0.1:${handle.port}` +
      ` (health=${healthy ? 'ok' : 'pending'}, hasKey=${Boolean(apiKey)})`
  )
  app.once('before-quit', () => {
    void stopEmbeddedAiGateway()
  })
  return handle.port
}

/** Gracefully stop the embedded gateway (before-quit / explicit teardown). */
export async function stopEmbeddedAiGateway(): Promise<void> {
  const handle = _handle
  _handle = null
  if (handle) await handle.close()
}
