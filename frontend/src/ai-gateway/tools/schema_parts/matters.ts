// Matter tool zod input schemas.
import { z } from 'zod'
import {
  MATTER_PROGRESS_BODY_MAX_CHARS,
  MATTER_PROGRESS_KINDS,
  MATTER_PROGRESS_MAX_REFS,
  MATTER_PROGRESS_TITLE_MAX_CHARS,
  MATTER_RESOURCE_SUMMARY_MAX_CHARS
} from '../../../shared/api/types/matter'

const matterIdempotencyFields = {
  idempotency_key: z.string().trim().min(1).max(256).optional(),
  reason: z.string().max(2000).optional(),
  reverses_event_id: z.number().int().positive().optional()
}

const matterVersionedFields = {
  ...matterIdempotencyFields,
  expected_version: z
    .number()
    .int()
    .positive()
    .describe(
      'The matter version you last read (matter_get/matter_find or a previous mutation result). ' +
        'Sub-entity writes (items/resources/stakeholders/relations) are auto-rebased when the ' +
        'version has moved on, so parallel appends and edits of untouched rows succeed; ' +
        'E_VERSION_CONFLICT is returned only when the same object was concurrently modified — ' +
        'then re-read the matter before deciding whether to retry.'
    )
}

/** A3 (0813) — every user-facing matter timestamp is epoch MILLISECONDS. The model kept sending
 *  epoch seconds (rendered as 1970-01-21 across the whole chain), so the unit is now declared on
 *  every field AND enforced server-side (E_INVALID_ARG below 10^12). */
const epochMillis = (label: string): z.ZodType<number> =>
  z
    .number()
    .int()
    .describe(`${label} as epoch MILLISECONDS (UTC), e.g. 1786690800000. Never epoch seconds.`)

/** O3 (0813 轮 3) — the ONE shared voice for every progress-bearing field (current_summary /
 *  note text / proposal summary). Owner complaint「进展像操作日志」: the model kept writing
 *  "I changed the status / added two items" because no field ever said what a progress update IS.
 *  The Python follow-up-run contract (src/matters/run_spec.py 提案标准 last clause) states the
 *  same discipline in Chinese — intentionally two venue-worded texts, not a mirrored constant. */
export const MATTER_PROGRESS_STYLE =
  'Write it as a reader-facing narrative of the WORK itself, never a log of your own edits: ' +
  'lead with the current blocker or conclusion, then the concrete next step (who does what, ' +
  'by when). Never write "changed status to active / added two action items" — the timeline ' +
  'already records those operations.'

export const matterFindSchema = z.object({
  q: z
    .string()
    .trim()
    .optional()
    .describe("Free text matched over title / goal / summary / tags — use the user's own words."),
  status: z
    .enum(['inbox', 'planned', 'active', 'waiting', 'blocked', 'monitoring', 'done', 'canceled'])
    .optional(),
  health: z.enum(['unknown', 'on_track', 'at_risk', 'off_track']).optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
  type: z.string().trim().min(1).max(128).optional(),
  tag: z.string().trim().min(1).optional(),
  view: z.string().trim().min(1).optional(),
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type MatterFindInput = z.infer<typeof matterFindSchema>

/** Mirrors what `GET /api/matters/{id}` actually branches on (src/matters/service.py::get_matter).
 *  🔴 `updates` is not optional garnish: matter_review_update REQUIRES an `update_id`, and this is
 *  the only read face that hands one out — without it the review tool is structurally uncallable
 *  (0813 dogfood 轮 3). `followup` (task 08-14) is the same story for matter_followup_mutate:
 *  every per-entry operation needs a `trigger_id`, and this is the only face that hands those out.
 *  🔴 数组体里只许有字符串字面量 —— Python 侧抽取器（tests/matters/test_matters_contract_parity.py）
 *  见到注释/表达式会判为「部分抽取」并直接红，注释一律写在数组外。 */
export const MATTER_GET_INCLUDES = [
  'items',
  'resources',
  'stakeholders',
  'timeline',
  'relations',
  'updates',
  'followup',
  'progress'
] as const
export const matterGetSchema = z.object({
  public_id: z.string().trim().min(1),
  include: z.array(z.enum(MATTER_GET_INCLUDES)).default(['items', 'stakeholders'])
})
export type MatterGetInput = z.infer<typeof matterGetSchema>

/** task 08-14 — 跟进配置的逐条 operation。🔴 值域跨语言手抄自
 *  `src/matters/followup_config.py::FOLLOWUP_OPERATIONS`，闸见
 *  `tests/matters/test_matters_contract_parity.py::test_followup_operation_enum_matches_python`。
 *  🔴 数组体里只许有字符串字面量（抽取器会把注释判成「部分抽取」）。 */
export const MATTER_FOLLOWUP_OPERATIONS = [
  'add_trigger',
  'update_trigger',
  'remove_trigger',
  'set_trigger_enabled',
  'set_actions',
  'set_enabled',
  'set_profile',
  'set_instructions',
  'set_model_override'
] as const

/** matter_followup_mutate —— 事项跟进配置的**逐条**编辑。
 *
 * 🔴 结构上没有「整份替换 triggers」的入口：删一条必须显式给它的 `trigger_id`。否则模型一次
 * update 就能把 owner 配好的 event / condition trigger 静默抹掉（PRD D2）。
 *
 * `trigger` 是有界自由对象而不是判别式 schema：事项的 kind 集（schedule / event / condition）
 * 与 custom agent 的（cron / email_filter / calendar_*）根本不是一套，在这里再写一份等于本仓
 * 第三份 trigger 契约。深校验的唯一真源是 Python（`followup_config.py` → `triggers.py`），
 * 坏 rule / 未知 kind / 超量在服务端一律拒。 */
export const matterFollowupMutateSchema = z.object({
  public_id: z.string().trim().min(1),
  operation: z.enum(MATTER_FOLLOWUP_OPERATIONS),
  trigger_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Required by update_trigger / remove_trigger / set_trigger_enabled (from matter_get include=followup).'
    ),
  trigger: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'For add_trigger / update_trigger. Shapes: {kind:"schedule", rule:{freq,interval,weekdays,' +
        'monthMode,monthDay,ordinal,weekday,hour,minute,clamp}, anchor:"YYYY-MM-DD", timezone:IANA} ' +
        '| {kind:"event", event_type} | {kind:"condition", condition}. A trigger kind cannot be ' +
        'changed in place — remove it and add a new one.'
    ),
  enabled: z
    .boolean()
    .optional()
    .describe('For set_enabled (the whole follow-up switch) or set_trigger_enabled (one entry).'),
  actions: z.array(z.string().trim().min(1).max(32)).max(16).optional(),
  profile_id: z
    .string()
    .trim()
    .max(128)
    .nullable()
    .optional()
    .describe(
      'For set_profile: the custom agent whose persona/model this follow-up borrows; null unbinds.'
    ),
  instructions: z.string().max(4000).nullable().optional(),
  agent: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      'For set_model_override: {model, effort, fallbackModels}; null/{} clears the override.'
    ),
  ...matterVersionedFields
})
export type MatterFollowupMutateInput = z.infer<typeof matterFollowupMutateSchema>

