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
    expect(classOfTool('web_fetch')).toBe('outbound')
    expect(classOfTool('email_search')).toBe('read')
  })

  test('an unclassified name fail-closes to exec (strictest class)', () => {
    expect(classOfTool('some_future_tool')).toBe('exec')
    expect(classOfTool('')).toBe('exec')
  })
})

describe('matrix — isToolClassAllowedInMode (registration) × mayAutoApprove (card skip)', () => {
  // The full 3×5 matrix, spelled out (ADR-001 D3): registration allows read/domain_write
  // everywhere and restricts capability_change/exec/outbound to manual_chat; auto-approve is
  // domain_write × manual_chat ONLY.
  const REGISTRATION_EXPECTED: Record<AgentContextMode, Record<GatewayToolClass, boolean>> = {
    manual_chat: {
      read: true,
      domain_write: true,
      capability_change: true,
      exec: true,
      outbound: true
    },
    untrusted_trigger: {
      read: true,
      domain_write: true,
      capability_change: false,
      exec: false,
      outbound: false
    },
    cron_headless: {
      read: true,
      domain_write: true,
      capability_change: false,
      exec: false,
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

// S5 W4 (ADR-004 D2/§9) — the matrix's THIRD axis: per-agent grants. Three invariants pinned:
// capability_change/outbound are false under ANY grants (structurally un-grantable — the type has
// only an exec key, and junk keys must have no effect); grants are consumed ONLY outside
// manual_chat (manual is true regardless); exec flips ONLY on the discriminated `exec === true`.
describe('matrix — 3-axis (class × mode × grants, ADR-004)', () => {
  // junk objects a buggy/hostile caller could smuggle in (runtime has no type erasure guard —
  // the function itself must only ever read `exec === true`).
  const GRANTS_AXIS: Array<{ label: string; grants?: AgentModeGrants }> = [
    { label: 'undefined', grants: undefined },
    { label: '{}', grants: {} },
    { label: '{exec:true}', grants: { exec: true } },
    { label: '{exec:false}', grants: { exec: false } },
    { label: "{exec:'yes'} (junk value)", grants: { exec: 'yes' } as unknown as AgentModeGrants },
    { label: '{exec:1} (junk value)', grants: { exec: 1 } as unknown as AgentModeGrants },
    {
      label: '{web:true, outbound:true, capability_change:true} (junk keys)',
      grants: { web: true, outbound: true, capability_change: true } as unknown as AgentModeGrants
    }
  ]

  test.each(GRANTS_AXIS)('registration under grants=$label', ({ grants }) => {
    const execGranted = grants?.exec === true
    for (const mode of AGENT_CONTEXT_MODES) {
      for (const cls of GATEWAY_TOOL_CLASS_VALUES) {
        const expected =
          mode === 'manual_chat'
            ? true // grants never consulted in manual
            : cls === 'read' || cls === 'domain_write'
              ? true
              : cls === 'exec'
                ? execGranted
                : false // capability_change + outbound:恒 false under ANY grants
        expect(isToolClassAllowedInMode(cls, mode, grants), `${cls} × ${mode} × ${JSON.stringify(grants)}`).toBe(
          expected
        )
      }
    }
  })

  test('applyContextModePolicy with an exec grant: exec tools survive a headless mode; capability_change/outbound still stripped', () => {
    const tools = buildAllTools('manual_chat')
    for (const mode of ['untrusted_trigger', 'cron_headless'] as const) {
      const filtered = applyContextModePolicy(tools, mode, { exec: true })
      for (const name of CLASSES_OF('exec')) {
        expect(filtered[name], `${name} (exec) must survive ${mode} under the grant`).toBeDefined()
      }
      for (const name of [...CLASSES_OF('capability_change'), ...CLASSES_OF('outbound')]) {
        expect(filtered[name], `${name} must stay stripped in ${mode} despite the grant`).toBeUndefined()
      }
    }
  })

  test('applyContextModePolicy in manual_chat ignores grants entirely (same identity pass-through object)', () => {
    const tools = buildAllTools('manual_chat')
    expect(applyContextModePolicy(tools, 'manual_chat', { exec: true })).toBe(tools)
  })

  test('buildGatewayTools × agentRunContext: the exec grant reaches the LAST assembly step', () => {
    const build = (grants?: AgentModeGrants) =>
      buildGatewayTools({
        domain: mockDomain(() => okEnvelope([])),
        writeToolsEnabled: true,
        approvalGuard: new ApprovalGuard(),
        execToolsEnabled: true,
        contextMode: 'cron_headless',
        ...(grants !== undefined
          ? { agentRunContext: { agentId: 'dms', allowedTools: [], modeGrants: grants } }
          : {})
      })
    // no context → exec absent (the S2 floor)
    expect(build(undefined).run_command).toBeUndefined()
    // discriminated true → the three exec tools register (still HITL'd per-call by evaluate)
    const granted = build({ exec: true })
    for (const name of ['run_command', 'file_read', 'file_write']) {
      expect(granted[name], `${name} must register under the grant`).toBeDefined()
    }
    // junk value → no registration (only `exec === true` counts)
    expect(build({ exec: 'yes' } as unknown as AgentModeGrants).run_command).toBeUndefined()
    // capability_change/outbound stay absent even under the grant
    expect(granted.skill_install).toBeUndefined()
    expect(granted.web_fetch).toBeUndefined()
    expect(granted.email_prepare_send).toBeUndefined()
  })
})

describe('applyContextModePolicy', () => {
  test('manual_chat is an identity pass-through (same object — zero diff on production runs)', () => {
    const tools = buildAllTools('manual_chat')
    expect(applyContextModePolicy(tools, 'manual_chat')).toBe(tools)
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    '%s strips capability_change/exec/outbound, keeps read + domain_write (key order preserved)',
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
  test("manual_chat → the FULL flag-on set (byte-identical keys to the pre-W0 assembly — W0 adds/removes no tool)", () => {
    const keys = Object.keys(buildAllTools('manual_chat')).sort()
    // The 30 gateway tools of the current full flag-on set = exactly the classified universe
    // (27 pre-W1 + the 3 S2 W1 exec tools).
    expect(keys).toEqual(Object.keys(GATEWAY_TOOL_CLASSES).sort())
  })

  test.each(['untrusted_trigger', 'cron_headless'] as const)(
    '%s → every capability_change/exec/outbound tool absent from the ToolSet; read + domain_write present',
    (mode) => {
      const tools = buildAllTools(mode)
      for (const name of [
        ...CLASSES_OF('capability_change'),
        ...CLASSES_OF('exec'),
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
