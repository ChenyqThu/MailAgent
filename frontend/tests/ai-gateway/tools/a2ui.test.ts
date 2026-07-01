// chat-panel P4 Phase 04a — A2UI payload contract + tool→card mapper (the single source the
// rich cards render from and the gateway audits with). Covers the mapping per tool, the
// component allowlist (unknown → null → generic fallback), and the runtime validator's
// invalid-payload-never-throws fallback.

import { describe, expect, test } from 'vitest'

import {
  A2UI_COMPONENTS,
  A2UI_PROTOCOL,
  A2UI_VERSION,
  buildToolA2UIPayload,
  componentForTool,
  parseA2UIPayload,
  type ApprovalActionCardProps,
  type DraftReplyCardProps,
  type NotionSyncCardProps,
  type SkillToggleCardProps,
  type SystemDocApprovalCardProps
} from '../../../src/shared/assistant/tools/a2ui'

describe('componentForTool — the registry allowlist', () => {
  test('write tools map to their cards; unknown / read tools → null', () => {
    expect(componentForTool('email_draft_reply')).toBe(A2UI_COMPONENTS.DraftReplyCard)
    expect(componentForTool('email_resync')).toBe(A2UI_COMPONENTS.NotionSyncCard)
    expect(componentForTool('email_flag')).toBe(A2UI_COMPONENTS.ApprovalActionCard)
    expect(componentForTool('email_archive')).toBe(A2UI_COMPONENTS.ApprovalActionCard)
    expect(componentForTool('email_pin')).toBe(A2UI_COMPONENTS.ApprovalActionCard)
    expect(componentForTool('update_system_md')).toBe(A2UI_COMPONENTS.SystemDocApprovalCard)
    expect(componentForTool('set_skill_enabled')).toBe(A2UI_COMPONENTS.SkillToggleCard)
    // discover_skills is a silent read → no card
    expect(componentForTool('discover_skills')).toBeNull()
    // memory tools retired (M5b) → no card
    expect(componentForTool('memory_write')).toBeNull()
    expect(componentForTool('memory_delete')).toBeNull()
    // unknown / read tools → null (caller falls back to the generic ToolTraceCard)
    expect(componentForTool('email_search')).toBeNull()
    expect(componentForTool('kos_query')).toBeNull()
    expect(componentForTool('totally_unknown')).toBeNull()
  })
})

describe('buildToolA2UIPayload — draft reply (edit tier)', () => {
  test('approval-request time (args only) → body from the proposed input', () => {
    const p = buildToolA2UIPayload('email_draft_reply', {
      args: { internal_id: 7, body_markdown: 'hi there' }
    })
    expect(p).not.toBeNull()
    expect(p!.protocol).toBe(A2UI_PROTOCOL)
    expect(p!.version).toBe(A2UI_VERSION)
    expect(p!.component).toBe('DraftReplyCard')
    const props = p!.props as unknown as DraftReplyCardProps
    expect(props.internalId).toBe(7)
    expect(props.bodyMarkdown).toBe('hi there')
    expect(props.draftId).toBeNull()
    expect(p!.audit).toMatchObject({ risk: 'edit', requiresApproval: true })
  })

  test('result time → executed body + draft id + userEdited', () => {
    const p = buildToolA2UIPayload('email_draft_reply', {
      args: { internal_id: 7, body_markdown: 'original' },
      result: {
        internal_id: 7,
        draft_id: 'reply_all_7',
        mailbox: 'Drafts',
        user_edited: true,
        final_body_markdown: 'edited body'
      },
      userEdited: true
    })
    const props = p!.props as unknown as DraftReplyCardProps
    // result.final_body_markdown (the EXECUTED body) wins over the proposed args body.
    expect(props.bodyMarkdown).toBe('edited body')
    expect(props.draftId).toBe('reply_all_7')
    expect(props.mailbox).toBe('Drafts')
    expect(props.userEdited).toBe(true)
  })
})

describe('buildToolA2UIPayload — notion sync (preview tier)', () => {
  test('result → old/new page id + action', () => {
    const p = buildToolA2UIPayload('email_resync', {
      args: { internal_id: 9 },
      result: { internal_id: 9, old_page_id: 'p-old', new_page_id: 'p-new', action: 'recreated' }
    })
    expect(p!.component).toBe('NotionSyncCard')
    const props = p!.props as unknown as NotionSyncCardProps
    expect(props.internalId).toBe(9)
    expect(props.oldPageId).toBe('p-old')
    expect(props.newPageId).toBe('p-new')
    expect(props.action).toBe('recreated')
    expect(p!.audit).toMatchObject({ risk: 'preview' })
  })
})