/** O2 (0813 轮 3) — one goal check entry. Element shape mirrors the server's
 *  `normalize_goal_checks` consumption ({t, done}); text limit 200 / at most 20 entries are the
 *  same server guardrails (MAX_GOAL_CHECK_LENGTH / MAX_GOAL_CHECKS). */
const matterGoalCheckSchema = z.object({
  t: z.string().trim().min(1).max(200).describe('One verifiable completion criterion.'),
  done: z.boolean().default(false).describe('Whether this criterion is already met.')
})

export const matterCreateSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'Short, action-oriented name of the piece of work being pushed forward — not the source ' +
        'email subject copied verbatim.'
    ),
  // v61 —— 背景与目标是**两个独立字段**（此前是一个 `description` 里塞两个 Markdown
  // 小标题）。两份 describe 各自说清自己那一半，别互相引用「另一段」。
  background: z
    .string()
    .default('')
    .describe(
      'How this piece of work came about（背景）: who is involved, what triggered it, and the ' +
        'constraints and decisions already settled. Write real substance from the conversation ' +
        '— NOT a summary or copy of the source email (evidence belongs in linked resources). ' +
        'Do NOT put the target outcome here — that is `goal` — and do NOT put the checklist ' +
        'here — that is goal_checks（完成标志）. Editable later via matter_update, but only when ' +
        'the user says the background moved — and that always asks the owner to approve, so ' +
        'getting it right now is cheaper.'
    ),
  goal: z
    .string()
    .default('')
    .describe(
      'What must be true when this is finished（目标）: the outcome, stated as a state of the ' +
        'world rather than a list of steps. Leave it empty rather than inventing one when the ' +
        'user has not said what done looks like. Do NOT restate the background here, and do ' +
        'NOT put the checkable criteria here — that is goal_checks（完成标志）. Same later-edit ' +
        'and approval rules as `background`.'
    ),
  type: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Business category, e.g. 客户交付 / 商务 / 售前 / 问题 / 产品 / 内部. Reuse an existing ' +
        'type from matter_find results when one fits.'
    ),
  tags: z
    .array(z.string())
    .default([])
    .describe(
      'Existing tag names when they clearly apply; do not invent a new taxonomy uninvited — ' +
        'matter_tags_list shows what already exists.'
    ),
  status: z
    .enum(['inbox', 'planned', 'active', 'waiting', 'blocked', 'monitoring', 'done', 'canceled'])
    .default('inbox')
    .describe(
      'Lifecycle stage. Default inbox = captured but not yet planned; use active only when the ' +
        'work is actually underway.'
    ),
  health: z
    .enum(['unknown', 'on_track', 'at_risk', 'off_track'])
    .default('unknown')
    .describe(
      'Progress signal independent of status; keep unknown unless evidence says otherwise.'
    ),
  priority: z
    .enum(['p0', 'p1', 'p2', 'p3'])
    .default('p1')
    .describe(
      'p0 = drop-everything urgent, p3 = backlog. Default p1 unless the user says otherwise.'
    ),
  due_at: epochMillis('Matter due date').nullable().optional(),
  waiting_context: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe('Only meaningful with status=waiting: who/what is being waited on and since when.'),
  goal_checks: z
    .array(matterGoalCheckSchema)
    .max(20)
    .optional()
    .describe(
      'Definition of done（完成标志）— the third block of the 「背景与目标」 card, kept separate ' +
        'from the prose in `background` / `goal`: a short checklist of how the owner will know this ' +
        'Matter is complete, e.g. [{"t":"合同已签署"},{"t":"款项已到账"}]. Set it at creation ' +
        'when the user has stated or implied what done means. Editable later via matter_update ' +
        '(owner-approved, and it replaces the whole list).'
    ),
  ...matterIdempotencyFields
})
export type MatterCreateInput = z.infer<typeof matterCreateSchema>

const matterPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    type: z.string().trim().min(1).max(128).nullable().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).optional(),
    due_at: epochMillis('Matter due date').nullable().optional(),
    waiting_context: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z
      .enum(['inbox', 'planned', 'active', 'waiting', 'blocked', 'monitoring', 'done', 'canceled'])
      .optional(),
    health: z.enum(['unknown', 'on_track', 'at_risk', 'off_track']).optional(),
    // S3（08-18）—— 背景与目标、完成标志对 agent 开放。🔴 两者都属于 MATTER_OWNER_FIELDS：
    // 带到它们的 patch **恒弹审批卡**（按字段判，不是把整个 matter_update 提到恒 ask ——
    // 那会让改状态、改优先级这些低风险写也开始弹卡）。
    background: z
      .string()
      .optional()
      .describe(
        "Rewrite the Matter's 背景 (how this came about, who is involved, settled constraints " +
          "and decisions). This is the owner's own words — change it ONLY when the user has " +
          'just told you the background moved, and send the whole field, not just the sentence ' +
          'that changed. Never rewrite it to "improve" the wording, and never fold status ' +
          'updates into it (that is current_summary). Always sends the owner an approval card ' +
          'showing the full new text; a follow-up run cannot call this at all and must propose ' +
          'instead.'
      ),
    goal: z
      .string()
      .optional()
      .describe(
        "Rewrite the Matter's 目标 (what must be true when this is finished). Independent of " +
          '`background` — send only the one that actually moved. Same owner-words rule, same ' +
          'approval card, same follow-up-run restriction. The checkable criteria live in ' +
          'goal_checks, not here.'
      ),
    goal_checks: z
      .array(matterGoalCheckSchema)
      .max(20)
      .optional()
      .describe(
        'Replace the definition of done（完成标志）— the whole checklist, not a delta. Send the ' +
          'full desired list including entries that already exist and their done flags, or you ' +
          'will silently drop the ones you omit. Same approval + follow-up-run rules as ' +
          '`background` / `goal`.'
      ),
    current_summary: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The「当前状态」progress narrative at the top of the Matter detail page. ' +
          MATTER_PROGRESS_STYLE +
          ' null clears it.'
      )
  })
  .strict()

export const matterUpdateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['patch', 'archive', 'reopen', 'trash', 'restore']),
    patch: matterPatchSchema.optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'patch' && value.patch == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'patch is required for operation=patch',
        path: ['patch']
      })
    }
    if (value.operation !== 'patch' && value.patch != null) {
      ctx.addIssue({
        code: 'custom',
        message: 'patch is only valid for operation=patch',
        path: ['patch']
      })
    }
  })
export type MatterUpdateInput = z.infer<typeof matterUpdateSchema>

const matterChecklistEntrySchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  done: z.boolean().default(false)
})
const matterItemFields = {
  kind: z
    .enum(['action', 'milestone', 'decision', 'blocker', 'question', 'note'])
    .optional()
    .describe(
      'action = a trackable to-do (the ONLY kind that carries status/priority/owner/due/' +
        'checklist); milestone = a dated marker; decision = a decision made and why; blocker = ' +
        'what is blocking progress; question = an open question needing an answer; note = a ' +
        'free-form remark (the same record matter_add_note creates).'
    ),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().nullable().optional(),
  position: z.number().int().optional(),
  status: z
    .enum(['open', 'in_progress', 'waiting', 'blocked', 'done', 'canceled'])
    .nullable()
    .optional(),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']).nullable().optional(),
  owner_kind: z.enum(['user', 'agent', 'system']).nullable().optional(),
  owner_id: z.string().nullable().optional(),
  waiting_on_stakeholder_id: z.number().int().positive().nullable().optional(),
  due_at: epochMillis('Item due date').nullable().optional(),
  completed_at: epochMillis('Completion time').nullable().optional(),
  checklist: z.array(matterChecklistEntrySchema).optional(),
  source_resource_id: z.number().int().positive().nullable().optional(),
  source_locator: z.record(z.string(), z.unknown()).nullable().optional()
}
export const matterItemMutateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['create', 'update', 'delete', 'restore']),
    item_id: z.number().int().positive().optional(),
    item: z.object(matterItemFields).strict().optional(),
    patch: z.object(matterItemFields).strict().optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'create' && value.item_id != null)
      ctx.addIssue({ code: 'custom', message: 'create forbids item_id', path: ['item_id'] })
    if (value.operation !== 'create' && value.item_id == null)
      ctx.addIssue({ code: 'custom', message: 'item_id is required', path: ['item_id'] })
    if (value.operation === 'create' && value.item == null)
      ctx.addIssue({ code: 'custom', message: 'item is required', path: ['item'] })
    if (value.operation === 'update' && value.patch == null)
      ctx.addIssue({ code: 'custom', message: 'patch is required', path: ['patch'] })
    const fields = value.operation === 'create' ? value.item : value.patch
    if (fields?.kind != null && fields.kind !== 'action') {
      for (const key of [
        'status',
        'priority',
        'owner_kind',
        'owner_id',
        'waiting_on_stakeholder_id',
        'due_at',
        'completed_at',
        'checklist'
      ] as const) {
        if (
          fields[key] != null &&
          !(key === 'checklist' && Array.isArray(fields[key]) && fields[key].length === 0)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'non-action item forbids action-only fields',
            path: [value.operation === 'create' ? 'item' : 'patch', key]
          })
        }
      }
    }
  })
export type MatterItemMutateInput = z.infer<typeof matterItemMutateSchema>

// ── task 08-25 — curated 进展 lane（matter_progress_mutate）────────────────────────────────────
//
// 词表 canonical 在 Python（`src/matters/models.MatterProgressKind`）；TS 侧**唯一**镜像
// 在 `shared/api/types/matter.ts::MATTER_PROGRESS_KINDS`（跨语言闸在那份上），这里 import
// 复用 —— 不再第二份手抄。长度上限同源（`MATTER_PROGRESS_TITLE/BODY_MAX_CHARS`）。

/** 一条进展的证据链引用。
 *
 *  🔴 形状权威在 Python（`models.normalize_progress_refs`），那里**有意宽松**：只要求「是
 *  对象、带非空 type」。这里的键是扁平并集而不是三个互斥变体 —— 把「email 必须带
 *  message_id」写成条件约束就是第二份契约，而分支约束一律不进 tool schema（本仓两连败）。
 *  哪个键配哪个 type 写在 describe 里，模型读得到，写错了服务端也只是丢那一条引用。 */
