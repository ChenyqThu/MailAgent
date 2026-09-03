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
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'

import { startAiGatewayServer, type AiGatewayHandle } from '../../ai-gateway/server'
import {
  resolveAiGatewayPort,
  type AiGatewayConfig,
  type GroupRunLogMirror,
  type GroupSessionMember,
  type IslandApprovalAnnounce,
  type LabsFlags,
  type PersistTurnInput
} from '../../ai-gateway/config'
import { MailAgentDomainClient } from '../../ai-gateway/python/domainClient'
import { buildGatewayTools } from '../../ai-gateway/tools'
// Stage 1 PR2 — MCP connector dynamic tools (MAILAGENT_MCP_CONNECTORS, default off): the manifest
// is TTL-cached off the request path; buildTools assembles the ToolSet synchronously from the
// cache, manual_chat runs only (shouldLoadConnectorTools — headless paths perform ZERO calls).
import {
  connectorCatalogForRun,
  connectorManifestSkipReason,
  createConnectorManifestCache,
  createConnectorTools,
  fetchConnectorManifest,
  projectConnectorCatalog,
  shouldLoadConnectorTools
} from '../../ai-gateway/tools/connector'
import type { ConnectorCatalogEntry } from '../../ai-gateway/prompts/stable_prompt'
import type { ToolSet } from 'ai'
import {
  stripOwnerDeniedTools,
  type GatewayToolApprovalPrefs,
  type GlobalApprovalMode
} from '../../ai-gateway/tools/types'
// g2 — the group speaker-run factories (member / judge) + the hook bundle the main-agent版 shares.
import {
  createGroupJudgeTools,
  createGroupMemberTools,
  type GroupToolHooks
} from '../../ai-gateway/tools/groups'
import {
  ApprovalGuard,
  HIGH_RISK_OUTBOUND_APPROVAL_TTL_MS,
  NORMAL_APPROVAL_TTL_MS
} from '../../ai-gateway/security/approval'
import { ApprovalRunStash, DEFAULT_STASH_TTL_MS } from '../../ai-gateway/approvalStash'
import {
  classOfTool,
  parseMatterRunWebFace,
  type MatterRunWebFace
} from '../../ai-gateway/tools/policy'
import { ActiveRunRegistry } from '../../ai-gateway/activeRuns'
import { extractApprovalStashInput } from '../../ai-gateway/chatRun'
import { parseGroupMemberIds } from '../../ai-gateway/groupChat'
// T2 群附件 — metadata.attachments 的读侧（写侧在 server.ts 的 append 分支，同一份编解码）。
import { parseAttachmentsMetadata } from '../../ai-gateway/groupAttachments'
// g1 群编排（CHAT_DB v31）— 成员设置 / seen 游标 / turn 台账的读写面。直接从子模块引（chat_db.ts
// 兼容 barrel 只为保住既有 importer 的路径，新模块无历史包袱）。
import { MAIN_AGENT_MEMBER_ID, type GroupResponseMode } from '../../ai-gateway/groupFloors'
import {
  advanceSeenCursor,
  familyOf,
  getGroupMemberConfigs,
  getSeenCursor,
  groupUsage,
  insertGroupTurn
} from './chat_db/groups'
import {
  INTERRUPT_IDLE_WAIT_LIMIT_MS,
  runQueuedInputDispatch
} from '../../ai-gateway/queuedInputDispatch'
import { selectMessagesForModelContext } from '../../ai-gateway/compactSelect'
import {
  CompactCoordinator,
  shouldAutoCompact,
  type CompactPersistence
} from '../../ai-gateway/compact'
import { buildToolA2UIPayload } from '../../shared/assistant/tools/a2ui'
import { chatMessageToUIMessage, extractTextFromUIMessage } from '@shared/assistant/uiMessage'
import {
  appendMessage,
  appendToolCall,
  cancelQueuedInput,
  claimQueuedInput,
  confirmQueuedInput,
  createAgentSession,
  createImSession,
  enqueueQueuedInput,
  findSessionByParentToolCall,
  findAssistantMessageRowIdByUiId,
  findUserMessageRowIdByUiId,
  getFirstUserText,
  getQueuedInput,
  getSession,
  listDispatchableQueuedInput,
  listLastNMessages,
  listQueuedInput,
  listMessages,
  markSent,
  markToolCallApprovalExpired,
  setAgentSessionJobId,
  restoreAllStale,
  restoreForSession,
  revertClaimed,
  updateQueuedInput,
  updateMessage,
  updateSessionPausedMarker,
  updateSessionTitle,
  updateToolCall
} from './chat_db'
import { getLlmApiKey, getLlmBaseUrl, getLlmModel } from './llm_settings'
import { runBuildDiagnostics, runSubmitFeedback } from './handlers/feedback'
import { resolveApiPort } from './backend_lifecycle'
import { getLocalApiToken } from './local_token'
// task 08-20-notification-center M2 批 B4 — chat run 完成 → 通知中心 loopback publish。
import { maybeNotifyChatRunFinished, maybeNotifyGroupReply } from './notification_fanout'
// task 07-21 — the env kill-switch parser lives in a pure lib module (pinned by a
// lightweight vitest; the Python side src/skills/invoke.py mirrors its truth table).
import { envBool } from './lib/env-bool'
import { deriveExecRule, ExecRuleDeriveError } from './exec_policy_matcher'
// Phase 06 (context injection) — the standing-context provider fetches the serve-api
// /chat/config, projecting the system-prompt fields for the gateway.
import { request } from '@shared/api/http_client'
import type { AssistantIdentity, ReportAgentConfig } from '@shared/api/types'
import type { GroupConfig } from '@shared/chat_model'
import type { GatewaySystemPromptConfig } from '../../ai-gateway/systemPrompt'
import type { SkillCatalogEntry } from '../../ai-gateway/prompts/stable_prompt'
// 🔴 MEDIUM-6 (batch1 review) — type-only imports from the SDK-FREE providerRef. providers.ts
// top-level imports six provider SDK packages, so it is loaded ONLY via the flag-on dynamic
// import inside startEmbeddedAiGateway: MAILAGENT_LLM_PROVIDER_REGISTRY off keeps the module
// graph free of the new SDKs (a broken provider package can't take down the flag-off gateway).
// Pinned by tests/ai-gateway/provider_lazy_import.test.ts.
import { parseProviderRef, type ProviderModelResolver } from '../../ai-gateway/providerRef'
import { resolveContextWindow } from '@shared/modelCatalog/contextWindow'
import {
  backfillLegacyDefaultProviderKey,
  getLlmProviderModelResolver,
  isLlmProviderRegistryEnabled
} from './llm_provider_resolver'

/** The /chat/config response fields the gateway projects into GatewaySystemPromptConfig
 *  (was typed via the legacy HttpPlatformConfig until S3 deleted the legacy engine). */
interface ChatConfigResponse {
  standingContext?: string | null
  userContext?: string | null
  memorySummary?: string | null
  kosConfigured?: boolean
  advertisedSkills?: string[] | null
  trustedSkillFragments?: string | null
  /** 阶段 0.5 — every skill + state; typed off the prompt module so the row shape has ONE source. */
  skillCatalog?: SkillCatalogEntry[] | null
}

let _handle: AiGatewayHandle | null = null

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

