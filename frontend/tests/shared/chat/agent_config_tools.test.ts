// PR6 — agent profile + skill management tools against a mock platform. Verifies
// confirmation tiers (reads silent; profile apply_patch = edit; everything else that
// mutates = preview), argument forwarding, agent_proposed provenance, validation, and
// the user-edited-input path. No serve-api — the platform is mocked.

import { describe, expect, test, vi } from 'vitest'

import { createAgentProfileTools } from '../../../src/shared/chat/tools/builtin/agent_profile'
import { createSkillManagementTools } from '../../../src/shared/chat/tools/builtin/skill_management'
import type { ChatToolPlatform } from '../../../src/shared/chat/platform'
import type { ToolDef, ToolExecCtx } from '../../../src/shared/chat/tools/registry'
import type { AgentProfileDoc, SkillSummary } from '../../../src/shared/api/types'

const ctx: ToolExecCtx = { sessionId: 42, emailId: null, signal: new AbortController().signal }

function mockPlatform(over: Partial<ChatToolPlatform> = {}): ChatToolPlatform {
  return { ...over } as unknown as ChatToolPlatform
}
function byName(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}
function doc(over: Partial<AgentProfileDoc> = {}): AgentProfileDoc {
  return {
    docName: 'soul',
    content: '# SOUL',
    contentHash: 'h',
    updatedBy: 'seed',
    updatedAt: 1,
    editable: true,
    ...over
  }
}
function skill(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: 'email',
    title: 'Email',
    description: 'd',
    defaultEnabled: true,
    enabled: true,
    overridden: false,
    sourceType: 'builtin',
    available: true,
    unavailableReason: null,
    toolCount: 3,
    scopes: ['email:read'],
    ...over
  }
}

// ── agent profile ──────────────────────────────────────────────────────────────
describe('agent profile tools — tiers', () => {
  test('reads silent; apply_patch edit; rollback preview; all meta', () => {
    const tools = createAgentProfileTools(mockPlatform())
    expect(byName(tools, 'agent_profile_list_docs').confirmationTier).toBe('silent')
    expect(byName(tools, 'agent_profile_read_doc').confirmationTier).toBe('silent')
    expect(byName(tools, 'agent_profile_history').confirmationTier).toBe('silent')
    expect(byName(tools, 'agent_profile_apply_patch').confirmationTier).toBe('edit')
    expect(byName(tools, 'agent_profile_rollback').confirmationTier).toBe('preview')
    for (const t of tools) expect(t.category).toBe('meta')
  })
})