const matterProgressRefSchema = z
  .object({
    type: z.enum(['email', 'resource', 'url']),
    message_id: z.string().trim().min(1).optional(),
    resource_id: z.number().int().positive().optional(),
    url: z.string().trim().min(1).optional()
  })
  .strict()
  .describe(
    "Evidence for this entry: type='email' carries message_id, type='resource' carries " +
      'resource_id (a resource already linked to this Matter — ids come from matter_get), ' +
      "type='url' carries url."
  )

const matterProgressFields = {
  kind: z
    .enum(MATTER_PROGRESS_KINDS)
    .optional()
    .describe(
      'goal = the goal was set or revised; milestone = a milestone was reached; progress = ' +
        'something concretely moved (a reply that settles a question, a delivery, a step ' +
        'forward); signal = a risk or warning sign worth watching; decision = a decision was ' +
        'made. Pick by what HAPPENED, not by how important it feels — progress is the default.'
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(MATTER_PROGRESS_TITLE_MAX_CHARS)
    .optional()
    .describe(
      'One sentence saying WHO did what or WHAT was settled, e.g. 「Simon 回邮确认 Q4 预算按 ' +
        '80 万走」. Written for someone reading this Matter months from now — never "updated ' +
        'the status" or "searched the mailbox".'
    ),
  body: z
    .string()
    .max(MATTER_PROGRESS_BODY_MAX_CHARS)
    .nullable()
    .optional()
    .describe(
      'Optional detail: the context a future reader needs. Leave out when the title says it all.'
    ),
  happened_at: epochMillis('When this actually happened')
    .optional()
    .describe(
      'When it HAPPENED (epoch MILLISECONDS), not when you are recording it — omit for ' +
        '"just now". Backdating an entry you learned about late is the normal case.'
    ),
  refs: z.array(matterProgressRefSchema).max(MATTER_PROGRESS_MAX_REFS).optional()
}

/** matter_progress_mutate — 单 op 形状照 `matter_item_mutate`。
 *
 *  🔴 `superRefine` 而不是顶层 `oneOf` / `not`：refinement 不进 JSON Schema（模型看到的是一份
 *  扁平可选的 schema），所以「prompt/schema 里的分支约束把模型带沟里」那两连败在这里不成立；
 *  值域与条件必填的**权威**在 Python（`service._progress_insert_fields` / `_progress_patch_fields`），
 *  这里只是让明显写错的调用当场返回可读的报错，少浪费一轮。 */
export const matterProgressMutateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['create', 'update', 'delete', 'restore']),
    progress_id: z.number().int().positive().optional(),
    progress: z.object(matterProgressFields).strict().optional(),
    patch: z.object(matterProgressFields).strict().optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'create' && value.progress_id != null)
      ctx.addIssue({ code: 'custom', message: 'create forbids progress_id', path: ['progress_id'] })
    if (value.operation !== 'create' && value.progress_id == null)
      ctx.addIssue({ code: 'custom', message: 'progress_id is required', path: ['progress_id'] })
    if (
      value.operation === 'create' &&
      (value.progress?.kind == null || value.progress.title == null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'create requires progress with kind and title',
        path: ['progress']
      })
    if (value.operation === 'update' && value.patch == null)
      ctx.addIssue({ code: 'custom', message: 'patch is required', path: ['patch'] })
  })
export type MatterProgressMutateInput = z.infer<typeof matterProgressMutateSchema>

export const matterResourceMutateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['link', 'update', 'unlink', 'restore']),
    resource_id: z.number().int().positive().optional(),
    resource: z
      .object({
        provider: z.string().trim().min(1),
        external_key: z.string().trim().min(1),
        kind: z.enum(['email', 'thread', 'event', 'doc', 'file', 'url']),
        title: z.string().optional(),
        canonical_url: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        access_policy: z.enum(['allowed', 'metadata_only', 'excluded']).optional(),
        pinned: z.boolean().optional(),
        relation_type: z.string().nullable().optional(),
        confirmed: z.boolean().optional(),
        sub_state: z.enum(['none', 'active', 'paused']).optional()
      })
      .strict()
      .optional(),
    patch: z
      .object({
        scope: z.enum(['resource', 'link']).optional(),
        access_policy: z.enum(['allowed', 'metadata_only', 'excluded']).optional(),
        pinned: z.boolean().optional(),
        relation_type: z.string().nullable().optional(),
        sub_state: z.enum(['active', 'paused']).optional(),
        confirmed: z.boolean().optional()
      })
      .strict()
      .optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'link' && (value.resource_id == null) === (value.resource == null))
      ctx.addIssue({
        code: 'custom',
        message: 'link requires exactly one of resource_id or resource',
        path: ['resource']
      })
    if (value.operation !== 'link' && value.resource_id == null)
      ctx.addIssue({ code: 'custom', message: 'resource_id is required', path: ['resource_id'] })
    if (value.operation === 'update' && value.patch == null)
      ctx.addIssue({ code: 'custom', message: 'patch is required', path: ['patch'] })
    if (value.patch?.access_policy != null && value.patch.scope !== 'resource')
      ctx.addIssue({
        code: 'custom',
        message: "access_policy requires scope='resource'",
        path: ['patch', 'scope']
      })
  })
export type MatterResourceMutateInput = z.infer<typeof matterResourceMutateSchema>

