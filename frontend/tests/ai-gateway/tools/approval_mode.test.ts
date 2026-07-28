// PART 2 (auto-approval) — needsApproval gating by approvalMode.
//
// 'always' (default / absent) → every write tool asks (preview + edit), the blocking send asks.
// 'auto-reversible'           → reversible preview-tier writes skip the card (needsApproval false);
//                               edit-tier still asks; the irreversible send ALWAYS asks (safety floor).
// The approval record is always registered (execute's guard.verify + the audit need it), so an
// auto-approved preview write still executes through guard.verify and audits approval_status='approved'.
//
// S2 W0 (ADR-001 D3) — auto-approve additionally requires class==='domain_write' AND
// contextMode==='manual_chat': a preview-tier capability change (set_skill_enabled) now ALWAYS
// asks (the auto-reversible escape is closed), and outside manual_chat nothing auto-approves.
// Test factories pass contextMode:'manual_chat' explicitly (the run-mode a renderer session has);
// the mode is a trusted server parameter, fail-closed 'untrusted_trigger' when absent.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
import {
  ACCEPT_EDITS_ASK_TOOLS,
  ACCEPT_EDITS_AUTO_APPROVE_TOOLS,
  BYPASS_STILL_ASK,
  GATEWAY_TOOL_CLASSES
} from '../../../src/ai-gateway/tools/policy'
import type { AgentContextMode } from '../../../src/ai-gateway/tools/policy'
import type {
  GatewayApprovalMode,
  GatewayToolAuditEntry
} from '../../../src/ai-gateway/tools/types'
import { mockDomain, okEnvelope } from './_helpers'

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
  contextMode: AgentContextMode | undefined = 'manual_chat'
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
  const tools = createWriteTools(domain, collector, guard, { approvalMode, contextMode })
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
  contextMode: AgentContextMode | undefined = 'manual_chat'
): { tools: Record<string, Tool>; collector: GatewayToolAuditEntry[] } {
  const collector: GatewayToolAuditEntry[] = []
  const domain = mockDomain(() => okEnvelope({ name: 'email', enabled: true }))
  const tools = createSelfMountTools(domain, collector, new ApprovalGuard(), {
    approvalMode,
    contextMode
  })
  return { tools, collector }
}

