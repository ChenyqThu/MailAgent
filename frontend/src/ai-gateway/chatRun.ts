// chat-panel P4 Phase 05 — shared chat-run preparation (single source for "build the model call").
//
// Extracted from the Phase 02–04b handleChat so the canonical /api/ai/chat handler AND the AG-UI
// mirror (/api/ai/agui/chat) construct the SAME streamText with the SAME tools + the SAME approval
// guard + secret. The mirror is then provably "复用同一 streamText + tools + 04b 双 guard approval,
// 只换 output 编码器" — there is no second tool implementation and no send path that skips the guard.
//
// 🔴 Pure-ish: depends only on `ai` + config + tools/types + uiMessage. No node:http (it takes an
//    already-parsed body + an AbortSignal), no electron / chat_db.

import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet
} from 'ai'
import { adaptiveSmoothStream } from './adaptiveSmoothStream'

import { anthropicBaseUrl, type AiGatewayConfig, type SessionAgentIdentity } from './config'
import { createAnthropic } from '@ai-sdk/anthropic'
// 🔴 MEDIUM-6 (batch1 review) — import from the SDK-free providerRef, NEVER from providers.ts
// (whose top level pulls six provider SDK packages; it only loads via the lifecycle's flag-on
// dynamic import). Pinned by tests/ai-gateway/provider_lazy_import.test.ts.
import {
  isPrivacyMaskError,
  isProviderCredentialsError,
  parseProviderRef,
  type ProviderProtocol,
  type ResolvedProviderModel
} from './providerRef'
import {
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditEntry
} from './tools/types'
// S2 W0 (ADR-001 D1) — the run's context mode is a TRUSTED prepareChatRun parameter asserted by
// each entrypoint in its own code. It is NEVER read from the request body (a client cannot claim
// manual_chat); absent/unknown fail-closes to 'untrusted_trigger'.
import {
  isCustomAgentComputerUseEnabled,
  normalizeContextMode,
  type AgentContextMode
} from './tools/policy'
import { type MailAgentUIMessage } from '@shared/assistant/uiMessage'
// W6 — the in-turn follow-up tool name (shared leaf; the renderer chips read the same constant).
import { SUGGEST_FOLLOWUPS_TOOL_NAME } from '@shared/assistant/followups'
// chat-panel P4 composer-parity C1-① — per-turn extended-thinking → @ai-sdk/anthropic providerOptions.
// WP-16a — effort 档位与 Brain 布尔并存：body.effort 显式合法时走 effortCallOptions（跨协议
// wire 映射），否则旧布尔路径字节级不变。
import { effortCallOptions, effortTierFromBody, thinkingProviderOptions } from './thinking'
import { opencodeSessionId } from './opencodeSessionId'
import { OPENCODE_SESSION_HEADER } from '@shared/lib/opencodeSession'
import { appendCompactSummaryToSystem } from './compactSelect'
// Phase 06 (context injection) — system prompt assembly + snapshot schema guard.
import {
  appendExecutionDiscipline,
  buildGatewaySystemPromptParts,
  type GatewaySystemPromptConfig
} from './systemPrompt'
// D1 (connector dogfood batch) — per-run scoping of the connector catalog reuses the connector
// module's ONE load seam + ceiling order (never a second filter implementation here); 0804 dogfood
// reuses the SAME seam to decide whether this run must warm the manifest before buildTools.
import {
  connectorCatalogForRun,
  shouldLoadConnectorTools,
  type ConnectorCatalogRunOpts
} from './tools/connector'
import {
  bindToolSearchPartition,
  partitionToolsForLazyLoading,
  type LazyToolPartition
} from './tools/tool_search'
import { bindComputerUseExecution } from './tools/computer_use'
import {
  isValidContextSnapshot,
  type AgentContextSnapshot
} from '@shared/assistant/context/contextSnapshot'
import { extractSdkUsage } from './chatRunPersist'

export {
  LENGTH_TRUNCATION_WARNING_TEXT,
  PERSISTED_TOOL_IMAGE_WINDOW,
  appendLengthTruncationWarning,
  approvalInputPreview,
  extractApprovalStashInput,
  extractSdkUsage,
  lastStepContextTokens,
  lastUserMessage,
  makePersistOnFinish,
  prunePersistedToolImages,
  redactApprovalRequestedParts,
  resolveApprovalPreview,
  responseMessageAwaitsApproval,
  runHasSuccessfulMemoryWrite
} from './chatRunPersist'

/** AI SDK requires a termination predicate. This sentinel is deliberately not a user budget: the
 *  real run boundary is the 30-minute deadline, while 10k only protects against a pathological
 *  infinite tool loop. Manual and headless runs share this exact value. */
export const INTERNAL_TOOL_STEP_SENTINEL = 10_000

// ── 流式节奏层 —— smoothStream 分块粒度（0805 回退，对齐 beUI streaming-response）──────
//
// 前端流式动效已**整层删除**（三代补偿层全被 owner 实机否掉，台账见 docs/motion-gsap.md
// §9.2），观感责任**全部**落在这一层的到达节奏上。上游对照 beUI 的正文渲染是一行裸的
// `{children}`，好看是因为 demo 按 ≈110 字符/秒喂 children，不是因为有动效。
//
// smoothStream 的 RegExp 语义 = 「chunk = buffer.slice(0, match.index) + match[0]」
// （ai@7 dist detectChunk），所以两个分支各自的实际切分（下方 fixture 实测钉住）：
//
//   [一-鿿]    U+4E00–U+9FFF，**只有汉字本身，不含中文标点**（。，！？：；「」在 U+3000
//              段与全角段）。故标点不单独成块，而是**跟着下一个汉字一起出**：`…很好。我`
//              切成 `很`/`好`/`。我`。句末标点落在段尾时由 flushBuffer 吐出，不会卡住。
//   \S+\s+     英文按整词出，**需要尾随空白**。最后一个无空格的词滞留 buffer，直到
//              text-end/finish 触发 flushBuffer —— 不会出现「最后一个词卡住」。
//              副作用（好的那种）：`1.5` / `![alt](url)` / `[a](url)` 这类无内部空白的
//              token 天然整块出，旧句级正则里为躲开它们而写的 lookahead 不再需要。
//
// 改这个正则 = 改每段文本被切成几块，于是**连带**改了打字速度（显示耗时 = chunk 数 ×
// 单拍，见下方 STREAM_CHUNKING_DELAY_MS）。观感本身没有任何断言接得住，所以
// tests/ai-gateway/stream_chunking.test.ts 用实测 fixture 钉住**切分形状**（不钉实测时长
// —— 那受机器负载影响必 flake；拍子常量另有一条绊线）。
export const STREAM_CHUNKING_REGEX = /[一-鿿]|\S+\s+/

