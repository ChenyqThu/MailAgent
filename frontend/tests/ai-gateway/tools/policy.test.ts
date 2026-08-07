// S2 W0 (task 07-02-s2-exec-skill-install, ADR-001) — context-mode × tool-class policy matrix.
//
// Proves: (1) fail-closed normalization (absent/unknown mode → 'untrusted_trigger'; unclassified
// tool → 'exec'); (2) the full 3-mode × 7-class registration + auto-approve matrix; (3)
// applyContextModePolicy is an identity in manual_chat (byte-level: current production behaviour
// unchanged) and strips capability_change/exec/outbound outside it; (4) completeness drift guard —
// every REAL gateway tool is classified in GATEWAY_TOOL_CLASSES and vice versa; (5) the eval
// catalog (tests/agent_eval/tool_catalog.json) mirrors the TS single source per name.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import {
  AGENT_CONTEXT_MODES,
  GATEWAY_TOOL_CLASS_VALUES,
  GATEWAY_TOOL_CLASSES,
  applyContextModePolicy,
  classOfTool,
  isToolClassAllowedInMode,
  mayAutoApprove,
  normalizeContextMode,
  parseConnectorGrants,
  parseWebGrant,
  type AgentContextMode,
  type AgentModeGrants,
  type GatewayToolClass
} from '../../../src/ai-gateway/tools/policy'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { mockDomain, okEnvelope } from './_helpers'

/** The FULL gateway tool set (every flag on) under an explicit mode — policy.test's source of
 *  truth for "every real gateway tool". Mirrors skill_gating.test's buildAllTools (🔴 keep the
 *  flag list in sync when a new tool-gating flag lands, same red-letter rule). */
function buildAllTools(contextMode?: AgentContextMode) {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    writeToolsEnabled: true,
    approvalGuard: new ApprovalGuard(),
    sendToolEnabled: true,
    sendSigningSecret: 'secret',
    skillGatingEnabled: true,
    sessionToolsEnabled: true,
    configToolsEnabled: true,
    webToolsEnabled: true,
    // S2 W1 — exec tools (MAILAGENT_OPENNESS_EXEC_TOOLS), classified 'exec' (manual-only).
    execToolsEnabled: true,
    // S2 W4 — skill-supply tools (MAILAGENT_OPENNESS_SKILL_INSTALL), classified capability_change
    // (writes) + read (skill_read).
    skillInstallToolsEnabled: true,
    // S5 W3 — custom-agent CRUD tools (MAILAGENT_CUSTOM_AGENTS_ENABLED), all classified
    // capability_change (2 silent reads + 4 edit writes).
    customAgentToolsEnabled: true,
    // calendar epic 4.1/4.2 — calendar tools (MAILAGENT_CALENDAR_AGENT_TOOLS), classified read
    // (2 silent reads) + domain_write (3 edit writes, 恒 HITL).
    calendarToolsEnabled: true,
    // task 07-21 — notion-agent tool (MAILAGENT_NOTION_AGENT_TOOL), classified 'outbound' (edit-tier
    // 恒 HITL, un-grantable → stripped headless). Built here so the FULL-set drift guards see it.
    notionAgentToolsEnabled: true,
    ...(contextMode !== undefined ? { contextMode } : {})
  })
}

const CONDITIONAL_HEADLESS_READ_TOOLS = new Set(['agent_catalog_list', 'agent_catalog_get'])

function buildGrantedHeadlessCatalogTools() {
  return buildGatewayTools({
    domain: mockDomain(() => okEnvelope([])),
    sessionProvenanceEnabled: true,
    contextMode: 'cron_headless',
    agentRunContext: {
      agentId: 'dms',
      allowedTools: ['chat_session_list'],
      skills: []
    }
  })
}

const CLASSES_OF = (cls: GatewayToolClass): string[] =>
  Object.entries(GATEWAY_TOOL_CLASSES)
    .filter(([, c]) => c === cls)
    .map(([n]) => n)

describe('normalizeContextMode — fail-closed', () => {
  test('the four known modes pass through', () => {
    for (const m of AGENT_CONTEXT_MODES) expect(normalizeContextMode(m)).toBe(m)
  })

  test('absent / unknown / near-miss values → untrusted_trigger (strictest)', () => {
    // 'im' is the trigger KIND (stage 0b), never a mode name — it must fail-close like any junk.
    for (const v of [
      undefined,
      null,
      '',
      'manual',
      'MANUAL_CHAT',
      ' manual_chat',
      'im',
      42,
      {},
      []
    ]) {
      expect(normalizeContextMode(v)).toBe('untrusted_trigger')
    }
  })
})

