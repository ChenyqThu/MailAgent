// chat-panel P4 Phase 06 (context injection) — AI SDK Gateway system-prompt assembly.
//
// The gateway's streamText `system` is built here via buildStableSystemPrompt — the stable-prefix
// assembly that the legacy custom-api backend and the gateway used to SHARE (one standing-context
// source, no second "stove"). S3 deleted the legacy engine and moved the assembly verbatim into
// ./prompts/stable_prompt.ts; the gateway is now its only consumer. The standing-context data
// (SOUL/AGENT/RULES/USER assembled backend-side, the user-context page, the memory summary, the
// KOS-configured flag) arrives via GatewaySystemPromptConfig, which the Electron wrapper fetches
// from the serve-api /chat/config endpoint. The AI-SDK-specific part is the typed
// AgentContextSnapshot block (buildContextSystemBlock) appended after the stable prefix — the open
// email travels in the untrusted-fenced context block (§5/§7), not a legacy EmailContext section.
//
// 🔴 Pure-ish: imports only pure shared modules (prompt assembly + the context
//    serializer). No node:http / electron / ai. Unit-testable in plain Node.
// 🔴 PRODUCT_SAFETY_FLOOR cannot be weakened here: buildStableSystemPrompt prepends it FIRST and it
//    is code-owned (prompts/safety_floor.ts), never sourced from standingContext — a parity test
//    asserts the floor bytes are always present, even when standingContext is set.

import {
  buildStableSystemPrompt,
  type ChatModelConfig,
  type ConnectorCatalogEntry,
  type SkillCatalogEntry
} from './prompts/stable_prompt'
import { buildContextSystemBlock } from '@shared/assistant/context/contextSerializer'
import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'
// g1 — 零依赖叶子；沉默契约那一句与调度器的 isSilence 判定共用同一个哨兵字面量。
import { SILENCE_SENTINEL } from './groupFloors'

/** The /chat/config projection the gateway needs to assemble the stable system prefix — the SAME
 *  fields the legacy HttpPlatformConfig carries (standing context + user context + memory + KOS
 *  gate). The Electron wrapper fetches these from serve-api /chat/config (TTL-cached). All optional:
 *  a field absent / empty → that section is skipped (graceful degrade to context-light). */
export interface GatewaySystemPromptConfig {
  /** SOUL+AGENT+RULES+USER assembled backend-side. null/"" → fall back to legacy SOUL_MARKDOWN. */
  standingContext?: string | null
  /** user profile / Sender Priority / focus projects page. null/"" → not injected. */
  userContext?: string | null
  /** durable user-scope memory summary (P2 memory kernel). null/"" → not injected. */
  memorySummary?: string | null
  /** KOS configured (enabled AND credentialed) → inject the KOS usage guidance block. */
  kosConfigured?: boolean
  /** M4a — advertised (enabled(override ?? default) && available) skill names from /chat/config,
   *  used by the gateway's skill→tool gating (buildTools), NOT by the prompt assembly here. Carried
   *  on this cached projection only because it shares the same /chat/config fetch + TTL cache as the
   *  prompt fields. null/undefined → unknown → gating fails open (no filtering). */
  advertisedSkills?: string[] | null
  /** Code-owned enabled skill guidance from /chat/config. This deliberately excludes installed
   *  third-party prompt fragments; W6 currently contributes only the Custom Agent builder flow. */
  trustedSkillFragments?: string | null
  /** 阶段 0.5「技能可发现性」— every skill's name + one line + state (disabled ones INCLUDED), from
   *  /chat/config.skillCatalog. The Electron wrapper only fills this when the main-env flag
   *  MAILAGENT_SKILL_CATALOG_PROMPT is on, so the default (off) leaves it null and the prompt stays
   *  byte-identical. Skill DESCRIPTIONS can be third-party text — stable_prompt sanitizes them. */
  skillCatalog?: SkillCatalogEntry[] | null
  /** D1 (connector dogfood batch) — the MCP connector catalog (one summary row per connector),
   *  projected by the Electron wrapper from its connector-manifest TTL cache ONLY when
   *  MAILAGENT_MCP_CONNECTORS is on AND the cache holds admitted tools (cold cache / flag off →
   *  field absent → prompt byte-identical). prepareChatRun scopes it per run
   *  (connectorCatalogForRun) BEFORE it reaches buildGatewaySystemPrompt: manual keeps the full
   *  list, a headless run keeps only its granted connectors, every other shape drops it. */
  connectorCatalog?: ConnectorCatalogEntry[] | null
}