/**
 * 每 chunk 之间的节流拍子（ms）。**7 不是拍脑袋的**，它由一个参照点定出来：
 * 对齐 beUI streaming-response demo 的 **≈110 字符/秒**（前端已无任何动效，这个到达
 * 速率就是观感本身，见本文件 STREAM_CHUNKING_REGEX 头注释与 docs/motion-gsap.md §9.2）。
 *
 * 🔴 **别按 `1000/delayInMs` 心算**：setTimeout 粒度让单拍实测比标称大 ~2ms。0805 用真实
 * smoothStream 量的（5 次取中位，400 字中文）：
 *
 *   delayInMs=7   单拍 9.20ms   ≈109 字/秒  ← 当前档，正对 beUI 的 110
 *   delayInMs=10  单拍 11.79ms  ≈ 85 字/秒     （曾用值，比参照点慢约 20%）
 *
 * 🔴 **选值时唯一要权衡的是「显示耗时有硬下界」**：smoothStream 每 chunk 固定 await 一次
 * delayInMs 且**没有任何追赶逻辑**，模型再快也追不回来 —— 显示耗时下界 = chunk 数 ×
 * 单拍。两个方向都有代价：
 *   · 调**大** → 模型早就生成完了，界面还在慢慢打字（1000 字中文 @delay=10 要流 ~11.8s，
 *     模型 6s 出完就拖一条 ~6s 的尾巴，停止按钮还亮着）。⚠️ 这是本次改动**新引入**的风险：
 *     此前的句级切分等于不限速（一拍一整句，上限 ~2000 字/秒，显示始终贴着模型走），
 *     所以以后谁要调大这个数，必须知道自己是在买这条尾巴，而不是"只是慢一点"。
 *   · 调**小** → 逐字质感消失，退化成整块弹出（那正是这一层存在的理由）。
 *
 * 🔴 **第二个隐藏消费面：`reasoning-delta` 与 `text-delta` 共用这同一套节流**（smoothStream
 * 对两类 delta 一视同仁，实证：30 字推理 = 30 拍）。所以开思考时，长中文 reasoning 块会
 * 按同一速率**爬完才轮到正文** —— 改这个数不只影响正文速度，也影响"多久才看见回答开始"。
 * 英文侧上限 ≈109 词/秒，远高于任何模型，实际不构成约束。
 */
export const STREAM_CHUNKING_DELAY_MS = 7

/**
 * HIGH-1 (batch1 review) — the ONE credential pre-gate all three LLM entrypoints share
 * (prepareChatRun + /api/ai/title + /api/ai/search-agent).
 *
 * Flag OFF (or no resolver): the legacy global-key gate, byte-identical — an empty cfg.apiKey is
 * 503 E_NO_LLM_KEY before anything runs. Registry path ON (flag + resolver): the gate is skipped —
 * per-provider keys live in the snapshot, so the RESOLVER is the credential authority: a selected
 * provider row missing a required key throws the typed ProviderCredentialsError (openai-compatible
 * rows may run keyless), which the entrypoints map back to the same 503 E_NO_LLM_KEY wire shape.
 * The condition mirrors resolveModelFactory's registry branch exactly.
 */
export function llmCredentialsMissing(cfg: AiGatewayConfig): boolean {
  if (cfg.providerRegistryEnabled && cfg.providerModelResolver) return false
  return !cfg.apiKey || cfg.apiKey.length === 0
}

/** Resolve the LanguageModel factory: injected (tests / mock) else the default @ai-sdk/anthropic
 *  provider wired to the normalized baseURL + key. */
export function resolveModelFactory(
  cfg: AiGatewayConfig
): (modelId: string) => ResolvedProviderModel | Promise<ResolvedProviderModel> {
  if (cfg.createModel) {
    return (modelId: string) => ({
      ...parseProviderRef(modelId),
      model: cfg.createModel!(modelId),
      protocol: 'anthropic'
    })
  }
  if (cfg.providerRegistryEnabled && cfg.providerModelResolver) {
    return (modelId: string) => cfg.providerModelResolver!.resolve(modelId)
  }
  const anthropic = createAnthropic({
    apiKey: cfg.apiKey ?? '',
    baseURL: anthropicBaseUrl(cfg.baseUrl)
  })
  return (modelId: string) => ({
    ...parseProviderRef(modelId),
    model: anthropic(modelId),
    protocol: 'anthropic'
  })
}

/**
 * D1 (connector dogfood batch) — scope the provider-supplied connector catalog to what THIS run
 * actually registers before the prompt is assembled. The provider is zero-arg (shared TTL cache),
 * so it always carries the FULL manual-shape catalog; here — where the run's trusted mode +
 * agentRunContext meet it — connectorCatalogForRun (connector.ts: the ONE seam + ceiling order)
 * narrows it: manual and im_chat (stage 2 PR-1, both owner-present) keep everything, a granted
 * headless run keeps only its granted connectors (writes zeroed above the ceiling), and every
 * seam-refused shape (owner-present venue + context stray, junk grants) drops the catalog
 * entirely — the prompt must never advertise tools the ToolSet does not hold. No catalog on the
 * config → returned as-is (byte-identical passthrough).
 */