describe('classOfTool — single source + fail-closed', () => {
  test('classified names resolve from the map', () => {
    expect(classOfTool('email_flag')).toBe('domain_write')
    expect(classOfTool('set_skill_enabled')).toBe('capability_change')
    // ADR-004 rev3.1 §3.1 — web tools migrated out of 'outbound'; send stays outbound.
    expect(classOfTool('web_fetch')).toBe('web')
    expect(classOfTool('web_search')).toBe('web')
    expect(classOfTool('email_prepare_send')).toBe('outbound')
    expect(classOfTool('email_list_filter')).toBe('read')
  })

  test('an unclassified name fail-closes to exec (strictest class)', () => {
    expect(classOfTool('some_future_tool')).toBe('exec')
    expect(classOfTool('')).toBe('exec')
  })
})

describe('matrix — isToolClassAllowedInMode (registration) × mayAutoApprove (card skip)', () => {
  // The full 4×7 matrix, spelled out (artifact added by the custom-report epic; im_chat by
  // stage 0b — grill Q10=A): registration allows read/artifact/domain_write everywhere and
  // restricts capability_change/exec/web/outbound to manual_chat (no grants); auto-approve is
  // domain_write × manual_chat ONLY.
  const REGISTRATION_EXPECTED: Record<AgentContextMode, Record<GatewayToolClass, boolean>> = {
    manual_chat: {
      read: true,
      artifact: true,
      domain_write: true,
      capability_change: true,
      exec: true,
      web: true,
      outbound: true,
      connector_write: true
    },
    untrusted_trigger: {
      read: true,
      artifact: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      web: false,
      outbound: false,
      // stage 1 PR3 — connector writes without grants stay fail-closed in every non-manual mode
      // (漏配即 deny, pinned here); the per-connector grant lift is pinned in the 3-axis describe.
      connector_write: false
    },
    cron_headless: {
      read: true,
      artifact: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      web: false,
      outbound: false,
      connector_write: false
    },
    // 0b (grill Q10=A) → stage 2 PR-1 (08-04 拍板) — im_chat: reads free, domain writes
    // registered (恒 HITL via mayAutoApprove), connector_write registered (「全开放」— writes
    // stay 恒 HITL for the same reason), web false WITHOUT the venue switch (Q19=A default off —
    // the venue axis is pinned in its own describe below), exec/capability_change/outbound
    // hard-denied — and grants never lift anything, see the 3-axis describe below.
    im_chat: {
      read: true,
      artifact: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      web: false,
      outbound: false,
      connector_write: true
    }
  }

  test.each(AGENT_CONTEXT_MODES)('registration row — %s', (mode) => {
    for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
      expect(isToolClassAllowedInMode(cls, mode), `${cls} in ${mode}`).toBe(
        REGISTRATION_EXPECTED[mode][cls]
      )
    }
  })

  test('mayAutoApprove — true ONLY for domain_write × manual_chat (4 modes × 7 classes)', () => {
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const expected = cls === 'domain_write' && mode === 'manual_chat'
        expect(mayAutoApprove(cls, mode), `${cls} in ${mode}`).toBe(expected)
      }
    }
  })
})

