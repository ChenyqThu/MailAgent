import type { Tool } from 'ai'

import type { DomainMatterMutation, MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import type { AgentContextMode } from './policy'
import {
  matterAddNoteSchema,
  matterCreateSchema,
  matterFindSchema,
  matterGetSchema,
  matterItemMutateSchema,
  matterRelationMutateSchema,
  matterResourceMutateSchema,
  matterStakeholderMutateSchema,
  matterUpdateSchema
} from './schemas'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'

export const GATEWAY_MATTER_READ_TOOL_NAMES = ['matter_find', 'matter_get'] as const
export const GATEWAY_MATTER_WRITE_TOOL_NAMES = [
  'matter_create',
  'matter_update',
  'matter_item_mutate',
  'matter_resource_mutate',
  'matter_stakeholder_mutate',
  'matter_relation_mutate',
  'matter_add_note'
] as const

function mutation(input: {
  idempotency_key?: string
  expected_version?: number
  reason?: string
  reverses_event_id?: number
}): DomainMatterMutation {
  return {
    source: 'ai_gateway',
    idempotency_key: input.idempotency_key ?? crypto.randomUUID(),
    expected_version: input.expected_version,
    reason: input.reason,
    reverses_event_id: input.reverses_event_id
  }
}

export function createMatterReadTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  const matter_find = auditedReadTool(
    {
      name: 'matter_find',
      description:
        'Find Matters by text and structured filters. Returns at most 50 compact summaries; use matter_get for bounded detail.',
      inputSchema: matterFindSchema,
      run: async (input, signal) => {
        const result = await domain.listMatters(input, signal)
        return {
          count: result.items.length,
          items: result.items.map((item) => {
            const matter = item as Record<string, unknown>
            return {
              public_id: matter.public_id,
              title: matter.title,
              type: matter.matter_type,
              tags: matter.tags,
              status: matter.status,
              health: matter.health,
              priority: matter.priority,
              due_at: matter.due_at,
              current_summary: matter.current_summary,
              version: matter.version,
              matched_fields: matter.matched_fields,
              snippet: matter.snippet
            }
          })
        }
      }
    },
    collector
  )

  const matter_get = auditedReadTool(
    {
      name: 'matter_get',
      description:
        'Read one Matter and a bounded subset of items, resources, stakeholders, timeline, or relations. Resource bodies are not returned.',
      inputSchema: matterGetSchema,
      run: (input, signal) => domain.getMatter(input.public_id, input.include, signal)
    },
    collector
  )

  return { matter_find, matter_get }
}

export function createMatterWriteTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const shared = {
    a2uiEnabled: opts.a2uiEnabled,
    approvalMode: opts.approvalMode,
    toolApprovalPrefs: opts.toolApprovalPrefs,
    oneShot: opts.oneShot,
    contextMode: opts.contextMode
  }

  const matter_create = auditedWriteTool(
    {
      ...shared,
      name: 'matter_create',
      description: 'Create a Matter and return the committed state plus an undo descriptor.',
      inputSchema: matterCreateSchema,
      risk: 'edit',
      run: async (input, { signal }) => {
        const { type, idempotency_key, reason, reverses_event_id, ...data } = input
        return domain.createMatter(
          { ...data, matter_type: type },
          mutation({ idempotency_key, reason, reverses_event_id }),
          signal
        )
      }
    },
    collector,
    guard
  )

  const matter_update = auditedWriteTool(
    {
      ...shared,
      name: 'matter_update',
      description:
        'Patch, archive, reopen, trash, or restore a Matter with optimistic concurrency. Arbitrary JSON and automation bindings are forbidden.',
      inputSchema: matterUpdateSchema,
      risk: 'edit',
      run: async (input, { signal }) => {
        const patch = input.patch
          ? { ...input.patch, matter_type: input.patch.type, type: undefined }
          : undefined
        return domain.updateMatter(input.public_id, input.operation, patch, mutation(input), signal)
      }
    },
    collector,
    guard
  )

  const matter_item_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_item_mutate',
      description: 'Create, update, soft-delete, or restore one typed Matter item.',
      inputSchema: matterItemMutateSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.mutateMatterItem(
          input.public_id,
          input.operation,
          input.item_id,
          input.operation === 'create' ? input.item : input.patch,
          mutation(input),
          signal
        )
    },
    collector,
    guard
  )

  const matter_resource_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_resource_mutate',
      description:
        'Link, update, unlink, or restore a Matter resource. Unlink never deletes the source object. Expanding access to allowed always requires approval.',
      inputSchema: matterResourceMutateSchema,
      risk: 'edit',
      forceApproval: (input) => input.patch?.access_policy === 'allowed',
      run: (input, { signal }) => {
        const data =
          input.operation === 'link'
            ? input.resource_id != null
              ? { resource_id: input.resource_id }
              : input.resource
            : input.patch
        return domain.mutateMatterResource(
          input.public_id,
          input.operation,
          input.resource_id,
          data,
          mutation(input),
          signal
        )
      }
    },
    collector,
    guard
  )

  const matter_stakeholder_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_stakeholder_mutate',
      description: 'Create, update, soft-delete, or restore one Matter stakeholder.',
      inputSchema: matterStakeholderMutateSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.mutateMatterStakeholder(
          input.public_id,
          input.operation,
          input.stakeholder_id,
          input.operation === 'create' ? input.stakeholder : input.patch,
          mutation(input),
          signal
        )
    },
    collector,
    guard
  )

  const matter_relation_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_relation_mutate',
      description: 'Create, update, soft-delete, or restore one relation between Matters.',
      inputSchema: matterRelationMutateSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.mutateMatterRelation(
          input.public_id,
          input.operation,
          input.relation_id,
          input.operation === 'create' ? input.relation : input.patch,
          mutation(input),
          signal
        )
    },
    collector,
    guard
  )

  const matter_add_note = auditedWriteTool(
    {
      ...shared,
      name: 'matter_add_note',
      description:
        'Append a Matter note. The undo path soft-deletes the note item; history remains auditable.',
      inputSchema: matterAddNoteSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.addMatterNote(
          input.public_id,
          { title: input.title, text: input.text },
          mutation(input),
          signal
        )
    },
    collector,
    guard
  )

  return {
    matter_create,
    matter_update,
    matter_item_mutate,
    matter_resource_mutate,
    matter_stakeholder_mutate,
    matter_relation_mutate,
    matter_add_note
  }
}
