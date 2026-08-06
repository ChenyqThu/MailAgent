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
  hasToolCall,
  smoothStream,
  stepCountIs,
  streamText,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type UIMessageStreamOnFinishCallback
} from 'ai'

import { anthropicBaseUrl, type AiGatewayConfig, type PersistTurnInput } from './config'
import { createAnthropic } from '@ai-sdk/anthropic'
// 🔴 MEDIUM-6 (batch1 review) — import from the SDK-free providerRef, NEVER from providers.ts
// (whose top level pulls six provider SDK packages; it only loads via the lifecycle's flag-on
// dynamic import). Pinned by tests/ai-gateway/provider_lazy_import.test.ts.
import {
  isProviderCredentialsError,
  parseProviderRef,
  type ResolvedProviderModel
} from './providerRef'
import type { GatewayApprovalMode, GatewayToolAuditEntry } from './tools/types'
// S2 W0 (ADR-001 D1) — the run's context mode is a TRUSTED prepareChatRun parameter asserted by
// each entrypoint in its own code. It is NEVER read from the request body (a client cannot claim
// manual_chat); absent/unknown fail-closes to 'untrusted_trigger'.
import {
  isRuntimeToolDestructive,
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
// Phase 06 (context injection) — system prompt assembly + snapshot schema guard.
import {
  appendExecutionDiscipline,
  buildGatewaySystemPrompt,
  type GatewaySystemPromptConfig
} from './systemPrompt'
// D1 (connector dogfood batch) — per-run scoping of the connector catalog reuses the connector
// module's ONE load seam + ceiling order (never a second filter implementation here); 0804 dogfood
// reuses the SAME seam to decide whether this run must warm the manifest before buildTools.
import { connectorCatalogForRun, shouldLoadConnectorTools } from './tools/connector'
import {
  isValidContextSnapshot,
  type AgentContextSnapshot
} from '@shared/assistant/context/contextSnapshot'

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
  connectorGrants: unknown
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
      connectorGrants
    )
  }
}

/** Pick the last user UIMessage of an incoming turn (the fresh message we persist alongside the
 *  assistant reply). */