// S5 W4 (ADR-004 D2/§9) + S6 W3 (rev3.1 web axis) + stage 1 PR3 (connector axis) — the matrix's
// THIRD axis: per-agent grants.
// Invariants pinned: capability_change/outbound (send) are false under ANY grants (structurally
// un-grantable — the type has only exec + web + connectors keys, and junk keys/values must have
// no effect); grants are consumed ONLY outside manual_chat (manual is true regardless); exec
// flips ONLY on the discriminated `exec === true`; web flips ONLY on the exact 'gated'/'open'
// literals; connector_write flips ONLY on a connectors record with a valid write-capable ceiling
// ('write'/'update' under a non-empty key — 'read'-only, 'delete', junk, empty keys all deny).
describe('matrix — 3-axis (class × mode × grants, ADR-004)', () => {
  // junk objects a buggy/hostile caller could smuggle in (runtime has no type erasure guard —
  // the function itself must only ever read the discriminated literals).
  const GRANTS_AXIS: Array<{ label: string; grants?: AgentModeGrants }> = [
    { label: 'undefined', grants: undefined },
    { label: '{}', grants: {} },
    { label: '{exec:true}', grants: { exec: true } },
    { label: '{exec:false}', grants: { exec: false } },
    { label: "{exec:'yes'} (junk value)", grants: { exec: 'yes' } as unknown as AgentModeGrants },
    { label: '{exec:1} (junk value)', grants: { exec: 1 } as unknown as AgentModeGrants },
    { label: "{web:'off'}", grants: { web: 'off' } },
    { label: "{web:'gated'}", grants: { web: 'gated' } },
    { label: "{web:'open'}", grants: { web: 'open' } },
    { label: "{exec:true, web:'open'}", grants: { exec: true, web: 'open' } },
    { label: '{web:true} (junk value)', grants: { web: true } as unknown as AgentModeGrants },
    { label: "{web:'yes'} (junk value)", grants: { web: 'yes' } as unknown as AgentModeGrants },
    { label: '{web:1} (junk value)', grants: { web: 1 } as unknown as AgentModeGrants },
    {
      label: '{outbound:true, capability_change:true} (junk keys)',
      grants: { outbound: true, capability_change: true } as unknown as AgentModeGrants
    },
    // stage 1 PR3 — the connector axis: real ceilings + every fail-closed junk shape.
    { label: "{connectors:{notion:'read'}}", grants: { connectors: { notion: 'read' } } },
    { label: "{connectors:{notion:'write'}}", grants: { connectors: { notion: 'write' } } },
    { label: "{connectors:{notion:'update'}}", grants: { connectors: { notion: 'update' } } },
    {
      label: "{connectors:{a:'read', b:'write'}} (mixed ceilings)",
      grants: { connectors: { a: 'read', b: 'write' } }
    },
    { label: '{connectors:{}} (empty)', grants: { connectors: {} } },
    {
      label: "{connectors:{notion:'delete'}} (excluded ceiling)",
      grants: { connectors: { notion: 'delete' } } as unknown as AgentModeGrants
    },
    {
      label: "{connectors:{notion:'yes'}} (junk value)",
      grants: { connectors: { notion: 'yes' } } as unknown as AgentModeGrants
    },
    {
      label: "{connectors:{'':'write'}} (empty key)",
      grants: { connectors: { '': 'write' } }
    },
    {
      label: "{connectors:'write'} (junk type)",
      grants: { connectors: 'write' } as unknown as AgentModeGrants
    },
    {
      label: "{exec:true, web:'open', connectors:{notion:'update'}} (all three)",
      grants: { exec: true, web: 'open', connectors: { notion: 'update' } }
    }
  ]

  /** Mirror of the connector_write row's semantics for computing expectations: ANY entry with a
   *  non-empty key and an exact 'write'/'update' value lifts the class row. */
  function connectorWriteGranted(grants?: AgentModeGrants): boolean {
    const raw = (grants as { connectors?: unknown } | undefined)?.connectors
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return false
    return Object.entries(raw).some(([k, v]) => k.length > 0 && (v === 'write' || v === 'update'))
  }

  test.each(GRANTS_AXIS)('registration under grants=$label', ({ grants }) => {
    const execGranted = grants?.exec === true
    const webGranted = grants?.web === 'gated' || grants?.web === 'open'
    const connectorGranted = connectorWriteGranted(grants)
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const expected =
          mode === 'manual_chat'
            ? true // grants never consulted in manual
            : cls === 'read' || cls === 'artifact' || cls === 'domain_write'
              ? true
              : mode === 'im_chat'
                ? // stage 2 PR-1 (08-04 拍板) — connector 全开放 in im_chat; every OTHER class
                  // keeps the hard floor and grants are STILL never consulted (web is the venue
                  // switch, pinned in its own describe — not part of the grants axis).
                  cls === 'connector_write'
                : cls === 'exec'
                  ? execGranted
                  : cls === 'web'
                    ? webGranted
                    : cls === 'connector_write'
                      ? connectorGranted // PR3 — the connector axis lifts ONLY its own row
                      : false // capability_change + outbound (send):恒 false under ANY grants
        expect(
          isToolClassAllowedInMode(cls, mode, grants),
          `${cls} × ${mode} × ${JSON.stringify(grants)}`
        ).toBe(expected)
      }
    }
  })

  test('applyContextModePolicy with an exec grant: exec tools survive a headless mode; capability_change/web/outbound still stripped', () => {
    const tools = buildAllTools('manual_chat')
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      const filtered = applyContextModePolicy(tools, mode, { exec: true })
      for (const name of CLASSES_OF('exec')) {
        expect(filtered[name], `${name} (exec) must survive ${mode} under the grant`).toBeDefined()
      }
      for (const name of [
        ...CLASSES_OF('capability_change'),
        ...CLASSES_OF('web'),
        ...CLASSES_OF('outbound')
      ]) {
        expect(
          filtered[name],
          `${name} must stay stripped in ${mode} despite the grant`
        ).toBeUndefined()
      }
    }
  })

  test.each(['gated', 'open'] as const)(
    "applyContextModePolicy with {web:'%s'}: web tools survive a headless mode; exec/capability_change/outbound still stripped",
    (tier) => {
      const tools = buildAllTools('manual_chat')
      for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
        const filtered = applyContextModePolicy(tools, mode, { web: tier })
        for (const name of CLASSES_OF('web')) {
          expect(filtered[name], `${name} (web) must survive ${mode} under the grant`).toBeDefined()
        }
        for (const name of [
          ...CLASSES_OF('exec'),
          ...CLASSES_OF('capability_change'),
          ...CLASSES_OF('outbound')
        ]) {
          expect(
            filtered[name],
            `${name} must stay stripped in ${mode} despite the web grant`
          ).toBeUndefined()
        }
      }
    }
  )

  test('applyContextModePolicy in manual_chat ignores grants entirely (same identity pass-through object)', () => {
    const tools = buildAllTools('manual_chat')
    expect(applyContextModePolicy(tools, 'manual_chat', { exec: true })).toBe(tools)
  })

  test("0b (Q10=A) — im_chat ignores grants entirely: even {exec:true, web:'open'} lifts NOTHING", () => {
    const tools = buildAllTools('manual_chat')
    const filtered = applyContextModePolicy(tools, 'im_chat', { exec: true, web: 'open' })
    for (const name of [
      ...CLASSES_OF('exec'),
      ...CLASSES_OF('web'),
      ...CLASSES_OF('capability_change'),
      ...CLASSES_OF('outbound')
    ]) {
      expect(filtered[name], `${name} must stay stripped in im_chat despite grants`).toBeUndefined()
    }
    for (const name of [
      ...CLASSES_OF('read'),
      ...CLASSES_OF('artifact'),
      ...CLASSES_OF('domain_write')
    ]) {
      if (CONDITIONAL_HEADLESS_READ_TOOLS.has(name)) {
        expect(filtered[name], `${name} is headless+grant only, never an im_chat tool`).toBeUndefined()
        continue
      }
      expect(filtered[name], `${name} must survive im_chat`).toBeDefined()
    }
  })

  test('buildGatewayTools × agentRunContext: the exec/web grants reach the LAST assembly step', () => {
    const build = (grants?: AgentModeGrants) =>
      buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        execToolsEnabled: true,
        webToolsEnabled: true,
        contextMode: 'cron_headless',
        ...(grants !== undefined
          ? { agentRunContext: { agentId: 'dms', allowedTools: [], modeGrants: grants } }
          : {})
      })
    // no context → exec + web absent (the S2 floor)
    expect(build(undefined).run_command).toBeUndefined()
    expect(build(undefined).web_fetch).toBeUndefined()
    // discriminated true → the three exec tools register (still HITL'd per-call by evaluate)
    const granted = build({ exec: true })
    for (const name of ['run_command', 'file_read', 'file_write']) {
      expect(granted[name], `${name} must register under the grant`).toBeDefined()
    }
    // junk value → no registration (only `exec === true` counts)
    expect(build({ exec: 'yes' } as unknown as AgentModeGrants).run_command).toBeUndefined()
    // web grant (rev3.1): gated/open register the two web tools; junk collapses to off
    for (const tier of ['gated', 'open'] as const) {
      const webGranted = build({ web: tier })
      expect(webGranted.web_fetch, `web_fetch must register under web:'${tier}'`).toBeDefined()
      expect(webGranted.web_search, `web_search must register under web:'${tier}'`).toBeDefined()
      expect(webGranted.run_command).toBeUndefined() // web grant lifts web ONLY
    }
    expect(build({ web: 'yes' } as unknown as AgentModeGrants).web_fetch).toBeUndefined()
    expect(build({ web: 'off' }).web_fetch).toBeUndefined()
    // exec grant lifts exec ONLY: web stays floored without its own grant
    expect(granted.web_fetch).toBeUndefined()
    expect(granted.web_search).toBeUndefined()
    // capability_change/outbound (send) stay absent even under any grant
    expect(granted.skill_install).toBeUndefined()
    expect(granted.email_prepare_send).toBeUndefined()
    expect(build({ exec: true, web: 'open' } as AgentModeGrants).email_prepare_send).toBeUndefined()
  })
})

