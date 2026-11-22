// Extracted from ai_gateway_lifecycle.ts — short-TTL config/settings resolvers & standing prompt cache.

import { existsSync, readFileSync } from 'fs'

import { request } from '@shared/api/http_client'
import type { AssistantIdentity, ReportAgentConfig } from '@shared/api/types'
import type { LabsFlags } from '../../../ai-gateway/config'
import type { SkillCatalogEntry } from '../../../ai-gateway/prompts/stable_prompt'
import type { MailAgentDomainClient } from '../../../ai-gateway/python/domainClient'
import type { GatewaySystemPromptConfig } from '../../../ai-gateway/systemPrompt'
import { parseMatterRunWebFace, type MatterRunWebFace } from '../../../ai-gateway/tools/policy'
import type { GatewayToolApprovalPrefs, GlobalApprovalMode } from '../../../ai-gateway/tools/types'
import { parseEnv, toRecord } from '../lib/env-parser'
import { resolveEnvPath } from '../lib/env-path'

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

/** task 09-02 — the IMAGE_GEN_MODEL providerRef as currently in the managed .env, or null when
 *  unset / unreadable. Read per tool assembly (one small file parse per chat turn) so a Settings
 *  change takes effect on the next message without a restart — the same hot-read posture as the
 *  serve-api's dotenv_values keys, and why the EnvField is `hotReload`. Never throws. */
export function readImageGenModelRef(): string | null {
  try {
    const path = resolveEnvPath()
    if (!existsSync(path)) return null
    const value = toRecord(parseEnv(readFileSync(path, 'utf8')))['IMAGE_GEN_MODEL']?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

/** P4b — coarse「它什么时候会自己动」line for the team-identity prompt block. MODE naming only:
 *  schedule SEMANTICS stay single-sourced (schedule-rule-contract.md) — this never expands
 *  occurrences or re-derives next-fire times, it just names which trigger family the agent has.
 *  Returns null when nothing coarse can be said (unknown type / unparseable trigger). */
export function describeAgentSchedule(agent: ReportAgentConfig): string | null {
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

// Phase 06 (context injection) — TTL-cached /chat/config projection for the gateway system prompt.
// Fetched from the SAME serve-api endpoint the legacy runtime uses (request() handles the envelope
// unwrap); a busy session reuses the cache so we don't refetch per turn. A fetch failure → null so
// the gateway degrades to context-light (SOUL fallback) rather than breaking the turn — this
// provider is CONTRACTED to never throw (chatRun trusts it returns null on failure).
const CONTEXT_CONFIG_TTL_MS = 15_000

let _systemPromptCache: { at: number; value: GatewaySystemPromptConfig | null } | null = null

export async function getSystemPromptConfig(
  apiBase: string,
  localToken: string | null,
  readSkillCatalogFlag: () => boolean
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
      skillCatalog: readSkillCatalogFlag() ? (cfg.skillCatalog ?? null) : null
    }
  } catch (err) {
    console.warn('[ai-gateway] /chat/config fetch failed — context-light system prompt', err)
    value = null
  }
  _systemPromptCache = { at: now, value }
  return value
}

export function peekAdvertisedSkills(): string[] | null {
  return _systemPromptCache?.value?.advertisedSkills ?? null
}

export interface GatewayTtlResolvers {
  resolveGlobalApprovalMode: () => Promise<GlobalApprovalMode>
  resolveLabsFlags: () => Promise<LabsFlags>
  resolveAssistantIdentity: () => Promise<AssistantIdentity | null>
  groupMemberReads: {
    reportAgent: (agentId: string) => Promise<ReportAgentConfig | null>
    assistantIdentity: () => Promise<AssistantIdentity | null>
    matterAgentDefaults: () => Promise<{ model?: string } | null>
  }
  resolveAutoCompactEnabled: () => Promise<boolean>
  resolveMatterRunWebFace: () => Promise<MatterRunWebFace>
  resolveToolApprovalPrefs: () => Promise<GatewayToolApprovalPrefs | null>
  fetchApprovalPreview: (info: { toolName: string; input: unknown }) => Promise<string | null>
}

export function createGatewayTtlResolvers(domain: MailAgentDomainClient): GatewayTtlResolvers {
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
    assistantIdentity: resolveAssistantIdentity,
    matterAgentDefaults: () => domain.getMatterAgentDefaults()
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

  return {
    resolveGlobalApprovalMode,
    resolveLabsFlags,
    resolveAssistantIdentity,
    groupMemberReads,
    resolveAutoCompactEnabled,
    resolveMatterRunWebFace,
    resolveToolApprovalPrefs,
    fetchApprovalPreview
  }
}