export function lastUserMessage(messages: MailAgentUIMessage[]): MailAgentUIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i]
  }
  return null
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
  trustedContextMode?: AgentContextMode
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
  const modelId = typeof body.model === 'string' && body.model.length > 0 ? body.model : cfg.model
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
  if (contextMode === 'manual_chat' && cfg.resolveGlobalApprovalMode) {
    try {
      const globalMode = await cfg.resolveGlobalApprovalMode()
      if (globalMode === 'acceptEdits' || globalMode === 'bypass') approvalMode = globalMode
    } catch {
      /* fail-closed — keep the request-level ('manual') semantics */
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
  const auditEntries: GatewayToolAuditEntry[] = []
  const tools = cfg.buildTools?.(auditEntries, approvalMode, contextMode)
  const hasTools = tools != null && Object.keys(tools).length > 0
  // W6 — the run holds the suggest_followups tool (manual chat with a real gateway ToolSet). Drives
  // (a) the follow-up guidance block in the system prompt below and (b) the hasToolCall stop
  // condition at streamText — both keyed off the BUILT set, never off the mode alone.
  const followupToolAvailable = hasTools && SUGGEST_FOLLOWUPS_TOOL_NAME in (tools as ToolSet)

  // System prompt. With the injection provider set (always injected since S3) assemble
  // from standing-context + the typed snapshot, reusing the legacy stable prefix
  // (buildGatewaySystemPrompt). Without it (default) pass body.system through unchanged AND ignore the
  // contextSnapshot field entirely — Phase 02/05 behaviour, byte-identical (no validation, no 400).
  let system: string | undefined
  if (cfg.systemPromptProvider) {
    // Resolve the typed context snapshot ONLY on the injection path: a valid v1 snapshot is used; a
    // snapshot that CLAIMS to be typed (carries a `version`) but fails validation → 400 (no off-spec
    // blob into the prompt); an UNtyped passthrough blob (no version — the AG-UI mirror's open
    // context, handled by the AG-UI route's own redacting readContext) is ignored here. Absent → null.
    let contextSnapshot: AgentContextSnapshot | null = null
    if (body.contextSnapshot != null) {
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
    // The provider is contracted to return null (not throw) on a /chat/config blip → context-light.
    // D1 — the connector catalog it carries is manual-shape (zero-arg shared cache); scope it to
    // THIS run before assembly (headless: granted connectors only; seam-refused shapes: none).
    const promptConfig = scopeConnectorCatalogForRun(
      (await cfg.systemPromptProvider()) ?? null,
      contextMode,
      cfg.agentRunContext != null,
      cfg.agentRunContext?.modeGrants?.connectors
    )
    // 07-01 — the bounded memory.md rides IN promptConfig.memorySummary (the cacheable stable prefix,
    // rendered by buildStableSystemPrompt as an untrusted MEMORY fence). The M2 per-query recall path
    // (retrieveMemory callback → /chat/memory/search) is retired: memory.md is injected whenever
    // Python's /chat/config sends a non-empty memorySummary, so there is nothing to recall per turn.
    system = buildGatewaySystemPrompt({
      promptConfig,
      contextSnapshot,
      headlessAgentRun: isHeadlessAgentRun,
      // W6 — inject the follow-up guidance only when THIS run's ToolSet holds the tool.
      followupToolAvailable
    })
  } else {
    const bodySystem =
      typeof body.system === 'string' && body.system.length > 0 ? body.system : undefined
    // 🔴 legacy passthrough 路径（无 systemPromptProvider）：**只有 headless 追加纪律**，manual 保持
    // body.system 逐字节透传（Phase 02 契约 —— 这条路径的全部意义就是「system 完全由调用方给」，
    // 纯 harness / 老测试依赖它）。F4 让 manual 也拿到纪律，但生产 manual chat 自 S3 起恒有
    // injection provider、走上面的 buildGatewaySystemPrompt 分支，所以目标达成不需要动这条契约。
    system = isHeadlessAgentRun ? appendExecutionDiscipline(bodySystem, true) : bodySystem
  }

  // 🔴 ai@6 convertToModelMessages is ASYNC (returns a Promise) — must await, else
  // streamText.standardizePrompt receives a Promise and throws "messages.some is not a function".
  let modelMessages
  try {
    modelMessages = await convertToModelMessages(rawMessages)
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
  const result = streamText({
    model: resolvedModel.model,
    system,
    messages: modelMessages,
    abortSignal,
    maxOutputTokens,
    experimental_transform: smoothStream({
      chunking: STREAM_CHUNKING_REGEX,
      delayInMs: STREAM_CHUNKING_DELAY_MS
    }),
    ...(thinkingProviderOpts ? { providerOptions: thinkingProviderOpts } : {}),
    // WP-16a — google 协议的 effort 走 ai@7 统一 reasoning 参数（SDK 按模型代分流 thinkingLevel/
    // thinkingBudget）；其余协议恒 undefined → 展开为空，字节级不变。
    ...(effortCall?.reasoning ? { reasoning: effortCall.reasoning } : {}),
    ...(hasTools
      ? {
          tools,
          // W6 — when the manual-chat suggest_followups tool is registered, its call is the turn's
          // stop signal (调完即停 — the answer is complete, no trailing text after the chips).
          // Runs without the tool (headless / im / harness) keep the bare sentinel byte-identical;
          // hasToolCall can never fire for a tool the ToolSet does not hold.
          stopWhen: followupToolAvailable
            ? [
                stepCountIs(cfg.internalMaxSteps ?? INTERNAL_TOOL_STEP_SENTINEL),
                hasToolCall(SUGGEST_FOLLOWUPS_TOOL_NAME)
              ]
            : stepCountIs(cfg.internalMaxSteps ?? INTERNAL_TOOL_STEP_SENTINEL)
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
      auditEntries,
      toolNames: hasTools ? Object.keys(tools as ToolSet) : [],
      originalBody: body,
      contextMode
    }
  }
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
 *  JSON. Never throws; caps length. */
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
 * Part B / S6 W2 (PRD P8) — on a paused approval, stash the run for server-side resume, and (island
 * only) fire-and-forget announce it to the island.
 *
 * The STASH step gates on cfg.approvalStash PRESENCE alone: the lifecycle now injects the stash
 * whenever server-side resume is live (island OR custom agents), so a headless custom-agent pause is
 * claimable in-app via the record view's /decide even with the island off ("内部审批优先"). The
 * ANNOUNCE step stays island-only (cfg.announceApprovalToIsland is only wired when the island flag is
 * on → the `if (cfg.islandAgentEnabled)` guard + `?.` are belt-and-suspenders). Both flags off → the
 * lifecycle leaves cfg.approvalStash undefined → this returns early (byte-identical to pre-S6). The
 * announce is best-effort (never awaited, self-contained try/catch) so it can't block or break the
 * already-streamed paused turn.
 */
function maybeStashAndAnnounceApproval(
  cfg: AiGatewayConfig,
  run: PreparedChatRun,
  responseMessage: MailAgentUIMessage
): void {
  if (!cfg.approvalStash || !run.originalBody) return
  try {
    const info = extractApprovalStashInput(responseMessage)
    if (!info) return
    const resumeToken = cfg.approvalStash.stash({
      toolCallId: info.toolCallId,
      approvalId: info.approvalId,
      toolName: info.toolName,
      sessionId: run.sessionId,
      body: run.originalBody,
      responseMessage,
      // S2 W0 (ADR-001 D1) — freeze the pause-time trusted mode into the stash: the island resume
      // re-runs under EXACTLY this mode (approvalResume passes it back to prepareChatRun), so a
      // resume can never escalate. Hand-built runs without a mode fail-close to untrusted.
      contextMode: normalizeContextMode(run.contextMode),
      // S5 W4 (ADR-004 §4.4) — freeze the per-agent tool context from the pause-time server cfg
      // (wrapCfgForAgentRun set it on the headless cfg2; manual cfgs never carry it → undefined,
      // byte-identical stash). The resume rebuilds through the same wrapper, so the narrowed
      // ToolSet + grants survive the island round-trip; a re-pause re-enters here with the SAME
      // cfg → the chain re-freezes the same context every hop.
      agentRunContext: cfg.agentRunContext,
      // Stage 2 PR-4 (task 08-01 messenger) — freeze the connector tool's DESTRUCTIVE bit so an
      // out-of-app approval surface (the Feishu card) can render the same red warning the desktop
      // McpApprovalCard does. Read from the runtime registry that createConnectorTools populated
      // at build time, NEVER from info.input (a model must not be able to spoof it away).
      // Non-connector tools are absent from the registry → false → no warning, as before.
      destructive: isRuntimeToolDestructive(info.toolName)
    })
    // ANNOUNCE step (island-only, P8): only the island needs the pushed card + the resumeToken; the
    // in-app record view claims from the stash directly via /decide (no token leaves the gateway).
    // announceApprovalToIsland is undefined unless the island flag is on, so the explicit guard just
    // documents the split and skips the preview compute when the island is off.
    if (cfg.islandAgentEnabled) {
      cfg.announceApprovalToIsland?.({
        sessionId: run.sessionId,
        toolCallId: info.toolCallId,
        toolName: info.toolName,
        risk: '', // the lifecycle enriches risk from ApprovalGuard.peek (it owns the guard)
        inputPreview: approvalInputPreview(info.toolName, info.input),
        resumeToken
      })
    }
  } catch (err) {
    console.error('[ai-gateway] island approval stash/announce failed (turn paused OK)', err)
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

/**
 * Build the onFinish callback that persists a finished turn (ai_chat.db dual-write) — the SAME
 * persistence both endpoints use (the AG-UI mirror is a true mirror, including audit). Best-effort:
 * a write failure logs and never breaks the already-streamed reply. Aborted turns are not persisted.
 */
export function makePersistOnFinish(
  cfg: AiGatewayConfig,
  run: PreparedChatRun
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
    if (cfg.serverResumeEnabled || cfg.islandAgentEnabled) {
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
            cfg.persistPausedAssistant(run.sessionId, redacted, run.modelId, run.runId ?? null)
          }
        } catch (err) {
          console.error('[ai-gateway] persistPausedAssistant failed (pause still streamed OK)', err)
        }
      }
      // Part B (harness 上岛) — when island agent is on, a paused approval is ALSO stashed for
      // server-side (island-driven) resume + announced to the island. Runs AFTER the R2-3 redacted
      // persist above: both must happen on a pause (history shows what the model said; the island can
      // approve), each self-contained (its own try/catch) so one failing never blocks the other. The
      // island /decide resume re-enters persistence through the SAME makePersistOnFinish → persistTurn
      // upsert (same UIMessage id), so the redacted row is replaced, never duplicated. flag-off
      // (default) → both cfg hooks are undefined → this call is inert (byte-identical early return).
      maybeStashAndAnnounceApproval(cfg, run, responseMessage as MailAgentUIMessage)
      return
    }
    // Part B (harness 上岛, finding 2) — if the one-shot guard.consume rejected this turn's tool
    // (E_APPROVAL_USED audit), the OTHER surface already executed + persisted the authoritative turn →
    // skip this duplicate error persist (and capture). Only relevant for a COMPLETED turn: a re-paused
    // turn already returned above without persisting. 07-15 — gated by serverResumeEnabled (see the
    // tombstone gate above; one-shot consume is live whenever server-side resume is), islandAgentEnabled
    // kept as the legacy fallback gate.
    if ((cfg.serverResumeEnabled || cfg.islandAgentEnabled) && runHasApprovalUsedError(run)) return
    const usage = await Promise.resolve(run.result.usage).catch(() => undefined)
    // WP-15 (context 环) — 上下文占用另取**末 step** 的 inputTokens（`usage` 是多 step 求和，
    // 语义不同，见 lastStepContextTokens）。与 usage 同样 best-effort：拿不到 → null → 前端不渲染。
    const steps = await Promise.resolve(run.result.steps).catch(() => undefined)
    // harness-chat lane C (07-15, PRD §3) — finishReason==='length' fail-loud: append a visible
    // warning to what gets PERSISTED (see appendLengthTruncationWarning's doc comment for why this
    // can't reach the already-streamed wire). No-op for every other finish reason.
    const persistedResponseMessage = appendLengthTruncationWarning(
      responseMessage as MailAgentUIMessage,
      finishReason
    )
    const turn: PersistTurnInput = {
      sessionId: run.sessionId,
      model: run.modelId,
      userMessage: lastUserMessage(run.rawMessages),
      responseMessage: persistedResponseMessage,
      usage: usage
        ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
        : undefined,
      contextTokens: lastStepContextTokens(steps),
      toolCalls: run.auditEntries,
      // codex r2 [C] — per-run settle dedup: the broadcast carries this runId to the renderer.
      runId: run.runId ?? null
    }
    try {
      await cfg.persistTurn(turn)
    } catch (err) {
      // persistence is best-effort — a write failure must not break the streamed reply.
      console.error('[ai-gateway] persistTurn failed (turn streamed OK)', err)
    }
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
    if (!runHasSuccessfulMemoryWrite(run) && finishReason !== 'length') {
      try {
        cfg.captureTurnMemory?.(turn)
      } catch (err) {
        console.error('[ai-gateway] captureTurnMemory threw (turn streamed OK)', err)
      }
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
  const { text } = await generateText({
    model: resolvedModel.model,
    prompt: buildTitlePrompt(firstUserText),
    maxOutputTokens: 64,
    abortSignal
  })
  return sanitizeSessionTitle(text)
}

// (W6 — the dogfood-3 out-of-turn follow-up generation trio [parseFollowups / buildFollowupsPrompt /
// generateFollowups] was removed with POST /api/ai/followups: follow-ups are now an IN-TURN
// suggest_followups tool call — see tools/followups.ts + shared/assistant/followups.ts.)