/** Code-owned repeated-failure discipline, injected into EVERY run (manual and headless alike).
 *
 *  🔴 Why every run (08-02 review F4, owner 拍板): the epic shipped this headless-only on the premise
 *  that "manual chat has a human in the loop". `MAILAGENT_CHAT_DETACHED_RUNS` (default ON) broke that
 *  premise — closing the panel no longer aborts the run, so a manual turn can keep looping unattended.
 *  And manual chat shares the same `stepCountIs(10000)` sentinel with no wall-clock budget of its own,
 *  so a tool that keeps failing the same way is bounded by nothing but the model's own judgement.
 *  That judgement is exactly what this section supplies.
 *
 *  Intentionally not a configurable string: no request / spec / installed-skill content can enter
 *  this trusted section. */
export const TOOL_FAILURE_DISCIPLINE = [
  '# Tool failure discipline',
  'If the same tool operation fails in the same way 2-3 times, stop repeating it. Change approach,',
  'use a different available tool, or report the task as incomplete with the observed reason and',
  'evidence. Never claim success after repeated identical failures.'
].join('\n')

/** The extra clause a headless run needs: there is nobody to ask, so "stop and clarify" is not an
 *  available move — it must decide or report. A manual turn CAN just ask, hence this stays split. */
export const HEADLESS_UNATTENDED_CLAUSE =
  'Nobody is watching this run, so asking a clarifying question is not an available move: pick the ' +
  'best-supported interpretation and say which one you picked, or stop and report what blocked you.'

/** The full trusted runtime discipline for a given run shape. */
export function executionDisciplineFor(headlessAgentRun: boolean): string {
  return headlessAgentRun
    ? `${TOOL_FAILURE_DISCIPLINE}\n${HEADLESS_UNATTENDED_CLAUSE}`
    : TOOL_FAILURE_DISCIPLINE
}

/** @deprecated Kept as the pre-F4 name so external references keep resolving; prefer
 *  `executionDisciplineFor(true)`. */
export const HEADLESS_AGENT_EXECUTION_DISCIPLINE = executionDisciplineFor(true)

/** chat UI 优化 W6 — follow-up suggestion guidance, injected ONLY when the run's ToolSet actually
 *  holds the suggest_followups tool (manual chat; prepareChatRun computes the predicate from the
 *  BUILT tools, so prompt and tool surface can never drift). Code-owned constant — placed after
 *  the execution discipline, BEFORE the date block, so the cacheable-prefix convention holds.
 *
 *  🔴 0805 — the "once" here is scoped to ONE REPLY and must stay that way. Unscoped ("call it
 *  exactly once") the model read it as once per CONVERSATION — the previous turn's own
 *  suggest_followups tool part is in its history — and stopped suggesting after turn 1 (owner
 *  dogfood, reproduced 2/2). The tool's own description (tools/followups.ts) carries the SAME
 *  rule; the two surfaces are read together by the model, so they must never state different
 *  scopes. followup_tool.test.ts pins the property (per-reply scope + chip-turn carve-out) on
 *  both surfaces without pinning the sentences. */
export const FOLLOWUP_SUGGESTIONS_GUIDANCE = [
  '# Follow-up suggestions',
  'Call the suggest_followups tool once per reply — the obligation is per reply, never per',
  'conversation. When your answer is fully complete (never mid-task, never while a tool approval',
  'is pending), call it with 2-3 short follow-up questions the user is likely to ask next.',
  'Having already called it on an earlier turn does NOT excuse this reply, and neither does the',
  'user having started this turn by tapping one of your earlier suggestions — an adopted',
  'suggestion is a new question, not a closed loop.',
  'Phrase each as the USER would ask it (first person), in the same language the user is writing',
  'in. The suggestions render as tappable chips — do not repeat them in your reply text, and do',
  'not write anything after the call.'
].join('\n')

/** Add the code-owned discipline to the legacy body.system path used by pure harnesses. */
export function appendExecutionDiscipline(
  system: string | undefined,
  headlessAgentRun: boolean
): string {
  return [system ?? '', executionDisciplineFor(headlessAgentRun)]
    .filter((segment) => segment.length > 0)
    .join('\n\n')
}

/** Build the streamText `system` string for an AI SDK gateway run. Always returns a non-empty
 *  string: the stable prefix is never empty (it falls back to SOUL_MARKDOWN when nothing is
 *  configured), and the typed context block (with untrusted fences) is appended when a snapshot
 *  carries usable context. Only backend-selected, code-owned skill fragments are injected; generic
 *  installed-skill fragments remain excluded from the gateway prompt. */
