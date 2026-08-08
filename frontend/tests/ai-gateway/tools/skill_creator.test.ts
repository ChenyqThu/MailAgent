import { describe, expect, test } from 'vitest'

import { buildGatewayTools } from '../../../src/ai-gateway/tools'
import { ApprovalGuard } from '../../../src/ai-gateway/security/approval'
import { GATEWAY_SKILL_CREATOR_TOOL_NAMES } from '../../../src/ai-gateway/tools/skill_creator'
import {
  skillDraftCreateSchema,
  skillDraftPublishSchema,
  skillDraftWriteFileSchema
} from '../../../src/ai-gateway/tools/schemas'
import { mockDomain, okEnvelope } from './_helpers'

const domain = () => mockDomain(() => okEnvelope({}))

describe('buildGatewayTools — MAILAGENT_SKILL_CREATOR gate', () => {
  test('flag off or missing approval guard registers none', () => {
    const flagOff = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      skillCreatorToolsEnabled: false,
      contextMode: 'manual_chat'
    })
    const noGuard = buildGatewayTools({
      domain: domain(),
      skillCreatorToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_SKILL_CREATOR_TOOL_NAMES) {
      expect(flagOff[name]).toBeUndefined()
      expect(noGuard[name]).toBeUndefined()
    }
  })

  test('flag on registers all six only in manual chat', () => {
    const manual = buildGatewayTools({
      domain: domain(),
      approvalGuard: new ApprovalGuard(),
      skillCreatorToolsEnabled: true,
      contextMode: 'manual_chat'
    })
    for (const name of GATEWAY_SKILL_CREATOR_TOOL_NAMES) expect(manual[name]).toBeDefined()

    for (const contextMode of ['untrusted_trigger', 'cron_headless', 'im_chat'] as const) {
      const tools = buildGatewayTools({
        domain: domain(),
        approvalGuard: new ApprovalGuard(),
        skillCreatorToolsEnabled: true,
        contextMode
      })
      for (const name of GATEWAY_SKILL_CREATOR_TOOL_NAMES) expect(tools[name]).toBeUndefined()
    }
  })
})

describe('Skill Creator schemas', () => {
  test('create rejects invalid names and write caps content at 1 MiB', () => {
    expect(skillDraftCreateSchema.safeParse({ name: 'Bad Name' }).success).toBe(false)
    expect(skillDraftCreateSchema.safeParse({ name: 'mail_triage' }).success).toBe(true)
    expect(
      skillDraftWriteFileSchema.safeParse({
        draftId: 'mail-triage-012345abcdef',
        path: 'SKILL.md',
        content: 'x'.repeat(1024 * 1024 + 1)
      }).success
    ).toBe(false)
  })

  test('publish defaults enabled to true', () => {
    expect(skillDraftPublishSchema.parse({ draftId: 'mail-triage-012345abcdef' })).toEqual({
      draftId: 'mail-triage-012345abcdef',
      enabled: true
    })
  })
})