// Stage 2 PR-1 (grill Q19=A) — the im web VENUE switch (MAILAGENT_IM_WEB_ENABLED): a per-venue
// owner switch, 🔴 deliberately NOT a grant (the grants axis above never lifts web in im_chat).
describe('im_chat web venue switch (Q19=A — an independent switch, never a grant)', () => {
  test('the venue switch lifts ONLY web × im_chat — full 4×8 sweep against the no-venue base', () => {
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const base = isToolClassAllowedInMode(cls, mode)
        const withVenue = isToolClassAllowedInMode(cls, mode, undefined, { imWebEnabled: true })
        const expected = mode === 'im_chat' && cls === 'web' ? true : base
        expect(withVenue, `${cls} × ${mode} × venue(imWebEnabled:true)`).toBe(expected)
      }
    }
  })

  test('fail-closed: only the exact literal true opens the im web row', () => {
    for (const v of [undefined, null, false, 'true', 'yes', 1, {}]) {
      expect(
        isToolClassAllowedInMode('web', 'im_chat', undefined, {
          imWebEnabled: v as unknown as boolean
        }),
        JSON.stringify(v)
      ).toBe(false)
    }
    expect(isToolClassAllowedInMode('web', 'im_chat')).toBe(false)
  })

  test('applyContextModePolicy: an im run keeps web tools ONLY under the venue switch; the hard floor stays', () => {
    const tools = buildAllTools('manual_chat')
    const off = applyContextModePolicy(tools, 'im_chat')
    for (const name of CLASSES_OF('web')) {
      expect(off[name], `${name} must be stripped with the switch off`).toBeUndefined()
    }
    const on = applyContextModePolicy(tools, 'im_chat', undefined, { imWebEnabled: true })
    for (const name of CLASSES_OF('web')) {
      expect(on[name], `${name} must survive im_chat under the switch`).toBeDefined()
    }
    for (const name of [
      ...CLASSES_OF('exec'),
      ...CLASSES_OF('capability_change'),
      ...CLASSES_OF('outbound')
    ]) {
      expect(on[name], `${name} must stay stripped despite the switch`).toBeUndefined()
    }
  })

  test('buildGatewayTools × imWebEnabled: web registers in im_chat only — never a headless lift', () => {
    const build = (mode: AgentContextMode, imWebEnabled: boolean) =>
      buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        webToolsEnabled: true,
        contextMode: mode,
        imWebEnabled
      })
    expect(build('im_chat', false).web_fetch).toBeUndefined()
    const imOn = build('im_chat', true)
    expect(imOn.web_fetch).toBeDefined()
    expect(imOn.web_search).toBeDefined()
    // NOT a grant: the switch never lifts web (or anything else) in a headless mode.
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      const headless = build(mode, true)
      expect(headless.web_fetch, `web_fetch must stay stripped in ${mode}`).toBeUndefined()
      expect(headless.web_search, `web_search must stay stripped in ${mode}`).toBeUndefined()
    }
    // manual is an identity pass-through either way.
    expect(build('manual_chat', false).web_fetch).toBeDefined()
  })
})