export function scopeConnectorCatalogForRun(
  promptConfig: GatewaySystemPromptConfig | null,
  contextMode: AgentContextMode | undefined,
  hasAgentRunContext: boolean,
  connectorGrants: unknown,
  opts?: ConnectorCatalogRunOpts
): GatewaySystemPromptConfig | null {
  if (!promptConfig?.connectorCatalog || promptConfig.connectorCatalog.length === 0) {
    return promptConfig
  }
  return {
    ...promptConfig,
    connectorCatalog: connectorCatalogForRun(
      promptConfig.connectorCatalog,
      contextMode,
      hasAgentRunContext,
      connectorGrants,
      opts
    )
  }
}

/** composer-parity C2 — prepend the renderer's mention/attachment injected context to the LAST user
 *  message of the MODEL-message array (NOT rawMessages, so persistence keeps the original user text).
 *  String content → string prefix; array content → an extra leading text part. The prefix already
 *  carries untrusted-content framing (buildMentionContext / buildAttachmentBlock from the renderer),
 *  so a mentioned email body can't masquerade as a system directive. Empty prefix → unchanged. */
export function prependInjectedContext(messages: ModelMessage[], prefix: string): ModelMessage[] {
  if (prefix.length === 0) return messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') {
      const next = { ...m, content: `${prefix}${content}` } as ModelMessage
      return messages.map((mm, idx) => (idx === i ? next : mm))
    }
    if (Array.isArray(content)) {
      const next = { ...m, content: [{ type: 'text', text: prefix }, ...content] } as ModelMessage
      return messages.map((mm, idx) => (idx === i ? next : mm))
    }
    break
  }
  return messages
}

/** Monotonic-ish id generator for response message ids (transient — reload re-stamps the persisted
 *  row id). Not security-sensitive. */
export function makeIdGenerator(): () => string {
  let seq = 0
  const boot = Date.now().toString(36)
  return () => `asst-${boot}-${(seq++).toString(36)}`
}

/** A prepared streamText run + the metadata both endpoints need to encode + persist it. */
export interface PreparedChatRun {
  result: StreamTextResult<ToolSet, never, never>
  rawMessages: MailAgentUIMessage[]
  sessionId: number | null
  modelId: string
  protocol: ProviderProtocol
  contextWindow?: number | null
  /** The per-request audit collector the tools push into (drained in onFinish → chat_tool_call). */
  auditEntries: GatewayToolAuditEntry[]
  /** Tool names exposed this run (for the AG-UI STATE_SNAPSHOT capabilities). */
  toolNames: string[]
  /** Part B (island resume) — the ORIGINAL request body, kept verbatim so a paused approval can be
   *  stashed + re-run server-side with the same model / thinking / contextSnapshot / system /
   *  approvalMode. Only read by makePersistOnFinish when the turn pauses at an approval gate AND
   *  cfg.islandAgentEnabled; otherwise inert. Optional so pre-Part-B test helpers that hand-build a
   *  PreparedChatRun stay valid — prepareChatRun always sets it, and maybeStashAndAnnounceApproval
   *  guards on it. */
  originalBody?: Record<string, unknown>
  /** S2 W0 (ADR-001 D1) — the normalized trusted context mode this run was prepared under.
   *  prepareChatRun always sets it; optional only so hand-built test PreparedChatRuns stay valid
   *  (absent fail-closes to 'untrusted_trigger' wherever it is consumed — the stash freeze in
   *  maybeStashAndAnnounceApproval). */
  contextMode?: AgentContextMode
  /** codex r2 [C] — the ActiveRunRegistry runId this run holds (stamped by server.ts after
   *  register(): /api/ai/chat's slot or the /decide resume lease). Read by makePersistOnFinish so
   *  the persisted turn / paused persist carry it into the 'chat:turn-persisted' broadcast for
   *  per-run settle dedup. undefined = unleased (headless agent run / no registry / null session). */
  runId?: string
  /** T4 (design M6) — true for every group SPEAKER run (identity.group present). Read by
   *  makePersistOnFinish to keep captureTurnMemory off: 群里的内容是其他 agent 的半可信输出，
   *  不进 memory.md。Today no group path attaches makePersistOnFinish at all (both drain
   *  textStream directly, see server.ts), so this is the structural guard for the day one does. */
  groupSpeakerRun?: boolean
  /** WS-2 Plane 1 — lazy schema loading partition metadata when `cfg.toolSearchEnabled === true`. */
  lazyPartition?: LazyToolPartition
}

export type PrepareChatOutcome =
  | { ok: true; run: PreparedChatRun }
  | { ok: false; status: number; body: { error: string; hint: string } }

/**
 * Validate an incoming chat request body and build the streamText run (key check, messages check,
 * model/system/sessionId parse, convertToModelMessages, tool registry + approval wiring). Returns a
 * typed error outcome (the caller writes it as JSON) or the prepared run. Mirrors the Phase 02–04b
 * handleChat preamble exactly, so /api/ai/chat behaviour is unchanged.
 *
 * S2 W0 (ADR-001 D1) — `trustedContextMode` is an independent TRUSTED parameter each entrypoint
 * asserts in its own code (/api/ai/chat + the AG-UI mirror pass 'manual_chat'; the island resume
 * passes the mode frozen in the stash; future S4 headless entrypoints pass their trigger's mode).
 * It is deliberately NOT read from `body` — a request carrying `contextMode:'manual_chat'` is
 * ignored, so a client can never escalate. Absent/unknown fail-closes to 'untrusted_trigger'
 * (strictest): an entrypoint that forgets to pass it degrades toward safety, never privilege.
 */
