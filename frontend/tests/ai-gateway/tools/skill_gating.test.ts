// mem0/skill 核心重构 epic M4a — skill→tool 门控 + buildGatewayTools 接线 + 漂移守护。
//
// 证：(1) applySkillGating 复刻 legacy advertised-owner-wins 语义（关 skill 删其读工具，
// collision-exempt + core 永留）；(2) flag-off / advertisedSkills null → ToolSet 字节级同 cutover；
// (3) 双向完整性漂移守护 —— 每个 gateway 工具必被归类（防「新读工具漏门控」复发 bug，review M2）。

import { describe, expect, test } from 'vitest'

import { buildGatewayTools, GATEWAY_DEFAULT_TOOL_NAMES } from '../../../src/ai-gateway/tools'
import {
  applySkillGating,
  GATEWAY_SKILL_TOOLS,
  COLLISION_EXEMPT_GATEWAY_TOOLS,
  CORE_UNGATED_GATEWAY_TOOLS
} from '../../../src/ai-gateway/tools/skill_gating'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

/** Build the FULL gateway tool set (all flags on) — the drift guard's source of
 *  truth for "every real gateway tool".
 *  🔴 维护：加新 tool-gating flag 时必须在此把它开齐，否则下方 FORWARD 完整性守护（every gateway
 *  tool ∈ 已分类）看不到该 flag 门控的工具 → 漏归类不会变红（review L2）。 */
const CONDITIONAL_HEADLESS_CORE_TOOLS = new Set(['agent_catalog_list', 'agent_catalog_get'])

function buildAllTools() {
  const manual = buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard(),
    sendToolEnabled: true,
    sendSigningSecret: 'secret',
    // M4b/M4c — also build the self-mount tools (update_system_md / discover_skills /
    // set_skill_enabled) so the FORWARD completeness guard sees them. advertisedSkills left unset
    // → applySkillGating not called → the full unfiltered set.
    skillGatingEnabled: true,
    // S1 R1 — chat-session read tools (MAILAGENT_OPENNESS_SESSION_TOOLS) so both drift-guard
    // directions see them (they are classified CORE_UNGATED).
    sessionToolsEnabled: true,
    // S1 R2 — profile-config tools (MAILAGENT_OPENNESS_CONFIG_TOOLS), same rationale.
    configToolsEnabled: true,
    // S1 R3 — web tools (MAILAGENT_OPENNESS_WEB_TOOLS), same rationale (classified CORE_UNGATED).
    webToolsEnabled: true,
    // S2 W1 — exec tools (MAILAGENT_OPENNESS_EXEC_TOOLS), same rationale (classified CORE_UNGATED).
    execToolsEnabled: true,
    // S2 W4 — skill-supply tools (MAILAGENT_OPENNESS_SKILL_INSTALL), same rationale (CORE_UNGATED).
    skillInstallToolsEnabled: true,
    // S5 W3 — custom-agent CRUD tools (MAILAGENT_CUSTOM_AGENTS_ENABLED), same rationale (CORE_UNGATED).
    customAgentToolsEnabled: true,
    // P8 R1 — Skill Creator draft tools (MAILAGENT_SKILL_CREATOR), manual-only CORE_UNGATED.
    skillCreatorToolsEnabled: true,
    customAgentCallEnabled: true,
    parentSessionId: 1,
    findSessionByParentToolCall: () => null,
    createAgentCallSession: () => 2,
    setAgentSessionJobId: () => undefined,
    // calendar epic 4.1/4.2 — calendar tools (MAILAGENT_CALENDAR_AGENT_TOOLS), same rationale
    // (classified CORE_UNGATED).
    calendarToolsEnabled: true,
    // task 07-21 — notion-agent tool (MAILAGENT_NOTION_AGENT_TOOL). Unlike the others this one IS
    // skill-gated (GATEWAY_SKILL_TOOLS notion_agent), so the FORWARD/REVERSE drift guards need it
    // built here to see it classified.
    notionAgentToolsEnabled: true,
    // S2 W0 — the drift guard reasons over the MANUAL-session universe (fail-closed default is
    // 'untrusted_trigger', which strips capability_change/outbound and would blind the guard).
    contextMode: 'manual_chat'
  })
  const grantedHeadless = buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    sessionProvenanceEnabled: true,
    contextMode: 'cron_headless',
    agentRunContext: {
      agentId: 'dms',
      allowedTools: ['chat_session_list'],
      skills: []
    }
  })
  return { ...manual, ...grantedHeadless }
}