// S6 W3 (ADR-004 rev3.1 D1) — the fail-closed web-grant parse funnel.
describe('parseWebGrant — fail-closed literal discrimination', () => {
  test("the exact 'gated'/'open' literals pass through", () => {
    expect(parseWebGrant('gated')).toBe('gated')
    expect(parseWebGrant('open')).toBe('open')
  })

  test("everything else collapses to 'off' (never a raw passthrough)", () => {
    for (const v of [
      undefined,
      null,
      '',
      'off',
      true,
      false,
      1,
      0,
      'yes',
      'OPEN',
      ' open',
      'Gated',
      {},
      [],
      ['open']
    ]) {
      expect(parseWebGrant(v), JSON.stringify(v)).toBe('off')
    }
  })
})

// Stage 1 PR3 — the fail-closed connector-grant parse funnel (per-entry, then empty→undefined).
describe('parseConnectorGrants — fail-closed per-entry discrimination', () => {
  test('exact read/write/update literals under non-empty keys pass through', () => {
    expect(parseConnectorGrants({ notion: 'read' })).toEqual({ notion: 'read' })
    expect(parseConnectorGrants({ notion: 'write', atlassian: 'update' })).toEqual({
      notion: 'write',
      atlassian: 'update'
    })
  })

  test("junk entries drop PER-ENTRY ('delete' included — the ceiling vocabulary has no delete)", () => {
    expect(
      parseConnectorGrants({ notion: 'delete', atlassian: 'update', jira: 'yes', '': 'write' })
    ).toEqual({ atlassian: 'update' })
  })

  test('empty / non-object / all-junk shapes collapse to undefined (no connector grants)', () => {
    for (const v of [
      undefined,
      null,
      '',
      'write',
      42,
      true,
      [],
      ['write'],
      {},
      { notion: 'delete' },
      { notion: 'WRITE' },
      { notion: true },
      { notion: 1 },
      { '': 'update' }
    ]) {
      expect(parseConnectorGrants(v), JSON.stringify(v)).toBeUndefined()
    }
  })
})