// ---------------------------------------------------------------------------
// D1 (connector dogfood batch) — on-disk gateway log (handlers/translate.ts 同款: app logs dir +
// JSON line via appendFileSync; logging never throws). Rationale: the gateway runs in the Electron
// MAIN process whose console goes nowhere in a packaged app, so connector manifest failures
// (fetchConnectorManifest's warnings) were invisible in the field. Scope is deliberately tiny —
// connector observability lines only, not a general logging system.
let _gwLogPathCache: string | null = null
function gatewayLogPath(): string | null {
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
function gatewayLogLine(rec: Record<string, unknown>): void {
  const p = gatewayLogPath()
  if (p === null) return
  try {
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8')
  } catch {
    /* logging never throws */
  }
}

/** P4b — coarse「它什么时候会自己动」line for the team-identity prompt block. MODE naming only:
 *  schedule SEMANTICS stay single-sourced (schedule-rule-contract.md) — this never expands
 *  occurrences or re-derives next-fire times, it just names which trigger family the agent has.
 *  Returns null when nothing coarse can be said (unknown type / unparseable trigger). */
function describeAgentSchedule(agent: ReportAgentConfig): string | null {
  const type = agent.type
  if (type === 'report') {
    const cadence = agent.schedule?.cadence
    const cadenceLabel =
      cadence === 'daily'
        ? '每天'
        : cadence === 'weekly'
          ? '每周'
          : cadence === 'monthly'
            ? '每月'
            : null
    return cadenceLabel ? `按排程自动运行：${cadenceLabel}生成一次报告。` : '按排程自动生成报告。'
  }
  if (type === 'contact_profile' || type === 'contact_governance') {
    return '每天定时自动运行一次。'
  }
  if (type === 'custom') {
    const trigger = agent.trigger
    const entries =
      trigger == null
        ? []
        : 'triggers' in trigger
          ? trigger.triggers.filter((entry) => entry.enabled)
          : [trigger]
    if (entries.length === 0) return '没有定时任务：只有用户来找它才会动。'
    const kinds = new Set(entries.map((entry) => entry.kind))
    const parts: string[] = []
    if (kinds.has('cron') || kinds.has('schedule')) parts.push('按排程定时自动运行')
    if (kinds.has('email_filter')) parts.push('邮件命中条件时自动运行')
    if (kinds.has('calendar_event_change') || kinds.has('calendar_before_start'))
      parts.push('日程变化/会前自动运行')
    return parts.length > 0 ? `${parts.join('；')}。` : null
  }
  return null
}

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

/** g1 群编排 — `ai_chat_sessions.group_config_json` → GroupConfig。🔴 脏值/坏 JSON 一律回落
 *  `{ v: 1 }` = 全取出厂默认（地板默认值单源在 groupFloors.ts）：一行坏 JSON 不该让整个群停摆，
 *  而「取默认」永远是更严的那一侧（默认地板最紧）。 */
function parseGroupConfig(raw: string | null): GroupConfig {
  if (typeof raw !== 'string' || raw.length === 0) return { v: 1 }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { v: 1 }
    return { ...(parsed as GroupConfig), v: 1 }
  } catch {
    return { v: 1 }
  }
}

/** g2 — 法官免卡锚是否失配：有法官位且 `sha256(members_json 原文 utf-8).hexdigest` ≠ 群设置里
 *  owner 确认法官位时写入的 judgeScopeHash。🔴 钉的是**原文**（等价重排也算变）—— 与 src/chat/db.py
 *  get_group_config / put_group_config 同口径（闸 tests/config/test_judge_scope_hash_parity.py），
 *  绝不从解析后的 members[] 重新序列化。无法官 → false。 */
export function computeJudgeScopeStale(
  rawMembersJson: string | null,
  config: { judgeAgentId?: string | null; judgeScopeHash?: string | null }
): boolean {
  if (config.judgeAgentId == null) return false
  const digest = createHash('sha256')
    .update(rawMembersJson ?? '', 'utf8')
    .digest('hex')
  return digest !== config.judgeScopeHash
}

/** T4 主 agent 入群 — 一个 members_json 成员 id → GroupSessionMember（导出供测试）。保留字
 *  `main` 没有 report_agent 行：title 取 owner_settings 的 assistant-identity.name（缺省 'AI'），
 *  duty 恒 null（SOUL/AGENT 已作 standingContext 恒注入，再塞进 <duty> 是重复注入 + 破坏可缓存
 *  前缀），model 恒 null（落到主 agent 默认模型，群级 modelOverride 仍优先）。其余 id 走
 *  report_agent 行。
 *  🔴 永不 throw、永不丢成员：读失败只降级 title / duty / model —— 成员资格是 handleGroupChat
 *  校验 speakAsAgentId 的安全事实，不能依赖 serve-api 可用性（resolveSessionAgent 同一契约）。 */
export async function resolveGroupMember(
  agentId: string,
  read: {
    reportAgent: (agentId: string) => Promise<ReportAgentConfig | null>
    assistantIdentity: () => Promise<AssistantIdentity | null>
  }
): Promise<GroupSessionMember> {
  if (agentId === MAIN_AGENT_MEMBER_ID) {
    let name: string | null = null
    try {
      name = (await read.assistantIdentity())?.name ?? null
    } catch (err) {
      console.warn('[ai-gateway] assistant identity fetch failed (main agent member degrades)', err)
    }
    return { agentId, title: name?.trim() || 'AI', duty: null, model: null }
  }
  try {
    const agent = await read.reportAgent(agentId)
    return {
      agentId,
      title: agent?.title?.trim() || agentId,
      duty: agent?.prompt?.trim() || null,
      model: agent?.model?.trim() || null
    }
  } catch (err) {
    console.warn('[ai-gateway] group member config fetch failed (degrades)', agentId, err)
    return { agentId, title: agentId, duty: null, model: null }
  }
}

/** g1 群编排 — 一条群消息的 `metadata.via`：'main_agent'（主助理投递进群的行）、g2 的
 *  'judge_post'（法官跨群投递的链根行，调度器据此定 trigger_kind），其余一律 null。
 *  🔴 装配侧据此标 `[主助理]`，**不用** speaker_agent_id 哨兵（那会污染成员命名空间）。 */
function readMessageVia(metadata: string | null): 'main_agent' | 'judge_post' | null {
  if (typeof metadata !== 'string' || metadata.length === 0) return null
  try {
    const parsed = JSON.parse(metadata) as { via?: unknown }
    if (parsed?.via === 'main_agent') return 'main_agent'
    if (parsed?.via === 'judge_post') return 'judge_post'
    return null
  } catch {
    return null
  }
}

/** g2 — 本会话最近一条 role='user' 行的正文（主 agent 版 group_post / group_create 的
 *  user_requested 核验只读这一份服务端事实，绝不读请求 body）。近 30 行里没有人类消息 → null
 *  → 工厂退 ask。 */
function lastHumanMessageText(sessionId: number): string | null {
  const last = listLastNMessages(sessionId, 30)
    .filter((row) => row.role === 'user')
    .at(-1)
  return last?.content ?? null
}

/** L4 群聊 UX 批 — renderer 经 `chat:group-foreground` 上报的「此刻在前台的群」（null = 没有）。
 *  通知投影据此跳过 owner 正盯着看的群；未上报过 = 不在前台 → 发（按链合并，有界）。 */
let foregroundGroupSessionId: number | null = null

function isGroupForeground(sessionId: number): boolean {
  return BrowserWindow.getFocusedWindow() != null && foregroundGroupSessionId === sessionId
}

/** `chat:group-foreground {sessionId | null}` 的 ipcMain.handle（一处）。restart 会再走一遍
 *  startEmbeddedAiGateway，先 removeHandler 防「second handler」抛错。 */
function registerGroupForegroundHandler(): void {
  ipcMain.removeHandler('chat:group-foreground')
  ipcMain.handle('chat:group-foreground', (_evt, payload: unknown) => {
    const raw =
      payload != null && typeof payload === 'object'
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined
    foregroundGroupSessionId =
      typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
  })
}