export async function prepareChatRun(
  body: Record<string, unknown>,
  cfg: AiGatewayConfig,
  abortSignal: AbortSignal,
  trustedContextMode?: AgentContextMode,
  /** P4b — the session's TEAM identity, resolved by the entrypoint from the sessionId
   *  (cfg.resolveSessionAgent; S2 W0: never from the body). Drives exactly three seams:
   *  model middle priority, the <current_team_agent> prompt block, and the custom_agent_call
   *  recursion guard (via buildTools' sessionAgentId slot). Absent/null → byte-identical. */
  sessionAgent?: SessionAgentIdentity | null
): Promise<PrepareChatOutcome> {
  // HIGH-1 — flag-off keeps the legacy global-key gate byte-identical; the registry path defers
  // to the resolver (per-provider keys), whose typed failure is mapped right below.
  if (llmCredentialsMissing(cfg)) {
    return {
      ok: false,
      status: 503,
      body: { error: 'E_NO_LLM_KEY', hint: '设置 LLM_API_KEY 后重试' }
    }
  }
  const rawMessages = Array.isArray(body.messages) ? (body.messages as MailAgentUIMessage[]) : []
  if (rawMessages.length === 0) {
    return { ok: false, status: 400, body: { error: 'E_INVALID_ARG', hint: 'messages[] required' } }
  }
  // P4b — model priority for a team-agent session: body.model (user's explicit pick) >
  // the agent row's model > gateway default. Non-team runs: sessionAgent is null → unchanged.
  const agentModel =
    sessionAgent?.model && sessionAgent.model.length > 0 ? sessionAgent.model : null
  const modelId =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : (agentModel ?? cfg.model)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  // chat-panel P4 composer-parity C1-① — per-turn extended-thinking toggle. body.thinking===true →
  // inject providerOptions by the model-family matrix (./thinking); absent/false → undefined →
  // providerOptions omitted below, byte-identical to the pre-toggle no-thinking streamText call.
  // HIGH-1 — registry-path credential failures (selected provider row lacks a required key /
  // fail-open leg with no legacy key) surface here as the typed error → same 503 wire shape the
  // legacy gate produced. Any other resolver failure propagates unchanged.
  let resolvedModel: ResolvedProviderModel
  try {
    resolvedModel = await resolveModelFactory(cfg)(modelId)
  } catch (e) {
    if (isProviderCredentialsError(e)) {
      return { ok: false, status: 503, body: { error: 'E_NO_LLM_KEY', hint: e.message } }
    }
    if (isPrivacyMaskError(e)) {
      return { ok: false, status: 503, body: { error: 'E_PRIVACY_MASK_FAILED', hint: e.message } }
    }
    throw e
  }
  // WP-16a — effort 显式传入（合法档位字符串）才走新路径；缺席/非法 → null → 旧 Brain 布尔
  // 路径逐字节保留（含 island resume：stash 冻结的 originalBody 带什么就重放什么）。
  const effortTier = effortTierFromBody(body.effort)
  const effortCall =
    effortTier != null
      ? effortCallOptions(resolvedModel.modelId, effortTier, resolvedModel.protocol)
      : undefined
  const thinkingProviderOpts =
    effortTier != null
      ? effortCall?.providerOptions
      : thinkingProviderOptions(
          resolvedModel.modelId,
          body.thinking === true,
          resolvedModel.protocol
        )
  // harness-chat lane C (07-15, feedback_llm_call_settings) — every LLM call gets an EXPLICIT 64k
  // output ceiling. resolvedModel.maxOutputTokens (set by the main-process wrapping resolver,
  // llm_provider_resolver.ts) already carries `min(64000, row.maxOutput)` when the provider row
  // pins a lower per-model cap; 64_000 is the fallback for the legacy/test-mock resolveModelFactory
  // branches, which never set it. 🔴 Passing this EXPLICITLY (not relying on providers.ts's
  // defaultSettingsMiddleware alone) matters: ai@7's middleware only applies its setting as a
  // DEFAULT — an explicit call-time maxOutputTokens always wins (mergeObjects(settings, params)) —
  // so for protocols whose SDK injects no per-model default (openai/deepseek/openai-compatible), an
  // unset value silently falls back to the UPSTREAM SERVER's own default (DeepSeek: 4k), starving a
  // long tool-call JSON input long before the model is actually done (research
  // lane-c-write-truncation.md §4/§6②). Threading the resolver's own clamp through here keeps the
  // two layers in agreement instead of the explicit param blindly overriding a lower row cap.
  const maxOutputTokens = resolvedModel.maxOutputTokens ?? 64_000

  // Normalize the SERVER-asserted mode once before assembling either the system prompt or tools.
  // A custom-agent wrapper supplies agentRunContext; combining both signals keeps this discipline
  // headless-only even if a hand-built manual cfg accidentally carries a stray context object.
  const contextMode = normalizeContextMode(trustedContextMode)
  const isHeadlessAgentRun = contextMode !== 'manual_chat' && cfg.agentRunContext != null

  // Build the tools bound to a fresh per-request audit collector (closure). No tools → text-only
  // (Phase 02 behaviour). The same buildTools feed BOTH endpoints, so the mirror's approval path is
  // identical to /api/ai/chat (no bypass). W6 — built BEFORE the system prompt so the follow-up
  // guidance block can key off the ACTUAL ToolSet (prompt and tool surface can never drift);
  // tool assembly and prompt assembly are otherwise independent.
  //
  // 🔴 We deliberately do NOT pass streamText `experimental_toolApprovalSecret`: the native
  // assistant-ui replay uses ai@6's addToolApprovalResponse, which DROPS the request signature, so a
  // signed approval would fail with a missing-signature error on the second (resume) call. The
  // MailAgent domain ApprovalGuard remains the authoritative write gate — it binds toolCallId + input
  // hash + expiry across the two HTTP calls of an approval round-trip (security/approval.ts), and the
  // high-risk send path keeps its own Python-side double guard. So removing the AI SDK secret weakens
  // nothing that actually gates a write.
  // Auto-approval mode (PART 2) — body.approvalMode threads into the write/memory tools'
  // needsApproval. Only the two recognized values are honored; anything else (incl. absent) →
  // 'always', so a malformed body never silently relaxes approval (byte-identical to pre-toggle).
  // S2 W0 — normalize the TRUSTED mode (never from body) once; it feeds buildTools (registration
  // filter + auto-approve predicate) and is frozen into the run for the island stash.
  let approvalMode: GatewayApprovalMode =
    body.approvalMode === 'auto-reversible' ? 'auto-reversible' : 'always'
  // 07-16 approval-mode switcher — overlay the owner-global mode (agent_config.db, hot-read via
  // the injected resolver; NEVER from the request body). 🔴 MANUAL_CHAT-GATED: headless custom-
  // agent runs reach prepareChatRun too (agentRun.ts) and must never see the global mode — they
  // are governed solely by their per-agent grants matrix, so the resolver is not even called for
  // them. 'manual' (default) keeps the request-level value above byte-identical; a resume of a
  // stashed MANUAL run re-resolves here, so the mode in effect at approval time is the owner's
  // CURRENT one (consistent with "hot-read at decision time"). Resolver absent (harness/test
  // cfgs) or failing → the request-level mode stands (fail-closed to manual semantics).
  // 08-05 WP-11 — only 'bypass' overlays now: the 'acceptEdits' mode is retired (server-side it
  // folds to 'manual' + per-tool prefs; a stale wire value is ignored here, fail-closed).
  if (contextMode === 'manual_chat' && cfg.resolveGlobalApprovalMode) {
    try {
      const globalMode = await cfg.resolveGlobalApprovalMode()
      if (globalMode === 'bypass') approvalMode = globalMode
    } catch {
      /* fail-closed — keep the request-level ('manual') semantics */
    }
  }
  // 08-05 WP-11 — the per-tool approval tiers + send whitelist of a MANUAL run, hot-read per run
  // (same "hot-read at decision time" semantics as the mode above: a stashed-approval resume
  // re-resolves, so the tiers in effect are the owner's CURRENT ones). 🔴 MANUAL_CHAT-GATED at
  // three layers: not resolved here for non-manual runs, dropped by buildGatewayTools for
  // non-manual assemblies, and re-checked at needsApproval consumption (types.ts). Resolver
  // absent/failing → null → every write asks (fail-closed — never fewer cards).
  let toolApprovalPrefs: GatewayToolApprovalPrefs | null = null
  if (contextMode === 'manual_chat' && cfg.resolveToolApprovalPrefs) {
    try {
      toolApprovalPrefs = (await cfg.resolveToolApprovalPrefs()) ?? null
    } catch {
      toolApprovalPrefs = null // fail-closed — ask semantics
    }
  }
  // 0804 dogfood 主修 —「重启后第一轮 connector 不可用」. The lifecycle's startup prewarm of the
  // connector manifest fires ~1.2s BEFORE serve-api accepts requests, so the very first
  // owner-present turn used to read an empty (failed) cache and register zero mcp__* tools — the
  // model then honestly answered「不可用」and only the SECOND turn worked. Await the bounded ensure
  // hook here, before buildTools: it short-circuits on a warm cache (cost ≈ 0 on every later
  // turn), is single-flight + fetch-bounded, and is contracted never to throw. Awaiting BEFORE
  // buildTools also removes the drift between the ToolSet and the system prompt's connector
  // catalog (systemPromptProvider is awaited later and read the cache at a different instant).
  // The seam decides WHO warms: owner-present venues (manual_chat / im_chat, no agentRunContext)
  // only — a headless run is warmed by runHeadlessAgent with its grants (agentRun.ts), and a
  // grant-less headless run must keep doing ZERO connector work. Hook absent (flag off / test
  // cfgs) → skipped entirely, byte-identical — the hook's PRESENCE is the MAILAGENT_MCP_CONNECTORS
  // gate here (the lifecycle wires it only when the flag is on), hence the literal `true`.
  const ensureConnectorManifest = cfg.ensureConnectorManifest
  if (
    ensureConnectorManifest &&
    shouldLoadConnectorTools(true, contextMode, cfg.agentRunContext != null)
  ) {
    try {
      await ensureConnectorManifest()
    } catch (err) {
      console.warn(
        '[ai-gateway] connector manifest ensure failed — run continues without connector tools',
        err
      )
    }
  }
  let contextSnapshot: AgentContextSnapshot | null = null
  if (cfg.systemPromptProvider && body.contextSnapshot != null) {
    if (isValidContextSnapshot(body.contextSnapshot)) {
      contextSnapshot = body.contextSnapshot
    } else if (
      typeof body.contextSnapshot === 'object' &&
      !Array.isArray(body.contextSnapshot) &&
      'version' in (body.contextSnapshot as object)
    ) {
      return {
        ok: false,
        status: 400,
        body: { error: 'E_INVALID_ARG', hint: 'contextSnapshot failed schema validation' }
      }
    }
  }
  const auditEntries: GatewayToolAuditEntry[] = []
  // 0812 owner拍板 — the Matter chat's「本事项 / 全库」toggle is gone (matter chat always reads the
  // full library), so the manual matterScopeFilter derivation that used to sit here is gone too.
  // With the P4 follow-up derivation already retired, NO caller narrows the email reads by Matter
  // any more and the tool-side option was removed with it (tools/index.ts, tools/email.ts).
  // WP-11 — the 4th slot (agentRunContext) belongs to the HEADLESS wrapper's own signature
  // (wrapCfgForAgentRun injects it); manual callers pass undefined there and the prefs ride the
  // 5th slot. The headless wrapper's 3-arg signature structurally drops the 5th argument, so a
  // headless run can never receive the prefs even if this call site changes.
  // P4b — the 7th slot carries the session's team-agent id into the assembly gate: an
  // agent-identity session must never register custom_agent_call (recursion guard). Non-team
  // runs pass undefined → assembly byte-identical.
  // g2 — the main-agent版 group tools' assembly inputs, both SERVER facts computed HERE and only
  // here (single source for all three entrypoints — handleChat / compact overflow retry /
  // approvalResume — because every one of them goes through prepareChatRun; approvalResume
  // deliberately does no lookup of its own). `isGroupSession` = the session is an origin='group'
  // row → the main-agent版 group_post / group_create must NOT register (a group run reaching
  // into groups is the recursion this guards). 🔴 fail-CLOSED: a throwing lookup counts as a
  // group session — the opposite of resolveSessionAgent's fail-open, because the risk here is a
  // group run gaining the tools, not a lost identity. `enabled` = labs.groupAgents (owner_settings,
  // hot-read), any failure → false (never "tools quietly appear"). Both are manual_chat-only: the
  // assembly gate is manual-only anyway and headless runs must perform zero group lookups.
  let isGroupSession = false
  let groupToolsEnabled = false
  if (contextMode === 'manual_chat' && sessionId != null) {
    if (cfg.resolveGroupSession) {
      try {
        isGroupSession = (await cfg.resolveGroupSession(sessionId)) != null
      } catch (err) {
        isGroupSession = true
        console.warn(
          '[ai-gateway] resolveGroupSession failed — treating session as a group (group tools withheld)',
          err
        )
      }
    }
    if (cfg.resolveLabsFlags) {
      try {
        groupToolsEnabled = (await cfg.resolveLabsFlags()).groupAgents === true
      } catch {
        groupToolsEnabled = false
      }
    }
  }
  // v30（群聊）/ g2 — a group-chat SPEAKER run never calls buildTools: its ToolSet is decided by
  // cfg.buildGroupSpeakerTools (member → the two reads pinned to its own group; judge → all
  // four, family-scoped), and ONLY for a 调度器-driven turn (identity.group.groupSpeakerRun ===
  // true AND a sessionId). The v30 renderer-driven speaker turn sets groupSpeakerRun too (T4 M7:
  // prompt 减重态两态一致) but carries no sessionId → tools=undefined, its zero-tool posture
  // unchanged (A3 §3 发言 turn 无写工具). The custom_agent_call recursion guard stays subsumed (neither
  // factory holds it); identity.group is only ever set by handleGroupChat / speakAsGroupMember
  // from server-resolved facts, never from the body.
  const rawDisabledConnectors =
    contextMode === 'manual_chat' && Array.isArray(body.disabledConnectors)
      ? body.disabledConnectors.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        )
      : []
  const disabledConnectors = rawDisabledConnectors.length > 0 ? rawDisabledConnectors : undefined

  const isGroupSpeakerRun = sessionAgent?.group != null
  const sessionAgentId = contextMode === 'manual_chat' ? (sessionAgent?.agentId ?? null) : null
  const groupIdentity = sessionAgent?.group
  const tools = isGroupSpeakerRun
    ? groupIdentity?.groupSpeakerRun === true && groupIdentity.sessionId != null
      ? await cfg.buildGroupSpeakerTools?.(auditEntries, {
          sessionId: groupIdentity.sessionId,
          agentId: sessionAgent!.agentId,
          isJudge: groupIdentity.isJudge === true,
          familySessionIds: groupIdentity.familySessionIds ?? [groupIdentity.sessionId],
          toolApprovalPrefs
        })
      : undefined
    : sessionId == null
      ? cfg.buildTools?.(
          auditEntries,
          approvalMode,
          contextMode,
          undefined,
          toolApprovalPrefs,
          undefined,
          sessionAgentId,
          {
            isGroupSession,
            enabled: groupToolsEnabled,
            ...(disabledConnectors ? { disabledConnectors } : {})
          }
        )
      : cfg.buildTools?.(
          auditEntries,
          approvalMode,
          contextMode,
          undefined,
          toolApprovalPrefs,
          sessionId,
          sessionAgentId,
          {
            isGroupSession,
            enabled: groupToolsEnabled,
            ...(disabledConnectors ? { disabledConnectors } : {})
          }
        )
  if (tools && 'computer_use_run' in tools) {
    const allowMatterComputerUse =
      contextMode === 'matter_followup' &&
      cfg.agentRunContext?.matterItemComputerUse?.enabled === true &&
      cfg.agentRunContext.matterItemComputerUse.mode === 'propose_only' &&
      cfg.agentRunContext.matterItemComputerUse.stopBeforeSubmit === true
    const allowCustomAgentComputerUse =
      (contextMode === 'untrusted_trigger' || contextMode === 'cron_headless') &&
      isCustomAgentComputerUseEnabled(cfg.agentRunContext?.modeGrants)
    if (
      cfg.computerUseEnabled === false ||
      (contextMode !== 'manual_chat' && !allowMatterComputerUse && !allowCustomAgentComputerUse)
    ) {
      delete tools.computer_use_run
    } else {
      bindComputerUseExecution(tools.computer_use_run, {
        model: resolvedModel.model,
        maxOutputTokens,
        sessionId,
        finalTools: tools
      })
    }
  }
  const hasTools = tools != null && Object.keys(tools).length > 0
  // W6 — the run holds the suggest_followups tool (manual chat with a real gateway ToolSet). Drives
  // the follow-up guidance block in the system prompt below — keyed off the BUILT set, never off
  // the mode alone.
  const followupToolAvailable = hasTools && SUGGEST_FOLLOWUPS_TOOL_NAME in (tools as ToolSet)
  const computerUseAvailable = hasTools && 'computer_use_run' in (tools as ToolSet)

  // System prompt. With the injection provider set (always injected since S3) assemble
  // from standing-context + the typed snapshot, reusing the legacy stable prefix
  // (buildGatewaySystemPrompt). Without it (default) pass body.system through unchanged AND ignore the
  // contextSnapshot field entirely — Phase 02/05 behaviour, byte-identical (no validation, no 400).
  let system: string | undefined
  // The config-derived head of `system` (tools + this part stay a cache hit across turns);
  // null on the body.system passthrough path.
  let systemCacheablePrefix: string | null = null
  if (cfg.systemPromptProvider) {
    // Resolve the typed context snapshot ONLY on the injection path: a valid v1 snapshot is used; a
    // snapshot that CLAIMS to be typed (carries a `version`) but fails validation → 400 (no off-spec
    // blob into the prompt); an UNtyped passthrough blob (no version — the AG-UI mirror's open
    // context, handled by the AG-UI route's own redacting readContext) is ignored here. Absent → null.
    // The provider is contracted to return null (not throw) on a /chat/config blip → context-light.
    // D1 — the connector catalog it carries is manual-shape (zero-arg shared cache); scope it to
    // THIS run before assembly (headless: granted connectors only; seam-refused shapes: none).
    const promptConfig = scopeConnectorCatalogForRun(
      (await cfg.systemPromptProvider()) ?? null,
      contextMode,
      cfg.agentRunContext != null,
      cfg.agentRunContext?.modeGrants?.connectors,
      {
        connectorToolGrants: cfg.agentRunContext?.modeGrants?.connectorTools,
        disabledConnectors
      }
    )
    // 07-01 — the bounded memory.md rides IN promptConfig.memorySummary (the cacheable stable prefix,
    // rendered by buildStableSystemPrompt as an untrusted MEMORY fence). The M2 per-query recall path
    // (retrieveMemory callback → /chat/memory/search) is retired: memory.md is injected whenever
    // Python's /chat/config sends a non-empty memorySummary, so there is nothing to recall per turn.
    const systemParts = buildGatewaySystemPromptParts({
      promptConfig,
      contextSnapshot,
      headlessAgentRun: isHeadlessAgentRun,
      headlessAgentIdentity: cfg.headlessAgentIdentity,
      // P4b — team identity block for an owner-present session opened AS an agent (manual only;
      // a headless run keeps its own <current_custom_agent> block).
      sessionAgentIdentity: contextMode === 'manual_chat' ? (sessionAgent ?? null) : null,
      // W6 — inject the follow-up guidance only when THIS run's ToolSet holds the tool.
      followupToolAvailable,
      // WS-5 — inject Tier 1 > Tier 2 > Tier 3 routing discipline when THIS run holds computer_use_run.
      computerUseAvailable,
      // g1 — prompt 减重门 + 沉默契约, set by the 调度器's speak adapter and (T4 M7) the v30
      // renderer-driven speaker branch (both in server.ts): every group speaker turn is the 减重态.
      groupSpeakerRun: sessionAgent?.group?.groupSpeakerRun === true
    })
    systemCacheablePrefix = systemParts.cacheable
    system = [systemParts.cacheable, systemParts.volatile].filter((s) => s.length > 0).join('\n\n')
  } else {
    const bodySystem =
      typeof body.system === 'string' && body.system.length > 0 ? body.system : undefined
    // 🔴 legacy passthrough 路径（无 systemPromptProvider）：**只有 headless 追加纪律**，manual 保持
    // body.system 逐字节透传（Phase 02 契约 —— 这条路径的全部意义就是「system 完全由调用方给」，
    // 纯 harness / 老测试依赖它）。F4 让 manual 也拿到纪律，但生产 manual chat 自 S3 起恒有
    // injection provider、走上面的 buildGatewaySystemPrompt 分支，所以目标达成不需要动这条契约。
    system = isHeadlessAgentRun ? appendExecutionDiscipline(bodySystem, true) : bodySystem
  }

  const selectedContext = cfg.selectMessagesForModelContext
    ? cfg.selectMessagesForModelContext(rawMessages)
    : { messages: rawMessages, summary: null, metadata: null }
  if (selectedContext.summary) {
    system = appendCompactSummaryToSystem(system ?? '', selectedContext.summary)
  }

  // WS-2 Plane 1 — Partition already-admitted tools AFTER buildTools/wrapCfgForAgentRun/mode/deny
  // filtering and AFTER context selection, BEFORE convertToModelMessages & streamText.
  // CRITICAL: `tools` stays FULL for BOTH convertToModelMessages({ tools }) (toModelOutput replay)
  // AND streamText({ tools }) (AI SDK tool resolution), while `activeTools` + `prepareStep` gate
  // which schemas the LLM sees on each step.
  let lazyPartition: LazyToolPartition | undefined
  if (hasTools && cfg.toolSearchEnabled === true && tools) {
    lazyPartition = partitionToolsForLazyLoading(tools, selectedContext.messages, {
      toolSearchEnabled: true
    })
    if (lazyPartition.deferredToolNames.length > 0 && 'tool_search' in tools) {
      bindToolSearchPartition(tools.tool_search, tools, lazyPartition)
    }
  }

  // 🔴 ai@6 convertToModelMessages is ASYNC (returns a Promise) — must await, else
  // streamText.standardizePrompt receives a Promise and throws "messages.some is not a function".
  // 🔴 WS-1A replay invariant: pass the EXACT same `tools` ToolSet to convertToModelMessages so
  // tool.toModelOutput runs when replaying historical multimodal tool outputs across turns.
  let modelMessages
  try {
    modelMessages = hasTools
      ? await convertToModelMessages(selectedContext.messages, { tools })
      : await convertToModelMessages(selectedContext.messages)
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: 'E_INVALID_ARG', hint: 'messages[] not convertible to model messages' }
    }
  }
  // composer-parity C2 — prepend the renderer's mention/attachment context to the model's last user
  // message (rawMessages stay original → persistence is clean). The prefix carries untrusted framing.
  const injectedContext = typeof body.injectedContext === 'string' ? body.injectedContext : ''
  if (injectedContext.length > 0) {
    modelMessages = prependInjectedContext(modelMessages, injectedContext)
  }

  // 流式节奏层：中文逐字 / 英文逐词。粒度、吞吐上限、reasoning 也被节流这三件事见文件头部
  // STREAM_CHUNKING_REGEX 的注释。前端已无任何流式动效，观感全靠这里的到达节奏。
  // 代价（已接受）：逐字进 Streamdown 时未闭合的 markdown 记号会短暂以字面量出现（`**` 等，
  // 实测只在「标签含空格」的链接/行内 code 上出现 2-3 拍），Streamdown 设计上会补全未终止
  // token。两个端点（/api/ai/chat + AG-UI 镜像）共用此 streamText，一致生效。
  // Prompt caching for Claude on the anthropic protocol (the relay does not add breakpoints on its
  // own): one breakpoint after the config-derived system head, plus request-level automatic
  // caching so the conversation history is reused across tool steps and turns. Other models behind
  // an anthropic-compatible endpoint may reject the request-level field, so they are left alone.
  const anthropicCaching =
    resolvedModel.protocol === 'anthropic' && /claude/i.test(resolvedModel.modelId)
  const systemForModel =
    anthropicCaching &&
    system !== undefined &&
    systemCacheablePrefix &&
    system.startsWith(systemCacheablePrefix)
      ? [
          {
            role: 'system' as const,
            content: systemCacheablePrefix,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' as const } } }
          },
          ...(system.length > systemCacheablePrefix.length
            ? [
                {
                  role: 'system' as const,
                  content: system.slice(systemCacheablePrefix.length).replace(/^\n\n/, '')
                }
              ]
            : [])
        ]
      : system
  const providerOptions = anthropicCaching
    ? {
        ...thinkingProviderOpts,
        anthropic: { ...thinkingProviderOpts?.anthropic, cacheControl: { type: 'ephemeral' } }
      }
    : thinkingProviderOpts
  const result = streamText({
    model: resolvedModel.model,
    system: systemForModel,
    messages: modelMessages,
    abortSignal,
    maxOutputTokens,
    // OpenCode Go 要求每段对话带稳定的 x-opencode-session（shared/lib/opencodeSession.ts）。
    ...(resolvedModel.opencodeSession
      ? { headers: { [OPENCODE_SESSION_HEADER]: opencodeSessionId(sessionId) } }
      : {}),
    experimental_transform: adaptiveSmoothStream({
      chunking: STREAM_CHUNKING_REGEX,
      baseDelayMs: STREAM_CHUNKING_DELAY_MS
    }),
    ...(providerOptions ? { providerOptions } : {}),
    // WP-16a — google 协议的 effort 走 ai@7 统一 reasoning 参数（SDK 按模型代分流 thinkingLevel/
    // thinkingBudget）；其余协议恒 undefined → 展开为空，字节级不变。
    ...(effortCall?.reasoning ? { reasoning: effortCall.reasoning } : {}),
    ...(hasTools
      ? {
          tools,
          ...(lazyPartition
            ? {
                activeTools: Array.from(lazyPartition.activatedTools),
                prepareStep: async () => ({
                  activeTools: Array.from(lazyPartition.activatedTools)
                })
              }
            : {}),
          // suggest_followups 不是停止信号：模型先调它、再写最终回答。Opus 5.5 / Sonnet 5.5 把
          // 「工具调用之前」的长文本改成进度型 thinking 块返回（默认不带文字），回答若写在这次
          // 调用之前就会整段消失；回答必须落在最后一次工具调用之后才是普通 text 块。
          stopWhen: stepCountIs(cfg.internalMaxSteps ?? INTERNAL_TOOL_STEP_SENTINEL)
        }
      : {})
  }) as StreamTextResult<ToolSet, never, never>

  return {
    ok: true,
    run: {
      result,
      rawMessages,
      sessionId,
      modelId,
      protocol: resolvedModel.protocol,
      contextWindow: resolvedModel.contextWindow ?? null,
      auditEntries,
      toolNames: hasTools ? Object.keys(tools as ToolSet) : [],
      originalBody: body,
      contextMode,
      groupSpeakerRun: isGroupSpeakerRun,
      ...(lazyPartition ? { lazyPartition } : {})
    }
  }
}

