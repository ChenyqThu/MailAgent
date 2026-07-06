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
// S3 — the gateway starts unconditionally (the ONLY chat engine); index.ts still
// dynamic-imports this module so the heavy `ai` deps stay in a lazy chunk.

import { app, BrowserWindow } from 'electron'

import { startAiGatewayServer, type AiGatewayHandle } from '../../ai-gateway/server'
import {
  resolveAiGatewayPort,
  type IslandApprovalAnnounce,
  type PersistTurnInput
} from '../../ai-gateway/config'
import { MailAgentDomainClient } from '../../ai-gateway/python/domainClient'
import { buildGatewayTools } from '../../ai-gateway/tools'
import { ApprovalGuard } from '../../ai-gateway/security/approval'
import { ApprovalRunStash, DEFAULT_STASH_TTL_MS } from '../../ai-gateway/approvalStash'
import { extractApprovalStashInput } from '../../ai-gateway/chatRun'
import { buildToolA2UIPayload } from '../../shared/assistant/tools/a2ui'
import { extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import {
  appendMessage,
  appendToolCall,
  createAgentSession,
  findAssistantMessageRowIdByUiId,
  findUserMessageRowIdByUiId,
  getFirstUserText,
  getLastTurnTexts,
  getSession,
  updateMessage,
  updateSessionTitle,
  updateToolCall
} from './chat_db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'
import { resolveApiPort } from './backend_lifecycle'
import { getLocalApiToken } from './local_token'
import { deriveExecRule, ExecRuleDeriveError } from './exec_policy_matcher'
// Phase 06 (context injection) — the standing-context provider fetches the serve-api
// /chat/config, projecting the system-prompt fields for the gateway.
import { request } from '@shared/api/http_client'
import type { GatewaySystemPromptConfig } from '../../ai-gateway/systemPrompt'

/** The /chat/config response fields the gateway projects into GatewaySystemPromptConfig
 *  (was typed via the legacy HttpPlatformConfig until S3 deleted the legacy engine). */
interface ChatConfigResponse {
  standingContext?: string | null
  userContext?: string | null
  memorySummary?: string | null
  kosConfigured?: boolean
  advertisedSkills?: string[] | null
}

let _handle: AiGatewayHandle | null = null

// #12 — keys（`${sessionId}:${userMessageId}`）of user messages already written eagerly at turn
// start (onTurnStart). persistTurn checks this to avoid double-writing the SAME user message
// (once eager, once in onFinish). Keyed by session+message id — NOT bare sessionId — so an
// abandoned HITL turn (approval never resolved → persistTurn never ran → key never cleared)
// cannot swallow the NEXT, different user message in the same session. Module-level so it
// survives across request handlers within one gateway lifecycle; entries are removed by
// persistTurn on the matched turn and the set resets on app restart.
const eagerWrittenUserMessages = new Set<string>()

/** #12 — dedup key for one eagerly-written user message. */
function eagerUserMessageKey(sessionId: number, userMessageId: string): string {
  return `${sessionId}:${userMessageId}`
}

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
 *
 * #12 — if onTurnStart already wrote THIS turn's user message eagerly (tracked via
 * eagerWrittenUserMessages, keyed by session+message id), skip the user message here
 * to avoid duplicate rows. The key is removed after the check so the set stays bounded.
 */
