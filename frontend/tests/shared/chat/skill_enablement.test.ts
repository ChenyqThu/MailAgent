// P3 (task 06-18-custom-ai-harness-agent Phase 3) — skill enablement compute.
//
// The TOOL-FILTER half of acceptance ③ ("Skill 开关关闭后 tool 与 prompt fragment
// 均不注入"): proves a disabled OR unavailable skill's tools land in
// disabledToolNames (so the runtime drops them from the catalog) AND its prompt
// fragment is excluded from skillFragments. The PROMPT-ASSEMBLY half (the soul
// prefix only injects a non-empty skillFragments) is covered in soul.test.ts.
//
// Runs in the default node env (matching sibling shared/chat tests); the
// localStorage round-trip stubs a minimal in-memory localStorage via vi.stubGlobal
// so it's env-independent (production reads the renderer/browser localStorage).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  computeSkillEnablement,
  readSkillOverrides,
  resolveSkills,
  setSkillOverride,
  SKILL_OVERRIDES_KEY
} from '../../../src/shared/chat/skill_enablement'
import type {
  ManifestSkillDef,
  ManifestToolDef,
  SkillManifest
} from '../../../src/shared/chat/tools/manifest'

function tool(name: string, scopes: string[] = []): ManifestToolDef {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    confirmation_tier: 'none',
    side_effect: 'read',
    auth_scopes: scopes,
    mcp_exposed: true,
    handler: { kind: 'service', target: name }
  }
}

function skill(
  name: string,
  opts: {
    defaultEnabled: boolean
    available: boolean
    reason?: string | null
    fragment: string
    tools: ManifestToolDef[]
  }
): ManifestSkillDef {
  return {
    name,
    version: '1.0',
    title: name,
    description: `${name} skill`,
    default_enabled: opts.defaultEnabled,
    availability: { available: opts.available, reason: opts.reason ?? null },
    prompt_fragment: opts.fragment,
    docs_path: `${name}.md`,
    tools: opts.tools
  }
}

const MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  generated_at: '2026-06-21',
  server_version: 'test',
  capabilities: {},
  skills: [
    skill('report', {
      defaultEnabled: true,
      available: true,
      fragment: 'REPORT_FRAG',
      tools: [
        tool('report_list', ['report:read']),
        tool('report_get'),
        tool('report_run', ['report:run'])
      ]
    }),
    skill('calendar', {
      defaultEnabled: true,
      available: true,
      fragment: 'CAL_FRAG',
      tools: [tool('calendar_list')]
    }),
    skill('notion_agent', {
      defaultEnabled: false,
      available: true,
      fragment: 'NOTION_FRAG',
      tools: [tool('notion_agent_chat')]
    }),
    skill('kos', {
      defaultEnabled: true,
      available: false,
      reason: 'KOS credentials missing',
      fragment: 'KOS_FRAG',
      tools: [tool('kos_query')]
    })
  ]
}

describe('computeSkillEnablement — defaults (no overrides)', () => {
  const e = computeSkillEnablement(MANIFEST, {})

  test('enabled+available skills inject their fragments', () => {
    expect(e.skillFragments).toContain('REPORT_FRAG')
    expect(e.skillFragments).toContain('CAL_FRAG')
  })

  test('enabled+available skills keep their tools (not in disabledToolNames)', () => {
    for (const name of ['report_list', 'report_get', 'report_run', 'calendar_list']) {
      expect(e.disabledToolNames.has(name)).toBe(false)
    }
  })

  test('default-disabled skill (notion_agent) drops tools + fragment', () => {
    expect(e.disabledToolNames.has('notion_agent_chat')).toBe(true)
    expect(e.skillFragments).not.toContain('NOTION_FRAG')
  })

  test('unavailable skill (kos) drops tools + fragment even though default-enabled', () => {
    expect(e.disabledToolNames.has('kos_query')).toBe(true)
    expect(e.skillFragments).not.toContain('KOS_FRAG')
  })
})