const stakeholderFields = z
  .object({
    person_key: z.string().optional(),
    display_name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    organization: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    relationship: z.string().nullable().optional(),
    is_waiting_on: z.boolean().optional(),
    tier: z
      .enum(['core', 'normal'])
      .optional()
      .describe(
        'How central this person is TO THIS MATTER (not a global property — the same person ' +
          'may be a bystander on another matter). `core`: drives or decides where this goes ' +
          '(decision maker, counterpart owner, the person a reply is being waited on). ' +
          '`normal`: kept in the loop, cc-ed, shows up occasionally. When unsure use `normal` — ' +
          'the core group is a short list the owner scans at a glance, and padding it destroys ' +
          'that. Defaults to `normal`.'
      ),
    last_contact_at: epochMillis('Last contact time').nullable().optional(),
    source_resource_id: z.number().int().positive().nullable().optional()
  })
  .strict()
// 🔴 `sort_order` **有意不给 agent**：那是 owner 拖出来的手感，模型排不出用户心里的顺序，
//    给了只会制造无谓的写和审批卡。它也不在 REST 的逐条 patch 白名单里（整批走
//    `PUT /stakeholders/order`，那个端点不对 agent 开放）。工具说明里明说这一点，
//    免得模型试图用 patch 绕。
export const matterStakeholderMutateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['create', 'update', 'delete', 'restore']),
    stakeholder_id: z.number().int().positive().optional(),
    stakeholder: stakeholderFields.optional(),
    patch: stakeholderFields.optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'create' && value.stakeholder_id != null)
      ctx.addIssue({
        code: 'custom',
        message: 'create forbids stakeholder_id',
        path: ['stakeholder_id']
      })
    if (value.operation !== 'create' && value.stakeholder_id == null)
      ctx.addIssue({
        code: 'custom',
        message: 'stakeholder_id is required',
        path: ['stakeholder_id']
      })
    if (value.operation === 'create' && value.stakeholder == null)
      ctx.addIssue({ code: 'custom', message: 'stakeholder is required', path: ['stakeholder'] })
    if (value.operation === 'update' && value.patch == null)
      ctx.addIssue({ code: 'custom', message: 'patch is required', path: ['patch'] })
  })
export type MatterStakeholderMutateInput = z.infer<typeof matterStakeholderMutateSchema>

const relationFields = z
  .object({
    target_public_id: z.string().trim().min(1).optional(),
    relation_type: z
      .enum(['related_to', 'depends_on', 'blocks', 'follow_up_of', 'supersedes'])
      .nullable()
      .optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    confirmed: z.boolean().optional()
  })
  .strict()
export const matterRelationMutateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['create', 'update', 'delete', 'restore']),
    relation_id: z.number().int().positive().optional(),
    relation: relationFields.optional(),
    patch: relationFields.omit({ target_public_id: true }).optional(),
    ...matterVersionedFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'create' && value.relation_id != null)
      ctx.addIssue({ code: 'custom', message: 'create forbids relation_id', path: ['relation_id'] })
    if (value.operation !== 'create' && value.relation_id == null)
      ctx.addIssue({ code: 'custom', message: 'relation_id is required', path: ['relation_id'] })
    if (value.operation === 'create' && value.relation == null)
      ctx.addIssue({ code: 'custom', message: 'relation is required', path: ['relation'] })
    if (value.operation === 'update' && value.patch == null)
      ctx.addIssue({ code: 'custom', message: 'patch is required', path: ['patch'] })
  })
export type MatterRelationMutateInput = z.infer<typeof matterRelationMutateSchema>

export const matterAddNoteSchema = z.object({
  public_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(500).optional(),
  text: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What happened or what was learned, written for a future reader. ' + MATTER_PROGRESS_STYLE
    ),
  ...matterVersionedFields
})
export type MatterAddNoteInput = z.infer<typeof matterAddNoteSchema>

// ── Matters MVP P4 — follow-up run: propose (D6) + the two review-side tools (D8) ─────────────
//
// 🔴 The mutation fields are spelled out here instead of spreading matterVersionedFields: neither
// tool can ever carry `reverses_event_id` (a run start / a review decision is not the reversal of
// an audit event), and matter_run_control's expected_version is OPTIONAL (an input anchor, not the
// concurrency gate matterVersionedFields models).
const matterReviewIdempotencyFields = {
  idempotency_key: z.string().trim().min(1).max(256).optional(),
  reason: z.string().max(2000).optional()
}

/** One evidence source of a proposed change — exactly one of `resource_id` / `change_id`.
 *  🔴 `resource_id` must belong to this Matter and `change_id` must name a `kind: 'resource'`
 *  change IN THIS SAME proposal that survived validation. The Python service re-validates both
 *  against server facts and drops the source (and, for a `fact`, the whole change) when it does
 *  not (D6 anti-hallucination) — the zod rule below only makes the ambiguous shapes
 *  unrepresentable, it is never the authority. */
const matterProposalSourceSchema = z
  .object({
    resource_id: z.number().int().positive().optional(),
    change_id: z.string().trim().min(1).max(64).optional(),
    locator: z.record(z.string(), z.unknown()).optional(),
    evidence: z.string().max(500).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const given = [value.resource_id != null, value.change_id != null].filter(Boolean).length
    if (given !== 1)
      ctx.addIssue({
        code: 'custom',
        message:
          'a source needs exactly one of resource_id (already linked) or change_id (a new resource proposed in this same call)',
        path: ['resource_id']
      })
  })

/** The identity of a resource this proposal wants to link for the FIRST time (0812).
 *  Field names are the existing `resource` table columns / `_upsert_resource` inputs — no second
 *  vocabulary. 🔴 `provider` is a SERVER-side whitelist (built-ins plus the connectors that are
 *  actually connected); the regex here only rejects free-form strings, it does not decide
 *  membership. `external_key` conventions per provider (`email:<id>` / an http(s) URL /
 *  `<entity>:<id>`) are likewise re-derived server-side and fail closed.
 *
 *  🔴 This shape is hand-copied FOUR times (this zod, the tool description below, the REST DTO
 *  `MatterProposalNewResource`, the `normalize_new_resource` key set) and the REST DTO forbids
 *  extras — adding a field here alone turns every discovery proposal into a silent 422. The
 *  parity gate is `tests/matters/test_matters_contract_parity.py`. */
const matterProposalNewResourceSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'provider must be a lowercase connector/source id'),
    kind: z.enum(['email', 'thread', 'event', 'doc', 'file', 'url']),
    external_key: z.string().trim().min(1).max(512),
    title: z.string().trim().max(500).optional(),
    canonical_url: z.string().trim().max(2000).optional(),
    /** What this resource SAYS, in at most 3 sentences — never why it is relevant (that belongs
     *  in the change text/reason), never filler like "this document introduces…". Leave it out
     *  when only metadata is visible: an invented summary is worse than an empty one. Mail and
     *  threads reuse the email's own AI summary server-side, so a model-written one is dropped. */
    summary: z.string().trim().max(MATTER_RESOURCE_SUMMARY_MAX_CHARS).optional(),
    /** Only when this resource was ALREADY attached and you just read a NEWER version: one
     *  checkable sentence on what changed versus the previous one (fields added/removed,
     *  numbers, status/date moves). It is filed into the version trail against the version that
     *  was superseded. Omit it for a first-time link and for mail/threads — neither has a
     *  previous version, so there is nothing for the sentence to be about. */
    diff: z.string().trim().max(MATTER_RESOURCE_SUMMARY_MAX_CHARS).optional()
  })
  .strict()

/** A proposed field/state value. Structured Matter fields (waiting_context) are objects, scalar
 *  ones (status/priority/due_at) are strings/numbers — hence the explicit union rather than a bare
 *  unknown (an unbounded `any` would give the model no shape guidance at all). */
const matterProposalValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown())
])

/** `happened_at` 宽收严归一（0825 dogfood）：模型描述日期时爱给 ISO 字符串，而这里只收 int
 *  毫秒 ⇒ 整个 matter_update_propose 调用被 AI_TypeValidationError 打回，重试那一发往往把
 *  progress change 整条丢掉（实测 matter_run 30：重试后只剩 fact/action/resource）。一个
 *  **可选**字段不该有能力打空整轮提案 —— 何况 REST DTO `MatterProposalProgress.happened_at`
 *  是 `int | None`，字符串连 `_validate_changes` 的门都摸不到就会 422 掉整份提案。
 *  🔴 只归一 ISO 字符串（无歧义），**不**把 epoch 秒 ×1000：秒值恒拒是 matter 域的时间戳纪律
 *  （A3 三道门），归一出的毫秒照旧要过 Python `run_service._validate_changes` 的 epoch-ms 门，
 *  权威一步没挪。解析不出来的字符串折成「不给」（= 按 owner 接受的时刻算），而不是让整条提案失败。
 *  🔴 这是**类型**联合（leaf anyOf），不是分支约束 —— 顶层 oneOf / 条件必填仍然禁止。 */
const matterProgressHappenedAtSchema = z
  .union([
    epochMillis('When this happened'),
    z
      .string()
      .trim()
      .max(100)
      .describe(
        'Or an ISO-8601 date / datetime (e.g. "2026-08-20" or "2026-08-20T10:00:00Z"), ' +
          'normalized to epoch milliseconds here. Epoch milliseconds are preferred.'
      )
  ])
  .transform((value) => {
    if (typeof value === 'number') return value
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  })

/** `kind: 'progress'` 的载荷（task 08-25）：跟进 run 对 curated 进展的**唯一**通道 —— 它拿不到
 *  进展写工具（结构红线），owner 接受这条 change 时才落成一行进展。
 *  🔴 只有「追加」这一种形态：信封里没有 progress_id，改既有条目要 owner 在场（事项对话）。
 *  字段与 REST DTO `MatterProposalProgress` / `service._progress_insert_fields` 同名同义。 */
const matterProposalProgressSchema = z
  .object({
    kind: z.enum(MATTER_PROGRESS_KINDS),
    title: z.string().trim().min(1).max(MATTER_PROGRESS_TITLE_MAX_CHARS),
    body: z.string().trim().max(MATTER_PROGRESS_BODY_MAX_CHARS).optional(),
    happened_at: matterProgressHappenedAtSchema.optional(),
    refs: z.array(matterProgressRefSchema).max(MATTER_PROGRESS_MAX_REFS).default([])
  })
  .strict()

const matterProposalChangeSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    kind: z.enum(['fact', 'inference', 'field', 'action', 'resource', 'progress']),
    target: z
      .object({
        entity: z.enum(['matter', 'item', 'resource', 'stakeholder']),
        id: z.union([z.string(), z.number()]).optional(),
        field: z.string().trim().min(1).max(64).optional()
      })
      .strict()
      .optional(),
    /** `kind: 'resource'` has two shapes: `target.id` CONFIRMS a resource already linked to this
     *  Matter, `resource` LINKS a newly found one for the first time. Exactly one of them. */
    resource: matterProposalNewResourceSchema.optional(),
    /** `kind: 'progress'` 的载荷 —— 记一条进展。 */
    progress: matterProposalProgressSchema.optional(),
    operation: z.enum(['add', 'replace', 'remove']).optional(),
    before: matterProposalValueSchema.optional(),
    after: matterProposalValueSchema.optional(),
    text: z.string().max(2000).optional(),
    reason: z.string().max(1000).optional(),
    is_inference: z.boolean().optional(),
    sources: z.array(matterProposalSourceSchema).max(5).default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.progress != null && value.kind !== 'progress')
      ctx.addIssue({
        code: 'custom',
        message: 'only a kind="progress" change can carry a progress entry',
        path: ['progress']
      })
    if (value.kind === 'progress' && value.progress == null)
      ctx.addIssue({
        code: 'custom',
        message: 'a kind="progress" change needs a progress entry',
        path: ['progress']
      })
    if (value.resource == null) return
    if (value.kind !== 'resource')
      ctx.addIssue({
        code: 'custom',
        message: 'only a kind="resource" change can carry a resource identity',
        path: ['resource']
      })
    if (value.target?.id != null)
      ctx.addIssue({
        code: 'custom',
        message:
          'a resource change either confirms an existing link (target.id) or proposes a new one (resource), never both',
        path: ['resource']
      })
  })

