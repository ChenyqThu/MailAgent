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
  matterAttentionListSchema,
  matterAttentionTriageSchema,
  matterCreateSchema,
  matterFindSchema,
  matterFollowupMutateSchema,
  matterGetSchema,
  matterItemMutateSchema,
  matterProgressMutateSchema,
  matterRelationMutateSchema,
  matterResourceMutateSchema,
  matterReviewUpdateSchema,
  matterRunControlSchema,
  matterRunsListSchema,
  matterStakeholderMutateSchema,
  matterSuggestionResolveSchema,
  matterTagsListSchema,
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

export const GATEWAY_MATTER_READ_TOOL_NAMES = [
  'matter_find',
  'matter_get',
  // 0813 轮 3 批 R — three reads that had REST but no tool. Class `read`, so the matter_followup
  // matrix row admits them by derivation: a follow-up run can now see its own attention signals
  // and what the previous runs concluded, instead of re-deriving both from scratch every round.
  'matter_attention_list',
  'matter_runs_list',
  'matter_tags_list'
] as const
// task 08-25（owner 0825「置信度非常低，反而徒增烦恼」）—— `matter_suggest_related_resources`
// 已退役：关键词命中式的资料推荐整条不要了。资料关联的推荐现在只有 LLM 判断那两条路 ——
// 跟进 run 提案信封里的 `resource` change，与这里 agent 自己检索后 matter_resource_mutate。
// owner 手动挑的只读候选弹窗（`GET /matters/{id}/resource-candidates`）不经工具面，不受影响。
export const GATEWAY_MATTER_WRITE_TOOL_NAMES = [
  'matter_create',
  'matter_update',
  'matter_item_mutate',
  'matter_progress_mutate',
  'matter_resource_mutate',
  'matter_stakeholder_mutate',
  'matter_relation_mutate',
  'matter_add_note',
  // P4 (D8) — the review-side pair. They live in the owner-present write family (manual / im),
  // NOT in a follow-up run: the matter_followup matrix row denies domain_write outright, so a run
  // can never start another run or accept its own proposal.
  'matter_run_control',
  'matter_review_update',
  // 0813 轮 3 批 R — the two disposal writes. Same venue story as the pair above (domain_write ⇒
  // owner-present only): a follow-up run may DISCOVER attention or suggestions, never dispose of
  // them. Factory tier `auto` follows the family (local, audited, reversible).
  'matter_attention_triage',
  'matter_suggestion_resolve'
] as const

/** P4 (D6) — the follow-up run's own tool, registered ONLY inside a matter-run context. Kept in
 *  its own array (not the write family) because it is class `artifact`, silent, and guard-free —
 *  the same shape as report_write. */
/** matter_update 里「owner 自己的话」——带到它们的 patch 恒弹审批卡（见该工具的 forceApproval）。
 *  🔴 与 Python `run_service.PROPOSAL_FIELD_WHITELIST` 里这三项是同一组字段的两个面：
 *  owner 在场 = 直写 + 卡；无人值守的跟进 run = 只能提案。改一边先想清另一边。
 *  🔴 v61 起 `background` 与 `goal` 是两个独立字段，**两个都要在这里** —— 少一个 = 那一半
 *  被 agent 静默改掉，owner 一张卡都看不到。 */
const MATTER_OWNER_VOICE_FIELDS = ['background', 'goal', 'goal_checks'] as const

export const GATEWAY_MATTER_RUN_TOOL_NAMES = ['matter_update_propose'] as const

/** task 08-14 — 跟进配置的逐条编辑。单列成组而不是并进写家族：它的 class 是
 *  `capability_change`（改的是无人值守 run 的触发条件），与那一族的 `domain_write` 不同 ——
 *  混进去会让「写家族 = domain_write」这条读得懂的规律失效。装配上仍随 matter 家族一起
 *  all-or-nothing 注册。 */
export const GATEWAY_MATTER_FOLLOWUP_TOOL_NAMES = ['matter_followup_mutate'] as const

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

/** 0813 轮 3 批 R — the run row fields a model may see. 🔴 `trigger_payload` is deliberately
 *  absent: it is fenced UNTRUSTED content lifted from an email / calendar event, and a run-history
 *  read must not become a second, unfenced delivery route for it. Everything kept here is
 *  machinery the run itself produced. */
const MATTER_RUN_PROJECTION = [
  'id',
  'lifecycle_state',
  'status',
  'trigger_kind',
  'created_at',
  'started_at',
  'completed_at',
  'canceled_at',
  'duration_ms',
  'update_id',
  'model',
  'error'
] as const

