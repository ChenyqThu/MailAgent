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
  type SkillCatalogEntry
} from './prompts/stable_prompt'
import { buildContextSystemBlock } from '@shared/assistant/context/contextSerializer'
import type { AgentContextSnapshot } from '@shared/assistant/context/contextSnapshot'

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
}): string {
  const pc = args.promptConfig
  const cfg: ChatModelConfig = {
    defaultModel: '', // unused by buildStableSystemPrompt
    kosConsumerEnabled: false,
    kosConfigured: pc?.kosConfigured ?? false,
    kosL1HotBlockEnabled: false, // the gateway does no L1 sender-digest prefetch
    userContext: pc?.userContext && pc.userContext.length > 0 ? pc.userContext : null,
    memorySummary: pc?.memorySummary && pc.memorySummary.length > 0 ? pc.memorySummary : null,
    // 🔴 manual chat only (08-02 review F8). The only fragment shipped today is the Custom Agent
    // builder workflow, and its six CRUD tools are capability_change — structurally absent from a
    // headless run's ToolSet (isToolClassAllowedInMode). Injecting it there taught an unattended
    // agent a procedure it cannot perform, and burned cacheable prefix on every scheduled run.
    skillFragments:
      !args.headlessAgentRun && pc?.trustedSkillFragments && pc.trustedSkillFragments.length > 0
        ? pc.trustedSkillFragments
        : null,
    // 阶段 0.5 — 🔴 manual chat only, deliberately following the SAME conservative line as the
    // fragments above (0.5 编排裁决 R3): a headless custom-agent run gets a server-pinned tool set,
    // cannot ask the user to enable anything, and cannot self-mount — a catalog of skills it may
    // not have would be prompt weight it can act on in exactly zero ways. Whether headless should
    // ever see it is a separate owner call; F8's judgement is untouched here.
    skillCatalog:
      !args.headlessAgentRun && pc?.skillCatalog && pc.skillCatalog.length > 0
        ? pc.skillCatalog
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
  // Order: stable (cacheable, incl. memory.md) → context (current view) → trusted runtime discipline
  // (always) → current-date (always). Each segment is joined only when non-empty; the date block is
  // ALWAYS non-empty and remains LAST so the preceding prompt stays a stable cache prefix and the
  // date changes at most once per day.
  const dateBlock = buildCurrentDateBlock(args.contextSnapshot)
  return [stable, contextBlock, executionDiscipline, dateBlock]
    .filter((s) => s.length > 0)
    .join('\n\n')
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
