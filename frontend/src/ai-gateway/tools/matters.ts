import type { Tool } from 'ai'

import type {
  DomainMatterMutation,
  DomainMatterUpdateDetail,
  DomainPolicyVerdict,
  MailAgentDomainClient
} from '../python/domainClient'
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
  matterReviewUpdateSchema,
  matterRunControlSchema,
  matterStakeholderMutateSchema,
  matterUpdateProposeSchema,
  matterUpdateSchema,
  type MatterReviewUpdateInput
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
  'matter_add_note',
  // P4 (D8) — the review-side pair. They live in the owner-present write family (manual / im),
  // NOT in a follow-up run: the matter_followup matrix row denies domain_write outright, so a run
  // can never start another run or accept its own proposal.
  'matter_run_control',
  'matter_review_update'
] as const

/** P4 (D6) — the follow-up run's own tool, registered ONLY inside a matter-run context. Kept in
 *  its own array (not the write family) because it is class `artifact`, silent, and guard-free —
 *  the same shape as report_write. */
export const GATEWAY_MATTER_RUN_TOOL_NAMES = ['matter_update_propose'] as const

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

  const matter_run_control = auditedWriteTool(
    {
      ...shared,
      name: 'matter_run_control',
      description:
        'Start a follow-up run for a Matter now, or cancel a queued/running one. The run reads the ' +
        'Matter and proposes an update for review — it never changes Matter state by itself. If a ' +
        'run is already active the existing one is returned (coalesced) instead of a second run.',
      inputSchema: matterRunControlSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        input.operation === 'cancel'
          ? domain.cancelMatterRun(input.public_id, input.run_id as number, mutation(input), signal)
          : domain.startMatterRun(input.public_id, mutation(input), signal)
    },
    collector,
    guard
  )

  const matter_review_update = auditedWriteTool(
    {
      ...shared,
      name: 'matter_review_update',
      description:
        'Accept or reject one pending Matter update proposal. Accepting applies exactly the ' +
        'selected changes (optionally with edited values) in a single transaction; rejecting ' +
        'applies nothing but records the reason. A stale proposal (the Matter moved on since it ' +
        'was written) can only be rejected — re-run the follow-up to get a fresh one.',
      inputSchema: matterReviewUpdateSchema,
      risk: 'edit',
      // D8 dynamic approval. 🔴 Deliberately a policyEvaluate seam rather than forceApproval: the
      // verdict needs a SERVER fact (does the selected subset touch a `field` change?) that the
      // input alone cannot carry — a model-supplied "kind" would be exactly the claim an approval
      // gate must not trust. Ladder position ⑥ means it also outranks the factory tier, so the
      // card can never be skipped by a per-tool preference (tool_prefs marks it non-configurable
      // for the same reason).
      // Audit note: an auto_allow here records the existing 'auto_whitelist' label with
      // rule_id=null — no new audit literal is minted, and the null rule id is what distinguishes
      // it from a real policy_rules hit.
      policyEvaluate: (input: MatterReviewUpdateInput) =>
        evaluateReviewApproval(domain, opts.contextMode, input),
      run: (input, { signal }) =>
        domain.reviewMatterUpdate(
          input.public_id,
          input.update_id,
          input.decision,
          input.decision === 'reject'
            ? { reason: input.reason }
            : {
                selected_change_ids: input.selected_change_ids,
                edited_changes: input.edited_changes,
                edited_summary: input.edited_summary
              },
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
    matter_add_note,
    matter_run_control,
    matter_review_update
  }
}

/** P4 (D6) — the follow-up run's single write tool. Registered ONLY when the run context carries a
 *  Matter anchor (tools/index.ts), and built with `auditedReadTool` on the report_write precedent:
 *  class `artifact`, silent, no ApprovalGuard, no risk tier. What it writes is a PENDING proposal —
 *  nothing in the Matter changes until the owner reviews it — so an approval card here would ask
 *  the owner to approve the very thing they are about to be asked to review.
 *
 *  🔴 `matterRun` is the server-assembled anchor (AgentRunContext.matterRun): matter/run identity
 *  comes from this closure, never from the model's input (the schema has no such fields). */
export function createMatterRunTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  matterRun: { matterId: number; publicId: string; runId: number }
): Record<string, Tool> {
  const matter_update_propose = auditedReadTool(
    {
      name: 'matter_update_propose',
      description:
        "Submit this follow-up run's proposed update for the Matter. Call it AT MOST ONCE, at the " +
        'end of the run, and only when there is something substantive to report: a summary plus the ' +
        'concrete changes you propose. Every factual change must carry at least one source; anything ' +
        'you inferred must be marked is_inference. Put what you could not determine into ' +
        'open_questions instead of guessing. Nothing here is applied automatically — the owner ' +
        'reviews and decides. If there is no meaningful change, do not call this tool at all.',
      inputSchema: matterUpdateProposeSchema,
      run: (input, signal) =>
        domain.proposeMatterUpdate(matterRun.publicId, matterRun.runId, input, signal)
    },
    collector
  )
  return { matter_update_propose }
}

/** D8 — the dynamic verdict behind matter_review_update's approval card. Fail-closed everywhere:
 *  any venue other than manual, any unreadable proposal payload, any error → 'ask'.
 *
 *  - non-manual (im / headless): 恒卡 — the owner-present IM venue keeps its always-HITL floor.
 *  - manual reject: card-free. Rejecting applies nothing; it is the safe direction, and forcing a
 *    card on "no, don't do that" trains the owner to click through cards.
 *  - manual accept: card-free ONLY when no SELECTED change is a `field` change (those write the
 *    Matter's own status/health/priority/due/waiting state). fact/inference/action/resource
 *    changes stay reviewable in the transcript and are individually reversible. */
async function evaluateReviewApproval(
  domain: MailAgentDomainClient,
  contextMode: AgentContextMode | undefined,
  input: MatterReviewUpdateInput
): Promise<DomainPolicyVerdict> {
  const ask: DomainPolicyVerdict = { decision: 'ask', rule_id: null }
  if (contextMode !== 'manual_chat') return ask
  if (input.decision === 'reject') return { decision: 'auto_allow', rule_id: null }
  try {
    const detail = await domain.getMatterUpdate(input.public_id, input.update_id)
    const changes = proposalChanges(detail)
    if (changes === null) return ask
    const selected = new Set(input.selected_change_ids ?? [])
    const touchesField = changes.some(
      (change) => selected.has(String(change.id)) && change.kind === 'field'
    )
    return touchesField ? ask : { decision: 'auto_allow', rule_id: null }
  } catch {
    return ask
  }
}

/** Read the proposal's change list out of either §3.8 shape ({update:{changes}} or a bare row).
 *  Returns null when neither is an array — the caller turns that into an approval card. */
function proposalChanges(
  detail: DomainMatterUpdateDetail
): Array<{ id?: unknown; kind?: unknown }> | null {
  const raw = detail.update?.changes ?? detail.changes
  return Array.isArray(raw) ? (raw as Array<{ id?: unknown; kind?: unknown }>) : null
}