function projectRun(run: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of MATTER_RUN_PROJECTION) if (run[key] !== undefined) out[key] = run[key]
  return out
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
        'Read one Matter and a bounded subset of items, resources, stakeholders, timeline, ' +
        'progress (the curated 进展 lane — the narrative of how the work unfolded; read it ' +
        'before recording a new entry so you neither repeat one nor contradict it), ' +
        'relations, updates (pending review proposals — include "updates" to get the update_id ' +
        'that matter_review_update needs), or followup (the follow-up configuration: triggers ' +
        'with their ids, run actions, bound agent profile, instructions and model overrides — ' +
        'include it to get the trigger_id that matter_followup_mutate needs). Resource bodies ' +
        'are not returned.',
      inputSchema: matterGetSchema,
      run: (input, signal) => domain.getMatter(input.public_id, input.include, signal)
    },
    collector
  )

  const matter_attention_list = auditedReadTool(
    {
      name: 'matter_attention_list',
      description:
        'List the attention signals Matters are raising — overdue waits, overdue actions, ' +
        'approaching deadlines, health drops, proposals awaiting review, failed follow-up runs, ' +
        'context gaps. Omit public_id to sweep every Matter; that is how to answer "what needs ' +
        'attention right now". Each signal carries the Matter it belongs to, why it opened, and ' +
        'the id that matter_attention_triage needs.',
      inputSchema: matterAttentionListSchema,
      run: async (input, signal) => {
        const result = await domain.listMatterAttention(
          { publicId: input.public_id, state: input.state },
          signal
        )
        const items = result.items ?? []
        return {
          count: Math.min(items.length, input.limit),
          truncated: items.length > input.limit,
          items: items.slice(0, input.limit)
        }
      }
    },
    collector
  )

  const matter_tags_list = auditedReadTool(
    {
      name: 'matter_tags_list',
      description:
        'List the Matter tags that already exist, with how many Matters use each one. Read this ' +
        'before putting tags on a Matter: reuse an existing name instead of coining a synonym ' +
        '(「客户交付」 vs 「交付」) — nothing merges them afterwards. Renaming, recoloring and ' +
        'deleting tags stays with the owner in 设置 → 事项 → 标签.',
      inputSchema: matterTagsListSchema,
      run: (_input, signal) => domain.listMatterTags(signal)
    },
    collector
  )

  const reads: Record<string, Tool> = {
    matter_find,
    matter_get,
    matter_attention_list,
    matter_tags_list
  }

  reads.matter_runs_list = auditedReadTool(
    {
      name: 'matter_runs_list',
      description:
        "Read a Matter's follow-up run history: when each round ran, how it ended, and whether " +
        'it produced a proposal (`update_id` — feed it to matter_get include:["updates"] to see ' +
        'what was proposed). Use it to answer "did the follow-up run / why did it come back ' +
        'empty" instead of starting another round. Run inputs are not returned.',
      inputSchema: matterRunsListSchema,
      run: async (input, signal) => {
        const result = await domain.listMatterRuns(input.public_id, { limit: input.limit }, signal)
        const items = result.items ?? []
        return { count: items.length, items: items.map(projectRun) }
      }
    },
    collector
  )

  return reads
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
      description:
        'Create a Matter and return the committed state plus an undo descriptor. Fill ' +
        '`background`（背景: how this came about, who is involved, what constrains it）and ' +
        '`goal`（目标: what must be true when it is done）— they are two independent fields, ' +
        'so leave `goal` empty rather than restating the background in it. Set `goal_checks`' +
        '（完成标志）when the user can state how done is judged. All three are owner-owned ' +
        'after creation and cannot be patched by agents later.',
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
        'Patch, archive, reopen, trash, or restore a Matter with optimistic concurrency. ' +
        "Arbitrary JSON and automation bindings are forbidden. Three fields are the owner's own " +
        'words and ALWAYS raise an approval card no matter how the approval tiers are set: ' +
        '`background`（背景）, `goal`（目标）and `goal_checks`（完成标志）— change them only ' +
        'when the user has just said the background, the goal, or the finish line moved, never ' +
        'to polish wording, and send only the one that actually moved.',
      inputSchema: matterUpdateSchema,
      risk: 'edit',
      // S3 (08-18) — per-FIELD always-ask. 🔴 Deliberately not "raise matter_update's tier to
      // ask": that would card every status/priority/tag tweak too, and dogfood would drown.
      // These two fields are the owner's own statement of intent, so a card showing the full new
      // text is the approval. A follow-up run never reaches here (matter_followup denies
      // domain_write outright) — it must go through matter_update_propose instead.
      forceApproval: (input) =>
        input.patch != null &&
        MATTER_OWNER_VOICE_FIELDS.some((field) => input.patch?.[field] !== undefined),
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
      description:
        'Create, update, soft-delete, or restore one typed Matter item (action / milestone / ' +
        'decision / blocker / question / note — the kind field explains when to use which).',
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

  // task 08-25 —— curated 进展 lane 的写面。与 matter_item_mutate 同 class / 同档 / 同形状：
  // 都是本地、可审计、可撤销（软删 + restore）的域内写。
  // 🔴 一件事一条、纯抄送不记这类**判断**写在 description 里而不是 schema 约束里：值域与
  // 条件必填的权威在 Python，而「这封值不值得记」根本不是 schema 能表达的东西。
  const matter_progress_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_progress_mutate',
      description:
        "Record or fix ONE entry in a Matter's 进展 (progress) lane — the curated narrative of " +
        'how the work is unfolding, kept separately from the operation log. Five kinds, pick by ' +
        'what happened: kind="goal" the goal was set or revised · "milestone" a milestone was ' +
        'reached · "progress" something concretely moved (a reply that settles a question, a ' +
        'delivery, a step forward — the default) · "signal" a risk or warning sign worth ' +
        'watching · "decision" a decision was made. ' +
        'Write `title` as one sentence saying WHO did what or WHAT was settled ' +
        '(「Simon 回邮确认 Q4 预算按 80 万走」), for a reader who opens this Matter months from ' +
        'now; put the context a reader needs in `body`. One happening, one entry. ' +
        'Do NOT record cc-only mail, routine notifications, anything with no new information, ' +
        'or your own tool calls and edits — the operation log already has those. ' +
        'Correct a wrong entry with operation="update" instead of adding a second one; ' +
        'operation="delete" soft-deletes and "restore" brings it back. ' +
        '`happened_at` is when it HAPPENED in epoch MILLISECONDS (omit for "just now"), and ' +
        '`refs` carries the evidence (an email message_id, a linked resource_id, a URL). ' +
        'A progress entry is NOT an action item: matter_item_mutate creates work objects you ' +
        'can check off, this records something that already happened. A significant decision may ' +
        'deserve both, but never mirror every item status change into the progress lane.',
      inputSchema: matterProgressMutateSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.mutateMatterProgress(
          input.public_id,
          input.operation,
          input.progress_id,
          input.operation === 'create' ? input.progress : input.patch,
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
      description:
        'Create, update, soft-delete, or restore one Matter stakeholder — a person who matters ' +
        'to this specific matter (their role here, whether a reply is being waited on them, ' +
        'and how central they are: see the `tier` field). Add someone when the conversation ' +
        'shows they decide, own, or are blocking a piece of this matter — not for everyone who ' +
        'appears on a thread. Display order is owner-controlled and NOT settable here.',
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
        'Append a Matter note — the lightest way to record progress or a learning without ' +
        'rewriting the summary. Write the note for a future reader (blocker/conclusion first, ' +
        'then next step), not as a log of your own edits. The undo path soft-deletes the note ' +
        'item; history remains auditable.',
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

  // task 08-14 — 跟进配置的逐条编辑。class capability_change（不是 domain_write）：改的是一个
  // **无人值守、有网络出口**的 run 的触发条件，与 internal_agent_update 同待遇；代价是 im_chat
  // （飞书）里改不了跟进节奏，owner 知情接受（PRD D8）。两种 class 都不影响「跟进 run 自己改不了
  // 自己的跟进配置」—— matter_followup 矩阵行对二者一并拒绝。
  const matter_followup_mutate = auditedWriteTool(
    {
      ...shared,
      name: 'matter_followup_mutate',
      description:
        "Change ONE thing about a Matter's follow-up configuration, after reading it with " +
        'matter_get include=["followup"] (that is where trigger ids come from). Operations: ' +
        'add_trigger / update_trigger / remove_trigger / set_trigger_enabled (one entry, by ' +
        'trigger_id) · set_actions · set_enabled (the whole follow-up switch) · set_profile · ' +
        'set_instructions · set_model_override. ' +
        '🔴 There is no way to replace the trigger list wholesale — removing one requires naming ' +
        'its trigger_id, so a schedule edit can never silently drop the event/condition triggers ' +
        'sitting next to it. Note that a Matter whose status is done/canceled stops firing ' +
        'scheduled follow-ups regardless of this configuration.',
      inputSchema: matterFollowupMutateSchema,
      risk: 'edit',
      run: (input, { signal }) => {
        // payload 逐字段组装：每个 operation 只带它自己那几个键，语义与校验的权威在 Python。
        const payload: Record<string, unknown> = {}
        if (input.trigger_id !== undefined) payload.trigger_id = input.trigger_id
        if (input.trigger !== undefined) payload.trigger = input.trigger
        if (input.enabled !== undefined) payload.enabled = input.enabled
        if (input.actions !== undefined) payload.actions = input.actions
        if (input.profile_id !== undefined) payload.profile_id = input.profile_id
        if (input.instructions !== undefined) payload.instructions = input.instructions
        if (input.agent !== undefined) payload.agent = input.agent
        return domain.mutateMatterFollowup(
          input.public_id,
          input.operation,
          payload,
          mutation(input),
          signal
        )
      }
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

  const matter_attention_triage = auditedWriteTool(
    {
      ...shared,
      name: 'matter_attention_triage',
      description:
        'Resolve, snooze, or dismiss ONE attention signal (ids come from matter_attention_list). ' +
        'Resolving records that the situation behind the signal is handled — the same signal ' +
        'reopens on its own if the condition returns, so resolve is the normal choice. Snooze ' +
        'needs an `until` timestamp. Dismiss stops it being raised at all and is for signals the ' +
        'owner says are simply wrong. This changes only the signal; the Matter itself is untouched.',
      inputSchema: matterAttentionTriageSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.triageMatterAttention(
          input.public_id,
          input.signal_id,
          input.action,
          { until: input.until },
          mutation(input),
          signal
        )
    },
    collector,
    guard
  )

  const matter_suggestion_resolve = auditedWriteTool(
    {
      ...shared,
      name: 'matter_suggestion_resolve',
      description:
        'Confirm or reject unconfirmed resource suggestions on a Matter, in one batch — the ' +
        'ones a follow-up run or a calendar event attached without the owner having said yet ' +
        'that they belong. ' +
        'Confirming links the resources as real evidence; rejecting records that they do not ' +
        'belong, which also stops them being suggested again. Ids already handled elsewhere come ' +
        'back in `skipped` with a reason — the batch is not rejected for them.',
      inputSchema: matterSuggestionResolveSchema,
      risk: 'edit',
      run: (input, { signal }) =>
        domain.resolveMatterSuggestions(
          input.public_id,
          input.resource_ids,
          input.action,
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
    matter_progress_mutate,
    matter_resource_mutate,
    matter_stakeholder_mutate,
    matter_relation_mutate,
    matter_add_note,
    matter_followup_mutate,
    matter_run_control,
    matter_review_update,
    matter_attention_triage,
    matter_suggestion_resolve
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
        'reviews and decides. If there is no meaningful change, do not call this tool at all. ' +
        'To bring in NEW evidence you found (an email, a Notion/Jira page, a web page not yet ' +
        'attached to this Matter), add a kind="resource" change carrying `resource` ' +
        '{provider, kind, external_key, title, canonical_url, summary, diff}; the owner links it by ' +
        'accepting. `summary` says what the resource ITSELF states in at most 3 sentences — not ' +
        'why it is relevant, no filler; leave it empty rather than guessing from metadata alone, ' +
        'and omit it for mail/threads (those reuse the email’s own summary server-side). ' +
        '`diff` is one checkable sentence on what changed versus the PREVIOUS version, and only ' +
        'applies when the resource was already attached and you just read a newer version of it; ' +
        'omit it otherwise. ' +
        'A fact may cite such a pending resource with sources[].change_id instead of resource_id. ' +
        'When the evidence shows the matter actually MOVED (someone replied, something was ' +
        'delivered, a blocker cleared, a decision landed), also include one kind="progress" change ' +
        'carrying `progress` {kind, title, body?, happened_at?} — that is what feeds the 进展 lane. ' +
        'A fact records what is now true; a progress entry records that a step happened. When ' +
        'nothing moved, do not fabricate one. ' +
        'Three field changes carry extra weight and the owner reads them closely: ' +
        'field="background" rewrites 背景 (how this came about and what constrains it) and ' +
        'field="goal" rewrites 目标 (what must be true when it is done) — they are independent ' +
        'fields, so propose only the one the evidence shows actually moved, and never to reword; ' +
        'field="goal_checks" replaces the whole ' +
        'definition-of-done checklist (send the full list including existing entries and their ' +
        "done flags, or the ones you omit are dropped). All three are the owner's own words, so a " +
        'run may only PROPOSE them — it can never write them directly.',
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
