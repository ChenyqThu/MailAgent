// PART 2 (auto-approval) + 08-05 WP-11 (per-tool tiers) — needsApproval gating.
//
// 'always' (default / absent) → without prefs every write tool asks (preview + edit), the
//                               blocking send asks (pre-WP-11 byte-identical).
// 'auto-reversible'           → reversible preview-tier writes skip the card (needsApproval
//                               false); edit-tier still asks; the send ALWAYS asks.
// per-tool tiers (WP-11)      → the manual ladder (F §4.3): bypass > explicit owner tier >
//                               policy_rules > auto-reversible > factory-default tier. Audited
//                               'auto_tool_pref' on a tier skip; 'deny' strips at assembly +
//                               hard-rejects at execute (belt).
// 'bypass' (07-16 / D1=a)     → everything auto-approves, send + exec + notion_agent included
//                               (08-05: BYPASS_STILL_ASK retired — bypass outranks per-tool ask).
//
// The 07-16 'acceptEdits' mode is RETIRED (08-05 WP-11): its by-name sets moved to the Python
// data layer (tool_prefs.py ACCEPT_EDITS_PRESET); the two-set partition completeness gate moved
// with them → tests/config/test_tool_prefs_catalog_parity.py (registry ↔ tool_catalog.json).
//
// S2 W0 (ADR-001 D3) — auto-approve additionally requires class==='domain_write' AND
// contextMode==='manual_chat'; outside manual_chat nothing auto-approves and per-tool prefs are
// never consulted (structural: buildGatewayTools drops them + types.ts re-checks).

import { describe, expect, test } from 'vitest'

import type { Tool } from 'ai'

import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { createWriteTools } from '../../../src/ai-gateway/tools/write'
import { createSendTools } from '../../../src/ai-gateway/tools/send'
import { createSelfMountTools } from '../../../src/ai-gateway/tools/self_mount'
import { createProfileTools } from '../../../src/ai-gateway/tools/profile'
import { createWebTools } from '../../../src/ai-gateway/tools/web'
import { createExecTools } from '../../../src/ai-gateway/tools/exec'
import { createSkillSupplyTools } from '../../../src/ai-gateway/tools/skill_supply'
import { createCustomAgentTools } from '../../../src/ai-gateway/tools/agents'
import { createCalendarWriteTools } from '../../../src/ai-gateway/tools/calendar'
import type { AgentContextMode } from '../../../src/ai-gateway/tools/policy'
import type {
  GatewayApprovalMode,
  GatewayToolApprovalPrefs,
  GatewayToolAuditEntry
} from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

type PrefMap = GatewayToolApprovalPrefs['tools']

const needsApprovalOf = (tool: Tool) =>
  tool.needsApproval as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[] }
  ) => boolean | Promise<boolean>
const executeOf = (tool: Tool) =>
  tool.execute as (
    i: unknown,
    o: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>

function writeTools(
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat',
  toolApprovalPrefs?: PrefMap
): {
  tools: Record<string, Tool>
  guard: ApprovalGuard
  collector: GatewayToolAuditEntry[]
  domainCalls: string[]
} {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domainCalls: string[] = []
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    return okEnvelope({ updated_ids: [9], outbox_entries: [], is_pinned: true, changed: true })
  })
  const tools = createWriteTools(domain, collector, guard, {
    approvalMode,
    contextMode,
    toolApprovalPrefs
  })
  return { tools, guard, collector, domainCalls }
}

function sendTool(): { tool: Tool } {
  const collector: GatewayToolAuditEntry[] = []
  const guard = new ApprovalGuard()
  const domain = mockDomain(() => okEnvelope({ sent: true }))
  const tools = createSendTools(domain, collector, guard, {
    signingSecret: 's',
    contextMode: 'manual_chat'
  })
  return { tool: tools.email_prepare_send }
}

function selfMountTools(
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat',
  toolApprovalPrefs?: PrefMap
): { tools: Record<string, Tool>; collector: GatewayToolAuditEntry[] } {
  const collector: GatewayToolAuditEntry[] = []
  const domain = mockDomain(() => okEnvelope({ name: 'email', enabled: true }))
  const tools = createSelfMountTools(domain, collector, new ApprovalGuard(), {
    approvalMode,
    contextMode,
    toolApprovalPrefs
  })
  return { tools, collector }
}