describe("approvalMode 'always' (default) — every write asks", () => {
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

  test('edit-tier (email_draft_reply) STILL asks → needsApproval true', async () => {
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
      // codex r1 P2-4 — a card-skip must be distinguishable from a human decision: the
      // reversible skip now audits 'auto_reversible' ('approved' is reserved for real card
      // approvals). approval_status is free-form TEXT in chat_tool_call — no migration.
      approvalStatus: 'auto_reversible'
    })
    expect(collector[0].approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('blocking send (email_prepare_send) — ALWAYS asks regardless of mode (safety floor)', () => {
  // The send tool takes no approvalMode param; its needsApproval hard-returns true. There is no
  // mode threading that can relax it — assert it asks even though we built it with no mode (= the
  // gateway never passes a mode to createSendTools).
  test('needsApproval true (the tool has no path to auto-approve)', async () => {
    const { tool } = sendTool()
    const needs = await needsApprovalOf(tool)(
      { to: ['x@corp.test'], subject: 's', body_markdown: 'b' },
      { toolCallId: 'tc-send', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

// ── S2 W0 (ADR-001 D3) — contextMode × toolClass matrix ────────────────────────────────────────

describe('S2 W0 — set_skill_enabled (preview + capability_change) NEVER auto-approves', () => {
  // 🔴 The escape codex flagged: pre-W0, auto-reversible skipped the card for EVERY preview-tier
  // write, including set_skill_enabled → a poisoned run could silently enable capabilities. The
  // predicate now requires class==='domain_write', so the capability change always asks. This is
  // a DELIBERATE behaviour change (unflagged security fix) — the old "preview ⇒ skip" assertion
  // is inverted for this tool.
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
  // Registration-time filtering (applyContextModePolicy) normally keeps a capability_change/
  // outbound tool OUT of a non-manual ToolSet — these assertions drive the factory directly to
  // prove the second line of defense: no card (needsApproval false, no misleading pause) and a
  // typed E_CONTEXT_MODE_DENIED tool-error, with the write never reaching the domain.
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
    // needsApproval keeps its hard true (safety floor unchanged) — but even a user-approved send
    // cannot execute outside a manual session.
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

// ── 07-16 approval-mode switcher — owner-global 'acceptEdits' / 'bypass' overlays ────────────────
//
// The values below are SERVER-injected by prepareChatRun (manual_chat-gated, never from a body);
// these factory-driven assertions pin the consumption-side semantics per tool:
//   acceptEdits → ONLY the by-name ALLOW-list (ACCEPT_EDITS_AUTO_APPROVE_TOOLS) auto-approves
//                 (codex r1 P1-3: fail-closed — an unlisted/future write asks); the explicit
//                 ask declarations live in ACCEPT_EDITS_ASK_TOOLS (calendar 三写 / run_command /
//                 skill supply chain / custom_agent 四写 / send) and the completeness gate below
//                 forces every catalog write tool into exactly one of the two;
//   bypass      → everything auto-approves, send + exec included (owner 拍板: 无例外);
//   both        → manual_chat ONLY (a non-manual contextMode keeps needsApproval true even if the
//                 mode were mis-threaded — consumption-side double gate).
// Audit (codex r1 P2-4): a card-skip executes with a DISTINCT approval_status
// ('auto_accept_edits'/'auto_bypass'/'auto_reversible') — 'approved' is reserved for humans.

function toolsOf(
  factory: 'profile' | 'web' | 'exec' | 'skillSupply' | 'customAgents' | 'calendarWrite',
  approvalMode?: GatewayApprovalMode,
  contextMode: AgentContextMode | undefined = 'manual_chat'
): { tools: Record<string, Tool>; domainCalls: string[]; policyVerdict?: string } {
  const domainCalls: string[] = []
  const state = { verdict: 'ask' as string, ruleId: null as number | null }
  const domain = mockDomain((url) => {
    domainCalls.push(url)
    if (url.includes('/agent/policy/evaluate')) {
      return okEnvelope({ decision: state.verdict, rule_id: state.ruleId })
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

describe('07-16 — acceptEdits allow/ask partition (codex r1 P1-3: fail-closed allow-list + completeness gate)', () => {
  test('every declared name is a real classified gateway tool (typo/rename guard, both sets)', () => {
    for (const name of [...ACCEPT_EDITS_AUTO_APPROVE_TOOLS, ...ACCEPT_EDITS_ASK_TOOLS]) {
      expect(
        GATEWAY_TOOL_CLASSES[name],
        `${name} must exist in GATEWAY_TOOL_CLASSES — a rename would orphan its acceptEdits decision`
      ).toBeDefined()
    }
  })

  test('the owner-拍板 sets, pinned verbatim (a set change is a deliberate policy change)', () => {
    // ALLOW-list = the ONLY runtime-consulted set: reversible email domain writes + draft,
    // identity/memory/skill-toggle edits, web, file read/write (owner 拍板「编辑/联网放行」).
    expect([...ACCEPT_EDITS_AUTO_APPROVE_TOOLS].sort()).toEqual(
      [
        'agent_memory_update',
        'agent_profile_restore',
        'email_archive',
        // prd 07-27 — the draft family rides with email_draft_reply: all three only write the
        // Drafts folder, nothing leaves the machine (the send is what asks).
        'email_draft_compose',
        'email_draft_reply',
        'email_draft_update',
        'email_flag',
        'email_pin',
        'email_resync',
        'file_read',
        'file_write',
        'set_skill_enabled',
        'update_system_md',
        'web_fetch',
        'web_search'
      ].sort()
    )
    // ASK declarations (documentation/accounting — the runtime never consults this set).
    // custom_agent 四写 per the 07-16 check 改判: the rev3.1 §7 grant vocabulary (model may
    // propose grant_web 'open'/grant_exec/cron) leans on the always-human card — releasing
    // create/update under acceptEdits = injected content can mint a persistent card-free
    // headless exfil backdoor. email_prepare_send is accounting-only (its factory never
    // consults either set — bypassMode literal is its only relaxation).
    expect([...ACCEPT_EDITS_ASK_TOOLS].sort()).toEqual(
      [
        'calendar_event_delete',
        'calendar_event_reschedule',
        'calendar_event_rsvp',
        'custom_agent_create',
        'custom_agent_delete',
        'custom_agent_run_now',
        'custom_agent_update',
        'email_prepare_send',
        'notion_agent_chat',
        'run_command',
        'skill_install',
        'skill_install_confirm',
        'skill_uninstall'
      ].sort()
    )
  })

  test('COMPLETENESS: every write:true catalog tool sits in EXACTLY one of the two sets (a new write tool without an explicit acceptEdits decision turns red)', () => {
    const catalogPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../tests/agent_eval/tool_catalog.json'
    )
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
      tools: Record<string, { write?: boolean; legacy_retired?: boolean }>
    }
    const writeTools = Object.entries(catalog.tools)
      .filter(([, entry]) => entry.write === true && entry.legacy_retired !== true)
      .map(([name]) => name)
    expect(writeTools.length).toBeGreaterThanOrEqual(25) // sanity: the catalog read worked
    for (const name of writeTools) {
      const allowed = ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(name)
      const asks = ACCEPT_EDITS_ASK_TOOLS.has(name)
      expect(
        allowed || asks,
        `${name} (write:true) has NO acceptEdits decision — add it to ACCEPT_EDITS_AUTO_APPROVE_TOOLS ` +
          `or ACCEPT_EDITS_ASK_TOOLS (policy.ts). Unlisted tools already ASK at runtime (fail-closed ` +
          `allow-list), but the decision must be explicit.`
      ).toBe(true)
      expect(allowed && asks, `${name} sits in BOTH sets — the partition must be disjoint`).toBe(
        false
      )
    }
    // no stale/mystery names: both sets contain only real catalog write tools.
    const writeSet = new Set(writeTools)
    for (const name of [...ACCEPT_EDITS_AUTO_APPROVE_TOOLS, ...ACCEPT_EDITS_ASK_TOOLS]) {
      expect(
        writeSet.has(name),
        `${name} declared in an acceptEdits set but is not a write:true catalog tool`
      ).toBe(true)
    }
  })
})

describe("07-16 'acceptEdits' — edits/web/config auto-approve; the by-name retain set still asks", () => {
  test('released: preview + edit domain writes (flag/pin/archive/resync/the three draft writes) → false', async () => {
    const { tools } = writeTools('acceptEdits')
    for (const name of [
      'email_flag',
      'email_pin',
      'email_archive',
      'email_resync',
      'email_draft_reply',
      // prd 07-27 — the new draft writes ride with the family.
      'email_draft_compose',
      'email_draft_update'
    ]) {
      const needs = await needsApprovalOf(tools[name])(
        {
          internal_id: 9,
          draft_internal_id: 9,
          is_flagged: true,
          pinned: true,
          body_markdown: 'hi',
          mode: 'new',
          to: ['a@x.test']
        },
        { toolCallId: `tc-ae-${name}`, messages: [] }
      )
      expect(needs, `${name} should auto-approve under acceptEdits`).toBe(false)
    }
  })

  test("audit (codex r1 P2-4): an acceptEdits skip executes + audits 'auto_accept_edits', never 'approved'", async () => {
    const { tools, domainCalls, collector } = writeTools('acceptEdits')
    const input = { internal_id: 9, is_flagged: true }
    expect(
      await needsApprovalOf(tools.email_flag)(input, { toolCallId: 'tc-ae-audit', messages: [] })
    ).toBe(false)
    const out = await executeOf(tools.email_flag)(input, {
      toolCallId: 'tc-ae-audit',
      messages: []
    })
    expect(out).toMatchObject({ internal_id: 9, user_edited: false })
    expect(domainCalls).toHaveLength(1)
    expect(collector[0]).toMatchObject({
      toolName: 'email_flag',
      status: 'ok',
      confirmationTier: 'preview',
      approvalStatus: 'auto_accept_edits'
    })
    expect(collector[0].approvalHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('released: capability_change identity/memory/skill-toggle (owner 拍板「编辑放行」) → false', async () => {
    const { tools } = selfMountTools('acceptEdits')
    for (const [name, input] of [
      ['update_system_md', { doc_name: 'agent', content: 'x' }],
      ['set_skill_enabled', { skill_name: 'email', enabled: true }]
    ] as const) {
      const needs = await needsApprovalOf(tools[name])(input, {
        toolCallId: `tc-ae-${name}`,
        messages: []
      })
      expect(needs, `${name} should auto-approve under acceptEdits`).toBe(false)
    }
    const profile = toolsOf('profile', 'acceptEdits')
    for (const name of ['agent_memory_update', 'agent_profile_restore']) {
      const needs = await needsApprovalOf(profile.tools[name])(
        { content: 'x', doc_name: 'memory', target_hash: 'h' },
        { toolCallId: `tc-ae-${name}`, messages: [] }
      )
      expect(needs, `${name} should auto-approve under acceptEdits`).toBe(false)
    }
  })

  test('released: web_fetch / web_search (联网放行) → false', async () => {
    const { tools } = toolsOf('web', 'acceptEdits')
    for (const [name, input] of [
      ['web_fetch', { url: 'https://example.test/x' }],
      ['web_search', { query: 'q' }]
    ] as const) {
      const needs = await needsApprovalOf(tools[name])(input, {
        toolCallId: `tc-ae-${name}`,
        messages: []
      })
      expect(needs, `${name} should auto-approve under acceptEdits`).toBe(false)
    }
  })

  test('retained: custom_agent 四写 (grant-minting CRUD — the rev3.1 §7 card IS the defense) → true', async () => {
    const { tools } = toolsOf('customAgents', 'acceptEdits')
    for (const [name, input] of [
      ['custom_agent_create', { name: 'a', prompt: 'p' }],
      ['custom_agent_update', { agent_id: 'a1', prompt: 'p2' }],
      ['custom_agent_delete', { agent_id: 'a1' }],
      ['custom_agent_run_now', { agent_id: 'a1' }]
    ] as const) {
      const needs = await needsApprovalOf(tools[name])(input, {
        toolCallId: `tc-ae-${name}`,
        messages: []
      })
      expect(needs, `${name} must stay HITL under acceptEdits`).toBe(true)
    }
  })

  test('exec: file_read / file_write auto-approve WITHOUT a whitelist round-trip; run_command keeps the whitelist-or-card path', async () => {
    const fw = toolsOf('exec', 'acceptEdits')
    for (const [name, input] of [
      ['file_read', { path: '/tmp/a.txt' }],
      ['file_write', { path: '/tmp/a.txt', content: 'x' }]
    ] as const) {
      const needs = await needsApprovalOf(fw.tools[name])(input, {
        toolCallId: `tc-ae-${name}`,
        messages: []
      })
      expect(needs, `${name} should auto-approve under acceptEdits`).toBe(false)
    }
    // released BEFORE the policyEvaluate branch → zero /agent/policy/evaluate calls.
    expect(fw.domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(0)
    // run_command (retain set) falls through to policyEvaluate: 'ask' verdict → the card.
    const rc = toolsOf('exec', 'acceptEdits')
    const needs = await needsApprovalOf(rc.tools.run_command)(
      { argv: ['echo', 'hi'] },
      { toolCallId: 'tc-ae-rc', messages: [] }
    )
    expect(needs).toBe(true)
    expect(rc.domainCalls.filter((u) => u.includes('/agent/policy/evaluate'))).toHaveLength(1)
  })

  test('retained: calendar 三写 (same (edit,domain_write) signature as draft_reply — by-NAME set) → true', async () => {
    const { tools } = toolsOf('calendarWrite', 'acceptEdits')
    for (const name of [
      'calendar_event_reschedule',
      'calendar_event_rsvp',
      'calendar_event_delete'
    ]) {
      const needs = await needsApprovalOf(tools[name])(
        { event_id: 'ev1' },
        { toolCallId: `tc-ae-${name}`, messages: [] }
      )
      expect(needs, `${name} must stay HITL under acceptEdits`).toBe(true)
    }
  })

  test('retained: skill supply chain (install/confirm/uninstall) → true', async () => {
    const { tools } = toolsOf('skillSupply', 'acceptEdits')
    for (const name of ['skill_install', 'skill_install_confirm', 'skill_uninstall']) {
      const needs = await needsApprovalOf(tools[name])(
        { source_url: 'https://example.test/p.zip', name: 's', package_hash: 'h' },
        { toolCallId: `tc-ae-${name}`, messages: [] }
      )
      expect(needs, `${name} must stay HITL under acceptEdits`).toBe(true)
    }
  })

  test('retained: the send NEVER relaxes under acceptEdits (bypassMode narrows to the bypass literal only)', async () => {
    const collector: GatewayToolAuditEntry[] = []
    const tools = createSendTools(
      mockDomain(() => okEnvelope({ sent: true })),
      collector,
      new ApprovalGuard(),
      {
        signingSecret: 's',
        contextMode: 'manual_chat',
        approvalMode: 'acceptEdits'
      }
    )
    const needs = await needsApprovalOf(tools.email_prepare_send)(
      { to: ['x@corp.test'], subject: 's', body_markdown: 'b' },
      { toolCallId: 'tc-ae-send', messages: [] }
    )
    expect(needs).toBe(true)
  })

  test('manual_chat-gated: acceptEdits under a non-manual mode never auto-approves', async () => {
    const { tools } = writeTools('acceptEdits', 'untrusted_trigger')
    const needs = await needsApprovalOf(tools.email_flag)(
      { internal_id: 9, is_flagged: true },
      { toolCallId: 'tc-ae-ut', messages: [] }
    )
    expect(needs).toBe(true)
  })
})

describe("07-16 'bypass' — everything auto-approves (owner 拍板: 无例外), manual_chat only", () => {
  test('domain writes + calendar 三写 + skill supply + custom agents + exec → all false', async () => {
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
    // guard chain intact on the skip: verified + consumed + audited with a content hash.
    // codex r1 P2-4 — the card-skipped send audits 'auto_bypass', NEVER the human 'approved'
    // (a bypass-mode real send must be distinguishable in incident forensics).
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

  test('BYPASS_STILL_ASK carve-out (codex HIGH-1): the pinned set + every member is a real classified tool', () => {
    // 'bypass' is 无例外 for THIS machine's own actions, but BYPASS_STILL_ASK keeps external-AI /
    // irreversible-outside tools 恒 HITL even here. Pinned verbatim (a set change is a deliberate
    // policy change); currently only notion_agent_chat.
    expect([...BYPASS_STILL_ASK].sort()).toEqual(['notion_agent_chat'])
    for (const name of BYPASS_STILL_ASK) {
      expect(
        GATEWAY_TOOL_CLASSES[name],
        `${name} must exist in GATEWAY_TOOL_CLASSES — a rename would orphan its bypass carve-out`
      ).toBeDefined()
      // it must also be in the ASK set for acceptEdits (both modes keep it HITL).
      expect(ACCEPT_EDITS_ASK_TOOLS.has(name)).toBe(true)
    }
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
