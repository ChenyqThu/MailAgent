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

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

import { ActiveRunRegistry } from '../../ai-gateway/activeRuns'
import { ApprovalRunStash, DEFAULT_STASH_TTL_MS } from '../../ai-gateway/approvalStash'
import { type CompactPersistence } from '../../ai-gateway/compact'
import { selectMessagesForModelContext } from '../../ai-gateway/compactSelect'
import { resolveAiGatewayPort, type AiGatewayConfig } from '../../ai-gateway/config'
import { MailAgentDomainClient } from '../../ai-gateway/python/domainClient'
import {
  ApprovalGuard,
  HIGH_RISK_OUTBOUND_APPROVAL_TTL_MS,
  NORMAL_APPROVAL_TTL_MS
} from '../../ai-gateway/security/approval'
import { startAiGatewayServer, type AiGatewayHandle } from '../../ai-gateway/server'
import { classOfTool } from '../../ai-gateway/tools/policy'
import { type ProviderModelResolver } from '../../ai-gateway/providerRef'
import type { ComputerUseActivityState } from '../../shared/computerUseOverlayContract'
import {
  buildGroupGatewayHooks,
  computeJudgeScopeStale,
  resolveGroupMember
} from './ai_gateway/groupGlue'
import {
  broadcastChatEvent,
  buildTurnPersistenceHooks,
  gatewayLogLine
} from './ai_gateway/persistenceGlue'
import { wirePostTurnAndQueuedInput } from './ai_gateway/postTurnGlue'
import { buildApprovalAndToolHooks } from './ai_gateway/toolsGlue'
import { createGatewayTtlResolvers, getSystemPromptConfig } from './ai_gateway/ttlResolvers'
import { resolveApiPort } from './backend_lifecycle'
import {
  appendMessage,
  cancelQueuedInput,
  confirmQueuedInput,
  enqueueQueuedInput,
  getQueuedInput,
  getSession,
  listMessages,
  listQueuedInput,
  restoreAllStale,
  restoreForSession,
  updateQueuedInput
} from './chat_db'
import { resolveDataRoot } from './db'
import { envBool } from './lib/env-bool'
import {
  backfillLegacyDefaultProviderKey,
  getLlmProviderModelResolver,
  isLlmProviderRegistryEnabled
} from './llm_provider_resolver'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'
import { getLocalApiToken } from './local_token'
import { startMainModelCatalogUpdates } from './model_catalog_updates'

export { computeJudgeScopeStale, resolveGroupMember }

let _handle: AiGatewayHandle | null = null
let stopModelCatalogUpdates: (() => void) | null = null

// WP7 dogfood 修复 — before-quit 钩子只挂一次。startEmbeddedAiGateway 现在会被
// restartEmbeddedAiGateway 二次调用（Labs「重启后端」连带重建 gateway），每启一次就
// app.once() 一个新的 one-shot listener → 重启十次后 MaxListenersExceededWarning，
// 且退出时把同一个幂等 stop 调十遍。挂钩与 handle 无关（stop 自己读当前 _handle），
// 所以整个进程生命周期一次就够。
let _quitHookRegistered = false
// 连点两次「重启后端」的互斥：stop 把 _handle 置空后 start 里有多个 await，两条重启
// 并发会双双走到 server.listen(同一个固定端口) → 第二条 EADDRINUSE reject。第二次调用
// 直接复用在途 Promise（而不是排队再重启一次）——用户连点两下要的是「重启一次」。
let _restarting: Promise<number | null> | null = null

/** L4 群聊 UX 批 — renderer 经 `chat:group-foreground` 上报的「此刻在前台的群」（null = 没有）。
 *  通知投影据此跳过 owner 正盯着看的群；未上报过 = 不在前台 → 发（按链合并，有界）。
 *  T3 起是二元组 {groupId, threadId|null}：群主线在前台 = threadId null；话题面在前台 = 该话题
 *  id。抑制判据 = 群相同 **且** threadId 相同（盯着群主线时话题回复照发，反之亦然）。 */
let foregroundGroup: { groupId: number; threadId: number | null } | null = null

function isGroupForeground(groupId: number, threadId: number | null): boolean {
  return (
    BrowserWindow.getFocusedWindow() != null &&
    foregroundGroup != null &&
    foregroundGroup.groupId === groupId &&
    foregroundGroup.threadId === threadId
  )
}

