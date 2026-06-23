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
import { extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import { appendMessage } from './chat_db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'

let _handle: AiGatewayHandle | null = null

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
  appendMessage({
    sessionId: turn.sessionId,
    role: 'assistant',
    content: extractTextFromUIMessage(turn.responseMessage),
    status: 'complete',
    model: turn.model,
    tokensInput: turn.usage?.inputTokens ?? null,
    tokensOutput: turn.usage?.outputTokens ?? null,
    uiMessageJson: JSON.stringify(turn.responseMessage)
  })
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
  const handle = await startAiGatewayServer({
    port: resolveAiGatewayPort(),
    baseUrl: getLlmBaseUrl(),
    apiKey,
    model: getLlmModel(),
    persistTurn
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