// ── Phase 10b — configurable LLM auto-title ────────────────────────────────────────────────────────

/** Clamp a model-generated title: strip wrapping quotes / a leading "Title:" label, collapse internal
 *  whitespace to single spaces, drop a trailing period, and cap the length. Empty after cleaning →
 *  null (the caller then leaves the session untitled so the first-message preview keeps showing). */
export function sanitizeSessionTitle(raw: string): string | null {
  let t = raw.trim()
  // strip surrounding quotes (ASCII + CJK) the model sometimes wraps the title in
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '')
  // a model may prefix "Title:" / "标题：" — drop a short leading label
  t = t.replace(/^\s*(title|标题)\s*[:：]\s*/i, '')
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/[.。]+$/, '').trim()
  if (t.length === 0) return null
  return t.length > 60 ? t.slice(0, 60).trim() : t
}

/** The auto-title prompt: a SHORT topic title in the user's own language, no quotes, no end label. The
 *  first user message is clipped (a title needs only the gist, not a 12k-char body). */
export function buildTitlePrompt(firstUserText: string): string {
  const clipped = firstUserText.length > 1000 ? firstUserText.slice(0, 1000) : firstUserText
  return [
    'Generate a SHORT title (at most 6 words) summarizing the topic of the user message below.',
    'Reply with ONLY the title text — no surrounding quotes, no trailing punctuation, no prefix label.',
    'Write the title in the SAME language as the user message.',
    '',
    'User message:',
    '<<<',
    clipped,
    '>>>'
  ].join('\n')
}