describe('applyContextModePolicy', () => {
  test('manual_chat is an identity pass-through (same object — zero diff on production runs)', () => {
    const tools = buildAllTools('manual_chat')
    expect(applyContextModePolicy(tools, 'manual_chat')).toBe(tools)
  })

  test.each(['untrusted_trigger', 'cron_headless', 'im_chat'] as const)(
    '%s strips capability_change/exec/web/outbound, keeps read + artifact + domain_write (key order preserved)',
    (mode) => {
      const tools = buildAllTools('manual_chat')
      const filtered = applyContextModePolicy(tools, mode)
      for (const name of Object.keys(filtered)) {
        expect(['read', 'artifact', 'domain_write']).toContain(classOfTool(name))
      }
      for (const name of Object.keys(tools)) {
        const cls = classOfTool(name)
        if (cls === 'read' || cls === 'artifact' || cls === 'domain_write') {
          expect(filtered[name], `${name} (${cls}) must survive ${mode}`).toBeDefined()
        } else {
          expect(filtered[name], `${name} (${cls}) must be dropped in ${mode}`).toBeUndefined()
        }
      }
      // order of the surviving keys is preserved (Object.entries iteration)
      expect(Object.keys(filtered)).toEqual(
        Object.keys(tools).filter((n) =>
          ['read', 'artifact', 'domain_write'].includes(classOfTool(n))
        )
      )
    }
  )

  test('an unclassified tool is dropped outside manual_chat (fail-closed via exec)', () => {
    const tools = buildAllTools('manual_chat')
    const withUnknown = { ...tools, some_future_tool: tools.email_list_filter }
    const filtered = applyContextModePolicy(withUnknown, 'untrusted_trigger')
    expect(filtered.some_future_tool).toBeUndefined()
  })
})