describe('applySkillGating (pure semantics)', () => {
  test('disabling email drops ALL its read tools (incl email_list_filter); core stay', () => {
    const tools = buildAllTools()
    const advertised = ['search', 'report', 'kos', 'calendar', 'notion_agent'] // email NOT advertised
    const gated = applySkillGating(tools, advertised)
    // PR-D: email_list_filter (former collision-exempt email_search) now gates with the email family.
    for (const n of ['email_list_filter', 'email_get', 'email_body', 'email_list_thread']) {
      expect(gated[n]).toBeUndefined()
    }
    for (const n of [
      'email_search_fulltext',
      'email_search_attachments',
      'report_list',
      'report_get'
    ]) {
      expect(gated[n]).toBeDefined() // search/report still advertised
    }
    for (const n of CORE_UNGATED_GATEWAY_TOOLS) expect(gated[n]).toBeDefined() // core never gated
  })

  test('advertisedSkills=[] gates every mapped skill tool; core survive', () => {
    const gated = applySkillGating(buildAllTools(), [])
    for (const names of Object.values(GATEWAY_SKILL_TOOLS)) {
      for (const n of names) expect(gated[n]).toBeUndefined()
    }
    for (const n of CORE_UNGATED_GATEWAY_TOOLS) expect(gated[n]).toBeDefined()
  })

  test('all mapped skills advertised → no drops (identity, same keys + order)', () => {
    const tools = buildAllTools()
    // task 07-21 — notion_agent is now a mapped skill too; advertise every GATEWAY_SKILL_TOOLS key.
    const gated = applySkillGating(tools, Object.keys(GATEWAY_SKILL_TOOLS))
    expect(Object.keys(gated)).toEqual(Object.keys(tools))
  })
})

// PR-D (search-batch2 D6) — email_search → email_list_filter rename retired the last collision-exempt
// tool. email_list_filter now gates with the email skill family like its sibling reads (deliberate
// behaviour change: pre-rename email_search was the collision-exempt floor, NEVER gated). Dedicated pins
// so the flip is self-documenting.
describe('email_list_filter skill gating (PR-D — collision-exempt特例退役)', () => {
  test('email skill OFF → email_list_filter dropped (no longer collision-exempt)', () => {
    const gated = applySkillGating(buildAllTools(), [
      'search',
      'report',
      'kos',
      'calendar',
      'notion_agent'
    ]) // email NOT advertised
    expect(gated.email_list_filter).toBeUndefined()
  })

  test('email skill ON → email_list_filter present (gates with the email family)', () => {
    const gated = applySkillGating(buildAllTools(), ['email'])
    expect(gated.email_list_filter).toBeDefined()
  })

  test('collision-exempt set is now empty (mechanism retained for future name collisions)', () => {
    expect(COLLISION_EXEMPT_GATEWAY_TOOLS.size).toBe(0)
  })
})