export function buildGatewaySystemPrompt(args: {
  promptConfig: GatewaySystemPromptConfig | null
  contextSnapshot: AgentContextSnapshot | null
  /** Trusted runtime provenance, set only by prepareChatRun for a server-derived headless agent. */
  headlessAgentRun?: boolean
  headlessAgentIdentity?: {
    agentId: string
    agentTitle: string
    jobId: number
    sessionId: number
  }
  /** P4b — the TEAM identity of an owner-present session opened AS an agent (origin='team').
   *  Server-resolved (cfg.resolveSessionAgent, never from the body). Renders the
   *  <current_team_agent> block below — the 形态 α identity block: name + duty REFERENCE +
   *  coarse schedule line. Mutually exclusive with headlessAgentIdentity by construction
   *  (headless runs are never team sessions); ignored when headlessAgentRun is true. */
  sessionAgentIdentity?: {
    agentId: string
    agentTitle: string
    duty?: string | null
    scheduleLine?: string | null
    /** v30（群聊）— present ONLY on a group-chat speaker run (handleGroupChat). Renders the
     *  <current_group_chat> block INSTEAD of <current_team_agent> (a speaking turn needs the
     *  multi-party framing — member roster + 不冒充他人 — not the 1:1 team framing). */
    group?: {
      members: Array<{ agentId: string; title: string }>
      topic?: string | null
    } | null
  } | null
  /** W6 — true iff THIS run's built ToolSet holds suggest_followups (manual chat). Injects the
   *  follow-up guidance block; absent/false → byte-identical prompt (headless / harness / tests). */
  followupToolAvailable?: boolean
  /** g1 (父设计拍板 D) — a group speaker turn (调度器-driven, and since T4 M7 the v30
   *  renderer-driven one too). True skips the four sections a zero-tool speaking turn cannot act
   *  on (skill fragments / skill catalog / connector catalog / memory.md) and adds the 沉默契约
   *  sentence to the group block. Absent/false on every other path (main agent / headless /
   *  team) → byte-identical. */
  groupSpeakerRun?: boolean
}): string {
  const pc = args.promptConfig
  const groupSpeakerRun = args.groupSpeakerRun === true
  const cfg: ChatModelConfig = {
    defaultModel: '', // unused by buildStableSystemPrompt
    kosConsumerEnabled: false,
    kosConfigured: pc?.kosConfigured ?? false,
    kosL1HotBlockEnabled: false, // the gateway does no L1 sender-digest prefetch
    userContext: pc?.userContext && pc.userContext.length > 0 ? pc.userContext : null,
    memorySummary:
      !groupSpeakerRun && pc?.memorySummary && pc.memorySummary.length > 0
        ? pc.memorySummary
        : null,
    // 🔴 manual chat only (08-02 review F8). The only fragment shipped today is the Custom Agent
    // builder workflow, and its six CRUD tools are capability_change — structurally absent from a
    // headless run's ToolSet (isToolClassAllowedInMode). Injecting it there taught an unattended
    // agent a procedure it cannot perform, and burned cacheable prefix on every scheduled run.
    skillFragments:
      !args.headlessAgentRun &&
      !groupSpeakerRun &&
      pc?.trustedSkillFragments &&
      pc.trustedSkillFragments.length > 0
        ? pc.trustedSkillFragments
        : null,
    // 阶段 0.5 — 🔴 manual chat only, deliberately following the SAME conservative line as the
    // fragments above (0.5 编排裁决 R3): a headless custom-agent run gets a server-pinned tool set,
    // cannot ask the user to enable anything, and cannot self-mount — a catalog of skills it may
    // not have would be prompt weight it can act on in exactly zero ways. Whether headless should
    // ever see it is a separate owner call; F8's judgement is untouched here.
    skillCatalog:
      !args.headlessAgentRun && !groupSpeakerRun && pc?.skillCatalog && pc.skillCatalog.length > 0
        ? pc.skillCatalog
        : null,
    // D1 — 🔴 deliberately NOT the skillCatalog manual-only gate: a granted headless run really
    // holds connector tools (grant_connectors), so hiding the catalog there would recreate the
    // dogfood blind spot for scheduled agents. The run-scoping already happened in prepareChatRun
    // (scopeConnectorCatalogForRun → connectorCatalogForRun): what arrives here IS the run's set.
    // g1 — a group speaker turn holds zero tools of any kind, so its catalog is always empty.
    connectorCatalog:
      !groupSpeakerRun && pc?.connectorCatalog && pc.connectorCatalog.length > 0
        ? pc.connectorCatalog
        : null,
    standingContext:
      pc?.standingContext && pc.standingContext.length > 0 ? pc.standingContext : null
  }
  // ctx=null + no-op digest → the EXACT legacy stable prefix (floor + standing/SOUL + user + memory.md
  // + KOS guidance), byte-identical to the custom-api path's cacheable prefix. 07-01 — the bounded
  // memory.md rides IN the cacheable prefix via cfg.memorySummary (buildStableSystemPrompt renders it
  // as an untrusted MEMORY fence, frozen per session for prefix-cache stability); "" → no fence →
  // byte-identical flag-off. This replaces the retired M2 per-query recall block.
  const stable = buildStableSystemPrompt(null, cfg, () => null)
  const contextBlock = args.contextSnapshot ? buildContextSystemBlock(args.contextSnapshot) : ''
  // 08-02 F4 — 恒注入（manual + headless），只有「无人值守」那一句按 run 形态分。它与上面的
  // skillFragments 方向**相反**（那条 manual-only），所以两者不能再共用一个三元条件。
  const executionDiscipline = executionDisciplineFor(args.headlessAgentRun === true)
  const identity =
    args.headlessAgentRun === true && args.headlessAgentIdentity
      ? `<current_custom_agent>\n  <id>${escapeXml(args.headlessAgentIdentity.agentId)}</id>\n  <title>${escapeXml(args.headlessAgentIdentity.agentTitle)}</title>\n  <job_id>${args.headlessAgentIdentity.jobId}</job_id>\n  <session_id>${args.headlessAgentIdentity.sessionId}</session_id>\n</current_custom_agent>`
      : ''
  // P4b — team identity block (owner-present sessions opened AS an agent). Reuses the
  // <current_custom_agent> assembly convention above; the trailing sentence pins the 形态 α
  // semantics: the duty is a REFERENCE, not an instruction — without it a report agent's prompt
  // ("generate the daily report") would turn every greeting into a report run.
  // v30（群聊）— a group-chat SPEAKER run renders the multi-party block instead: same identity
  // fields, plus the roster + speaking discipline (own voice only, no impersonation, no
  // self-prefix — the [名字] labels in history are assembly artifacts, not a style to copy).
  const teamIdentity =
    args.headlessAgentRun !== true && args.sessionAgentIdentity
      ? args.sessionAgentIdentity.group
        ? buildGroupChatIdentityBlock({
            ...args.sessionAgentIdentity,
            group: args.sessionAgentIdentity.group,
            silenceContract: groupSpeakerRun
          })
        : buildTeamAgentIdentityBlock(args.sessionAgentIdentity)
      : ''
  // W6 — follow-up guidance only when the run's ToolSet holds the tool (manual chat). A constant
  // block per run shape, so the cacheable prefix stays stable across a manual session's turns.
  const followupGuidance = args.followupToolAvailable === true ? FOLLOWUP_SUGGESTIONS_GUIDANCE : ''
  // Order: stable (cacheable, incl. memory.md) → context (current view) → trusted runtime discipline
  // (always) → follow-up guidance (manual, constant) → current-date (always). Each segment is joined
  // only when non-empty; the date block is ALWAYS non-empty and remains LAST so the preceding prompt
  // stays a stable cache prefix and the date changes at most once per day.
  const dateBlock = buildCurrentDateBlock(args.contextSnapshot)
  return [
    stable,
    contextBlock,
    identity,
    teamIdentity,
    executionDiscipline,
    followupGuidance,
    dateBlock
  ]
    .filter((s) => s.length > 0)
    .join('\n\n')
}

