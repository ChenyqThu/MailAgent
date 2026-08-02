import { describe, expect, test } from 'vitest'

import {
  CUSTOM_AGENT_CAPABILITY_TIERS,
  applyCustomAgentCapabilityPatch,
  customAgentPolicyFromCapabilities,
  deriveCustomAgentCapabilities,
  type CustomAgentCapabilityProfile
} from '../../src/shared/lib/customAgentCapabilities'

function profiles(): CustomAgentCapabilityProfile[] {
  const out: CustomAgentCapabilityProfile[] = []
  for (const email of CUSTOM_AGENT_CAPABILITY_TIERS.email) {
    for (const calendar of CUSTOM_AGENT_CAPABILITY_TIERS.calendar) {
      for (const knowledge of CUSTOM_AGENT_CAPABILITY_TIERS.knowledge) {
        for (const reports of CUSTOM_AGENT_CAPABILITY_TIERS.reports) {
          for (const web of CUSTOM_AGENT_CAPABILITY_TIERS.web) {
            for (const files of CUSTOM_AGENT_CAPABILITY_TIERS.files) {
              out.push({ email, calendar, knowledge, reports, web, files })
            }
          }
        }
      }
    }
  }
  return out
}

describe('customAgentCapabilities', () => {
  test('all 216 canonical profiles round-trip through allowed_tools + grants', () => {
    for (const profile of profiles()) {
      const policy = customAgentPolicyFromCapabilities(profile)
      expect(deriveCustomAgentCapabilities(policy)).toEqual({ profile, customized: [] })
    }
  })

  test('report_write belongs only to the report produce tier', () => {
    const base: CustomAgentCapabilityProfile = {
      email: 'read',
      calendar: 'off',
      knowledge: 'off',
      reports: 'read',
      web: 'off',
      files: 'off'
    }
    expect(customAgentPolicyFromCapabilities(base).allowedTools).not.toContain('report_write')
    expect(
      customAgentPolicyFromCapabilities({ ...base, reports: 'produce' }).allowedTools
    ).toContain('report_write')
  })

  test('one card edit preserves unrelated and future atomic tools', () => {
    const next = applyCustomAgentCapabilityPatch(
      {
        allowedTools: ['email_get', 'calendar_event_get', 'future_tool_x'],
        grantWeb: 'gated',
        grantExec: true
      },
      { reports: 'produce' }
    )
    expect(next.allowedTools).toEqual([
      'email_get',
      'calendar_event_get',
      'future_tool_x',
      'report_get',
      'report_list',
      'report_write'
    ])
    expect(next.grantWeb).toBe('gated')
    expect(next.grantExec).toBe(true)
  })

  test('advanced partial selections are retained and surfaced as customized', () => {
    const policy = {
      allowedTools: ['email_get', 'email_draft_reply'],
      grantWeb: 'off' as const,
      grantExec: false
    }
    const derived = deriveCustomAgentCapabilities(policy)
    expect(derived.customized).toContain('email')
    expect(policy.allowedTools).toEqual(['email_get', 'email_draft_reply'])
  })
})