/** harness-chat lane A (B2) — broadcast a chat event to every renderer window (the same
 *  BrowserWindow loop onServerResumeSettled used inline; extracted so persistTurn /
 *  persistPausedAssistant / the settle hook share one emitter). Best-effort: a torn-down
 *  renderer never breaks the persist that triggered the broadcast. */
function broadcastChatEvent(channel: string, payload: Record<string, unknown>): void {
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
  let assistantId: number
  if (pausedRowId != null) {
    updateMessage(pausedRowId, {
      content: extractTextFromUIMessage(turn.responseMessage),
      status: 'complete',
      model: turn.model,
      tokensInput: turn.usage?.inputTokens ?? null,
      tokensOutput: turn.usage?.outputTokens ?? null,
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
      advertisedSkills: cfg.advertisedSkills ?? null,
      // W6 — backend-filtered code-owned workflow guidance. Never carries installed third-party
      // prompt fragments; null/empty preserves the post-cutover no-fragment behaviour.
      trustedSkillFragments: cfg.trustedSkillFragments ?? null,
      // 阶段 0.5「技能可发现性」— MAILAGENT_SKILL_CATALOG_PROMPT gates the L0 catalog block. THIS is
      // the only gate: flag off → the field never leaves this projection → buildGatewaySystemPrompt
      // renders nothing → the system prompt is byte-identical to before (pinned by a vitest on the
      // pure module, which is why the flag is read here and not inside it). Python sends the data
      // unconditionally; the read cost is one already-cached /chat/config field. Default OFF (ship
      // off → dogfood → cutover 另拍), main-env-only, NO vite define (mirrors the openness flags).
      skillCatalog: envBool('MAILAGENT_SKILL_CATALOG_PROMPT', false)
        ? (cfg.skillCatalog ?? null)
        : null
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
  // errors. An explicit custom-agent-call flag false keeps the established 30-min single TTL.
  const islandAgentEnabled = envBool('MAILAGENT_ISLAND_AGENT_ENABLED', true)
  // 07-15 owner拍板（无灵动岛方案优先，task 07-15-harness-chat lane A）— the SERVER-SIDE approval
  // resume infra (stash + extended guard TTL + /pending + /decide + settle broadcast) is now
  // UNCONDITIONAL: the in-panel approval card (chat 面板内可批卡) is the PRIMARY approval surface and
  // must work with BOTH MAILAGENT_ISLAND_AGENT_ENABLED and MAILAGENT_CUSTOM_AGENTS_ENABLED explicitly
  // false — the island is an optional overlay notification face that may be removed. Only the island
  // ANNOUNCE leg (+ the island result cards) stays island-gated below. Security posture is unchanged:
  // /decide stays fail-closed (one-shot claim, approvalId/token-matched), the guard stays hash-bound
  // one-shot, and cross-surface single-resolver semantics (oneShotWrites / isApprovalResolved /
  // rejectApproval / serverResumeEnabled in chatRun) are now ALWAYS live — a strictly stricter write
  // gate than the old flag-gated wiring. (customAgentsEnabled still gates the S4 headless agent-run
  // endpoint + job settle below; default ON since E3 cutover, env explicit false = kill-switch.)
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
  const activeRuns = new ActiveRunRegistry()
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
  // 'connector_write' class). Default OFF (ship off → dogfood → cutover 另拍, island 模式);
  // off → no manifest fetch, no registration, buildGatewayTools byte-identical. main-env-only,
  // NO vite define (mirrors the other tool-family flags). Python serve-api reads the SAME env via
  // pydantic (mcp_connectors_enabled) — off there turns every /api/connector/* endpoint 409.
  const mcpConnectorsEnabled = envBool('MAILAGENT_MCP_CONNECTORS', false)
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
  // TTL-cached connector tool manifest (loopback pulls stay OFF the request path — buildTools is
  // synchronous). A fetch failure caches null = no connector tools (silent degradation, warned in
  // fetchConnectorManifest) but only for the SHORT failure TTL (0804 dogfood — a 30s negative
  // window is what made the first turn after a restart connector-blind).
  // PR3 — refresh RETURNS its in-flight promise (single-flight): cfg.ensureConnectorManifest below
  // AWAITS it so neither a one-shot headless run with connector grants nor an owner-present turn
  // (manual/im — 0804 主修, prepareChatRun awaits before buildTools) builds tools off a cold cache.
  const connectorManifest = createConnectorManifestCache(
    (opts) =>
      fetchConnectorManifest(domain, {
        // D1 observability — the degradation warnings used to go console-only (invisible in a
        // packaged app); mirror them into the on-disk gateway log. 0805 dogfood — `quiet` (set by
        // the prewarm's middle retries, connector.ts) suppresses only the ON-DISK line; console.warn
        // still fires unconditionally (cheap, dev-only visibility) since it never accumulates on disk.
        onWarn: (message, err) => {
          console.warn(message, err)
          if (!opts?.quiet) {
            gatewayLogLine({ event: 'connector_manifest_warn', message, error: String(err) })
          }
        }
      }),
    gatewayLogLine
  )
  const refreshConnectorManifest = (): Promise<void> =>
    mcpConnectorsEnabled ? connectorManifest.refresh() : Promise.resolve()
  // Prewarm (fire-and-forget — a slow serve-api must never block gateway startup) WITH bounded
  // retries: 0805 dogfood raised these from 2 to 5 attempts (~40s cumulative, see
  // CONNECTOR_MANIFEST_PREWARM_RETRIES_MS) after field logs showed serve-api's cold start ranging
  // 4-34s, not the ~1.2s the original 1s/3s schedule assumed.
  if (mcpConnectorsEnabled) connectorManifest.prewarm()
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

  // 07-16 approval-mode switcher — the owner-global chat approval mode resolver prepareChatRun
  // hot-reads per MANUAL run (headless runs never call it). Short TTL (a Settings/composer switch
  // takes effect within seconds without a per-turn loopback storm) + bounded timeout; CONTRACTED
  // to resolve 'manual' on ANY failure (fail-closed — an unreachable serve-api / dirty row can
  // only ever mean "current HITL behaviour", never a silent relaxation). The renderer PUTs the
  // mode straight to serve-api (owner UI), so there is no gateway-side write face to wire.
  const APPROVAL_MODE_TTL_MS = 3_000
  let _approvalModeCache: { at: number; value: GlobalApprovalMode } | null = null
  const resolveGlobalApprovalMode = async (): Promise<GlobalApprovalMode> => {
    const now = Date.now()
    if (_approvalModeCache && now - _approvalModeCache.at < APPROVAL_MODE_TTL_MS) {
      return _approvalModeCache.value
    }
    let value: GlobalApprovalMode = 'manual'
    try {
      const r = await domain.getApprovalMode(AbortSignal.timeout(2_000))
      // 08-05 WP-11 — 'acceptEdits' is retired (folded server-side); only 'bypass' survives the
      // parse, everything else (incl. a stale legacy value) fail-closes to 'manual'.
      if (r.mode === 'bypass') value = r.mode
    } catch {
      value = 'manual' // fail-closed
    }
    _approvalModeCache = { at: now, value }
    return value
  }

  // g1 群编排 — labs 实验开关热读（真源 = agent_config.db owner_settings `labs_group_agents`，
  // 经 serve-api GET /api/agent/labs）。形状照上面的 resolveGlobalApprovalMode：短 TTL（LabsTab
  // 里一拨开关，下一条群消息就按新值走）+ 有界超时，🔴 **fail-closed**：够不着 serve-api / 脏行
  // 一律 `{ groupAgents: false }` = 退回 v1（renderer 自己的循环），绝不能是「服务端悄悄开始
  // 编排」——那会在 owner 完全不知情的情况下开始烧 token。
  const LABS_FLAGS_TTL_MS = 5_000
  let _labsFlagsCache: { at: number; value: LabsFlags } | null = null
  const resolveLabsFlags = async (): Promise<LabsFlags> => {
    const now = Date.now()
    if (_labsFlagsCache && now - _labsFlagsCache.at < LABS_FLAGS_TTL_MS)
      return _labsFlagsCache.value
    let value: LabsFlags = { groupAgents: false }
    try {
      const r = await domain.getLabsFlags(AbortSignal.timeout(3_000))
      value = { groupAgents: r.groupAgents === 'on' }
    } catch {
      value = { groupAgents: false } // fail-closed
    }
    _labsFlagsCache = { at: now, value }
    return value
  }

  // T4 主 agent 入群 — 主 agent 显示身份热读（GET /api/agent/assistant-identity），形状照上面的
  // resolveLabsFlags：TTL + 有界超时，读失败缓存 null（成员降级成 'AI'，绝不丢成员）。TTL 比
  // labs 长：resolveGroupSession 有意不缓存、每条群消息（含级联里每个 turn 前的事实重读）都
  // 重跑，没有这层缓存一条消息会放大成 N 次 loopback；改名容忍一分钟延迟。
  const ASSISTANT_IDENTITY_TTL_MS = 60_000
  let _assistantIdentityCache: { at: number; value: AssistantIdentity | null } | null = null
  const resolveAssistantIdentity = async (): Promise<AssistantIdentity | null> => {
    const now = Date.now()
    if (_assistantIdentityCache && now - _assistantIdentityCache.at < ASSISTANT_IDENTITY_TTL_MS)
      return _assistantIdentityCache.value
    let value: AssistantIdentity | null = null
    try {
      value = await domain.getAssistantIdentity(AbortSignal.timeout(3_000))
    } catch {
      value = null
    }
    _assistantIdentityCache = { at: now, value }
    return value
  }
  const groupMemberReads = {
    reportAgent: (agentId: string) => domain.getReportAgent(agentId),
    assistantIdentity: resolveAssistantIdentity
  }

  const AUTO_COMPACT_SETTING_TTL_MS = 3_000
  let _autoCompactSettingCache: { at: number; value: boolean } | null = null
  const resolveAutoCompactEnabled = async (): Promise<boolean> => {
    const now = Date.now()
    if (
      _autoCompactSettingCache &&
      now - _autoCompactSettingCache.at < AUTO_COMPACT_SETTING_TTL_MS
    ) {
      return _autoCompactSettingCache.value
    }
    let value = false
    try {
      const result = await domain.getAutoCompactSetting(AbortSignal.timeout(2_000))
      value = result.mode === 'on'
    } catch (err) {
      console.warn(
        '[ai-gateway] auto-compact setting unavailable — automatic compact disabled',
        err
      )
      value = false
    }
    _autoCompactSettingCache = { at: now, value }
    return value
  }

  // 0812 dogfood — the owner's web tier for Matter follow-up runs. Same shape as the two
  // resolvers above (short TTL so a Settings change lands within seconds without a per-run
  // loopback storm + bounded timeout), with ONE deliberate difference: it is fail-SAFE, not
  // fail-closed. 🔴 A transient loopback/DB error resolving to 'off' would silently strip an
  // unattended run's web reads with nothing in the UI to show for it; resolving to 'keep' (the
  // documented default, also what serve-api returns for a missing/dirty row) at worst keeps a
  // capability the owner left on. An owner who wants web off gets it from the NEXT successful
  // read — and turning it off is not a containment action taken under attack, it is a preference.
  const MATTER_WEB_FACE_TTL_MS = 3_000
  let _matterWebFaceCache: { at: number; value: MatterRunWebFace } | null = null
  const resolveMatterRunWebFace = async (): Promise<MatterRunWebFace> => {
    const now = Date.now()
    if (_matterWebFaceCache && now - _matterWebFaceCache.at < MATTER_WEB_FACE_TTL_MS) {
      return _matterWebFaceCache.value
    }
    let value: MatterRunWebFace = 'keep'
    try {
      const r = await domain.getMatterRunWebFace(AbortSignal.timeout(2_000))
      value = parseMatterRunWebFace(r.mode) ?? 'keep'
    } catch (err) {
      console.warn(
        '[ai-gateway] matter web face setting unavailable — follow-up runs keep the default tier',
        err
      )
      value = 'keep' // fail-safe
    }
    _matterWebFaceCache = { at: now, value }
    return value
  }

  // 08-05 WP-11 — the per-tool approval tiers + send whitelist resolver prepareChatRun hot-reads
  // per MANUAL run (headless/im never call it). Same shape as the mode resolver above: short TTL
  // (a Settings tier change lands within seconds, no per-turn loopback storm) + bounded timeout;
  // CONTRACTED to resolve null on ANY failure — null = "no prefs" = every write asks (fail-closed:
  // the gateway holds NO copy of the Python factory defaults, so an unreachable serve-api can only
  // ever mean MORE cards). Wire rows fold into the {tier, source} entries types.ts' ladder reads:
  // an explicit override (tier non-null) → source 'owner'; else the factory default → 'default'.
  // Junk tier strings are dropped per-row (fail-closed to ask via absence — a row the ladder
  // cannot read must never relax approval).
  const TOOL_PREFS_TTL_MS = 3_000
  let _toolPrefsCache: { at: number; value: GatewayToolApprovalPrefs | null } | null = null
  const resolveToolApprovalPrefs = async (): Promise<GatewayToolApprovalPrefs | null> => {
    const now = Date.now()
    if (_toolPrefsCache && now - _toolPrefsCache.at < TOOL_PREFS_TTL_MS) {
      return _toolPrefsCache.value
    }
    let value: GatewayToolApprovalPrefs | null = null
    try {
      const r = await domain.getToolApprovalPrefs(AbortSignal.timeout(2_000))
      const tools: Record<string, { tier: 'ask' | 'auto' | 'deny'; source: 'owner' | 'default' }> =
        {}
      for (const row of r.tools ?? []) {
        const explicit = row.tier
        const source = explicit != null ? 'owner' : 'default'
        const tier = explicit ?? row.effectiveTier
        if (tier === 'ask' || tier === 'auto' || tier === 'deny') {
          tools[row.toolName] = { tier, source }
        }
      }
      value = {
        tools,
        sendRecipientWhitelist: (r.sendWhitelist ?? []).filter((e) => typeof e === 'string')
      }
    } catch (err) {
      // fail-closed — ask semantics. Logged (throttled by the TTL cache: at most one line per
      // window) because this degradation also downgrades an owner 'deny' to ask-with-card for
      // the run (the strip needs the prefs) — the trace matters for forensics (check 08-05).
      console.warn('[ai-gateway] tool-prefs fetch failed — every write asks this run', err)
      value = null
    }
    _toolPrefsCache = { at: now, value }
    return value
  }

  // L4 批次1 #6 — the approval-card preview line, built by serve-api from the REAL payload
  // (POST /api/approval/preview). 🔴 fail-OPEN by contract, and the contract is implemented HERE:
  // bounded timeout + swallow everything → null, so the gateway core's fallback (the model's own
  // args) is the only thing a slow/unreachable serve-api can cost us. The timeout matches
  // resolveToolApprovalPrefs — an approval card is a user-facing pause, not a background job.
  const fetchApprovalPreview = async (info: {
    toolName: string
    input: unknown
  }): Promise<string | null> => {
    try {
      return await domain.fetchApprovalPreview(
        info.toolName,
        info.input,
        AbortSignal.timeout(2_000)
      )
    } catch (err) {
      console.warn('[ai-gateway] approval preview fetch failed — falling back to model args', err)
      return null
    }
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

  const gatewayConfig: AiGatewayConfig = {
    port: resolveAiGatewayPort(),
    baseUrl: llmBaseUrl,
    apiKey,
    model: getLlmModel(),
    providerRegistryEnabled,
    providerModelResolver,
    // L4 群聊 UX 批 — 调度器 turn 生命周期 → renderer（在场态 / 流式正文 / 沉默 / 停止原因）。
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
    // 07-16 approval-mode switcher — the owner-global mode resolver (short-TTL cached, fail-closed
    // 'manual'; see its construction above). prepareChatRun consults it per manual run only.
    resolveGlobalApprovalMode,
    // 08-05 WP-11 — the per-tool approval tiers resolver (short-TTL cached, fail-closed null =
    // ask semantics). prepareChatRun consults it per MANUAL run only.
    resolveToolApprovalPrefs,
    // 0812 dogfood — the Matter follow-up web tier resolver (short-TTL cached, fail-SAFE 'keep';
    // see its construction above). runHeadlessAgent consults it per MATTER run only.
    resolveMatterRunWebFace,
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
    // L4 批次2 — the READ-ONLY half of the same seam: GET /api/ai/approval/pending surfaces the
    // EFFECTIVE input + the registered editableFields so the generic in-panel approval card can
    // render an editor for the 12 tools that registered editable fields (chat's 3 rich edit cards
    // stay as they are). peek never mutates / never consumes; nothing else of the record leaves.
    peekApprovalRecord: (toolCallId: string) => {
      const rec = approvalGuard.peek(toolCallId)
      if (!rec) return null
      return { input: rec.editedInput ?? rec.input, editableFields: rec.editableFields ?? [] }
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
    // D1 (connector dogfood batch) — merge the MCP connector catalog into the projection so the
    // system prompt can announce the mcp__* tools (root cause ①: zero prompt-level告知 → the
    // model "honestly" denied having them). Data source = the SAME connectorManifest cache the
    // ToolSet builds from (zero new loopback requests, zero new TTLs — buildTools' per-turn
    // refresh keeps it warm; since the 0804 fix prepareChatRun awaits the warm-up before BOTH
    // reads, prompt and ToolSet can no longer disagree about the catalog).
    // Cold cache / flag off / nothing admitted → field omitted → prompt
    // byte-identical to today. The catalog here is manual-shape; prepareChatRun scopes it per run
    // (headless: granted connectors only) via connectorCatalogForRun.
    systemPromptProvider: async () => {
      const value = await getSystemPromptConfig(apiBase, getLocalApiToken())
      if (!mcpConnectorsEnabled) return value
      const catalog = projectConnectorCatalog(connectorManifest.peek())
      if (!catalog) return value
      // /chat/config blip (value null) + a warm manifest → still surface the catalog: the
      // connector tools ARE registered on such a turn, so the context-light prompt should not
      // go connector-blind on top of losing standing context.
      return { ...(value ?? {}), connectorCatalog: catalog }
    },
    sessionProvenanceEnabled,
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
    markApprovalExpired: (toolCallId: string) => markToolCallApprovalExpired(toolCallId),
    // Factory: the gateway builds the tools per request bound to a fresh audit collector
    // (closure). Read tools always; the approval-gated write tools under
    // MAILAGENT_AI_SDK_WRITE_TOOLS — S3: an env-only KILL-SWITCH, default literal true (the
    // cutover master it used to follow was GA'd away). `approvalMode` (PART 2) comes from the
    // request body (default 'always'); 'auto-reversible' lets reversible preview writes skip the
    // card. The blocking send always asks regardless (safety floor in auditedSendTool).
    buildTools: (
      collector,
      approvalMode,
      contextMode,
      agentRunContext,
      toolApprovalPrefs,
      parentSessionId,
      sessionAgentId,
      groupTools
    ) => {
      // Stage 1 PR2/PR3 — dynamic MCP connector tools. Two admitted shapes (shouldLoadConnectorTools):
      // manual_chat without an agentRunContext (PR2, unchanged), and a headless agent run whose
      // per-agent connector grants parse non-empty (PR3 — grant 外的 headless run performs ZERO
      // connector work, not "fetch then deny"). The ToolSet is built synchronously from the TTL
      // cache; a warm cache refreshes in the background (the NEXT turn sees manifest changes), and
      // EVERY admitted shape pre-warms it via cfg.ensureConnectorManifest before buildTools runs
      // (headless: agentRun.ts; owner-present manual/im: prepareChatRun — 0804 dogfood 主修), so
      // the read here is populated even on the first turn after a restart.
      let dynamicTools: ToolSet | undefined
      // D1 — the run-scoped catalog matching dynamicTools, threaded to discover_skills so the
      // self-description tool stops being connector-blind (dogfood root cause ②).
      let connectorCatalog: ConnectorCatalogEntry[] | null = null
      const connectorGrants = agentRunContext?.modeGrants?.connectors
      if (
        shouldLoadConnectorTools(
          mcpConnectorsEnabled,
          contextMode,
          agentRunContext != null,
          connectorGrants
        )
      ) {
        void refreshConnectorManifest()
        const manifest = connectorManifest.peek()
        const skipReason = connectorManifestSkipReason(manifest)
        if (skipReason !== null) {
          // 0804 dogfood — an admitted run that registers NOTHING used to fail silently (the log
          // only ever carried the success line), which is why「connector 不可用」took a whole
          // session to explain. One line per skipped run, with which of the two shapes it was.
          gatewayLogLine({
            event: 'connector_tools_skipped',
            mode: contextMode ?? null,
            reason: skipReason
          })
        } else if (manifest) {
          dynamicTools = createConnectorTools(domain, collector, approvalGuard, manifest, {
            a2uiEnabled,
            approvalMode,
            oneShot: serverResumeEnabled,
            contextMode,
            // PR3 — headless only: the per-connector ceilings + the caller agent id (manual runs
            // carry no context → both absent → PR2 byte-identical).
            ...(agentRunContext != null
              ? { connectorGrants, agentId: agentRunContext.agentId }
              : {})
          })
          // Same single filter source as the prompt path: projection + per-run narrowing.
          connectorCatalog = connectorCatalogForRun(
            projectConnectorCatalog(manifest),
            contextMode,
            agentRunContext != null,
            connectorGrants
          )
          // D1 observability — registered-count line per connector-bearing run (on-disk log).
          gatewayLogLine({
            event: 'connector_tools_registered',
            mode: contextMode ?? null,
            tools: Object.keys(dynamicTools).length,
            connectors: connectorCatalog?.length ?? 0
          })
        }
      }
      return buildGatewayTools(
        {
          domain,
          kosTimeDecayEnabled: envBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true),
          // P0 — default ON fixes the prompt/tool mismatch; this main-process-only flag is an
          // emergency rollback switch and is intentionally not exposed through a Vite define.
          planToolsEnabled: envBool('MAILAGENT_PLAN_TOOL', true),
          sessionProvenanceEnabled,
          writeToolsEnabled: envBool('MAILAGENT_AI_SDK_WRITE_TOOLS', true),
          approvalGuard,
          a2uiEnabled,
          // Phase 04b — the send tool needs the approval guard (write tools) + the signing secret
          // (local API token). Both already constructed above; off by default.
          sendToolEnabled,
          sendSigningSecret: getLocalApiToken(),
          // PART 2 — auto-approval mode from the request body (default 'always' when absent).
          approvalMode,
          // 08-05 WP-11 — the per-tool approval tiers + send whitelist prepareChatRun resolved
          // for THIS run (manual only; the headless wrapper's 3-arg signature never forwards
          // the 5th slot, and buildGatewayTools additionally drops it for non-manual modes).
          toolApprovalPrefs,
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
          // Part B / 07-15 — one-shot preview/edit writes whenever server-side resume is live
          // (always since the owner拍板): an in-panel/island-resumed approval and a renderer-resumed
          // approval must never double-execute, independent of the island flag.
          oneShotWrites: serverResumeEnabled,
          // S1 R1 — chat-session read tools (MAILAGENT_OPENNESS_SESSION_TOOLS, default off).
          sessionToolsEnabled,
          // S1 R2 — profile-config tools (MAILAGENT_OPENNESS_CONFIG_TOOLS, default off).
          configToolsEnabled,
          // S1 R3 — web tools (MAILAGENT_OPENNESS_WEB_TOOLS, default off).
          webToolsEnabled,
          // Stage 2 PR-1 — the im web venue switch (MAILAGENT_IM_WEB_ENABLED, Q19=A; NOT a
          // grant). Only the im_chat matrix branch consults it — non-im runs byte-identical.
          imWebEnabled,
          // S2 W1 — exec tools (MAILAGENT_OPENNESS_EXEC_TOOLS, default off).
          execToolsEnabled,
          // S2 W4 — skill-supply tools (MAILAGENT_OPENNESS_SKILL_INSTALL, default off).
          skillInstallToolsEnabled,
          skillCreatorToolsEnabled,
          // calendar epic 4.1/4.2 — calendar tools (MAILAGENT_CALENDAR_AGENT_TOOLS, default on).
          calendarToolsEnabled,
          // task 07-21 — notion-agent tool (MAILAGENT_NOTION_AGENT_TOOL, default on; skill-gated).
          notionAgentToolsEnabled,
          // task 08-27 P4a — submit_feedback 的提交实现。诊断包在**批准之后**才组装（弹卡时
          // 不该先花掉），截图恒无（agent 截不了图）。
          // 🔴 这条路跳过 `PRAGMA quick_check`：3.2G 的 sync_store 上实测 70s+，对话里这段时间
          // 模型什么都不吐、看起来就是卡死。设置页的「导出诊断包」是人主动等的，仍跑 quick_check。
          submitFeedback: async (input) => {
            let diagnosticsPath: string | undefined
            if (input.attach_diagnostics === true) {
              const diag = await runBuildDiagnostics({ quickCheck: false })
              diagnosticsPath = diag.path
            }
            return runSubmitFeedback({
              kind: input.kind,
              title: input.title,
              detail: input.detail,
              freq: input.freq,
              email: input.email,
              diagnosticsPath,
              viaAgent: true
            })
          },
          // S5 W3 — conversational custom-agent CRUD tools (MAILAGENT_CUSTOM_AGENTS_ENABLED, the same
          // flag that gates the S4 headless kernel; default off → byte-identical to the S4 set).
          customAgentToolsEnabled: customAgentsEnabled,
          // task 08-14 — 内建 agent 只读面（默认开）。与上一行是两件事：那个管「自建 agent」，
          // 这个管「内建 agent」——零 custom 行的库里前者恒返回空列表。
          internalAgentToolsEnabled,
          customAgentCallEnabled,
          parentSessionId,
          // P4b — the team-session recursion guard input (tools/index.ts drops
          // custom_agent_call when non-null). Threaded verbatim from prepareChatRun's 7th slot.
          sessionAgentId,
          // g2 — the main-agent版 group tools' gate inputs from prepareChatRun's 8th slot
          // (labs on + not a group session), joined here with the hook bundle. The headless
          // wrapper's 3-arg signature structurally never forwards the slot → undefined → absent.
          groupTools: groupTools
            ? {
                enabled: groupTools.enabled,
                isGroupSession: groupTools.isGroupSession,
                hooks: groupToolHooks,
                sessionId: parentSessionId ?? null
              }
            : undefined,
          findSessionByParentToolCall,
          createAgentCallSession: (input) =>
            createAgentSession({
              agentId: input.agentId,
              title: input.title,
              parentSessionId: input.parentSessionId,
              parentToolCallId: input.parentToolCallId,
              invokedBy: input.invokedBy
            }),
          setAgentSessionJobId,
          // S5 W4 (ADR-004) — the per-agent run context of a headless agent run, from
          // wrapCfgForAgentRun's buildTools wrapper (4th param). Manual runs pass undefined →
          // assembly byte-identical.
          agentRunContext,
          // Stage 1 PR2 — connector tools ride the stage-0b admitDynamicTools seam (after both
          // skill-gating passes, before the context-mode policy). undefined (flag off / headless /
          // empty cache) → identity pass-through, byte-identical.
          dynamicTools,
          // D1 — the matching run-scoped catalog (discover_skills External-connectors summary).
          connectorCatalog
        },
        collector
      )
    },
    // P4b (task 08-27) — TEAM session identity by sessionId reverse lookup (S2 W0: never from
    // the body). Only origin='team' rows resolve; NULL/'agent'/'im' → null → byte-identical run.
    // 🔴 Contract (config.ts): when the row says 'team' + agent_id, the identity is returned even
    // if the report_agent config fetch fails (weakened fields) — the custom_agent_call recursion
    // guard must not depend on serve-api availability.
    resolveSessionAgent: async (sessionId) => {
      const session = getSession(sessionId)
      if (!session || session.origin !== 'team') return null
      const agentId = session.agent_id
      if (typeof agentId !== 'string' || agentId.length === 0) return null
      try {
        const agent = await domain.getReportAgent(agentId)
        if (agent) {
          return {
            agentId,
            agentTitle: agent.title?.trim() || agentId,
            duty: agent.prompt?.trim() || null,
            model: agent.model?.trim() || null,
            scheduleLine: describeAgentSchedule(agent)
          }
        }
      } catch (err) {
        console.warn('[ai-gateway] team agent config fetch failed (identity degrades)', err)
      }
      return { agentId, agentTitle: agentId, duty: null, model: null, scheduleLine: null }
    },
    // v30（群聊）— GROUP session facts by sessionId reverse lookup (origin='group' rows only;
    // everything else → null → /api/ai/group-chat answers E_NOT_GROUP). Per-member config fetch
    // is best-effort (a failure degrades title/duty/model to id/null) but 🔴 NEVER drops the
    // member: membership is the security fact handleGroupChat validates speakAsAgentId against,
    // and it must not depend on serve-api availability (resolveSessionAgent's contract, same
    // rationale).
    resolveGroupSession: async (sessionId) => {
      const session = getSession(sessionId)
      if (!session || session.origin !== 'group') return null
      const memberIds = parseGroupMemberIds(session.members_json ?? null)
      const members: GroupSessionMember[] = []
      for (const memberId of memberIds) {
        members.push(await resolveGroupMember(memberId, groupMemberReads))
      }
      // g1 (v31) — 群设置 / 每成员响应模式 / family 一并解析。🔴 每次 onGroupMessage 重读、
      // 不缓存：这就是「owner 改完设置对下一条消息生效」的结构性保证（AC1），不靠缓存失效。
      const family = familyOf(sessionId)
      const modes: Record<string, GroupResponseMode> = {}
      for (const row of getGroupMemberConfigs(sessionId)) {
        // 只收还在名单里的成员（成员被移出群后残留的设置行不该影响候选集）。
        if (memberIds.includes(row.agentId)) modes[row.agentId] = row.responseMode
      }
      const config = parseGroupConfig(session.group_config_json ?? null)
      return {
        members,
        config,
        modes,
        parentSessionId: family.parentSessionId,
        childSessionIds: family.childSessionIds,
        judgeScopeStale: computeJudgeScopeStale(session.members_json ?? null, config)
      }
    },
    // v30（群聊）— the shared transcript, projected for server-side history assembly.
    // g1 (v31): 多带四项 —— 行 id（seen 游标 / 窗口边界）、chain_id（链归属）、metadata.via
    // （主助理投递的装配标签）、created_at。
    // T2: 再多一项 attachments —— 与 via 同读 metadata 这一列的两个读者，各取各的键、互不影响；
    // 没有附件的行恒 null（不是空数组），装配侧据此决定要不要前置围栏块。
    listGroupHistory: (sessionId) =>
      listMessages(sessionId).map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        speakerAgentId: row.speaker_agent_id ?? null,
        status: row.status,
        chainId: row.chain_id ?? null,
        via: readMessageVia(row.metadata ?? null),
        attachments: parseAttachmentsMetadata(row.metadata ?? null),
        createdAt: row.created_at
      })),
    // v30（群聊）— persist one group message (owner user message / member reply). appendMessage
    // bumps the session's updated_at, so the 群聊 list orders by fresh activity like every list.
    // g1 (v31): token / cost / chain_id / metadata 一并落库（AC6 成本可见 + 链上限地板的计数
    // 依据），写完广播 chat:turn-persisted 让 renderer 刷新（labs on 的群视图只 append + 订阅）。
    appendGroupMessage: (sessionId, message) => {
      const row = appendMessage({
        sessionId,
        role: message.role,
        content: message.content,
        status: 'complete',
        model: message.model ?? null,
        speakerAgentId: message.speakerAgentId ?? null,
        tokensInput: message.tokensInput ?? null,
        tokensOutput: message.tokensOutput ?? null,
        costUsd: message.costUsd ?? null,
        chainId: message.chainId ?? null,
        metadata: message.metadata ?? null
      })
      // 🔴 runId:null = 「无租约持久化」语义（headless run 同款，:374 那一处的注释）：renderer 的
      // settle 门不会因为对不上 runId 而丢弃它。group:true 让群视图只 invalidate 本群。
      try {
        broadcastChatEvent('chat:turn-persisted', {
          sessionId,
          status: 'finished',
          runId: null,
          group: true
        })
      } catch (err) {
        console.error('[ai-gateway] group turn-persisted broadcast failed (persist landed)', err)
      }
      // L4 群聊 UX 批 — 通知中心投影（判据与 dedupe 见 maybeNotifyGroupReply 头注）。labs on / off
      // 两条路径都经这里 → 同样生效。
      maybeNotifyGroupReply(
        {
          sessionId,
          role: message.role,
          content: message.content,
          speakerAgentId: message.speakerAgentId ?? null,
          chainId: message.chainId ?? null
        },
        getSession,
        isGroupForeground,
        async (agentId) => (await resolveGroupMember(agentId, groupMemberReads)).title
      )
      return row.id
    },
    resolveLabsFlags,
    getSeenCursor,
    advanceSeenCursor,
    insertGroupTurn: (row) => insertGroupTurn(row),
    groupUsage: (sessionIds, sinceMs) => groupUsage(sessionIds, sinceMs),
    // g3 — game_over 的重启兜底：PUT group-config 的 sessionTurnCap 区间下界是 1。
    setSessionTurnCap: async (sessionId, cap) => {
      await domain.setGroupConfig(sessionId, { sessionTurnCap: Math.max(1, cap) })
    },
    lastHumanMessageText,
    // g2 — the group SPEAKER run's ToolSet (调度器 turns only; chatRun calls this instead of
    // buildTools for identity.group.groupSpeakerRun). labs off → undefined (a member turn keeps
    // the zero-tool posture; the judge factory is never even constructed — labs off must be
    // byte-identical to g1). Facts are re-read here (not trusted from the spec) so the judge's
    // judgeScopeStale is the current roster's. The judge result additionally passes the owner
    // 'deny' strip: an owner-denied group_post is invisible to the judge, not silently asked.
    buildGroupSpeakerTools: async (collector, spec) => {
      if (!(await resolveLabsFlags()).groupAgents) return undefined
      const facts = (await gatewayConfig.resolveGroupSession?.(spec.sessionId)) ?? null
      if (!facts) return undefined
      if (!spec.isJudge) {
        return createGroupMemberTools(collector, groupToolHooks, { sessionId: spec.sessionId })
      }
      const tools = createGroupJudgeTools(collector, approvalGuard, groupToolHooks, {
        sessionId: spec.sessionId,
        judgeAgentId: spec.agentId,
        familySessionIds: spec.familySessionIds,
        judgeScopeStale: facts.judgeScopeStale,
        contextMode: 'manual_chat',
        toolApprovalPrefs: spec.toolApprovalPrefs?.tools,
        a2uiEnabled
      })
      return stripOwnerDeniedTools(tools, spec.toolApprovalPrefs?.tools)
    },
    // g1 — spoke turn → 一行 agent_run_log（团队页执行记录可见，AC6）。🔴 best-effort：跨库无
    // 事务（run log 在 sync_store.db、群消息在 ai_chat.db），失败只 warn —— ai_chat_group_turn
    // 才是权威源。status 值域按 run_log.py（completed / failed / skipped / running，**无
    // stopped**），步骤只用 trig / out 两类。
    mirrorGroupRunLog: async (input: GroupRunLogMirror) => {
      // T4 — 主 agent 成员的 spoke turn 不镜像：团队页的主 Agent 没有记录档（teamMembers.ts
      // recordSource:'none'），写了也是一行没有入口的孤儿台账；ai_chat_group_turn 仍是权威源。
      if (input.agentId === MAIN_AGENT_MEMBER_ID) return
      try {
        await domain.postRunLog({
          agentId: input.agentId,
          startedAtMs: input.startedAtMs,
          completedAtMs: input.finishedAtMs,
          status: input.status,
          triggerKind: 'group_chat',
          triggerDetail: `session:${input.sessionId};chain:${input.chainId};run:${input.runId}`,
          summary: input.summary,
          model: input.model ?? null,
          inputTokens: input.tokensInput ?? null,
          outputTokens: input.tokensOutput ?? null,
          error: input.error ?? null,
          steps: [
            {
              kind: 'trig',
              name: '群聊唤醒',
              detail: `窗口 #${input.windowFromId ?? '-'}-#${input.windowToId ?? '-'}`
            },
            {
              kind: 'out',
              name: '发言',
              detail: input.messageId == null ? null : `message:${input.messageId}`,
              ok: input.status === 'completed'
            }
          ]
        })
      } catch (err) {
        console.warn('[ai-gateway] group run-log mirror failed (turn ledger is authoritative)', err)
      }
    },
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
    // Part B (harness 上岛) + 07-15 owner拍板 — the island flag now ONLY gates the announce leg
    // (island card push); the stash + cross-surface single-resolver hooks are ALWAYS wired so the
    // in-panel approval card works with the island (and custom agents) explicitly off.
    islandAgentEnabled,
    serverResumeEnabled,
    approvalStash,
    approvalTtlResponseEnabled: customAgentCallEnabled,
    // B1 — detach-tolerant chat runs (MAILAGENT_CHAT_DETACHED_RUNS, default on). Registry undefined
    // when the env kill-switch is false → /api/ai/chat keeps close→abort + run endpoints 404.
    detachedRunsEnabled,
    activeRuns,
    announceApprovalToIsland: islandAgentEnabled ? announceApprovalToIsland : undefined,
    // L4 批次1 #6 — always wired (not island-gated): the in-panel / record-view pending probe is a
    // first-class approval surface too, and it reads the same preview line.
    fetchApprovalPreview,
    // /decide short-circuit vs a renderer that won the race: has THIS approval already reached a
    // terminal decision (executed OR rejected) on the other surface? If so, resumeApprovalRun does
    // not re-run (no double execute / persist; a renderer reject also blocks a later in-panel/island
    // approve). Always wired (07-15): the in-panel decide card is a second surface regardless of flags.
    isApprovalResolved: (toolCallId: string) => approvalGuard.isResolved(toolCallId),
    // Tombstone an approval as rejected so the other surface can't approve+execute it afterwards.
    rejectApproval: (toolCallId: string) => approvalGuard.reject(toolCallId),
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
          broadcastChatEvent('chat:session-updated', { sessionId, status })
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
    // Built-in matter/contact headless venues are always available after the 2026-08-19 cutover.
    fetchAgentRunSpec: (jobId: number, claimToken: string) =>
      domain.fetchAgentRunSpec(jobId, claimToken),
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
    imFeishuEnabled,
    createImSession: imFeishuEnabled
      ? () => {
          try {
            return createImSession()
          } catch (err) {
            console.error('[ai-gateway] createImSession failed (run will be unsaved)', err)
            return null
          }
        }
      : undefined,
    // Stage 1 PR3 — BOUNDED connector-manifest warm-up for a headless run with connector grants
    // (runHeadlessAgent awaits it before building tools; the fire-and-forget TTL cache alone would
    // let a one-shot cron run read an empty cold cache and silently miss its granted tools).
    // Single-flight + fresh-cache short-circuit inside refreshConnectorManifest; the fetch is
    // 3s-bounded per request and never throws. Flag off → unwired → zero work, byte-identical.
    ensureConnectorManifest: mcpConnectorsEnabled ? () => refreshConnectorManifest() : undefined
  }

  // g2 — the hook bundle every group tool factory (main agent / member / judge) reads its facts
  // through. Composed AFTER the cfg literal because it reuses the cfg's own group hooks (the
  // factories only ever run at request time, long after both exist). 🔴 deliverGroupMessage is
  // read LAZILY at call time: createAiGatewayServer writes it back onto gatewayConfig after the
  // 调度器 is built, i.e. after this bundle is composed — capturing the value here would freeze
  // `undefined` forever (E_GROUP_NOT_ORCHESTRATED on every post). Only group_create goes to
  // serve-api (the membership / subset / nesting validation lives in routers/chat.py, never here).
  const groupToolHooks: GroupToolHooks = {
    resolveGroupSession: (sessionId) => gatewayConfig.resolveGroupSession!(sessionId),
    listGroupHistory: (sessionId) => gatewayConfig.listGroupHistory!(sessionId),
    appendGroupMessage: (sessionId, message) =>
      gatewayConfig.appendGroupMessage!(sessionId, message),
    groupUsage: (sessionIds, sinceMs) => groupUsage(sessionIds, sinceMs),
    deliverGroupMessage: () => gatewayConfig.deliverGroupMessage,
    getSessionTitle: (sessionId) => getSession(sessionId)?.title ?? null,
    lastHumanMessageText,
    createGroupSession: async (input) => {
      const created = await domain.createGroupSession({
        title: input.title,
        groupMembers: input.memberAgentIds,
        parentSessionId: input.parentSessionId,
        invokedBy: input.invokedBy
      })
      return {
        sessionId: created.id,
        title: created.title ?? null,
        members: parseGroupMemberIds(created.members_json),
        parentSessionId: created.parent_session_id ?? input.parentSessionId
      }
    },
    setGroupConfig: (sessionId, patch) => domain.setGroupConfig(sessionId, patch),
    deleteSession: (sessionId) => domain.deleteSession(sessionId)
  }

  const postTurnChains = new Map<number, Promise<void>>()
  const chainPostTurn = (sessionId: number, task: () => Promise<void>): void => {
    // P5 dispatch must remain after P4 compact. Future P6+ post-turn actions must use this chain.
    const previous = postTurnChains.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    const chained = next.finally(() => {
      if (postTurnChains.get(sessionId) === chained) postTurnChains.delete(sessionId)
    })
    postTurnChains.set(sessionId, chained)
  }

  let compactCoordinator: CompactCoordinator | null = null
  if (compactPersistence && autoCompactFeatureEnabled) {
    const coordinator = new CompactCoordinator(gatewayConfig, compactPersistence)
    compactCoordinator = coordinator
    gatewayConfig.compactCoordinator = coordinator
    gatewayConfig.resolveAutoCompactEnabled = resolveAutoCompactEnabled
    gatewayConfig.maybeAutoCompact = (turn: PersistTurnInput): void => {
      setTimeout(() => {
        if (turn.sessionId == null) return
        chainPostTurn(turn.sessionId, async () => {
          if (turn.sessionId == null) return
          const settingEnabled = await resolveAutoCompactEnabled()
          let contextWindow: number | null = null
          try {
            if (providerModelResolver) {
              contextWindow =
                (await providerModelResolver.resolve(turn.model)).contextWindow ?? null
            } else {
              const ref = parseProviderRef(turn.model)
              contextWindow = resolveContextWindow({
                providerId: ref.providerId,
                modelId: ref.modelId,
                protocol: turn.protocol ?? null,
                snapshotModel: null
              })
            }
          } catch (err) {
            console.warn('[ai-gateway] auto-compact context window resolution failed', err)
          }
          if (
            !shouldAutoCompact({
              p3Enabled: compactEnabled,
              settingEnabled,
              contextTokens: turn.contextTokens,
              contextWindow,
              runActive: activeRuns.hasActive(turn.sessionId),
              compactActive: coordinator.hasActive(turn.sessionId)
            })
          ) {
            return
          }
          try {
            const result = await coordinator.run(turn.sessionId, {
              reason: 'threshold',
              contextWindow
            })
            if (result.status === 'completed') {
              gatewayConfig.onCompactCompleted?.(turn.sessionId)
            }
          } catch (err) {
            console.warn('[ai-gateway] automatic compact skipped or failed', err)
          }
        })
      }, 0)
    }
  }

  if (queuedInputEnabled) {
    const dispatchDeps = {
      hasActiveRun: (sessionId: number) => activeRuns.hasActive(sessionId),
      compactActive: (sessionId: number) => compactCoordinator?.hasActive(sessionId) === true,
      listDispatchable: listDispatchableQueuedInput,
      claim: claimQueuedInput,
      revert: (ids: number[]) => {
        revertClaimed(ids)
      },
      listSessionUIMessages: (sessionId: number) =>
        listMessages(sessionId).map(chatMessageToUIMessage),
      getSessionModel: (sessionId: number) => getSession(sessionId)?.backend_model ?? null,
      postChat: async (body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        return {
          ok: response.ok,
          drain: async () => {
            await response.arrayBuffer()
          }
        }
      },
      broadcast: (sessionId: number) =>
        broadcastChatEvent('chat:queued-input-changed', { sessionId }),
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    }
    const scheduleDispatch = (sessionId: number): void => {
      setTimeout(
        () => chainPostTurn(sessionId, () => runQueuedInputDispatch(dispatchDeps, sessionId)),
        0
      )
    }
    gatewayConfig.dispatchQueuedInput = (turn): void => {
      if (turn.sessionId != null) scheduleDispatch(turn.sessionId)
    }
    gatewayConfig.dispatchQueuedInputIfIdle = scheduleDispatch
    // Same per-session chain as the drain: an onFinish drain already queued ahead of this task
    // claims the row first and this dispatch then finds nothing — claim() is the only dedup gate.
    gatewayConfig.dispatchQueuedInputInterrupt = (sessionId, id, revertIds): void => {
      setTimeout(
        () =>
          chainPostTurn(sessionId, () =>
            runQueuedInputDispatch(dispatchDeps, sessionId, {
              ids: [id],
              waitForIdleMs: INTERRUPT_IDLE_WAIT_LIMIT_MS,
              revertIds
            })
          ),
        0
      )
    }
  }

  const handle = await startAiGatewayServer(gatewayConfig)
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