/** matter_update_propose — the follow-up run's ONLY output channel (D6).
 *  🔴 There is deliberately NO matter_id / run_id / from_event_id / to_event_id /
 *  anchored_matter_version field: all of them are stamped server-side from the run context
 *  (AgentRunContext.matterRun + the Python run row), so the model structurally cannot address
 *  another Matter, another run, or a different event watermark. */
export const matterUpdateProposeSchema = z
  .object({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe('At most 3 sentences. ' + MATTER_PROGRESS_STYLE),
    changes: z.array(matterProposalChangeSchema).max(20).default([]),
    open_questions: z.array(z.string().trim().min(1).max(500)).max(5).optional(),
    confidence: z.number().min(0).max(1).optional()
  })
  .strict()
export type MatterUpdateProposeInput = z.infer<typeof matterUpdateProposeSchema>

/** matter_item_report — an ITEM-dispatch run's ONLY output channel (L4 批次3, task 08-25).
 *  🔴 Like matterUpdateProposeSchema there is deliberately NO matter / item / dispatch id: all
 *  three are stamped server-side from the run context, so the model structurally cannot report
 *  against another dispatch.
 *  🔴 FLAT on purpose — `changes`/`summary` XOR `needs_input`, "exactly one of them", and "at most
 *  one question per round" are NOT expressed here. Branch constraints stay out of tool schemas
 *  (D11: a top-level oneOf / conditional-required took the whole tool chain down twice); Python
 *  `run_service.report_item_dispatch` is the single judge and its rejection reaches the model in
 *  the same turn. */
export const matterItemReportSchema = z
  .object({
    summary: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe(
        'At most 3 sentences: what you concluded or produced for THIS action item, written for ' +
          'the owner. Not a log of the tools you called.'
      ),
    changes: z
      .array(matterProposalChangeSchema)
      .max(20)
      .optional()
      .describe(
        'What you propose to record. kind="action" with target {entity:"item", id:<this item>} ' +
          'updates THIS item; kind="action" without a target creates a sub-task. Changes aimed ' +
          'at other items, or at the Matter\'s own fields (kind="field"), are dropped server-side.'
      ),
    needs_input: z
      .object({
        question: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .describe('One question, answerable in a sentence. Ask everything you need at once.'),
        options: z
          .array(z.string().trim().min(1).max(200))
          .max(8)
          .optional()
          .describe('Concrete choices, when the answer is a pick rather than free text.')
      })
      .strict()
      .optional()
      .describe(
        'Use INSTEAD of summary/changes when a decision only the owner can make is blocking you. ' +
          'The round ends here; once the owner answers, a fresh round starts with this Q&A ' +
          'carried over.'
      )
  })
  .strict()
export type MatterItemReportInput = z.infer<typeof matterItemReportSchema>

/** matter_run_control — start or cancel a follow-up run (D8).
 *  🔴 No `trigger_kind` field: a manual start is the ONLY kind this tool can produce (the gateway
 *  pins it), so forging `trigger_kind=schedule` is structurally impossible (contracts §4.4). Also
 *  no agent id / tool policy / prompt / budget — the authoritative spec comes from the Matter
 *  binding, never from the model. */
export const matterRunControlSchema = z
  .object({
    public_id: z.string().trim().min(1),
    operation: z.enum(['start', 'cancel']),
    run_id: z.number().int().positive().optional(),
    expected_version: z.number().int().positive().optional(),
    ...matterReviewIdempotencyFields
  })
  .superRefine((value, ctx) => {
    if (value.operation === 'cancel' && value.run_id == null)
      ctx.addIssue({ code: 'custom', message: 'run_id is required to cancel', path: ['run_id'] })
    if (value.operation === 'start' && value.run_id != null)
      ctx.addIssue({ code: 'custom', message: 'start forbids run_id', path: ['run_id'] })
  })
export type MatterRunControlInput = z.infer<typeof matterRunControlSchema>

const matterEditedChangeSchema = z
  .object({
    change_id: z.string().trim().min(1).max(64),
    after: matterProposalValueSchema.optional(),
    text: z.string().max(2000).optional(),
    edit_reason: z.string().max(1000).optional()
  })
  .strict()

/** matter_review_update — accept or reject one pending proposal (D8, contracts §4.4).
 *  Shape only: whether an id actually exists in the stored proposal, whether the Update is stale,
 *  and whether the Matter version still matches are all SERVER checks (E_UPDATE_STALE /
 *  E_VERSION_CONFLICT). Zod's job is to make the illegal request shapes unrepresentable. */
