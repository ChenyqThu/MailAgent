// S2 W0 (task 07-02-s2-exec-skill-install, ADR-001) — context-mode × tool-class policy matrix.
//
// Proves: (1) fail-closed normalization (absent/unknown mode → 'untrusted_trigger'; unclassified
// tool → 'exec'); (2) the full 3-mode × 5-class registration + auto-approve matrix; (3)
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
    ...(contextMode !== undefined ? { contextMode } : {})
  })
}

const CLASSES_OF = (cls: GatewayToolClass): string[] =>
  Object.entries(GATEWAY_TOOL_CLASSES)
    .filter(([, c]) => c === cls)
    .map(([n]) => n)

describe('normalizeContextMode — fail-closed', () => {
  test('the three known modes pass through', () => {
    for (const m of AGENT_CONTEXT_MODES) expect(normalizeContextMode(m)).toBe(m)
  })

  test('absent / unknown / near-miss values → untrusted_trigger (strictest)', () => {
    for (const v of [undefined, null, '', 'manual', 'MANUAL_CHAT', ' manual_chat', 42, {}, []]) {
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
    expect(classOfTool('email_search')).toBe('read')
  })

  test('an unclassified name fail-closes to exec (strictest class)', () => {
    expect(classOfTool('some_future_tool')).toBe('exec')
    expect(classOfTool('')).toBe('exec')
  })
})

describe('matrix — isToolClassAllowedInMode (registration) × mayAutoApprove (card skip)', () => {
  // The full 3×6 matrix, spelled out (ADR-001 D3, 'web' class added by ADR-004 rev3.1):
  // registration allows read/domain_write everywhere and restricts
  // capability_change/exec/web/outbound to manual_chat (no grants); auto-approve is
  // domain_write × manual_chat ONLY.
  const REGISTRATION_EXPECTED: Record<AgentContextMode, Record<GatewayToolClass, boolean>> = {
    manual_chat: {
      read: true,
      domain_write: true,
      capability_change: true,
      exec: true,
      web: true,
      outbound: true
    },
    untrusted_trigger: {
      read: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      web: false,
      outbound: false
    },
    cron_headless: {
      read: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      web: false,
      outbound: false
    }
  }

  test.each(AGENT_CONTEXT_MODES)('registration row — %s', (mode) => {
    for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
      expect(isToolClassAllowedInMode(cls, mode), `${cls} in ${mode}`).toBe(
        REGISTRATION_EXPECTED[mode][cls]
      )
    }
  })

  test('mayAutoApprove — true ONLY for domain_write × manual_chat (15 cells)', () => {
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const expected = cls === 'domain_write' && mode === 'manual_chat'
        expect(mayAutoApprove(cls, mode), `${cls} in ${mode}`).toBe(expected)
      }
    }
  })
})

// S5 W4 (ADR-004 D2/§9) + S6 W3 (rev3.1 web axis) — the matrix's THIRD axis: per-agent grants.
// Invariants pinned: capability_change/outbound (send) are false under ANY grants (structurally
// un-grantable — the type has only exec + web keys, and junk keys/values must have no effect);
// grants are consumed ONLY outside manual_chat (manual is true regardless); exec flips ONLY on
// the discriminated `exec === true`; web flips ONLY on the exact 'gated'/'open' literals.
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
    }
  ]

  test.each(GRANTS_AXIS)('registration under grants=$label', ({ grants }) => {
    const execGranted = grants?.exec === true
    const webGranted = grants?.web === 'gated' || grants?.web === 'open'
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const expected =
          mode === 'manual_chat'
            ? true // grants never consulted in manual
            : cls === 'read' || cls === 'domain_write'
              ? true
              : cls === 'exec'
                ? execGranted
                : cls === 'web'
                  ? webGranted
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

describe('applyContextModePolicy', () => {
  test('manual_chat is an identity pass-through (same object — zero diff on production runs)', () => {
    const tools = buildAllTools('manual_chat')
    expect(applyContextModePolicy(tools, 'manual_chat')).toBe(tools)
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    '%s strips capability_change/exec/web/outbound, keeps read + domain_write (key order preserved)',
    (mode) => {
      const tools = buildAllTools('manual_chat')
      const filtered = applyContextModePolicy(tools, mode)
      for (const name of Object.keys(filtered)) {
        expect(['read', 'domain_write']).toContain(classOfTool(name))
      }
      for (const name of Object.keys(tools)) {
        const cls = classOfTool(name)
        if (cls === 'read' || cls === 'domain_write') {
          expect(filtered[name], `${name} (${cls}) must survive ${mode}`).toBeDefined()
        } else {
          expect(filtered[name], `${name} (${cls}) must be dropped in ${mode}`).toBeUndefined()
        }
      }
      // order of the surviving keys is preserved (Object.entries iteration)
      expect(Object.keys(filtered)).toEqual(
        Object.keys(tools).filter((n) => ['read', 'domain_write'].includes(classOfTool(n)))
      )
    }
  )

  test('an unclassified tool is dropped outside manual_chat (fail-closed via exec)', () => {
    const tools = buildAllTools('manual_chat')
    const withUnknown = { ...tools, some_future_tool: tools.email_search }
    const filtered = applyContextModePolicy(withUnknown, 'untrusted_trigger')
    expect(filtered.some_future_tool).toBeUndefined()
  })
})

describe('buildGatewayTools × contextMode (registration-time filter wiring)', () => {
  test('manual_chat → the FULL flag-on set (byte-identical keys to the pre-W0 assembly — W0 adds/removes no tool)', () => {
    const keys = Object.keys(buildAllTools('manual_chat')).sort()
    // The 30 gateway tools of the current full flag-on set = exactly the classified universe
    // (27 pre-W1 + the 3 S2 W1 exec tools).
    expect(keys).toEqual(Object.keys(GATEWAY_TOOL_CLASSES).sort())
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
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
})

describe('drift guards — classification completeness + eval catalog mirror', () => {
  test('FORWARD: every real gateway tool (all flags on, manual_chat) is classified', () => {
    const unclassified = Object.keys(buildAllTools('manual_chat')).filter(
      (n) => GATEWAY_TOOL_CLASSES[n] === undefined
    )
    expect(unclassified).toEqual([])
  })

  test('REVERSE: every classified name exists as a real gateway tool (catches rename/delete)', () => {
    const real = new Set(Object.keys(buildAllTools('manual_chat')))
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