describe('buildGatewayTools × contextMode (registration-time filter wiring)', () => {
  test('manual_chat → the FULL flag-on set (byte-identical keys to the pre-W0 assembly — W0 adds/removes no tool)', () => {
    const keys = Object.keys(buildAllTools('manual_chat')).sort()
    const expected = Object.keys(GATEWAY_TOOL_CLASSES)
      .filter((name) => !CONDITIONAL_HEADLESS_READ_TOOLS.has(name))
      .sort()
    expect(keys).toEqual(expected)
  })

  // W6 — the ONE read-class tool with a registration-time VENUE gate: suggest_followups is
  // interactive UI supply (composer-top chips + the hasToolCall stop condition), registered only
  // in manual_chat. The class matrix's "reads register everywhere" deliberately does not apply to
  // it — see the registration comment in tools/index.ts.
  const VENUE_GATED_READ_TOOLS = new Set([
    'suggest_followups',
    ...CONDITIONAL_HEADLESS_READ_TOOLS
  ])

  test.each(['untrusted_trigger', 'cron_headless', 'im_chat'] as const)(
    '%s → every capability_change/exec/web/outbound tool absent from the ToolSet; read + domain_write present',
    (mode) => {
      const tools = buildAllTools(mode)
      for (const name of [
        ...CLASSES_OF('capability_change'),
        ...CLASSES_OF('exec'),
        ...CLASSES_OF('web'),
        ...CLASSES_OF('outbound')
      ]) {
        expect(tools[name], `${name} must not register in ${mode}`).toBeUndefined()
      }
      for (const name of [...CLASSES_OF('read'), ...CLASSES_OF('domain_write')]) {
        if (VENUE_GATED_READ_TOOLS.has(name)) {
          expect(
            tools[name],
            `${name} is venue/grant-gated — must NOT register in this ${mode} build`
          ).toBeUndefined()
          continue
        }
        expect(tools[name], `${name} must register in ${mode}`).toBeDefined()
      }
    }
  )

  test('absent contextMode fail-closes to untrusted_trigger (NOT manual_chat)', () => {
    const absent = Object.keys(buildAllTools(undefined)).sort()
    const untrusted = Object.keys(buildAllTools('untrusted_trigger')).sort()
    expect(absent).toEqual(untrusted)
    expect(absent).not.toContain('set_skill_enabled')
    expect(absent).not.toContain('web_fetch')
    expect(absent).not.toContain('email_prepare_send')
    expect(absent).not.toContain('run_command')
  })

  test('agent catalog registers only for headless provenance + knowledge/session grant', () => {
    expect(buildAllTools('manual_chat').agent_catalog_list).toBeUndefined()
    expect(buildAllTools('im_chat').agent_catalog_get).toBeUndefined()
    expect(buildAllTools('cron_headless').agent_catalog_list).toBeUndefined()

    const granted = buildGrantedHeadlessCatalogTools()
    expect(granted.agent_catalog_list).toBeDefined()
    expect(granted.agent_catalog_get).toBeDefined()

    const flagOff = buildGatewayTools({
      domain: mockDomain(() => okEnvelope([])),
      sessionProvenanceEnabled: false,
      contextMode: 'cron_headless',
      agentRunContext: { agentId: 'dms', allowedTools: ['chat_session_list'], skills: [] }
    })
    expect(flagOff.agent_catalog_list).toBeUndefined()
    expect(flagOff.agent_catalog_get).toBeUndefined()
  })
})

describe('drift guards — classification completeness + eval catalog mirror', () => {
  test('FORWARD: every real gateway tool (all flags on, manual_chat) is classified', () => {
    const unclassified = Object.keys(buildAllTools('manual_chat')).filter(
      (n) => GATEWAY_TOOL_CLASSES[n] === undefined
    )
    expect(unclassified).toEqual([])
  })

  test('REVERSE: every classified name exists as a real gateway tool (catches rename/delete)', () => {
    const real = new Set([
      ...Object.keys(buildAllTools('manual_chat')),
      ...Object.keys(buildGrantedHeadlessCatalogTools())
    ])
    for (const name of Object.keys(GATEWAY_TOOL_CLASSES)) {
      expect(real.has(name), `${name} classified but not a real gateway tool`).toBe(true)
    }
  })

  test('tests/agent_eval/tool_catalog.json mirrors GATEWAY_TOOL_CLASSES per name; every entry carries a valid tool_class', () => {
    const catalogPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../tests/agent_eval/tool_catalog.json'
    )
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
      tools: Record<string, { tool_class?: string }>
    }
    // every catalog entry (legacy + gateway) carries a valid class value
    for (const [name, entry] of Object.entries(catalog.tools)) {
      expect(
        GATEWAY_TOOL_CLASS_VALUES as readonly string[],
        `catalog entry ${name} missing/invalid tool_class`
      ).toContain(entry.tool_class ?? '')
    }
    // gateway tools: the catalog mirrors the TS single source exactly
    for (const [name, cls] of Object.entries(GATEWAY_TOOL_CLASSES)) {
      expect(catalog.tools[name], `${name} missing from tool_catalog.json`).toBeDefined()
      expect(catalog.tools[name].tool_class, `tool_class drift for ${name}`).toBe(cls)
    }
  })
})