describe('computeSkillEnablement — user overrides', () => {
  test('disabling report drops its tools + fragment; calendar unaffected', () => {
    const e = computeSkillEnablement(MANIFEST, { report: false })
    expect(e.disabledToolNames.has('report_list')).toBe(true)
    expect(e.disabledToolNames.has('report_get')).toBe(true)
    expect(e.disabledToolNames.has('report_run')).toBe(true)
    expect(e.skillFragments).not.toContain('REPORT_FRAG')
    // calendar still advertised
    expect(e.disabledToolNames.has('calendar_list')).toBe(false)
    expect(e.skillFragments).toContain('CAL_FRAG')
  })

  test('enabling a default-off available skill (notion_agent) advertises it', () => {
    const e = computeSkillEnablement(MANIFEST, { notion_agent: true })
    expect(e.disabledToolNames.has('notion_agent_chat')).toBe(false)
    expect(e.skillFragments).toContain('NOTION_FRAG')
  })

  test('enabling an UNAVAILABLE skill still drops it (availability gate wins)', () => {
    const e = computeSkillEnablement(MANIFEST, { kos: true })
    expect(e.disabledToolNames.has('kos_query')).toBe(true)
    expect(e.skillFragments).not.toContain('KOS_FRAG')
  })
})

describe('computeSkillEnablement — collision-exempt tools (review MEDIUM)', () => {
  test('email_search is never auto-dropped (builtin metadata ≠ manifest FTS)', () => {
    const m: SkillManifest = {
      ...MANIFEST,
      skills: [
        skill('search', {
          defaultEnabled: true,
          available: true,
          fragment: 'SEARCH_FRAG',
          tools: [tool('email_search'), tool('email_search_fulltext')]
        })
      ]
    }
    // disable the search skill → its tools would normally drop…
    const e = computeSkillEnablement(m, { search: false })
    // …but email_search is collision-exempt (the builtin is a metadata filter, a
    // different tool from the search skill's FTS email_search) → kept.
    expect(e.disabledToolNames.has('email_search')).toBe(false)
    // a non-colliding tool of the same disabled skill IS still dropped.
    expect(e.disabledToolNames.has('email_search_fulltext')).toBe(true)
    expect(e.skillFragments).not.toContain('SEARCH_FRAG')
  })
})

describe('resolveSkills — UI projection', () => {
  test('effectiveEnabled = override ?? default; advertised = effective && available', () => {
    const resolved = resolveSkills(MANIFEST, { report: false, notion_agent: true })
    const byName = Object.fromEntries(resolved.map((s) => [s.name, s]))
    expect(byName.report.effectiveEnabled).toBe(false)
    expect(byName.report.advertised).toBe(false)
    expect(byName.calendar.effectiveEnabled).toBe(true) // no override → default true
    expect(byName.calendar.advertised).toBe(true)
    expect(byName.notion_agent.effectiveEnabled).toBe(true) // overridden on
    expect(byName.notion_agent.advertised).toBe(true)
    expect(byName.kos.effectiveEnabled).toBe(true) // default true
    expect(byName.kos.advertised).toBe(false) // but unavailable
    expect(byName.report.toolCount).toBe(3)
    expect(byName.report.scopes).toEqual(['report:read', 'report:run'])
  })
})

describe('readSkillOverrides / setSkillOverride — localStorage SSoT', () => {
  beforeEach(() => {
    let store: Record<string, string> = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string): string | null => (k in store ? store[k] : null),
      setItem: (k: string, v: string): void => {
        store[k] = v
      },
      removeItem: (k: string): void => {
        delete store[k]
      },
      clear: (): void => {
        store = {}
      }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('empty / absent → {}', () => {
    expect(readSkillOverrides()).toEqual({})
  })

  test('setSkillOverride persists + readSkillOverrides round-trips', () => {
    setSkillOverride('report', false)
    expect(readSkillOverrides()).toEqual({ report: false })
    setSkillOverride('notion_agent', true)
    expect(readSkillOverrides()).toEqual({ report: false, notion_agent: true })
  })

  test('malformed JSON → {} (graceful)', () => {
    localStorage.setItem(SKILL_OVERRIDES_KEY, '{not json')
    expect(readSkillOverrides()).toEqual({})
  })

  test('non-boolean values are dropped', () => {
    localStorage.setItem(SKILL_OVERRIDES_KEY, JSON.stringify({ a: true, b: 'yes', c: 1 }))
    expect(readSkillOverrides()).toEqual({ a: true })
  })
})
