import type { Tool } from 'ai'
import type { z } from 'zod'

import type { MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import type { AgentContextMode } from './policy'
import {
  skillDraftCreateSchema,
  skillDraftDiscardSchema,
  skillDraftPublishSchema,
  skillDraftReadSchema,
  skillDraftValidateSchema,
  skillDraftWriteFileSchema
} from './schemas'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'

export const GATEWAY_SKILL_CREATOR_TOOL_NAMES = [
  'skill_draft_create',
  'skill_draft_write_file',
  'skill_draft_read',
  'skill_draft_validate',
  'skill_draft_publish',
  'skill_draft_discard'
] as const

export function createSkillCreatorTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const makeWrite = <I>(toolOpts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    editableFields?: readonly string[]
    run: (input: I, ctx: { userEdited: boolean; signal: AbortSignal | undefined }) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      {
        ...toolOpts,
        risk: 'edit',
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: opts.toolApprovalPrefs,
        a2uiEnabled: opts.a2uiEnabled,
        oneShot: opts.oneShot,
        contextMode: opts.contextMode
      },
      collector,
      guard
    )

  const skill_draft_create = makeWrite({
    name: 'skill_draft_create',
    description: 'Create an isolated Skill draft. Drafts are never executable.',
    inputSchema: skillDraftCreateSchema,
    run: (input, { signal }) => domain.skillDraftCreate(input, signal)
  })

  const skill_draft_write_file = makeWrite({
    name: 'skill_draft_write_file',
    description: 'Write one UTF-8 file in an isolated Skill draft, subject to containment and size limits.',
    inputSchema: skillDraftWriteFileSchema,
    editableFields: ['path', 'content'],
    run: (input, { signal }) => domain.skillDraftWriteFile(input, signal)
  })

  const skill_draft_publish = makeWrite({
    name: 'skill_draft_publish',
    description:
      'Publish a valid Skill draft through the verified atomic promote lifecycle. This always requires owner approval.',
    inputSchema: skillDraftPublishSchema,
    editableFields: ['enabled'],
    run: (input, { signal }) => domain.skillDraftPublish(input.draftId, input.enabled, signal)
  })

  const skill_draft_discard = makeWrite({
    name: 'skill_draft_discard',
    description: 'Discard an unpublished Skill draft and remove its isolated files.',
    inputSchema: skillDraftDiscardSchema,
    run: (input, { signal }) => domain.skillDraftDiscard(input.draftId, signal)
  })

  const skill_draft_read = auditedReadTool(
    {
      name: 'skill_draft_read',
      description: 'Read a Skill draft tree or one draft file for review.',
      inputSchema: skillDraftReadSchema,
      run: async (input, signal) =>
        input.path
          ? domain.skillDraftReadFile(input.draftId, input.path, signal)
          : domain.skillDraftGet(input.draftId, signal)
    },
    collector
  )

  const skill_draft_validate = auditedReadTool(
    {
      name: 'skill_draft_validate',
      description: 'Run static validation and package-hash preview for an isolated Skill draft.',
      inputSchema: skillDraftValidateSchema,
      run: (input, signal) => domain.skillDraftValidate(input.draftId, signal)
    },
    collector
  )

  return {
    skill_draft_create,
    skill_draft_write_file,
    skill_draft_read,
    skill_draft_validate,
    skill_draft_publish,
    skill_draft_discard
  }
}