export const matterReviewUpdateSchema = z
  .object({
    public_id: z.string().trim().min(1),
    update_id: z.number().int().positive(),
    decision: z.enum(['accept', 'reject']),
    selected_change_ids: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    edited_changes: z.array(matterEditedChangeSchema).max(20).optional(),
    edited_summary: z.string().max(2000).optional(),
    expected_version: z.number().int().positive(),
    ...matterReviewIdempotencyFields
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'reject') {
      if (!value.reason || value.reason.trim().length === 0)
        ctx.addIssue({ code: 'custom', message: 'reject requires a reason', path: ['reason'] })
      for (const key of ['selected_change_ids', 'edited_changes', 'edited_summary'] as const) {
        if (value[key] != null)
          ctx.addIssue({ code: 'custom', message: `reject forbids ${key}`, path: [key] })
      }
      return
    }
    // accept — selected_change_ids must be PRESENT; an explicitly empty array is the
    // "accept the summary only" case (contracts §4.4), never an accidental omission.
    if (value.selected_change_ids == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'accept requires selected_change_ids (pass [] to accept a summary-only Update)',
        path: ['selected_change_ids']
      })
      return
    }
    const selected = new Set(value.selected_change_ids)
    for (const edit of value.edited_changes ?? []) {
      if (!selected.has(edit.change_id))
        ctx.addIssue({
          code: 'custom',
          message: `edited change ${edit.change_id} is not in selected_change_ids`,
          path: ['edited_changes']
        })
    }
  })
export type MatterReviewUpdateInput = z.infer<typeof matterReviewUpdateSchema>

// ── 0813 轮 3 批 R — the four action surfaces that had REST but no tool ────────────────────────
//
// Owner complaint「工具提供的不全」. Each of these wraps an endpoint that already exists; nothing
// new is authored server-side. Deliberately NOT mirrored here: the `kind` / `status` /
// `trigger_kind` filter enums. They are Python vocabularies (MatterAttentionKind,
// MATTER_RUN_LIFECYCLE_STATES, MatterRunTrigger) and every returned row already carries the
// value, so the model can filter what it got back — copying three more enums across the language
// boundary would buy a filter shortcut and cost three un-gated hand-copies.

/** matter_attention_list — the「有哪些事项在告警」read. `state` is copied from Python's
 *  MatterAttentionState (4 values); the server re-validates it (E_INVALID_ARG on drift). */
export const matterAttentionListSchema = z.object({
  public_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Limit to one Matter. OMIT it to sweep every Matter — that is the "what needs attention ' +
        'right now" question, and the only way to answer it.'
    ),
  state: z
    .enum(['open', 'snoozed', 'resolved', 'dismissed'])
    .default('open')
    .describe(
      'open = still asking for attention (the default, and almost always what you want). The ' +
        'other three answer "what did I already triage".'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Newest first. The reply reports whether it truncated.')
})
export type MatterAttentionListInput = z.infer<typeof matterAttentionListSchema>

/** matter_attention_triage — resolve / snooze / dismiss ONE signal.
 *  🔴 No expected_version: an attention signal is not part of the Matter's versioned state (the
 *  REST face takes the mutation envelope with require_version=False). */
export const matterAttentionTriageSchema = z
  .object({
    public_id: z.string().trim().min(1),
    signal_id: z
      .number()
      .int()
      .positive()
      .describe('The signal `id` from matter_attention_list — not the Matter id.'),
    action: z
      .enum(['resolve', 'snooze', 'dismiss'])
      .describe(
        'resolve = the situation behind it is handled; the signal reopens by itself if the ' +
          'condition comes back. snooze = not now, ask again after `until`. dismiss = stop ' +
          'raising this one at all. Prefer resolve; only dismiss when the owner says the signal ' +
          'itself is wrong.'
      ),
    until: epochMillis(
      'Snooze expiry (required for action=snooze, must be in the future)'
    ).optional(),
    ...matterReviewIdempotencyFields
  })
  .superRefine((value, ctx) => {
    if (value.action === 'snooze' && value.until == null)
      ctx.addIssue({ code: 'custom', message: 'snooze requires until', path: ['until'] })
    if (value.action !== 'snooze' && value.until != null)
      ctx.addIssue({
        code: 'custom',
        message: 'until only applies to snooze',
        path: ['until']
      })
  })
export type MatterAttentionTriageInput = z.infer<typeof matterAttentionTriageSchema>

/** matter_runs_list — what the follow-up runs actually did.
 *  🔴 Bounded projection on the tool side (matters.ts): the raw run row carries
 *  `trigger_payload`, which is fenced UNTRUSTED content copied from an email / calendar event.
 *  A run history read is not a smuggling route for it. */
export const matterRunsListSchema = z.object({
  public_id: z.string().trim().min(1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Most recent first. Each row says whether it produced a proposal (`update_id`).')
})
export type MatterRunsListInput = z.infer<typeof matterRunsListSchema>

/** matter_tags_list — the tag vocabulary that already exists.
 *  Zero parameters: the whole point is「先看看有哪些标签」before matter_create/matter_update
 *  invents a near-duplicate one. */
export const matterTagsListSchema = z.object({})
export type MatterTagsListInput = z.infer<typeof matterTagsListSchema>

/** matter_suggestion_resolve — the disposal half of resource suggestions (unconfirmed links a
 *  follow-up run or a calendar-ended event attached). Without it the only way to act on one was
 *  matter_resource_mutate patch confirmed:true per row, and rejecting was impossible.
 *  One call, one version check, one version bump — mixed-in ids that were already handled come
 *  back in `skipped` with a reason instead of failing the batch. */
export const matterSuggestionResolveSchema = z.object({
  public_id: z.string().trim().min(1),
  resource_ids: z
    .array(z.number().int().positive())
    // 200 = the server's MATTER_SUGGESTION_BULK_MAX; it re-checks and 400s past it.
    .min(1)
    .max(200)
    .describe(
      'Unconfirmed resource ids, from matter_get(include:["resources"]). Ids that are already ' +
        'confirmed / unlinked / not on this Matter are reported in `skipped`, not rejected.'
    ),
  action: z
    .enum(['confirm', 'reject'])
    .describe(
      'confirm = link them for real (the Matter now treats them as evidence). reject = record ' +
        'that they do not belong here, which also teaches the suggester not to raise them again.'
    ),
  ...matterVersionedFields
})
export type MatterSuggestionResolveInput = z.infer<typeof matterSuggestionResolveSchema>