describe('agent_profile_apply_patch', () => {
  test('forwards content + agent_proposed provenance + sessionId', async () => {
    const setProfileDoc = vi.fn(async () => doc({ docName: 'rules', contentHash: 'new' }))
    const res = await byName(
      createAgentProfileTools(mockPlatform({ setProfileDoc })),
      'agent_profile_apply_patch'
    ).handler({ name: 'rules', content: '# RULES\nBe concise' }, ctx)
    expect(setProfileDoc).toHaveBeenCalledWith({
      name: 'rules',
      content: '# RULES\nBe concise',
      updatedBy: 'agent_proposed',
      sessionId: 42
    })
    expect(res).toMatchObject({ ok: true, output: { saved: true, docName: 'rules' } })
  })

  test('rejects an unknown doc name', async () => {
    const res = await byName(
      createAgentProfileTools(mockPlatform({ setProfileDoc: vi.fn() })),
      'agent_profile_apply_patch'
    ).handler({ name: 'memory', content: 'x' }, ctx)
    expect(res).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('uses the user-edited content when present', async () => {
    const setProfileDoc = vi.fn(async () => doc())
    await byName(
      createAgentProfileTools(mockPlatform({ setProfileDoc })),
      'agent_profile_apply_patch'
    ).handler(
      { name: 'soul', content: 'AGENT_PROPOSED' },
      { ...ctx, userEditedInput: { name: 'soul', content: 'USER_EDITED' } }
    )
    expect(setProfileDoc).toHaveBeenCalledWith(expect.objectContaining({ content: 'USER_EDITED' }))
  })
})

describe('agent_profile_read_doc / rollback', () => {
  test('read_doc requires name + forwards', async () => {
    const readProfileDoc = vi.fn(async () => doc())
    const tools = createAgentProfileTools(mockPlatform({ readProfileDoc }))
    const bad = await byName(tools, 'agent_profile_read_doc').handler({}, ctx)
    expect(bad).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
    await byName(tools, 'agent_profile_read_doc').handler({ name: 'soul' }, ctx)
    expect(readProfileDoc).toHaveBeenCalledWith('soul')
  })

  test('rollback forwards target_hash + agent_proposed', async () => {
    const rollbackProfileDoc = vi.fn(async () => doc())
    await byName(
      createAgentProfileTools(mockPlatform({ rollbackProfileDoc })),
      'agent_profile_rollback'
    ).handler({ name: 'soul', target_hash: 'abc' }, ctx)
    expect(rollbackProfileDoc).toHaveBeenCalledWith({
      name: 'soul',
      targetHash: 'abc',
      updatedBy: 'agent_proposed',
      sessionId: 42
    })
  })
})

// ── skill management ─────────────────────────────────────────────────────────────
describe('skill management tools — tiers', () => {
  test('reads silent; mutations preview; all meta', () => {
    const tools = createSkillManagementTools(mockPlatform())
    expect(byName(tools, 'skill_list_installed').confirmationTier).toBe('silent')
    expect(byName(tools, 'skill_read').confirmationTier).toBe('silent')
    for (const n of ['skill_enable', 'skill_disable', 'skill_install', 'skill_uninstall']) {
      expect(byName(tools, n).confirmationTier).toBe('preview')
    }
    for (const t of tools) expect(t.category).toBe('meta')
  })
})

describe('skill management — forwarding + validation', () => {
  test('skill_enable / skill_disable forward the boolean', async () => {
    const setAgentSkillEnabled = vi.fn(async () => undefined)
    const tools = createSkillManagementTools(mockPlatform({ setAgentSkillEnabled }))
    await byName(tools, 'skill_enable').handler({ name: 'report' }, ctx)
    expect(setAgentSkillEnabled).toHaveBeenCalledWith('report', true)
    await byName(tools, 'skill_disable').handler({ name: 'report' }, ctx)
    expect(setAgentSkillEnabled).toHaveBeenCalledWith('report', false)
  })

  test('skill_read finds by name', async () => {
    const listAgentSkills = vi.fn(async () => [skill({ name: 'report' }), skill({ name: 'email' })])
    const tools = createSkillManagementTools(mockPlatform({ listAgentSkills }))
    const found = await byName(tools, 'skill_read').handler({ name: 'email' }, ctx)
    expect(found).toMatchObject({ ok: true, output: { found: true, name: 'email' } })
    const miss = await byName(tools, 'skill_read').handler({ name: 'nope' }, ctx)
    expect(miss).toMatchObject({ ok: true, output: { found: false } })
  })

  test('skill_install rejects an unsupported source_type', async () => {
    const res = await byName(
      createSkillManagementTools(mockPlatform({ installAgentSkill: vi.fn() })),
      'skill_install'
    ).handler({ name: 'x', source_type: 'mcp' }, ctx)
    expect(res).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('skill_install forwards document source + scopes', async () => {
    const installAgentSkill = vi.fn(async () => ({ name: 'notes', sourceType: 'document' }))
    await byName(
      createSkillManagementTools(mockPlatform({ installAgentSkill })),
      'skill_install'
    ).handler({ name: 'notes', source_type: 'document', granted_scopes: ['email:read'] }, ctx)
    expect(installAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'notes',
        sourceType: 'document',
        grantedScopes: ['email:read']
      })
    )
  })

  test('R9 — skill_install forwards source_uri / package_hash / trusted risk metadata', async () => {
    const installAgentSkill = vi.fn(async () => ({ name: 'pack', sourceType: 'skill_pack' }))
    await byName(
      createSkillManagementTools(mockPlatform({ installAgentSkill })),
      'skill_install'
    ).handler(
      {
        name: 'pack',
        source_type: 'skill_pack',
        source_uri: 'https://example.com/pack.zip',
        package_hash: 'sha256:abc',
        trusted: true,
        reason: 'user asked',
        risk_summary: 'read-only report helper'
      },
      ctx
    )
    expect(installAgentSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'pack',
        sourceType: 'skill_pack',
        sourceUri: 'https://example.com/pack.zip',
        packageHash: 'sha256:abc',
        trusted: true
      })
    )
  })

  test('skill_uninstall forwards the name', async () => {
    const uninstallAgentSkill = vi.fn(async () => ({ name: 'gone', removed: true }))
    const res = await byName(
      createSkillManagementTools(mockPlatform({ uninstallAgentSkill })),
      'skill_uninstall'
    ).handler({ name: 'gone' }, ctx)
    expect(uninstallAgentSkill).toHaveBeenCalledWith('gone')
    expect(res).toMatchObject({ ok: true, output: { removed: true } })
  })
})