/** `chat:group-foreground {groupId: number | null, threadId: number | null}` 的 ipcMain.handle
 *  （一处）。🔴 两个键名与 renderer 侧唯一的发送点 `ElectronApi.setGroupForeground` 逐字对齐
 *  （闸 tests/main/group_foreground_ipc.test.ts）—— 键名对不上不会有类型错、也不会报错，
 *  只会让 foregroundGroup 恒为 null，表现成「群明明开着，通知照发」。`threadId` 缺省 /
 *  非正整数 = null（群主线在前台）。restart 会再走一遍 startEmbeddedAiGateway，先
 *  removeHandler 防「second handler」抛错。 */
function registerGroupForegroundHandler(): void {
  ipcMain.removeHandler('chat:group-foreground')
  ipcMain.handle('chat:group-foreground', (_evt, payload: unknown) => {
    const body =
      payload != null && typeof payload === 'object'
        ? (payload as { groupId?: unknown; threadId?: unknown })
        : {}
    const positive = (raw: unknown): number | null =>
      typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
    const groupId = positive(body.groupId)
    foregroundGroup = groupId == null ? null : { groupId, threadId: positive(body.threadId) }
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
export interface StartEmbeddedAiGatewayOptions {
  computerUseOverlay?: {
    reportActivity: (state: ComputerUseActivityState) => void
    registerAbort: (runId: string, abort: () => void) => () => void
  }
}

export async function startEmbeddedAiGateway(
  opts?: StartEmbeddedAiGatewayOptions
): Promise<number | null> {
  if (_handle) return _handle.port
  registerGroupForegroundHandler()
  const apiKey = await getLlmApiKey()
  const llmBaseUrl = getLlmBaseUrl()
  const providerRegistryEnabled = isLlmProviderRegistryEnabled()
  // MEDIUM-6 — the shared main-process resolver keeps providers.ts (and thus the six provider SDK
  // packages) behind a flag-on dynamic import. Flag off → the chunk never loads.
  let providerModelResolver: ProviderModelResolver | undefined
  if (providerRegistryEnabled) {
    // 发版终审 HIGH-1 — keytar-only 旧 key 回填必须先于 resolver 构建：resolver 首拉快照
    // 即拿到回填后的 default 行（version 已 bump），无需强制刷新。失败仅 warning 不阻断。
    await backfillLegacyDefaultProviderKey()
    providerModelResolver = await getLlmProviderModelResolver()
  }
  // task 09-02 — generate_image store, sibling of data/attachments (created lazily by the tool).
  const generatedImagesDir = join(resolveDataRoot(), 'data', 'generated')
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
  // 07-15 owner拍板 — the SERVER-SIDE approval resume infra (stash + extended guard TTL + /pending +
  // /decide + settle broadcast) is UNCONDITIONAL: the in-panel approval card and Feishu approval
  // card are first-class approval surfaces. Security posture is unchanged: /decide stays fail-closed
  // (one-shot claim, approvalId/token-matched), the guard stays hash-bound one-shot, and
  // cross-surface single-resolver semantics (oneShotWrites / isApprovalResolved / rejectApproval /
  // serverResumeEnabled in chatRun) are ALWAYS live. (customAgentsEnabled still gates the S4
  // headless agent-run endpoint + job settle below; default ON since E3 cutover, env explicit false
  // = kill-switch.)
  const customAgentsEnabled = envBool('MAILAGENT_CUSTOM_AGENTS_ENABLED', true)
  const customAgentCallEnabled = envBool('MAILAGENT_CUSTOM_AGENT_CALL', true)
  // task 08-14 — 内建 agent 工具面。🔴 双载体：这里与 Python `internal_agent_tools_enabled`
  // （src/config.py）默认必须同为 true，回退也一起翻。main-env-only，不加 vite define。
  const internalAgentToolsEnabled = envBool('MAILAGENT_INTERNAL_AGENT_TOOLS', true)
  const serverResumeEnabled = true
  // The guard record must outlive the stash window so a verify()/consume() on the eventual in-app (or
  // island) approve doesn't expire first — extended TTL whenever server-side resume is live (always).
  const approvalTtlForTool = customAgentCallEnabled
    ? (toolName: string) =>
        classOfTool(toolName) === 'outbound'
          ? HIGH_RISK_OUTBOUND_APPROVAL_TTL_MS
          : NORMAL_APPROVAL_TTL_MS
    : undefined
  const approvalGuard = new ApprovalGuard({
    ttlMs: DEFAULT_STASH_TTL_MS,
    ttlMsForTool: approvalTtlForTool
  })
  // Part B / S6 W2 / 07-15 — per-gateway stash of paused approval runs (server-side resume source).
  // Always built: the stash's PRESENCE is the gate everywhere downstream (/pending + /decide + the
  // chatRun stash leg), and it must hold with both flags off (in-panel card is the primary surface).
  const approvalStash: ApprovalRunStash | undefined = new ApprovalRunStash({
    ttlMs: DEFAULT_STASH_TTL_MS,
    ttlMsForTool: approvalTtlForTool
  })
  // harness-chat lane A (B1) — MAILAGENT_CHAT_DETACHED_RUNS gates detach-tolerant chat runs: client
  // disconnect no longer aborts /api/ai/chat's upstream call (the gateway drains server-side to
  // persistTurn); the composer stop goes through POST /api/ai/run/stop. Default ON; an explicit env
  // false is the emergency rollback. main-env-only, NO vite define (the renderer never reads it — it
  // just calls the endpoints best-effort).
  //
  // 🔴 codex r2 [A] — the ActiveRunRegistry is DECOUPLED from the flag and always built: it serves
  // the per-session run mutex of the ALWAYS-ON approval-resume chain (a /decide resume and a new
  // /api/ai/chat turn for the same session must never interleave their persistence) plus the
  // /run/active truth probe, so its presence is a safety property, not a detached-runs feature.
  // The flag now gates ONLY the drain behaviour (detached server-side drain vs legacy close→abort).
  // Off-branch semantics (documented, no longer byte-identical): a chat run still takes the session
  // slot; a client disconnect aborts the run AND releases the slot immediately (abort 即释放, wired
  // on the response 'close' in server.ts), so the rollback target is "old drain behaviour + the
  // approval-resume mutex kept". CLAUDE.md 开关表 carries the same wording.
  const detachedRunsEnabled = envBool('MAILAGENT_CHAT_DETACHED_RUNS', true)
  const queuedInputEnabled = envBool('MAILAGENT_CHAT_QUEUED_INPUT', true)
  // 0903 —— 「一轮结束了」的唯一收敛点。真正的处理器要等 dispatchDeps / chainPostTurn 建好才装得上
  // （它们在本函数后半段），所以这里只留一个可后填的槽；装上之前 release 的通知是 no-op（启动早期
  // 本来也没有在跑的 run）。
  const onChatRunSettledRef: { current?: (sessionId: number) => void } = {}
  const activeRuns = new ActiveRunRegistry({
    onSessionIdle: (sessionId) => onChatRunSettledRef.current?.(sessionId)
  })
  // Set after the server listens (chicken-and-egg: the announce needs the gateway's own port, known
  // only post-listen; a paused approval fires well after startup so this is populated by then).
  let gatewayPort = 0
  if (queuedInputEnabled) restoreAllStale()

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
  // P1 fixes prompt/query provenance gaps; default-off would preserve the bug. Emergency rollback only.
  const sessionProvenanceEnabled = envBool('MAILAGENT_SESSION_PROVENANCE', true)
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
  const skillCreatorToolsEnabled = envBool('MAILAGENT_SKILL_CREATOR', true)
  // calendar epic 4.1/4.2 — MAILAGENT_CALENDAR_AGENT_TOOLS gates the five calendar tools
  // (calendar_events_list / calendar_event_get silent reads with CALENDAR_EVENT-fenced event text +
  // calendar_event_reschedule / calendar_event_rsvp / calendar_event_delete, all edit-tier writes —
  // D4 恒 HITL: always ask, no whitelist/免卡 channel, rich CalendarApprovalCard registered).
  // Default ON; an explicit env false is the emergency rollback (kill-switch). main-env-only, NO
  // vite define (mirrors the openness flags). Explicit false → buildGatewayTools output
  // byte-identical to the pre-epic set.
  const calendarToolsEnabled = envBool('MAILAGENT_CALENDAR_AGENT_TOOLS', true)
  // task 07-21 — MAILAGENT_NOTION_AGENT_TOOL gates the notion_agent_chat tool (edit-tier 恒 HITL —
  // delegates a Notion request to the notion-agent CLI via serve-api /api/skills/invoke). Unlike the
  // other tool families this one is SKILL-gated (skill_gating maps it to the notion_agent skill), so
  // the real user control is the Settings → Custom AI → Skills toggle; this flag is only the
  // emergency kill-switch. Default ON; an explicit env false → the tool is never registered,
  // byte-identical. main-env-only, NO vite define (mirrors the openness/calendar flags).
  const notionAgentToolsEnabled = envBool('MAILAGENT_NOTION_AGENT_TOOL', true)
  // Stage 1 PR2 — MAILAGENT_MCP_CONNECTORS gates the dynamic MCP connector tools
  // (`mcp__<connector>__<tool>`, read silent / write·update edit-tier 恒 HITL via the runtime
  // 'connector_write' class). Default ON (2026-11-20 cutover; explicit false = emergency rollback);
  // off → no manifest fetch, no registration, buildGatewayTools byte-identical. main-env-only,
  // NO vite define (mirrors the other tool-family flags). Python serve-api reads the SAME env via
  // pydantic (mcp_connectors_enabled) — off there turns every /api/connector/* endpoint 409.
  const mcpConnectorsEnabled = envBool('MAILAGENT_MCP_CONNECTORS', true)
  // Stage 2 PR-1 (task 08-01 messenger) — MAILAGENT_IM_FEISHU gates the im_chat entrypoint
  // (POST /api/ai/im-chat, the ONLY code asserting 'im_chat') + the createImSession hook.
  // Default ON (cutover 2026-08-04, owner dogfood 通过); an explicit env false → the route is
  // not registered (404) and the gateway is byte-identical. main-env-only, NO vite define
  // (mirrors MAILAGENT_MCP_CONNECTORS). 🔴 Double-carrier: the Python serve-api reads the SAME
  // env via pydantic (im_feishu_enabled, PR-2 — 飞书连接底座); both defaults MUST stay true
  // together (tests/config/test_flag_cross_language.py), else the bridge would POST an endpoint
  // that 404s (or the endpoint would sit live with no bridge) — same failure shape as the MCP flag's.
  const imFeishuEnabled = envBool('MAILAGENT_IM_FEISHU', true)
  // Stage 2 PR-1 (grill Q19=A) — MAILAGENT_IM_WEB_ENABLED: the INDEPENDENT im-web venue switch
  // (🔴 deliberately NOT a grant — policy.ts pins that direction). Default OFF: web_fetch /
  // web_search are stripped from every im run's ToolSet (and their runtime modeDenied
  // hard-rejects). ON: they register in im_chat and stay 恒 HITL (mayAutoApprove is manual-only).
  // Only the im_chat matrix branch reads it, so non-im runs are byte-identical either way.
  // main-env-only, NO vite define.
  const imWebEnabled = envBool('MAILAGENT_IM_WEB_ENABLED', false)
  // WS-2 Plane 1 — lazy schema loading for long-tail external MCP tools (`tool_search` +
  // prepareStep `activeTools` partition), unconditionally enabled by default.
  const toolSearchEnabled = true
  // WS-4 — bounded `computer_use_run` sub-agent tool when at least one active
  // `browser_use` or `desktop_use` connector is mounted in `manual_chat` (or explicit `matter_item_run`),
  // unconditionally enabled by default.
  const computerUseEnabled = true

  const apiBase = `http://127.0.0.1:${resolveApiPort()}/api`
  const readSkillCatalogFlag = (): boolean => envBool('MAILAGENT_SKILL_CATALOG_PROMPT', false)
  if (skillGatingEnabled) {
    await getSystemPromptConfig(apiBase, getLocalApiToken(), readSkillCatalogFlag)
  }

  const resolvers = createGatewayTtlResolvers(domain)

  const compactEnabled = envBool('MAILAGENT_CHAT_COMPACT', true)
  const autoCompactFeatureEnabled = envBool('MAILAGENT_CHAT_AUTO_COMPACT', true)
  const compactPersistence: CompactPersistence | undefined = compactEnabled
    ? {
        listSessionMessages: (sessionId: number) => listMessages(sessionId),
        getSessionModel: (sessionId: number) => getSession(sessionId)?.backend_model ?? null,
        appendCompactMessage: (input) => {
          appendMessage({
            sessionId: input.sessionId,
            role: 'system',
            content: input.summary,
            status: 'complete',
            model: input.metadata.model,
            metadata: JSON.stringify(input.metadata),
            uiMessageJson: input.uiMessageJson
          })
        }
      }
    : undefined

  const groupGlue = buildGroupGatewayHooks({
    domain,
    approvalGuard,
    a2uiEnabled,
    groupMemberReads: resolvers.groupMemberReads,
    resolveLabsFlags: resolvers.resolveLabsFlags,
    isGroupForeground,
    getDeliverGroupMessage: () => gatewayConfig.deliverGroupMessage
  })

  const persistenceGlue = buildTurnPersistenceHooks({
    domain,
    captureTurnMemoryEnabled: envBool('MAILAGENT_MEM0_CAPTURE', true),
    serverResumeEnabled,
    customAgentsEnabled,
    imFeishuEnabled
  })

  const toolsGlue = buildApprovalAndToolHooks({
    domain,
    generatedImagesDir,
    approvalGuard,
    approvalStash,
    groupToolHooks: groupGlue.groupToolHooks,
    providerModelResolver,
    computerUseOverlay: opts?.computerUseOverlay,
    getSystemPromptConfig: () =>
      getSystemPromptConfig(apiBase, getLocalApiToken(), readSkillCatalogFlag),
    readPerBuildToolFlags: () => ({
      kosTimeDecayEnabled: envBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true),
      planToolsEnabled: envBool('MAILAGENT_PLAN_TOOL', true),
      writeToolsEnabled: envBool('MAILAGENT_AI_SDK_WRITE_TOOLS', true)
    }),
    flags: {
      customAgentsEnabled,
      customAgentCallEnabled,
      internalAgentToolsEnabled,
      serverResumeEnabled,
      a2uiEnabled,
      sendToolEnabled,
      aguiMirrorEnabled,
      skillGatingEnabled,
      sessionToolsEnabled,
      sessionProvenanceEnabled,
      configToolsEnabled,
      webToolsEnabled,
      execToolsEnabled,
      skillInstallToolsEnabled,
      skillCreatorToolsEnabled,
      calendarToolsEnabled,
      notionAgentToolsEnabled,
      mcpConnectorsEnabled,
      imWebEnabled,
      toolSearchEnabled,
      computerUseEnabled
    }
  })

  const gatewayConfig: AiGatewayConfig = {
    port: resolveAiGatewayPort(),
    baseUrl: llmBaseUrl,
    apiKey,
    model: getLlmModel(),
    providerRegistryEnabled,
    providerModelResolver,
    logEvent: gatewayLogLine,
    onGroupTurnEvent: (event) => broadcastChatEvent('chat:group-turn', { ...event }),
    ...(queuedInputEnabled
      ? {
          queuedInputStore: {
            list: listQueuedInput,
            enqueue: enqueueQueuedInput,
            get: getQueuedInput,
            update: updateQueuedInput,
            cancel: cancelQueuedInput,
            confirm: confirmQueuedInput,
            restoreForSession
          },
          onQueuedInputChanged: (sessionId: number) =>
            broadcastChatEvent('chat:queued-input-changed', { sessionId })
        }
      : {}),
    ...(autoCompactFeatureEnabled && compactPersistence
      ? {
          onCompactCompleted: (sessionId: number) =>
            broadcastChatEvent('chat:turn-persisted', {
              sessionId,
              status: 'compacted',
              runId: null
            })
        }
      : {}),
    ...(compactPersistence
      ? {
          selectMessagesForModelContext,
          compactPersistence
        }
      : {}),
    ...persistenceGlue,
    resolveGlobalApprovalMode: resolvers.resolveGlobalApprovalMode,
    resolveToolApprovalPrefs: resolvers.resolveToolApprovalPrefs,
    resolveMatterRunWebFace: resolvers.resolveMatterRunWebFace,
    ...toolsGlue,
    ...groupGlue.configHooks,
    serverResumeEnabled,
    approvalStash,
    generatedImagesDir,
    approvalTtlResponseEnabled: customAgentCallEnabled,
    detachedRunsEnabled,
    activeRuns,
    fetchApprovalPreview: resolvers.fetchApprovalPreview,
    isApprovalResolved: (toolCallId: string) => approvalGuard.isResolved(toolCallId),
    rejectApproval: (toolCallId: string) => approvalGuard.reject(toolCallId),
    imFeishuEnabled,
    toolSearchEnabled,
    computerUseEnabled,
    localApiToken: getLocalApiToken()
  }

  onChatRunSettledRef.current = wirePostTurnAndQueuedInput({
    gatewayConfig,
    compactEnabled,
    autoCompactFeatureEnabled,
    queuedInputEnabled,
    compactPersistence,
    providerModelResolver,
    activeRuns,
    approvalStash,
    resolveAutoCompactEnabled: resolvers.resolveAutoCompactEnabled,
    getGatewayPort: () => gatewayPort
  })

  const handle = await startAiGatewayServer(gatewayConfig)
  stopModelCatalogUpdates ??= startMainModelCatalogUpdates(app.getPath('userData'))
  _handle = handle
  gatewayPort = handle.port // Part B — now the announce closure can stamp our port on /decide callbacks
  const healthy = await pollHealth(handle.port)
  console.log(
    `[ai-gateway] embedded gateway listening on http://127.0.0.1:${handle.port}` +
      ` (health=${healthy ? 'ok' : 'pending'}, hasKey=${Boolean(apiKey)})`
  )
  if (!_quitHookRegistered) {
    _quitHookRegistered = true
    app.once('before-quit', () => {
      void stopEmbeddedAiGateway()
    })
  }
  return handle.port
}

/** close() 的兜底等待上限。closeAllConnections() 之后 server.close 应当立刻回调；
 *  这个 race 只是保证「重启」永远不会变成无限挂起（挂起 = gateway 永久死掉，比原
 *  bug 更糟）。超时后 listen 若撞上未释放的端口会 EADDRINUSE，由调用方记录。 */
const GATEWAY_CLOSE_TIMEOUT_MS = 3_000

/** Gracefully stop the embedded gateway (before-quit / explicit teardown).
 *
 *  🔴 closeAllConnections()：server.close() 只停止 accept，**要等所有已建立连接结束**
 *  才回调。chat 是长驻 SSE 流（detached runs 更是刻意不随客户端断开而中止），所以不强制
 *  断连的话 close() 可能永远不回调。Labs「重启后端」本就是破坏性动作（有确认弹窗），
 *  与 Python 两进程被 kill 的语义一致：在途 chat run 一并断掉。 */
export async function stopEmbeddedAiGateway(): Promise<void> {
  stopModelCatalogUpdates?.()
  stopModelCatalogUpdates = null
  const handle = _handle
  _handle = null
  if (!handle) return
  try {
    handle.server.closeAllConnections()
  } catch {
    /* 老 Node / 已关闭的 server — 忽略，下面的 close 仍会跑 */
  }
  await Promise.race([
    handle.close(),
    new Promise<void>((resolve) => setTimeout(resolve, GATEWAY_CLOSE_TIMEOUT_MS))
  ])
}

/**
 * 停掉再重建 embedded gateway，让启动时读取的 env 快照按**当前** process.env 重新求值。
 *
 * Labs 翻动仍属 gateway 的开关时，env:set 会同步 process.env，但 services:restart
 * 只重启 Python 两进程；因此需要显式重建 gateway。
 *
 * 端口不会变：listen 端口与 renderer 的 `?aiGatewayPort=` 同源 resolveAiGatewayPort()
 *（env 覆盖或固定默认值，非内核随机分配），所以 chat 面板不需要知道这次重启。
 *
 * 失败（例如端口尚未释放 → EADDRINUSE）返回 null 并由调用方记日志，不抛。
 */
export async function restartEmbeddedAiGateway(): Promise<number | null> {
  if (_restarting) return _restarting
  const run = (async (): Promise<number | null> => {
    await stopEmbeddedAiGateway()
    return startEmbeddedAiGateway()
  })()
  _restarting = run
  try {
    return await run
  } finally {
    if (_restarting === run) _restarting = null
  }
}