function persistTurn(turn: PersistTurnInput): void {
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
  if (!eagerWritten && turn.userMessage) {
    appendMessage({
      sessionId: turn.sessionId,
      role: 'user',
      content: extractTextFromUIMessage(turn.userMessage),
      status: 'complete',
      uiMessageJson: JSON.stringify(turn.userMessage)
    })
  }
  // R2-3 — upsert by UIMessage id: if the approval pause already persisted a redacted copy of this
  // assistant message (persistPausedAssistant, same merged id on resume), REPLACE that row with the
  // final full message instead of appending a duplicate. DB-backed lookup（json_extract '$.id'）——
  // survives app restarts, no in-memory state. Normal turns: lookup misses（one cheap per-session
  // SELECT）→ append as before.
  const pausedRowId = findAssistantMessageRowIdByUiId(turn.sessionId, turn.responseMessage.id)
  let assistantId: number
  if (pausedRowId != null) {
    updateMessage(pausedRowId, {
      content: extractTextFromUIMessage(turn.responseMessage),
      status: 'complete',
      model: turn.model,
      tokensInput: turn.usage?.inputTokens ?? null,
      tokensOutput: turn.usage?.outputTokens ?? null,
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
    const cfg = await request<ChatConfigResponse>(apiBase, 'GET', '/chat/config', {
      headers: localToken ? { 'X-MailAgent-Local-Token': localToken } : {}
    })
    value = {
      standingContext: cfg.standingContext ?? null,
      userContext: cfg.userContext ?? null,
      memorySummary: cfg.memorySummary ?? null,
      kosConfigured: cfg.kosConfigured ?? false,
      // M4a — advertised (enabled && available) skill names for skill→tool gating (read by the
      // buildTools factory, NOT the prompt). null when /chat/config omits it → gateway fails open.
      advertisedSkills: cfg.advertisedSkills ?? null
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
  //
  // Part B (harness 上岛, MAILAGENT_ISLAND_AGENT_ENABLED) — when the island agent path is on, an
  // approval can wait on the island (user off the app) → extend the guard TTL to the island ack
  // window (30 min, DEFAULT_STASH_TTL_MS) so verify()/consume() don't expire before the user comes
  // back to click. Default ON since E3 cutover (2026-07-06, owner 终拍) — no island installed/running
  // is a first-class fail-open path (the announce POST to serve-api never throws; the island socket
  // send fails closed → debug-only log, no retry, no queue backlog — covered by direct unit tests, see
  // research/island-no-island-degradation.md), so users without the island app get inert no-op, not
  // errors. An explicit env false is the emergency rollback — the guard then keeps its 5-min TTL
  // (byte-identical to pre-cutover).
  const islandAgentEnabled = envBool('MAILAGENT_ISLAND_AGENT_ENABLED', true)
  // S6 W2 (PRD P8) — the SERVER-SIDE approval resume infra (stash + extended guard TTL + settle hook)
  // follows EITHER flag, not just the island: a headless custom-agent run (MAILAGENT_CUSTOM_AGENTS_
  // ENABLED) that pauses at an approval must be claimable IN-APP (the record view's /decide) even with
  // the island off ("内部审批优先"). Only the announce LEG (pushing an island card) stays island-only,
  // gated below. Both flags off → serverResumeEnabled false → no stash, 5-min guard TTL, /pending +
  // /decide 404 → byte-identical to pre-S6. (customAgentsEnabled is re-read for the endpoint gating
  // comment at the agent-run wiring below; one envBool per key is cheap.)
  // Default ON since E3 cutover (2026-07-06; v1.4.0 dogfood 全 flag-on 通过 R1-R5) — an explicit
  // env false is the emergency rollback (kill-switch). The Python side reads the SAME env via
  // pydantic (custom_agents_enabled, default True) — both sides flip together (E3 WP4).
  const customAgentsEnabled = envBool('MAILAGENT_CUSTOM_AGENTS_ENABLED', true)
  const serverResumeEnabled = islandAgentEnabled || customAgentsEnabled
  // The guard record must outlive the stash window so a verify()/consume() on the eventual in-app (or
  // island) approve doesn't expire first — extend it whenever server-side resume is live.
  const approvalGuard = serverResumeEnabled
    ? new ApprovalGuard({ ttlMs: DEFAULT_STASH_TTL_MS })
    : new ApprovalGuard()
  // Part B / S6 W2 — per-gateway stash of paused approval runs (server-side resume source). Built when
  // EITHER server-resume flag is on; both off → undefined → chatRun's stash block is inert + /pending +
  // /decide 404 (byte-identical to pre-S6). The stash's PRESENCE (not the island flag) is now the
  // gate everywhere downstream.
  const approvalStash = serverResumeEnabled ? new ApprovalRunStash() : undefined
  // Set after the server listens (chicken-and-egg: the announce needs the gateway's own port, known
  // only post-listen; a paused approval fires well after startup so this is populated by then).
  let gatewayPort = 0
  // S3 — the A2UI rich tool cards are always on (MAILAGENT_A2UI_TOOL_CARDS GA'd away):
  // backend side stamps the A2UI render payload into the write-tool audit (ui_payload_json);
  // the renderer mounts the cards unconditionally (registerToolUIs).
  const a2uiEnabled = true
  // Phase 04b — MAILAGENT_AI_SDK_SEND_TOOL gates the high-risk email_prepare_send tool. The HMAC
  // signing secret for its approval token is the per-session local API token (getLocalApiToken),
  // which the Python serve-api also knows (env MAILAGENT_LOCAL_API_TOKEN) → no new key. Must be
  // on together with write tools to take effect (buildGatewayTools only adds it under
  // writeToolsEnabled). S3 — kept as an env-only KILL-SWITCH, default literal true (the cutover
  // master it used to follow was GA'd away); an explicit env false is the independent shutdown
  // for the real-SMTP surface (complements, never replaces, the blocking approval).
  const sendToolEnabled = envBool('MAILAGENT_AI_SDK_SEND_TOOL', true)
  // Phase 05 — MAILAGENT_AG_UI_MIRROR gates the AG-UI interop mirror endpoint (POST /api/ai/agui/
  // chat). Off (default) → the route is not registered, byte-identical to 04b. It is a pure旁路: it
  // reuses the SAME streamText + tools + double-guard approval as /api/ai/chat (no new write path),
  // only re-encoding the output as an AG-UI event stream. It does NOT affect the AI SDK runtime.
  const aguiMirrorEnabled = envBool('MAILAGENT_AG_UI_MIRROR', false)
  // S3 — standing-context injection is always on (MAILAGENT_AI_SDK_CONTEXT_INJECTION GA'd
  // away): the gateway assembles the system prompt from /chat/config + the renderer snapshot
  // via the provider below. The provider never throws (returns null → context-light) so a
  // /chat/config blip can't break a turn.
  // M4a — MAILAGENT_SKILL_SELF_MOUNT (default ON since the 2026-07-02 cutover; an explicit env
  // false is the emergency rollback — NOT master-following) gates the gateway's skill→tool filter:
  // the per-request buildTools factory drops a disabled skill's read tools by consulting
  // /chat/config.advertisedSkills (Python 业务态). Pure backend — the gateway runs in the electron
  // main process; the renderer never reads this flag → main env only, NO vite define (mirrors
  // MAILAGENT_MEM0_CAPTURE/RETRIEVAL). Off → applySkillGating never called → ToolSet byte-identical
  // to the cutover set.
  const skillGatingEnabled = envBool('MAILAGENT_SKILL_SELF_MOUNT', true)
  // S1 R1 (task 07-02 openness wave1) — MAILAGENT_OPENNESS_SESSION_TOOLS gates the three
  // chat-session read tools (chat_session_list/search/get). Default ON since E3 cutover (2026-07-06;
  // v1.4.0 dogfood 全 flag-on 通过 R1-R5) — an explicit env false is the emergency rollback
  // (kill-switch), NOT master-following. main-env-only, NO vite define (the renderer never reads it
  // — mirrors MAILAGENT_ISLAND_AGENT_ENABLED). Explicit false → buildGatewayTools output
  // byte-identical to pre-cutover (v1.2.0).
  const sessionToolsEnabled = envBool('MAILAGENT_OPENNESS_SESSION_TOOLS', true)
  // S1 R2 — MAILAGENT_OPENNESS_CONFIG_TOOLS gates the four profile-config tools
  // (agent_profile_read/history/restore + agent_memory_update). Default ON since E3 cutover
  // (2026-07-06); an explicit env false is the emergency rollback (kill-switch). main-env-only,
  // NO vite define (mirrors MAILAGENT_OPENNESS_SESSION_TOOLS). Explicit false → buildGatewayTools
  // output byte-identical to pre-cutover (v1.2.0).
  const configToolsEnabled = envBool('MAILAGENT_OPENNESS_CONFIG_TOOLS', true)
  // S1 R3 — MAILAGENT_OPENNESS_WEB_TOOLS gates the two web tools (web_fetch / web_search, both
  // edit-tier writes — outbound network always asks; SSRF-guarded server-side in routers/web.py).
  // Default ON since E3 cutover (2026-07-06); an explicit env false is the emergency rollback
  // (kill-switch). The always-asks HITL floor on outbound network is unchanged by the default flip.
  // main-env-only, NO vite define (mirrors the other two openness flags). Explicit false →
  // buildGatewayTools output byte-identical to pre-cutover (v1.2.0).
  const webToolsEnabled = envBool('MAILAGENT_OPENNESS_WEB_TOOLS', true)
  // S2 W1 — MAILAGENT_OPENNESS_EXEC_TOOLS gates the three exec tools (run_command / file_read /
  // file_write, all edit-tier writes — local execution always asks unless a structured PolicyRule
  // whitelist matches; class 'exec' = manual_chat-only). Default ON since E3 cutover (2026-07-06);
  // an explicit env false is the emergency rollback (kill-switch). The security floor is unchanged
  // by the default flip: no whitelist rule → every exec still asks (恒 HITL). main-env-only, NO vite
  // define (mirrors the other openness flags). Explicit false → buildGatewayTools output
  // byte-identical to pre-cutover (v1.2.0).
  const execToolsEnabled = envBool('MAILAGENT_OPENNESS_EXEC_TOOLS', true)
  // S2 W4 — MAILAGENT_OPENNESS_SKILL_INSTALL gates the four skill-supply tools (skill_install /
  // skill_install_confirm / skill_uninstall — edit-tier capability_change writes, two HITL cards
  // per install with the confirm card rendering SERVER facts; + skill_read, silent fenced read).
  // Default ON since E3 cutover (2026-07-06); an explicit env false is the emergency rollback
  // (kill-switch). The security floor is unchanged by the default flip: capability_change installs
  // are 恒 HITL (never auto-approved). main-env-only, NO vite define (mirrors the other openness
  // flags). Explicit false → buildGatewayTools output byte-identical to pre-cutover (v1.2.0).
  const skillInstallToolsEnabled = envBool('MAILAGENT_OPENNESS_SKILL_INSTALL', true)
  // S4 W3 — MAILAGENT_CUSTOM_AGENTS_ENABLED gates the headless custom-agent fresh-spawn endpoint
  // (POST /api/ai/agent-run): its two cfg hooks (fetchAgentRunSpec + createAgentSession) are wired
  // only when on → an explicit env false → the endpoint 404s, byte-identical to S3. This wave adds
  // ZERO gateway tools, so buildGatewayTools output is unaffected either way. Main-env-only, NO vite
  // define (the renderer never reads it — mirrors the other openness flags). The Python side reads
  // the SAME env via pydantic (custom_agents_enabled) to gate the trigger worker + spec endpoints.
  // (customAgentsEnabled is read once above with serverResumeEnabled — the S6 W2 stash decoupling.)
  const apiBase = `http://127.0.0.1:${resolveApiPort()}/api`
  // M4a — prewarm the /chat/config cache ONCE before the server accepts requests so the per-request
  // buildTools factory reads a populated advertisedSkills on the very first turn (no null-first-turn
  // gap). Only when gating is on; getSystemPromptConfig never throws (null on failure → buildGatewayTools
  // fails open). flag-off → not called → startup behaviour unchanged.
  if (skillGatingEnabled) {
    await getSystemPromptConfig(apiBase, getLocalApiToken())
  }

  // Part B (harness 上岛) — fire-and-forget announce a paused approval to the island via serve-api
  // /api/island/agent/announce. Enriches `risk` from the ApprovalGuard (main owns it) and stamps THIS
  // gateway's port so serve-api's ack → /api/ai/approval/decide callback reaches us. Local-token
  // authenticated (gateway → serve-api loopback). Never awaited (best-effort; a slow/failed announce
  // can't block the already-paused turn). Skips unsaved sessions (sessionId null → the user is active
  // in-app, the renderer resumes; no island card needed).
  const announceApprovalToIsland = (info: IslandApprovalAnnounce): void => {
    if (info.sessionId == null) return
    const rec = approvalGuard.peek(info.toolCallId)
    const payload = {
      kind: 'approval',
      sessionId: info.sessionId,
      toolName: info.toolName,
      inputPreview: info.inputPreview,
      risk: rec?.risk ?? info.risk,
      toolCallId: info.toolCallId,
      resumeToken: info.resumeToken,
      gatewayPort
    }
    const localToken = getLocalApiToken()
    void fetch(`http://127.0.0.1:${resolveApiPort()}/api/island/agent/announce`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(localToken ? { 'X-MailAgent-Local-Token': localToken } : {})
      },
      body: JSON.stringify(payload)
    }).catch((err) => {
      console.error('[ai-gateway] island approval announce failed (turn paused OK)', err)
    })
  }

  const handle = await startAiGatewayServer({
    port: resolveAiGatewayPort(),
    baseUrl: getLlmBaseUrl(),
    apiKey,
    model: getLlmModel(),
    // #12 (dogfood session-history) — eager-persist: write the user message at turn START so the
    // session appears in history even when the first turn is HITL-paused and onFinish skips
    // persistTurn. eagerWrittenUserMessages（module-level Set，keyed `${sessionId}:${messageId}`）
    // coordinates with persistTurn to prevent double-writing when both paths fire.
    onTurnStart: (sessionId, userMessage) => {
      if (sessionId == null || !userMessage) return
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
    persistPausedAssistant: (sessionId, redactedMessage, modelId) => {
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
      } catch (err) {
        console.error('[ai-gateway] persistPausedAssistant write failed (best-effort)', err)
      }
    },
    persistTurn,
    // M1c — auto-capture 触发（MAILAGENT_MEM0_CAPTURE，默认开 —— 2026-07-02 cutover，env 显式
    // false 为应急回退）。开时注入 fire-and-forget 回调：
    // 抽取 turn 的 user+assistant 文本 POST serve-api /chat/memory/capture（mem0.add 自动抽取）。
    // 🔴 红线：回调 return void（绝不让 gateway onFinish await）+ 错误自吞 → capture 慢/失败绝不
    // 阻塞已流式 reply。关时 undefined → 字节级 flag-off（onFinish 的 ?. 短路）。capture 是纯后端
    // 行为（renderer 无感，toast 由 M1d SSE 驱动）→ 此 flag 不需 renderer mirror / vite define。
    captureTurnMemory: envBool('MAILAGENT_MEM0_CAPTURE', true)
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
    // 07-01 — M2 per-query recall (retrieveMemory → /chat/memory/search) is retired. The bounded
    // memory.md is now injected into the cacheable stable prefix via /chat/config.memorySummary
    // (getSystemPromptConfig above already carries it, on a 15s TTL — NOT frozen per session), so
    // there is no per-turn recall callback. A durable-fact capture re-caches the prefix on a later
    // turn once the TTL lapses; keeping memory in the cached prefix is cost-optimal for the occasional
    // capture (most turns hit the cache, only an occasional re-cache — cheaper than an uncached refetch
    // every turn).
    // Phase 04a — apply an edit-tier UI edit to a pending approval (the resolve side-channel).
    // applyEdit overlays the editable fields onto the original input (identity pinned) WITHOUT
    // touching the ai@6 history input, so the signed approval stays valid on replay. Throws an
    // ApprovalError (.code) on not-found / expired / not-editable → typed HTTP from server.ts.
    resolveEditedApproval: (toolCallId, editedFields) => {
      const rec = approvalGuard.applyEdit(toolCallId, editedFields)
      return { approvalId: rec.approvalId, toolName: rec.toolName }
    },
    // S2 W1 — the exec approval card's "always allow" affordance (POST /api/ai/policy/remember).
    // Peek the pending exec approval (READ-ONLY — never mutates/consumes; the same approved
    // argv/cwd/path so the model cannot forge a broader rule), derive a full-PIN structured rule,
    // and persist it via the owner policy API with context_mode PINNED to manual_chat (a whitelist
    // is manual-only, ADR-001 §9). Only wired when exec tools are on → /remember 501s otherwise.
    // Throws an ExecRuleDeriveError/.code (non-exec tool / no record / fs error) → typed HTTP.
    rememberExecApproval: execToolsEnabled
      ? async (toolCallId: string) => {
          const rec = approvalGuard.peek(toolCallId)
          // E_APPROVAL_NOT_FOUND → server maps to 404 (the pending approval expired / wrong id).
          if (!rec) {
            throw new ExecRuleDeriveError('E_APPROVAL_NOT_FOUND', 'no pending approval to remember')
          }
          const input = rec.editedInput ?? rec.input
          const { capability, matcher } = deriveExecRule(rec.toolName, input)
          const rule = await domain.createPolicyRule({
            capability,
            matcher,
            contextMode: 'manual_chat',
            note: '审批卡「总是允许」'
          })
          return rule as unknown as Record<string, unknown>
        }
      : undefined,
    // S6 W3-3 (ADR-004 rev3.1 §4.2 D-fix-3) — the in-record web_fetch "always allow this domain" PIN.
    // Wired only when web tools + custom agents + the stash are on (else the { approvalId } shape 501s).
    // Peeks the STASHED headless approval by approvalId (read-only), enforces the agent-run-only
    // boundary (a manual web_fetch never lands in the stash — only headless runs stash — so a per-agent
    // rule can never derive from manual chat; the toolName + agentRunContext asserts are defence in
    // depth), extracts the approved URL, and creates a per-agent web origin rule with the agent id +
    // SERVER-derived contextMode (Python normalizes the origin on store — TS never self-normalizes).
    rememberWebApproval:
      webToolsEnabled && customAgentsEnabled && approvalStash
        ? async (approvalId: string) => {
            const entry = approvalStash.peekByApprovalId(approvalId)
            if (!entry) {
              throw new ExecRuleDeriveError(
                'E_APPROVAL_NOT_FOUND',
                'no pending approval to remember'
              )
            }
            const agentId = entry.agentRunContext?.agentId
            if (entry.toolName !== 'web_fetch' || agentId == null) {
              throw new ExecRuleDeriveError(
                'E_INVALID_ARG',
                'remember-web applies only to a headless web_fetch approval'
              )
            }
            const extracted = extractApprovalStashInput(entry.responseMessage)
            const url =
              extracted && extracted.input != null && typeof extracted.input === 'object'
                ? (extracted.input as { url?: unknown }).url
                : undefined
            if (typeof url !== 'string' || url.length === 0) {
              throw new ExecRuleDeriveError('E_INVALID_ARG', 'approved web_fetch has no url')
            }
            const rule = await domain.createPolicyRule({
              capability: 'web',
              // origin = the approved URL verbatim; Python _normalize_origin canonicalizes on store.
              matcher: { v: 1, origin: url },
              agentId,
              note: '审批卡「总是允许该域名」'
            })
            return rule as unknown as Record<string, unknown>
          }
        : undefined,
    // Phase 05 — AG-UI mirror flag + its approval-request enricher. The enricher is READ-ONLY
    // (approvalGuard.peek — never mutates / consumes) and only surfaces what a client needs to render
    // the interrupt card (risk / reason / expiry + optional A2UI). NO token / secret leaves main.
    aguiMirrorEnabled,
    // S3 — the standing-context provider is always injected (CONTEXT_INJECTION GA'd away).
    // The provider never throws (returns null → context-light) so a /chat/config blip can't
    // break a turn.
    systemPromptProvider: () => getSystemPromptConfig(apiBase, getLocalApiToken()),
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
    // (closure). Read tools always; the five approval-gated write tools under
    // MAILAGENT_AI_SDK_WRITE_TOOLS — S3: an env-only KILL-SWITCH, default literal true (the
    // cutover master it used to follow was GA'd away). `approvalMode` (PART 2) comes from the
    // request body (default 'always'); 'auto-reversible' lets reversible preview writes skip the
    // card. The blocking send always asks regardless (safety floor in auditedSendTool).
    buildTools: (collector, approvalMode, contextMode, agentRunContext) =>
      buildGatewayTools(
        {
          domain,
          kosTimeDecayEnabled: envBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true),
          writeToolsEnabled: envBool('MAILAGENT_AI_SDK_WRITE_TOOLS', true),
          approvalGuard,
          a2uiEnabled,
          // Phase 04b — the send tool needs the approval guard (write tools) + the signing secret
          // (local API token). Both already constructed above; off by default.
          sendToolEnabled,
          sendSigningSecret: getLocalApiToken(),
          // PART 2 — auto-approval mode from the request body (default 'always' when absent).
          approvalMode,
          // S2 W0 (ADR-001 D1) — the run's trusted context mode from prepareChatRun (never the
          // body). Absent → buildGatewayTools fail-closes to 'untrusted_trigger'.
          contextMode,
          // M4a — skill→tool gating (MAILAGENT_SKILL_SELF_MOUNT). advertisedSkills from the TTL-cached
          // /chat/config projection; the systemPromptProvider (always injected post-S3) re-fetches it
          // per-request → a Settings skill toggle takes effect within the 15s TTL. null (cache empty /
          // Python hiccup) → fails open. SELF_MOUNT off → applySkillGating never called → ToolSet
          // byte-identical.
          skillGatingEnabled,
          advertisedSkills: _systemPromptCache?.value?.advertisedSkills ?? null,
          // Part B — make preview/edit writes one-shot when island agent is on, so an island-resumed
          // approval and a renderer-resumed approval never double-execute. Off → byte-identical.
          oneShotWrites: islandAgentEnabled,
          // S1 R1 — chat-session read tools (MAILAGENT_OPENNESS_SESSION_TOOLS, default off).
          sessionToolsEnabled,
          // S1 R2 — profile-config tools (MAILAGENT_OPENNESS_CONFIG_TOOLS, default off).
          configToolsEnabled,
          // S1 R3 — web tools (MAILAGENT_OPENNESS_WEB_TOOLS, default off).
          webToolsEnabled,
          // S2 W1 — exec tools (MAILAGENT_OPENNESS_EXEC_TOOLS, default off).
          execToolsEnabled,
          // S2 W4 — skill-supply tools (MAILAGENT_OPENNESS_SKILL_INSTALL, default off).
          skillInstallToolsEnabled,
          // S5 W3 — conversational custom-agent CRUD tools (MAILAGENT_CUSTOM_AGENTS_ENABLED, the same
          // flag that gates the S4 headless kernel; default off → byte-identical to the S4 set).
          customAgentToolsEnabled: customAgentsEnabled,
          // S5 W4 (ADR-004) — the per-agent run context of a headless agent run, from
          // wrapCfgForAgentRun's buildTools wrapper (4th param). Manual runs pass undefined →
          // assembly byte-identical.
          agentRunContext
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
    getFollowupContext: (sessionId) => getLastTurnTexts(sessionId),
    // Part B (harness 上岛, MAILAGENT_ISLAND_AGENT_ENABLED) — server-side island approval resume.
    // All undefined when off (default) → chatRun's stash/announce block is inert + /api/ai/approval/
    // decide 404s + write tools keep their pre-Part-B one-call verify, byte-identical.
    islandAgentEnabled,
    approvalStash,
    announceApprovalToIsland: islandAgentEnabled ? announceApprovalToIsland : undefined,
    // /decide short-circuit vs a renderer that won the race: has THIS approval already reached a
    // terminal decision (executed OR rejected) on the other surface? If so, resumeApprovalRun does
    // not re-run (no double execute / persist; a renderer reject also blocks a later island approve).
    isApprovalResolved: islandAgentEnabled
      ? (toolCallId: string) => approvalGuard.isResolved(toolCallId)
      : undefined,
    // Tombstone an approval as rejected so the other surface can't approve+execute it afterwards.
    rejectApproval: islandAgentEnabled
      ? (toolCallId: string) => approvalGuard.reject(toolCallId)
      : undefined,
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
    onServerResumeSettled: serverResumeEnabled
      ? (sessionId: number, status: 'completed' | 'rejected' | 'error') => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed()) continue
            try {
              win.webContents.send('chat:session-updated', { sessionId, status })
            } catch {
              /* renderer torn down mid-send — ignore */
            }
          }
          if (customAgentsEnabled) {
            try {
              const session = getSession(sessionId)
              if (session?.origin === 'agent' && session.agent_job_id) {
                const jobId = Number(session.agent_job_id)
                if (Number.isInteger(jobId)) {
                  const state = status === 'rejected' ? 'rejected' : 'approved'
                  void domain
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
    // S4 W3 (ADR-003 D2) — pull the authoritative agent-run spec by jobId + claimToken. Wired only
    // when MAILAGENT_CUSTOM_AGENTS_ENABLED is on → off (default) → POST /api/ai/agent-run 404s.
    fetchAgentRunSpec: customAgentsEnabled
      ? (jobId: number, claimToken: string) => domain.fetchAgentRunSpec(jobId, claimToken)
      : undefined,
    // S4 W3 (ADR-003 D3) — pre-create the ai_chat.db session (origin='agent') a headless run persists
    // into. Wired only when custom agents are on. A create failure returns null (the run streams but
    // persists nothing) rather than throwing → the endpoint degrades gracefully.
    createAgentSession: customAgentsEnabled
      ? (input: { agentId: string; jobId: number; title: string }) => {
          try {
            return createAgentSession(input)
          } catch (err) {
            console.error('[ai-gateway] createAgentSession failed (run will be unsaved)', err)
            return null
          }
        }
      : undefined
  })
  _handle = handle
  gatewayPort = handle.port // Part B — now the announce closure can stamp our port on /decide callbacks
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