/** Generate a session title from its first user message via the configured model factory. Non-streaming
 *  generateText; returns the cleaned title or null (empty / clean-to-empty). Output is a handful of
 *  tokens (a title), so maxOutputTokens is small — deliberately NOT the chat ceiling. Throws on an
 *  upstream error (the caller maps it to 502); the title is best-effort UX, never blocks the chat. */
export async function generateSessionTitle(
  cfg: AiGatewayConfig,
  firstUserText: string,
  modelId: string,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const factory = resolveModelFactory(cfg)
  const resolvedModel = await factory(modelId)
  const t0 = Date.now()
  try {
    const { text, usage } = await generateText({
      model: resolvedModel.model,
      prompt: buildTitlePrompt(firstUserText),
      maxOutputTokens: 64,
      abortSignal
    })
    const extracted = extractSdkUsage(usage)
    cfg.recordUsageEvent?.({
      surface: 'auto_title',
      model: modelId,
      protocol: resolvedModel.protocol,
      ...extracted,
      latencyMs: Date.now() - t0,
      status: 'ok'
    })
    return sanitizeSessionTitle(text)
  } catch (err) {
    cfg.recordUsageEvent?.({
      surface: 'auto_title',
      model: modelId,
      protocol: resolvedModel.protocol,
      latencyMs: Date.now() - t0,
      status: 'error',
      errorCode: err instanceof Error ? err.name : 'E_UPSTREAM'
    })
    throw err
  }
}

// (W6 — the dogfood-3 out-of-turn follow-up generation trio [parseFollowups / buildFollowupsPrompt /
// generateFollowups] was removed with POST /api/ai/followups: follow-ups are now an IN-TURN
// suggest_followups tool call — see tools/followups.ts + shared/assistant/followups.ts.)