describe("approvalMode 'always' (default) — without prefs every write asks (pre-WP-11 parity)", () => {
  test('preview-tier (email_flag / email_pin / email_archive / email_resync) → needsApproval true', async () => {
    const { tools } = writeTools('always')
    for (const name of ['email_flag', 'email_pin', 'email_archive', 'email_resync']) {
      const needs = await needsApprovalOf(tools[name])(
        { internal_id: 9, is_flagged: true, pinned: true },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should ask in 'always'`).toBe(true)
    }
  })

  test('edit-tier (email_draft_reply) → needsApproval true', async () => {
    const { tools } = writeTools('always')
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-draft', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test('absent approvalMode behaves like always (preview asks)', async () => {
    const { tools } = writeTools(undefined)
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc1', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe("approvalMode 'auto-reversible' — reversible preview writes skip the card", () => {
  test('preview-tier writes → needsApproval false (no card)', async () => {
    const { tools } = writeTools('auto-reversible')
    for (const name of ['email_flag', 'email_pin', 'email_archive', 'email_resync']) {
      const needs = await needsApprovalOf(tools[name])(
        { internal_id: 9, is_flagged: true, pinned: true },
        { toolCallId: `tc-${name}`, messages: [] }
      )
      expect(needs, `${name} should auto-approve in 'auto-reversible'`).toBe(false)
    }
  })

  test('edit-tier (email_draft_reply) STILL asks without prefs → needsApproval true', async () => {
    const { tools } = writeTools('auto-reversible')
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-draft', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test("an auto-approved preview write still registers + verifies + executes + audits 'auto_reversible'", async () => {
    const { tools, domainCalls, collector } = writeTools('auto-reversible')
    const input = { internal_id: 9, is_flagged: true }
    // needsApproval returns false (no card) AND registers the record (side-effect).
    const needs = await needsApprovalOf(tools.email_flag)(input, {
      toolCallId: 'tc1',
      messages: []
    })
    expect(needs).toBe(false)
    // ai@6 then runs execute in the SAME call; guard.verify finds the record + hash matches.
    const out = await executeOf(tools.email_flag)(input, { toolCallId: 'tc1', messages: [] })
    expect(out).toMatchObject({ internal_id: 9, user_edited: false })
    expect(domainCalls).toHaveLength(1) // the write actually ran
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'auto_reversible'
    })
    expect(collector[0].approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── 08-05 WP-11 — the per-tool tier ladder ─────────────────────────────────────────────────────

describe('WP-11 — factory-default tiers (source "default")', () => {
  const DEFAULT_AUTO_PREFS: PrefMap = {
    email_flag: { tier: 'auto', source: 'default' },
    email_draft_reply: { tier: 'auto', source: 'default' },
    email_draft_compose: { tier: 'auto', source: 'default' },
    email_draft_update: { tier: 'auto', source: 'default' }
  }

  test('验收① — draft writes with the factory-default auto tier no longer card', async () => {
    const { tools } = writeTools('always', 'manual_chat', DEFAULT_AUTO_PREFS)
    for (const name of ['email_draft_reply', 'email_draft_compose', 'email_draft_update']) {
      const needs = await needsApprovalOf(tools[name])(
        {
          internal_id: 9,
          draft_internal_id: 9,
          body_markdown: 'hi',
          mode: 'new',
          to: ['a@x.test']
        },
        { toolCallId: `tc-def-${name}`, messages: [] }
      )
      expect(needs, `${name} should be card-free on its default auto tier`).toBe(false)
    }
  })

  test('验收① — web_search / web_fetch with the factory-default auto tier no longer card', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domain = mockDomain(() => okEnvelope({ ok: true }))
    const tools = createWebTools(domain, collector, new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: {
        web_fetch: { tier: 'auto', source: 'default' },
        web_search: { tier: 'auto', source: 'default' }
      }
    })
    for (const [name, input] of [
      ['web_fetch', { url: 'https://example.test/x' }],
      ['web_search', { query: 'q' }]
    ] as const) {
      const needs = await needsApprovalOf(tools[name])(input, {
        toolCallId: `tc-def-${name}`,
        messages: []
      })
      expect(needs, `${name} should be card-free on its default auto tier`).toBe(false)
    }
  })

  test("a default-auto skip executes + audits 'auto_tool_pref' (never 'approved')", async () => {
    const { tools, domainCalls, collector } = writeTools(
      'always',
      'manual_chat',
      DEFAULT_AUTO_PREFS
    )
    const input = { internal_id: 9, is_flagged: true }
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-dfa', messages: [] })
    ).toBe(false)
    await executeOf(tools.email_flag)(input, { toolCallId: 'tc-dfa', messages: [] })
    expect(domainCalls).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'auto_tool_pref'
    })
    expect(collector[0].approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a default-ASK tier keeps the card (calendar three writes stay ask by default)', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domain = mockDomain(() => okEnvelope({ ok: true }))
    const tools = createCalendarWriteTools(domain, collector, new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: {
        calendar_event_reschedule: { tier: 'ask', source: 'default' },
        calendar_event_rsvp: { tier: 'ask', source: 'default' },
        calendar_event_delete: { tier: 'ask', source: 'default' }
      }
    })
    for (const name of [
      'calendar_event_reschedule',
      'calendar_event_rsvp',
      'calendar_event_delete'
    ]) {
      const needs = await needsApprovalOf(tools[name])(
        { event_id: 'ev1' },
        { toolCallId: `tc-cal-${name}`, messages: [] }
      )
      expect(needs, `${name} must keep asking on its default ask tier`).toBe(true)
    }
  })

  test('prefs absent (resolver failure / harness cfg) → every write asks (fail-closed)', async () => {
    const { tools } = writeTools('always', 'manual_chat', undefined)
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-nofail', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe('WP-11 — explicit owner tiers (source "owner", ladder ④)', () => {
  test("owner 'auto' on a default-ask tool skips the card (audits 'auto_tool_pref')", async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domain = mockDomain(() => okEnvelope({ ok: true }))
    const tools = createCalendarWriteTools(domain, collector, new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { calendar_event_reschedule: { tier: 'auto', source: 'owner' } }
    })
    const input = {
      event_id: 'ev1',
      scope: 'series',
      new_start: '2026-08-06T10:00:00',
      new_end: '2026-08-06T11:00:00',
      timezone: 'America/Los_Angeles'
    }
    expect(
      await needsApprovalOf(tools.calendar_event_reschedule)(input, {
        toolCallId: 'tc-own-auto',
        messages: []
      })
    ).toBe(false)
    await executeOf(tools.calendar_event_reschedule)(input, {
      toolCallId: 'tc-own-auto',
      messages: []
    })
    expect(collector[0]).toMatchObject({ approvalStatus: 'auto_tool_pref' })
  })

  test("owner 'ask' on a default-auto tool forces the card back", async () => {
    const { tools } = writeTools('always', 'manual_chat', {
      email_draft_reply: { tier: 'ask', source: 'owner' }
    })
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-own-ask', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test("owner 'ask' outranks auto-reversible (ladder ④ > ⑤)", async () => {
    const { tools } = writeTools('auto-reversible', 'manual_chat', {
      email_flag: { tier: 'ask', source: 'owner' }
    })
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc-own-ar', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test("owner 'ask' outranks a policy_rules auto_allow (ladder ④ > ⑥ — no whitelist round-trip)", async () => {
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ decision: 'auto_allow', rule_id: 7 })
    })
    const tools = createExecTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { file_write: { tier: 'ask', source: 'owner' } }
    })
    const needs = await needsApprovalOf(tools.file_write)(
      { path: '/tmp/a.txt', content: 'x' },
      { toolCallId: 'tc-own-rule', messages: [] }
    )
    expect(needs).toBe(true)
    expect(domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(0)
  })

  test("owner 'auto' on an exec file tool skips BEFORE the whitelist round-trip", async () => {
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ ok: true })
    })
    const tools = createExecTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { file_read: { tier: 'auto', source: 'owner' } }
    })
    const needs = await needsApprovalOf(tools.file_read)(
      { path: '/tmp/a.txt' },
      { toolCallId: 'tc-own-fr', messages: [] }
    )
    expect(needs).toBe(false)
    expect(domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(0)
  })

  test('run_command has NO tier entry (registry excludes it) → whitelist-or-card path unchanged', async () => {
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ decision: 'ask', rule_id: null })
    })
    // even a (hypothetical, server-impossible) run_command entry is irrelevant: the server
    // registry never emits one — here we thread NO entry, the honest wire shape.
    const tools = createExecTools(domain, [], new ApprovalGuard(), {
      contextMode: 'manual_chat',
      toolApprovalPrefs: { file_read: { tier: 'auto', source: 'owner' } }
    })
    const needs = await needsApprovalOf(tools.run_command)(
      { argv: ['echo', 'hi'] },
      { toolCallId: 'tc-rc', messages: [] }
    )
    expect(needs).toBe(true)
    expect(domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(1)
  })

  test('capability_change tools honor an owner auto tier (set_skill_enabled / update_system_md)', async () => {
    const { tools } = selfMountTools('always', 'manual_chat', {
      set_skill_enabled: { tier: 'auto', source: 'owner' },
      update_system_md: { tier: 'auto', source: 'owner' }
    })
    for (const [name, input] of [
      ['set_skill_enabled', { skill_name: 'email', enabled: true }],
      ['update_system_md', { doc_name: 'agent', content: 'x' }]
    ] as const) {
      const needs = await needsApprovalOf(tools[name])(input, {
        toolCallId: `tc-cap-${name}`,
        messages: []
      })
      expect(needs, `${name} should honor the explicit owner auto tier`).toBe(false)
    }
    const profile = createProfileTools(
      mockDomain(() => okEnvelope({ ok: true })),
      [],
      new ApprovalGuard(),
      {
        contextMode: 'manual_chat',
        toolApprovalPrefs: { agent_memory_update: { tier: 'auto', source: 'owner' } }
      }
    )
    expect(
      await needsApprovalOf(profile.agent_memory_update)(
        { content: 'x' },
        { toolCallId: 'tc-cap-mem', messages: [] }
      )
    ).toBe(false)
  })
})

describe('WP-11 — 验收⑥ per-tool tiers only ever apply in manual_chat', () => {
  test.each(['untrusted_trigger', 'cron_headless', 'im_chat'] as const)(
    'a threaded prefs map is INERT under %s (consumption-side belt)',
    async (mode) => {
      // Drive the factory directly with prefs a buggy caller might thread — the tier must not
      // relax anything outside manual_chat (buildGatewayTools additionally drops them upstream).
      const { tools } = writeTools('always', mode, {
        email_flag: { tier: 'auto', source: 'owner' }
      })
      const needs = await needsApprovalOf(tools.email_flag)(
        { internal_id: 9, is_flagged: true },
        { toolCallId: `tc-inert-${mode}`, messages: [] }
      )
      expect(needs).toBe(true)
    }
  )
})

describe("WP-11 — owner 'deny' (registration strip + runtime belt)", () => {
  test('needsApproval false (no misleading card) + execute hard-rejects E_TOOL_DENIED, domain untouched', async () => {
    const { tools, domainCalls, collector } = writeTools('always', 'manual_chat', {
      email_flag: { tier: 'deny', source: 'owner' }
    })
    const input = { internal_id: 9, is_flagged: true }
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-deny', messages: [] })
    ).toBe(false)
    await expect(
      executeOf(tools.email_flag)(input, { toolCallId: 'tc-deny', messages: [] })
    ).rejects.toThrow(/E_TOOL_DENIED/)
    expect(domainCalls).toHaveLength(0)
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'error',
      approvalStatus: 'rejected'
    })
  })

  test("🔴 bypass does NOT resurrect an owner 'deny' (deny is the availability axis — no card, E_TOOL_DENIED at execute)", async () => {
    // check 2026-08-05 — the most dangerous imaginable combination is「deny 在 bypass 下静默变
    // auto」. Pinned here: prefDenied is consulted BEFORE the bypass branch, so even under the
    // owner-global bypass the denied tool never executes (and never cards — a card would be
    // misleading for a tool that cannot run). Registration-face stripping is additionally
    // approvalMode-independent (build.test.ts pins that half).
    const { tools, domainCalls } = writeTools('bypass', 'manual_chat', {
      email_flag: { tier: 'deny', source: 'owner' }
    })
    const input = { internal_id: 9, is_flagged: true }
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-by-deny', messages: [] })
    ).toBe(false)
    await expect(
      executeOf(tools.email_flag)(input, { toolCallId: 'tc-by-deny', messages: [] })
    ).rejects.toThrow(/E_TOOL_DENIED/)
    expect(domainCalls).toHaveLength(0)
  })

  test("a 'default'-sourced deny is impossible wire data and does NOT deny (only owner overrides deny)", async () => {
    const { tools, domainCalls } = writeTools('always', 'manual_chat', {
      email_flag: { tier: 'deny', source: 'default' } as never
    })
    const input = { internal_id: 9, is_flagged: true }
    // falls through the ladder: no owner deny, no auto → the card (fail-closed, never a hard block)
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-dd', messages: [] })
    ).toBe(true)
    expect(domainCalls).toHaveLength(0)
  })
})

// ── S2 W0 (ADR-001 D3) — contextMode × toolClass matrix (unchanged by WP-11) ───────────────────

describe('S2 W0 — set_skill_enabled (preview + capability_change) NEVER auto-approves via auto-reversible', () => {
  test('auto-reversible + manual_chat → set_skill_enabled STILL pauses (needsApproval true)', async () => {
    const { tools } = selfMountTools('auto-reversible')
    const needs = await needsApprovalOf(tools.set_skill_enabled)(
      { skill_name: 'email', enabled: true },
      { toolCallId: 'tc-skill', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test('update_system_md (edit + capability_change) still asks in auto-reversible (unchanged)', async () => {
    const { tools } = selfMountTools('auto-reversible')
    const needs = await needsApprovalOf(tools.update_system_md)(
      { doc_name: 'agent', content: 'x' },
      { toolCallId: 'tc-doc', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe('S2 W0 — auto-approve requires manual_chat (domain_write in a non-manual run asks)', () => {
  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    'auto-reversible + %s → email_flag (preview + domain_write) still asks',
    async (mode) => {
      const { tools } = writeTools('auto-reversible', mode)
      const needs = await needsApprovalOf(tools.email_flag)(
        { internal_id: 9, is_flagged: true },
        { toolCallId: 'tc1', messages: [] }
      )
      expect(needs).toBe(true)
    }
  )

  test('absent contextMode fail-closes: auto-reversible does NOT skip the card', async () => {
    // Build WITHOUT a contextMode key at all (the helper's default would re-fill 'manual_chat'
    // on an explicit undefined) — the factory must fail-close to untrusted_trigger.
    const tools = createWriteTools(
      mockDomain(() => okEnvelope({ updated_ids: [9] })),
      [],
      new ApprovalGuard(),
      { approvalMode: 'auto-reversible' }
    )
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc1', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe('S2 W0 — runtime double-insurance: a mode-denied tool hard-rejects at execute', () => {
  test('set_skill_enabled under untrusted_trigger → no card + execute rejects, domain untouched', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ name: 'email', enabled: true })
    })
    const tools = createSelfMountTools(domain, collector, new ApprovalGuard(), {
      contextMode: 'untrusted_trigger'
    })
    const input = { skill_name: 'email', enabled: true }
    const needs = await needsApprovalOf(tools.set_skill_enabled)(input, {
      toolCallId: 'tc-deny',
      messages: []
    })
    expect(needs).toBe(false) // no approval card — the tool can never execute in this mode
    await expect(
      executeOf(tools.set_skill_enabled)(input, { toolCallId: 'tc-deny', messages: [] })
    ).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
    expect(domainCalls).toHaveLength(0) // the write never ran
    expect(collector[0]).toMatchObject({
      toolName: 'set_skill_enabled',
      status: 'error',
      confirmationTier: 'preview',
      approvalStatus: 'rejected'
    })
  })

  test('email_prepare_send under cron_headless → execute rejects even after an approved card', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const guard = new ApprovalGuard()
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ sent: true })
    })
    const tools = createSendTools(domain, collector, guard, {
      signingSecret: 's',
      contextMode: 'cron_headless'
    })
    const input = { to: ['x@corp.test'], subject: 's', body_markdown: 'b' }
    const needs = await needsApprovalOf(tools.email_prepare_send)(input, {
      toolCallId: 'tc-send-deny',
      messages: []
    })
    expect(needs).toBe(true)
    await expect(
      executeOf(tools.email_prepare_send)(input, { toolCallId: 'tc-send-deny', messages: [] })
    ).rejects.toThrow(/E_CONTEXT_MODE_DENIED/)
    expect(domainCalls).toHaveLength(0)
  })

  test('email_flag (domain_write) under untrusted_trigger is NOT mode-denied (HITL path intact)', async () => {
    const { tools, domainCalls } = writeTools('always', 'untrusted_trigger')
    const input = { internal_id: 9, is_flagged: true }
    const needs = await needsApprovalOf(tools.email_flag)(input, {
      toolCallId: 'tc-dw',
      messages: []
    })
    expect(needs).toBe(true) // asks (never auto in non-manual) …
    const out = await executeOf(tools.email_flag)(input, { toolCallId: 'tc-dw', messages: [] })
    expect(out).toMatchObject({ internal_id: 9 }) // … and executes after approval
    expect(domainCalls).toHaveLength(1)
  })
})

// ── 07-16 'bypass' + 08-05 D1=a — everything auto-approves, 无例外 ─────────────────────────────

function toolsOf(
  factory: 'profile' | 'web' | 'exec' | 'skillSupply' | 'customAgents' | 'calendarWrite',
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat'
): { tools: Record<string, Tool>; domainCalls: string[] } {
  const domainCalls: string[] = []
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    if (url.includes('/agent/policy/evaluate')) {
      return okEnvelope({ decision: 'ask', rule_id: null })
    }
    return okEnvelope({ ok: true })
  })
  const guard = new ApprovalGuard()
  const opts = { approvalMode, contextMode }
  const tools =
    factory === 'profile'
      ? createProfileTools(domain, [], guard, opts)
      : factory === 'web'
        ? createWebTools(domain, [], guard, opts)
        : factory === 'exec'
          ? createExecTools(domain, [], guard, opts)
          : factory === 'skillSupply'
            ? createSkillSupplyTools(domain, [], guard, opts)
            : factory === 'customAgents'
              ? createCustomAgentTools(domain, [], guard, opts)
              : createCalendarWriteTools(domain, [], guard, opts)
  return { tools, domainCalls }
}

describe("07-16 'bypass' — everything auto-approves (owner 拍板: 无例外; D1=a), manual_chat only", () => {
  test('domain writes + calendar 三写 + skill supply + custom agents → all false', async () => {
    const { tools } = writeTools('bypass')
    for (const name of ['email_flag', 'email_draft_reply']) {
      expect(
        await needsApprovalOf(tools[name])(
          { internal_id: 9, is_flagged: true, body_markdown: 'x' },
          { toolCallId: `tc-by-${name}`, messages: [] }
        )
      ).toBe(false)
    }
    const cal = toolsOf('calendarWrite', 'bypass')
    for (const name of [
      'calendar_event_reschedule',
      'calendar_event_rsvp',
      'calendar_event_delete'
    ]) {
      expect(
        await needsApprovalOf(cal.tools[name])(
          { event_id: 'ev1' },
          { toolCallId: `tc-by-${name}`, messages: [] }
        ),
        `${name} should auto-approve under bypass`
      ).toBe(false)
    }
    const supply = toolsOf('skillSupply', 'bypass')
    for (const name of ['skill_install', 'skill_install_confirm', 'skill_uninstall']) {
      expect(
        await needsApprovalOf(supply.tools[name])(
          { source_url: 'https://example.test/p.zip', name: 's', package_hash: 'h' },
          { toolCallId: `tc-by-${name}`, messages: [] }
        ),
        `${name} should auto-approve under bypass`
      ).toBe(false)
    }
    const agents = toolsOf('customAgents', 'bypass')
    expect(
      await needsApprovalOf(agents.tools.custom_agent_delete)(
        { agent_id: 'a1' },
        { toolCallId: 'tc-by-cad', messages: [] }
      )
    ).toBe(false)
  })

  test("audit (codex r1 P2-4): a bypass write skip executes + audits 'auto_bypass', never 'approved'", async () => {
    const { tools, domainCalls, collector } = writeTools('bypass')
    const input = { internal_id: 9, is_flagged: true }
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-by-audit', messages: [] })
    ).toBe(false)
    await executeOf(tools.email_flag)(input, { toolCallId: 'tc-by-audit', messages: [] })
    expect(domainCalls).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'auto_bypass'
    })
  })

  test('exec run_command → false WITHOUT consulting the whitelist (released before policyEvaluate)', async () => {
    const rc = toolsOf('exec', 'bypass')
    const needs = await needsApprovalOf(rc.tools.run_command)(
      { argv: ['echo', 'hi'] },
      { toolCallId: 'tc-by-rc', messages: [] }
    )
    expect(needs).toBe(false)
    expect(rc.domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(0)
  })

  test("验收④ D1=a — bypass outranks an explicit per-tool 'ask' (字面「无例外」)", async () => {
    const { tools } = writeTools('bypass', 'manual_chat', {
      email_draft_reply: { tier: 'ask', source: 'owner' }
    })
    const needs = await needsApprovalOf(tools.email_draft_reply)(
      { internal_id: 9, body_markdown: 'hi' },
      { toolCallId: 'tc-by-vs-ask', messages: [] }
    )
    expect(needs).toBe(false)
  })

  test('send → needsApproval false AND the full double-guard execute chain still runs (register/verify/consume/audit)', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const domainCalls: string[] = []
    const domain = mockDomain((url) => {
      domainCalls.push(url)
      return okEnvelope({ sent: true, message_id: 'mid', archived_to_sent: true })
    })
    const tools = createSendTools(domain, collector, new ApprovalGuard(), {
      signingSecret: 's',
      contextMode: 'manual_chat',
      approvalMode: 'bypass'
    })
    const input = { to: ['x@corp.test'], subject: 's', body_markdown: 'b' }
    const needs = await needsApprovalOf(tools.email_prepare_send)(input, {
      toolCallId: 'tc-by-send',
      messages: []
    })
    expect(needs).toBe(false) // no card …
    const out = await executeOf(tools.email_prepare_send)(input, {
      toolCallId: 'tc-by-send',
      messages: []
    })
    expect(out).toMatchObject({ sent: true, subject: 's' }) // … but the send executed
    expect(domainCalls).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'email_prepare_send',
      status: 'ok',
      confirmationTier: 'edit',
      approvalStatus: 'auto_bypass'
    })
    expect(collector[0].contentHash).toBeTruthy()
    expect(collector[0].idempotencyKey).toBeTruthy()
    // one-shot: a replayed execute for the same approval fails closed (E_APPROVAL_USED).
    await expect(
      executeOf(tools.email_prepare_send)(input, { toolCallId: 'tc-by-send', messages: [] })
    ).rejects.toThrow(/E_APPROVAL_USED/)
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    'manual_chat-gated: bypass under %s never auto-approves (headless isolation, consumption side)',
    async (mode) => {
      const { tools } = writeTools('bypass', mode)
      expect(
        await needsApprovalOf(tools.email_flag)(
          { internal_id: 9, is_flagged: true },
          { toolCallId: 'tc-by-iso', messages: [] }
        )
      ).toBe(true)
      const collector: GatewayToolAuditEntry[] = []
      const send = createSendTools(
        mockDomain(() => okEnvelope({ sent: true })),
        collector,
        new ApprovalGuard(),
        {
          signingSecret: 's',
          contextMode: mode,
          approvalMode: 'bypass'
        }
      )
      expect(
        await needsApprovalOf(send.email_prepare_send)(
          { to: ['x@corp.test'], subject: 's', body_markdown: 'b' },
          { toolCallId: 'tc-by-send-iso', messages: [] }
        )
      ).toBe(true)
    }
  )
})