describe('drift guard (review M2 — completeness, both directions)', () => {
  // FORWARD: every REAL gateway tool must be classified into exactly one bucket. A NEW gateway read
  // tool added without classifying it → not in any set → would never be gated = the very bug M4a
  // fixes, recurring (and a subset-only check would stay green). This catches it.
  test('every gateway tool ∈ skill ∪ collision-exempt ∪ core', () => {
    const classified = new Set<string>([
      ...Object.values(GATEWAY_SKILL_TOOLS).flat(),
      ...COLLISION_EXEMPT_GATEWAY_TOOLS,
      ...CORE_UNGATED_GATEWAY_TOOLS
    ])
    const unclassified = Object.keys(buildAllTools()).filter((n) => !classified.has(n))
    expect(unclassified).toEqual([])
  })

  // REVERSE: every classified name must still exist as a real gateway tool (catches rename/delete).
  test('all classified names exist as real gateway tools', () => {
    const real = new Set(Object.keys(buildAllTools()))
    const mapped = [
      ...Object.values(GATEWAY_SKILL_TOOLS).flat(),
      ...COLLISION_EXEMPT_GATEWAY_TOOLS,
      ...CORE_UNGATED_GATEWAY_TOOLS
    ]
    for (const n of mapped) expect(real.has(n)).toBe(true)
  })
})

describe('buildGatewayTools skill-gating wiring', () => {
  test('flag-off → ToolSet identical to no-gating even if advertisedSkills present (byte-level)', () => {
    const base = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      contextMode: 'manual_chat'
    })
    const flagOff = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      advertisedSkills: [], // would gate everything IF the flag were on — but it's off
      contextMode: 'manual_chat'
    })
    expect(Object.keys(flagOff)).toEqual(Object.keys(base))
    expect(Object.keys(base).sort()).toEqual([...GATEWAY_DEFAULT_TOOL_NAMES].sort())
  })

  test('flag-on + advertisedSkills null → fail-open (not gated)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      skillGatingEnabled: true,
      advertisedSkills: null,
      contextMode: 'manual_chat'
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_DEFAULT_TOOL_NAMES].sort())
  })

  test('flag-on + advertisedSkills omitting search → drops search read tools only', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      skillGatingEnabled: true,
      advertisedSkills: ['email', 'report'], // search NOT advertised
      contextMode: 'manual_chat'
    })
    expect(tools.email_search_fulltext).toBeUndefined()
    expect(tools.email_search_attachments).toBeUndefined()
    expect(tools.email_list_filter).toBeDefined() // email advertised → email family present
    expect(tools.email_get).toBeDefined() // email advertised
    expect(tools.report_list).toBeDefined() // report advertised
    expect(tools.kos_query).toBeDefined() // core
  })
})

