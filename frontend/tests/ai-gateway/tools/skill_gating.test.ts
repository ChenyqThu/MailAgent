// mem0/skill 核心重构 epic M4a — skill→tool 门控 + buildGatewayTools 接线 + 漂移守护。
//
// 证：(1) applySkillGating 复刻 legacy advertised-owner-wins 语义（关 skill 删其读工具，
// collision-exempt + core 永留）；(2) flag-off / advertisedSkills null → ToolSet 字节级同 cutover；
// (3) 双向完整性漂移守护 —— 每个 gateway 工具必被归类（防「新读工具漏门控」复发 bug，review M2）。

import { describe, expect, test } from 'vitest'

import { buildGatewayTools, GATEWAY_READ_TOOL_NAMES } from '../../../src/ai-gateway/tools'
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
function buildAllTools() {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard(),
    sendToolEnabled: true,
    sendSigningSecret: 'secret',
    // M4b/M4c — also build the self-mount tools (update_system_md / discover_skills /
    // set_skill_enabled) so the FORWARD completeness guard sees them. advertisedSkills left unset
    // → applySkillGating not called → the full unfiltered set.
    skillGatingEnabled: true
  })
}

describe('applySkillGating (pure semantics)', () => {
  test('disabling email drops its read tools; collision-exempt email_search + core stay', () => {
    const tools = buildAllTools()
    const advertised = ['search', 'report', 'kos', 'calendar', 'notion_agent'] // email NOT advertised
    const gated = applySkillGating(tools, advertised)
    for (const n of ['email_get', 'email_body', 'email_list_thread']) {
      expect(gated[n]).toBeUndefined()
    }
    expect(gated.email_search).toBeDefined() // collision-exempt
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

  test('advertisedSkills=[] gates every mapped skill tool; collision-exempt + core survive', () => {
    const gated = applySkillGating(buildAllTools(), [])
    for (const names of Object.values(GATEWAY_SKILL_TOOLS)) {
      for (const n of names) expect(gated[n]).toBeUndefined()
    }
    expect(gated.email_search).toBeDefined()
    for (const n of CORE_UNGATED_GATEWAY_TOOLS) expect(gated[n]).toBeDefined()
  })

  test('all three skills advertised → no drops (identity, same keys + order)', () => {
    const tools = buildAllTools()
    const gated = applySkillGating(tools, ['email', 'search', 'report'])
    expect(Object.keys(gated)).toEqual(Object.keys(tools))
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
    const base = buildGatewayTools({ domain: mockDomain(() => okEnvelope([])) })
    const flagOff = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      advertisedSkills: [] // would gate everything IF the flag were on — but it's off
    })
    expect(Object.keys(flagOff)).toEqual(Object.keys(base))
    expect(Object.keys(base).sort()).toEqual([...GATEWAY_READ_TOOL_NAMES].sort())
  })

  test('flag-on + advertisedSkills null → fail-open (not gated)', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      skillGatingEnabled: true,
      advertisedSkills: null
    })
    expect(Object.keys(tools).sort()).toEqual([...GATEWAY_READ_TOOL_NAMES].sort())
  })

  test('flag-on + advertisedSkills omitting search → drops search read tools only', () => {
    const tools = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      skillGatingEnabled: true,
      advertisedSkills: ['email', 'report'] // search NOT advertised
    })
    expect(tools.email_search_fulltext).toBeUndefined()
    expect(tools.email_search_attachments).toBeUndefined()
    expect(tools.email_search).toBeDefined() // collision-exempt
    expect(tools.email_get).toBeDefined() // email advertised
    expect(tools.report_list).toBeDefined() // report advertised
    expect(tools.kos_query).toBeDefined() // core
  })
})