/** P4b — render the <current_team_agent> identity block. Exported for tests. */
export function buildTeamAgentIdentityBlock(identity: {
  agentId: string
  agentTitle: string
  duty?: string | null
  scheduleLine?: string | null
}): string {
  const duty = identity.duty?.trim()
  const schedule = identity.scheduleLine?.trim()
  const lines = [
    '<current_team_agent>',
    `  <id>${escapeXml(identity.agentId)}</id>`,
    `  <title>${escapeXml(identity.agentTitle)}</title>`,
    ...(duty ? [`  <duty>${escapeXml(duty)}</duty>`] : []),
    ...(schedule ? [`  <schedule>${escapeXml(schedule)}</schedule>`] : []),
    '</current_team_agent>',
    `你正在以团队成员「${identity.agentTitle}」的身份与用户对话。` +
      (duty
        ? '<duty> 是它作为自动化成员的职责设定，仅作背景参考——本会话是用户主动发起的交互对话，除非用户明确要求，不要自行开始执行该任务。'
        : '本会话是用户主动发起的交互对话。')
  ]
  return lines.join('\n')
}

/** v30（群聊）— render the <current_group_chat> block for a group speaker run. Exported for
 *  tests. The trailing sentences pin the speaking discipline: own voice only, concise, never
 *  impersonate另一个成员, never emit a `[名字]` prefix (that labelling is how OTHER
 *  participants' turns are fed in — see groupChat.ts assembleGroupHistory).
 *  g1 — `silenceContract` (调度器 turns only) appends the one-sentence 沉默契约. */
