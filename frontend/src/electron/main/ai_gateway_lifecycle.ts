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

import { randomBytes } from 'node:crypto'

import { app } from 'electron'

import { startAiGatewayServer, type AiGatewayHandle } from '../../ai-gateway/server'
import { resolveAiGatewayPort, type PersistTurnInput } from '../../ai-gateway/config'
import { MailAgentDomainClient } from '../../ai-gateway/python/domainClient'
import { buildGatewayTools } from '../../ai-gateway/tools'
import { ApprovalGuard } from '../../ai-gateway/security/approval'
import { extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import { appendMessage, appendToolCall, updateToolCall } from './chat_db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'
import { resolveApiPort } from './backend_lifecycle'
import { getLocalApiToken } from './local_token'

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
      ...(tc.approvalHash !== undefined ? { approvalHash: tc.approvalHash } : {})
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
  // so it is created ONCE here and bound into every request's write-tool factory). The
  // per-process HMAC secret signs ai@6's tool-approval-requests (forge / input-swap guard,
  // the layer that stacks on the domain guard). Both only matter when write tools are on.
  const approvalGuard = new ApprovalGuard()
  const toolApprovalSecret = randomBytes(32).toString('hex')
  const handle = await startAiGatewayServer({
    port: resolveAiGatewayPort(),
    baseUrl: getLlmBaseUrl(),
    apiKey,
    model: getLlmModel(),
    persistTurn,
    toolApprovalSecret,
    // Factory: the gateway builds the tools per request bound to a fresh audit collector
    // (closure). Read tools always; the five approval-gated write tools only when
    // MAILAGENT_AI_SDK_WRITE_TOOLS is on (default off → byte-identical to 03a read-only).
    buildTools: (collector) =>
      buildGatewayTools(
        {
          domain,
          kosTimeDecayEnabled: envBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true),
          writeToolsEnabled: envBool('MAILAGENT_AI_SDK_WRITE_TOOLS', false),
          approvalGuard
        },
        collector
      )
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