describe('buildToolA2UIPayload — generic approval card (flag/archive/pin)', () => {
  test('flag → human summary of the proposed change', () => {
    const p = buildToolA2UIPayload('email_flag', {
      args: { internal_id: 3, is_flagged: true, is_read: false }
    })
    expect(p!.component).toBe('ApprovalActionCard')
    const props = p!.props as unknown as ApprovalActionCardProps
    expect(props.toolName).toBe('email_flag')
    expect(props.internalId).toBe(3)
    expect(props.summary).toContain('旗标')
  })

  test('archive / pin summaries', () => {
    const archive = buildToolA2UIPayload('email_archive', { args: { internal_id: 1 } })
    expect((archive!.props as unknown as ApprovalActionCardProps).summary).toContain('归档')
    const pin = buildToolA2UIPayload('email_pin', { args: { internal_id: 1, pinned: true } })
    expect((pin!.props as unknown as ApprovalActionCardProps).summary).toContain('置顶')
  })

  test('unknown tool → null payload', () => {
    expect(buildToolA2UIPayload('email_search', { args: { q: 'x' } })).toBeNull()
  })
})

describe('buildToolA2UIPayload — self-mount cards (M4b/M4c)', () => {
  test('update_system_md (rules) → high-risk SystemDocApprovalCard + content preview (edit tier)', () => {
    const p = buildToolA2UIPayload('update_system_md', {
      args: { doc_name: 'rules', content: 'Always confirm before sending.' }
    })
    expect(p!.component).toBe(A2UI_COMPONENTS.SystemDocApprovalCard)
    const props = p!.props as unknown as SystemDocApprovalCardProps
    expect(props.docName).toBe('rules')
    expect(props.highRisk).toBe(true)
    expect(props.contentPreview).toContain('Always confirm')
    expect(props.contentLength).toBe('Always confirm before sending.'.length)
    expect(p!.audit).toMatchObject({ risk: 'edit', requiresApproval: true })
  })

  test('update_system_md (user) → NOT high-risk', () => {
    const p = buildToolA2UIPayload('update_system_md', {
      args: { doc_name: 'user', content: 'Prefers concise replies.' }
    })
    expect((p!.props as unknown as SystemDocApprovalCardProps).highRisk).toBe(false)
  })

  test('update_system_md shows the FULL content (never truncated) — the review surface (M4b HIGH-2)', () => {
    const full = '体'.repeat(300)
    const p = buildToolA2UIPayload('update_system_md', {
      args: { doc_name: 'agent', content: full }
    })
    const props = p!.props as unknown as SystemDocApprovalCardProps
    expect(props.highRisk).toBe(true) // agent is high-risk (M4b MED-3)
    expect(props.contentLength).toBe(300)
    expect(props.contentPreview).toBe(full) // full content, never truncated
    expect(props.contentPreview.endsWith('…')).toBe(false)
  })

  test('update_system_md HIGH-RISK (rules) long content → NOT truncated (full for 逐字确认)', () => {
    const full = '规则'.repeat(300)
    const p = buildToolA2UIPayload('update_system_md', {
      args: { doc_name: 'rules', content: full }
    })
    const props = p!.props as unknown as SystemDocApprovalCardProps
    expect(props.highRisk).toBe(true)
    expect(props.contentPreview).toBe(full) // soul/rules show the full content, no ellipsis
    expect(props.contentPreview.endsWith('…')).toBe(false)
  })

  test('set_skill_enabled → SkillToggleCard (preview tier)', () => {
    const p = buildToolA2UIPayload('set_skill_enabled', {
      args: { skill_name: 'report', enabled: true }
    })
    expect(p!.component).toBe(A2UI_COMPONENTS.SkillToggleCard)
    const props = p!.props as unknown as SkillToggleCardProps
    expect(props.skillName).toBe('report')
    expect(props.enabled).toBe(true)
    expect(p!.audit).toMatchObject({ risk: 'preview', requiresApproval: true })
  })

  test('discover_skills (silent read) → null payload', () => {
    expect(buildToolA2UIPayload('discover_skills', { args: {} })).toBeNull()
  })
})

describe('parseA2UIPayload — runtime validator never throws', () => {
  const valid = {
    protocol: A2UI_PROTOCOL,
    version: A2UI_VERSION,
    component: 'DraftReplyCard',
    props: { internalId: 1, bodyMarkdown: 'x' }
  }

  test('valid payload parses', () => {
    expect(parseA2UIPayload(valid)).not.toBeNull()
  })

  test.each([
    ['wrong protocol', { ...valid, protocol: 'a2ui.other' }],
    ['wrong version', { ...valid, version: '2.0' }],
    ['missing component', { ...valid, component: undefined }],
    ['props not an object', { ...valid, props: 'nope' }],
    ['null', null],
    ['a string', 'not a payload'],
    ['a number', 42]
  ])('invalid (%s) → null (fallback to generic card, never throws)', (_label, bad) => {
    expect(parseA2UIPayload(bad)).toBeNull()
  })
})