// S6 W3-1b (ADR-004 rev3.1 §5.1/D3) — per-agent skill MOUNT gating: a SECOND applySkillGating
// pass keyed SOLELY on agentRunContext presence (owner authorization state), stacked on the M4a
// business-state gate → surviving skill tools = mounted ∩ advertised. Independent of the M4a flag
// and of the advertisedSkills-null fail-open (those are manual semantics; the mount list fails
// CLOSED — missing → []).
describe('buildGatewayTools per-agent mount gating (S6 W3-1b)', () => {
  const domain = () => mockDomain(() => okEnvelope([]))

  test('mount gating keys on agentRunContext presence alone — no M4a flag, no advertisedSkills', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      contextMode: 'manual_chat',
      agentRunContext: { agentId: 'dms', skills: ['email'] } // search/report NOT mounted
    })
    // email family mounted → present
    for (const n of ['email_get', 'email_body', 'email_list_thread']) {
      expect(tools[n]).toBeDefined()
    }
    // unmounted families → ABSENT (absence, not an error — the model never sees them)
    for (const n of [
      'email_search_fulltext',
      'email_search_attachments',
      'report_list',
      'report_get'
    ]) {
      expect(tools[n]).toBeUndefined()
    }
    expect(tools.email_list_filter).toBeDefined() // email family mounted → present (PR-D: no longer a collision-exempt floor)
  })

  test('skills=[] (zero mounts): every mapped skill tool absent; FULL CORE_UNGATED floor stays', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      sendToolEnabled: true,
      sendSigningSecret: 'secret',
      skillGatingEnabled: true,
      sessionToolsEnabled: true,
      configToolsEnabled: true,
      webToolsEnabled: true,
      execToolsEnabled: true,
      skillInstallToolsEnabled: true,
      customAgentToolsEnabled: true,
      skillCreatorToolsEnabled: true,
      customAgentCallEnabled: true,
      parentSessionId: 1,
      findSessionByParentToolCall: () => null,
      createAgentCallSession: () => 2,
      setAgentSessionJobId: () => undefined,
      calendarToolsEnabled: true,
      contextMode: 'manual_chat', // manual probe isolates the mount gate from the mode floor
      agentRunContext: { agentId: 'dms', skills: [] }
    })
    for (const names of Object.values(GATEWAY_SKILL_TOOLS)) {
      for (const n of names) expect(tools[n]).toBeUndefined()
    }
    // the mount list is NOT a second switch for the core floor (ADR §5.1)
    for (const n of CORE_UNGATED_GATEWAY_TOOLS) {
      if (CONDITIONAL_HEADLESS_CORE_TOOLS.has(n)) {
        expect(tools[n]).toBeUndefined()
      } else {
        expect(tools[n]).toBeDefined()
      }
    }
  })

  test('mounted ∩ advertised: mounting can never revive a globally-disabled skill (and vice versa)', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      skillGatingEnabled: true,
      advertisedSkills: ['email'], // search globally OFF
      contextMode: 'manual_chat',
      agentRunContext: { agentId: 'dms', skills: ['search', 'report'] } // email NOT mounted
    })
    // email: advertised but unmounted → absent (mount reduction)
    expect(tools.email_get).toBeUndefined()
    // search: mounted but not advertised → absent (business reduction — mount can't revive)
    expect(tools.email_search_fulltext).toBeUndefined()
    // report: mounted, and M4a only gates against the advertised list → survives the business
    // pass only if advertised… report NOT advertised → absent too
    expect(tools.report_list).toBeUndefined()
    // the intersection of the two lists is empty → only the CORE_UNGATED floor remains
    // (PR-D: email_list_filter ∈ email skill, advertised but unmounted → absent; no collision-exempt floor)
    expect(tools.email_list_filter).toBeUndefined()
    expect(tools.kos_query).toBeDefined()
  })

  test('missing skills on the context → [] fail-closed (never the advertised-null fail-open)', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      contextMode: 'manual_chat',
      agentRunContext: { agentId: 'dms' } // hand-built context without skills
    })
    for (const names of Object.values(GATEWAY_SKILL_TOOLS)) {
      for (const n of names) expect(tools[n]).toBeUndefined()
    }
    expect(tools.email_list_filter).toBeUndefined() // email skill unmounted → absent (no collision-exempt floor since PR-D)
  })

  test('no agentRunContext → mount gating never applies (manual assembly byte-identical)', () => {
    const base = buildGatewayTools({ domain: domain(), contextMode: 'manual_chat' })
    expect(Object.keys(base).sort()).toEqual([...GATEWAY_DEFAULT_TOOL_NAMES].sort())
  })

  test('applyContextModePolicy still filters LAST: dangerous classes stay absent under a fully-mounted headless run', () => {
    const tools = buildGatewayTools({
      domain: domain(),
      writeToolsEnabled: true,
      approvalGuard: new ApprovalGuard(),
      sendToolEnabled: true,
      sendSigningSecret: 'secret',
      skillInstallToolsEnabled: true,
      execToolsEnabled: true,
      contextMode: 'cron_headless',
      agentRunContext: { agentId: 'dms', skills: ['email', 'search', 'report'] } // mounts wide open
    })
    // mounting everything cannot smuggle a floored class past the mode policy (no grants here)
    for (const n of ['skill_install', 'run_command', 'email_prepare_send']) {
      expect(tools[n]).toBeUndefined()
    }
    // mounted read families are present under the headless floor
    expect(tools.email_get).toBeDefined()
    expect(tools.report_list).toBeDefined()
  })
})