export function buildGroupChatIdentityBlock(identity: {
  agentId: string
  agentTitle: string
  duty?: string | null
  /** `topic` = 群用途（group_config_json.topic）：有值 → <topic> 元素 + 尾句；缺省字节不变。 */
  group: { members: Array<{ agentId: string; title: string }>; topic?: string | null }
  silenceContract?: boolean
}): string {
  const duty = identity.duty?.trim()
  const topic = identity.group.topic?.trim()
  const memberTitles = identity.group.members.map((m) => m.title)
  const lines = [
    '<current_group_chat>',
    `  <self_id>${escapeXml(identity.agentId)}</self_id>`,
    `  <self_title>${escapeXml(identity.agentTitle)}</self_title>`,
    ...(duty ? [`  <duty>${escapeXml(duty)}</duty>`] : []),
    `  <members>${escapeXml(memberTitles.join('、'))}</members>`,
    ...(topic ? [`  <topic>${escapeXml(topic)}</topic>`] : []),
    '</current_group_chat>',
    `这是一个多人群聊，成员有：${memberTitles.join('、')}，以及用户本人。` +
      `你正在以成员「${identity.agentTitle}」的身份发言。历史消息里以「[名字]」开头的是` +
      '其他成员或用户的发言。请只以你自己的身份简洁发言，不要冒充或代替其他成员发言，' +
      '也不要在回复前加「[名字]」前缀。' +
      (duty
        ? '<duty> 是你的职责设定，仅作背景参考，除非用户明确要求，不要自行开始执行该任务。'
        : '') +
      (identity.silenceContract === true ? `若这轮无需你发言，只回复 ${SILENCE_SENTINEL}。` : '') +
      (topic ? `群用途：${topic}。` : '')
  ]
  return lines.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Build the always-present "current date" segment appended last to the gateway system prompt.
 *  Without this the model has no notion of "now" and defaults to its training cutoff (e.g. reads a
 *  2026 date as 2025) — breaking "latest developments"-style questions in the general agent.
 *
 *  🔴 DATE granularity only (no clock time): this is a prompt-cache-prefix suffix, so a minute/
 *     second stamp would invalidate the cache every turn. Formatted as
 *     「当前日期：2026-07-07（星期二），时区 Asia/Shanghai」.
 *
 *  Timezone: the user's UI timezone from the context snapshot when present (so "today" matches what
 *  the user sees), else the gateway process's resolved zone, else UTC. `tzCandidate` is passed to
 *  Intl.DateTimeFormat, which throws RangeError on a non-IANA string — that both validates the zone
 *  and defangs a crafted timezone value (garbage → skipped, never rendered into the prompt). `now`
 *  is injectable for deterministic tests; production always uses the current instant. */
export function buildCurrentDateBlock(
  snapshot?: AgentContextSnapshot | null,
  now: Date = new Date()
): string {
  const candidates: string[] = []
  const fromSnapshot = snapshot?.uiState?.timezone
  if (typeof fromSnapshot === 'string' && fromSnapshot.trim().length > 0) {
    candidates.push(fromSnapshot.trim())
  }
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (local && local.length > 0) candidates.push(local)
  } catch {
    /* resolvedOptions unavailable → fall through to UTC */
  }
  candidates.push('UTC')

  for (const timeZone of candidates) {
    try {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'long'
      }).formatToParts(now)
      const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
      const date = `${get('year')}-${get('month')}-${get('day')}`
      const weekday = get('weekday')
      return `当前日期：${date}（${weekday}），时区 ${timeZone}`
    } catch {
      /* invalid / unsupported timeZone (incl. a crafted snapshot value) → try the next candidate */
    }
  }
  // UTC above cannot realistically throw; this only guards a fully Intl-less runtime.
  return `当前日期：${now.toISOString().slice(0, 10)}，时区 UTC`
}
