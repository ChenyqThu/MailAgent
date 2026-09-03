// chat-panel P4 Phase 03a — zod input schemas for the AI SDK Gateway read tools.
//
// One zod schema per migrated read tool, mirroring the legacy JSON-Schema field
// names / constraints / defaults (shared/chat/tools/builtin/{email,attachment,kos,
// report}.ts) byte-for-byte so the model sees the same tool surface and the parity
// tests can drive both implementations from the SAME input fixtures. Exported so the
// parity tests import the canonical schemas rather than re-declaring them.
//
// 🔴 Tool-facing field names (snake_case, model-visible) — these are the LEGACY tool
//    param names, NOT the serve-api wire names. The domain client maps them to the
//    (inconsistent) wire params; see python/domainClient.ts.

import { z } from 'zod'
import {
  GROUP_HISTORY_LIMIT_MAX,
  GROUP_POST_TEXT_MAX_CHARS,
  MAX_GROUP_MEMBERS,
  RESPONSE_MODES
} from '../groupFloors'
import { FEEDBACK_FREQUENCIES, FEEDBACK_KINDS } from '../../shared/feedback/contract'
import { REPORT_CADENCES, reportBlockInputSchema } from '../../shared/api/reportBlocks'
import {
  MATTER_PROGRESS_BODY_MAX_CHARS,
  MATTER_PROGRESS_KINDS,
  MATTER_PROGRESS_MAX_REFS,
  MATTER_PROGRESS_TITLE_MAX_CHARS,
  MATTER_RESOURCE_SUMMARY_MAX_CHARS
} from '../../shared/api/types/matter'

export const PLAN_STEP_STATUSES = [
  'pending',
  'in_progress',
  'done',
  'blocked',
  'unavailable'
] as const

/** plan_update — local, side-effect-free plan artifact. */
export const planUpdateSchema = z
  .object({
    goal: z.string().trim().min(1),
    steps: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1),
          status: z.enum(PLAN_STEP_STATUSES),
          note: z.string().trim().optional()
        })
      )
      .max(12)
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'step id must be unique within a plan',
          path: ['steps', index, 'id']
        })
      }
      seen.add(step.id)
    })
  })
export type PlanUpdateInput = z.infer<typeof planUpdateSchema>

/** email_list_filter — metadata filter (subject/sender/date/flags). All optional. */
export const emailSearchSchema = z.object({
  subject_contains: z.string().optional(),
  sender_contains: z.string().optional(),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type EmailSearchInput = z.infer<typeof emailSearchSchema>

/** email_search_fulltext — FTS body search (query required). */
export const emailSearchFulltextSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchFulltextInput = z.infer<typeof emailSearchFulltextSchema>

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

/** email_get — single email metadata. */
export const emailGetSchema = z.object({
  internal_id: z.number().int()
})
export type EmailGetInput = z.infer<typeof emailGetSchema>

/** email_body — markdown body (capped). */
export const emailBodySchema = z.object({
  internal_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000)
})
export type EmailBodyInput = z.infer<typeof emailBodySchema>

/** email_list_thread — all emails in a thread. */
export const emailListThreadSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailListThreadInput = z.infer<typeof emailListThreadSchema>

/** email_search_attachments — FTS over extracted attachment text (query required). */
export const emailSearchAttachmentsSchema = z.object({
  query: z.string().min(1),
  mailbox: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20)
})
export type EmailSearchAttachmentsInput = z.infer<typeof emailSearchAttachmentsSchema>

/** email_thread_attachments — every attachment across a thread (metadata + provenance). Mirrors
 *  email_list_thread's single thread_id input. */
export const emailThreadAttachmentsSchema = z.object({
  thread_id: z.string().min(1)
})
export type EmailThreadAttachmentsInput = z.infer<typeof emailThreadAttachmentsSchema>

/** email_attachment_text — extracted text of one attachment (capped, clip mode mirrors email_body). */
export const emailAttachmentTextSchema = z.object({
  attachment_id: z.number().int(),
  max_chars: z.number().int().min(200).max(12000).default(12000)
})
export type EmailAttachmentTextInput = z.infer<typeof emailAttachmentTextSchema>

/** kos_query — cross-domain KOS retrieval. */
export const kosQuerySchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).default(10),
  expand: z.boolean().default(false),
  source_id: z.string().optional()
})
export type KosQueryInput = z.infer<typeof kosQuerySchema>

// ── extra KOS read tools (issue #57) — keyword full-text / page read / expert lookup /
//    page listing / backlinks. All proxy through domain.kosCall(<mcp name>, args) to the
//    generic serve-api /chat/kos-call passthrough (KOSClient.call_tool) — zero new Python.
//    All silent reads (no write tool is registered). ──────────────────────────────────────

/** kos_search — keyword full-text search (a lighter, faster sibling of kos_query).
 *  NO `mode`: KOS's own tools/list documents it as "Local callers only" and a live probe
 *  (v0.42.64.0) returned byte-identical hits + scores for every value incl. garbage — an
 *  optional param the model believes tunes the search but cannot is exactly the #57 bug. */
export const kosSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosSearchInput = z.infer<typeof kosSearchSchema>

/** kos_get_page — read one page's full content by slug (fuzzy = tolerate near-miss slugs). */
export const kosGetPageSchema = z.object({
  slug: z.string().min(1),
  fuzzy: z.boolean().optional()
})
export type KosGetPageInput = z.infer<typeof kosGetPageSchema>

/** kos_find_experts — "who knows X" — people/concepts related to a topic (with scores). */
export const kosFindExpertsSchema = z.object({
  topic: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10)
})
export type KosFindExpertsInput = z.infer<typeof kosFindExpertsSchema>

/** kos_list_pages — list people/concept/etc. pages (all filters optional). `sort` is the
 *  KOS enum (tools/list): a free-form string silently falls back to updated_desc, so the
 *  model must not be able to invent one. `type` stays open (the brain grows types —
 *  person/company/concept/project/note/email/source/atom/… all observed live). */
export const kosListPagesSchema = z.object({
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  updated_after: z.string().optional(),
  sort: z.enum(['updated_desc', 'updated_asc', 'created_desc', 'slug']).optional()
})
export type KosListPagesInput = z.infer<typeof kosListPagesSchema>

/** kos_get_backlinks — pages/people that reference a given page (empty = no edges yet).
 *  `limit` is applied CLIENT-side: KOS's get_backlinks takes only {slug} and returns the
 *  full edge set (a live probe returned 337 rows / 65KB for one person page), which would
 *  dump ~16k tokens of third-party text into the context on a single call. */
export const kosGetBacklinksSchema = z.object({
  slug: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50)
})
export type KosGetBacklinksInput = z.infer<typeof kosGetBacklinksSchema>

/** report_list — generated reports (all filters optional). */
export const reportListSchema = z.object({
  cadence: z.enum(REPORT_CADENCES).optional(),
  agent_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20)
})
export type ReportListInput = z.infer<typeof reportListSchema>

/** report_get — one report by id. */
export const reportGetSchema = z.object({
  report_id: z.string().min(1)
})
export type ReportGetInput = z.infer<typeof reportGetSchema>

/** report_write — local structured artifact. The shared block schema also enforces the
 * internal-only image source policy. */
export const reportWriteSchema = z.object({
  title: z.string().min(1).max(200),
  blocks: z.array(reportBlockInputSchema).min(1).max(100),
  mode: z.enum(['new', 'replace']).default('new')
})
export type ReportWriteInput = z.infer<typeof reportWriteSchema>

// ── write-tool schemas (Phase 03b) — mirror the legacy JSON-Schema field names /
//    requireds from shared/chat/tools/builtin/write.ts byte-for-byte (parity). The
//    "at least one of …" semantic checks stay in the tool's run (matching the legacy
//    handler's E_INVALID_ARG), not the schema, so the error shape matches legacy. ──

/** email_flag — toggle is_read / is_flagged / processing_status (≥1 enforced in run). */
export const emailFlagSchema = z.object({
  internal_id: z.number().int(),
  is_read: z.boolean().optional(),
  is_flagged: z.boolean().optional(),
  processing_status: z.string().optional()
})
export type EmailFlagInput = z.infer<typeof emailFlagSchema>

/** email_archive — move into Archive (davmail-only). */
export const emailArchiveSchema = z.object({
  internal_id: z.number().int()
})
export type EmailArchiveInput = z.infer<typeof emailArchiveSchema>

/** email_pin — pin / unpin (local UI flag). */
export const emailPinSchema = z.object({
  internal_id: z.number().int(),
  pinned: z.boolean()
})
export type EmailPinInput = z.infer<typeof emailPinSchema>

/** email_draft_reply — compose a reply / reply-all draft. Recipients default to
 *  server-derived reply-all; optional to/cc/bcc OVERRIDE the full lists (the way to
 *  add/remove people on top of reply-all — compute the final lists from the source
 *  email's sender/to/cc and pass them explicitly).
 *  Per-field `.describe()` (issue #70) — the JSON Schema is the ONLY part of a schema the model
 *  actually sees, so every rule a caller can get wrong has to be stated on the field itself. */
export const emailDraftReplySchema = z.object({
  internal_id: z.number().int().describe('The email being replied to (its internal_id). Required.'),
  body_markdown: z.string().min(1),
  mode: z.enum(['reply', 'reply-all']).optional(),
  to: z
    .array(z.string().min(3))
    .optional()
    .describe(
      'OVERRIDE of the whole To list (omit to let the server derive reply-all). Not additive: ' +
        'to add or remove one person, compute the FULL final list yourself and pass it.'
    ),
  cc: z
    .array(z.string().min(3))
    .optional()
    .describe('OVERRIDE of the whole Cc list (same all-or-nothing rule as `to`).'),
  bcc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Bcc list.')
})
export type EmailDraftReplyInput = z.infer<typeof emailDraftReplySchema>

/** email_draft_compose (prd 07-27 C-3) — a BRAND-NEW draft (`mode:'new'`) or a forward of an
 *  existing email (`mode:'forward'`). Unlike the "at least one of …" checks that live in `run`,
 *  the cross-field rules sit in `.superRefine` so an impossible combination fails BEFORE the
 *  approval card is shown (showing the user a card for a call that can only error is worse than a
 *  validation retry the model fixes itself):
 *    - forward REQUIRES internal_id (the source email) + at least one recipient (the service
 *      rejects a recipient-less forward too);
 *    - 'new' REJECTS internal_id — a new draft has no source email, so passing one means the
 *      model meant forward (or email_draft_reply).
 *  quote_original is forward-only (a new draft has nothing to quote); default true.
 *
 *  🔴 issue #70 — a `.superRefine` is invisible to the model: `toJSONSchema` drops it, so the
 *  mode↔internal_id coupling reached the model through NOTHING but prose buried mid-description,
 *  and a model that guessed `internal_id` on a 'new' draft repeatedly burned the run guessing
 *  values (0 → -1 → 1.9e15 → 0) for a field that must simply be absent. The rules now live on the
 *  fields themselves via `.describe()` (that IS the model-visible surface) — the superRefine stays
 *  as the pre-approval-card backstop, not as the way the model learns the rule. Every retry message
 *  below therefore also states the corrective ACTION, not just the violated constraint. */
export const emailDraftComposeSchema = z
  .object({
    mode: z
      .enum(['new', 'forward'])
      .describe(
        "'new' = a brand-new draft written from scratch; 'forward' = forward an existing email. " +
          'The two modes take DIFFERENT parameters — see internal_id.'
      ),
    internal_id: z
      .number()
      .int()
      .optional()
      .describe(
        "mode 'forward' ONLY, where it is required: the internal_id of the email being forwarded. " +
          "OMIT THIS FIELD ENTIRELY for mode 'new' — a new draft has no source email, so there is " +
          'no id to pass and no placeholder (0 / -1 / any number) is accepted. To reply to an ' +
          'email, use email_draft_reply instead of guessing an id here.'
      ),
    subject: z
      .string()
      .optional()
      .describe(
        "Subject line. Pass it for mode 'new'; for mode 'forward' it defaults to \"Fwd: <original>\"."
      ),
    body_markdown: z.string().min(1).describe('Draft body, markdown.'),
    to: z.array(z.string().min(3)).describe('Final To list — explicit, never derived. Required.'),
    cc: z.array(z.string().min(3)).optional(),
    bcc: z.array(z.string().min(3)).optional(),
    quote_original: z
      .boolean()
      .optional()
      .describe(
        "mode 'forward' only (default true): quote the forwarded email under your body. A new " +
          'draft has nothing to quote.'
      )
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'forward') {
      if (v.internal_id === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['internal_id'],
          message:
            "mode 'forward' requires internal_id (the source email to forward). Retry with the " +
            'internal_id of the email you are forwarding.'
        })
      }
      if (v.to.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message:
            "mode 'forward' requires at least one recipient in `to`. Retry with the recipients filled in."
        })
      }
    } else if (v.internal_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['internal_id'],
        message:
          "mode 'new' takes no internal_id (a new draft has no source email — use mode 'forward' to forward one, or email_draft_reply to reply to one). " +
          'Retry with the SAME arguments and the internal_id field REMOVED — do not substitute 0, ' +
          '-1 or any other placeholder value.'
      })
    }
  })
export type EmailDraftComposeInput = z.infer<typeof emailDraftComposeSchema>

/** email_draft_update (prd 07-27 C-4) — edit an EXISTING draft by its internal_id. Every content
 *  field is optional: an omitted field is backfilled from the current draft, so a subject-only
 *  edit keeps the body/recipients as they are. "at least one field must change" is enforced in
 *  `run` (email_flag precedent — the semantic check keeps the legacy E_INVALID_ARG error shape). */
export const emailDraftUpdateSchema = z.object({
  draft_internal_id: z
    .number()
    .int()
    .describe(
      'internal_id of the DRAFT row to edit — not the id of the email it replies to or forwards. ' +
        'To create a draft instead, use email_draft_compose / email_draft_reply.'
    ),
  subject: z.string().optional().describe('Omit to keep the current subject.'),
  body_markdown: z.string().min(1).optional().describe('Omit to keep the current body.'),
  to: z
    .array(z.string().min(3))
    .optional()
    .describe('OVERRIDE of the whole To list; omit to keep the current recipients.'),
  cc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Cc list.'),
  bcc: z.array(z.string().min(3)).optional().describe('OVERRIDE of the whole Bcc list.')
})
export type EmailDraftUpdateInput = z.infer<typeof emailDraftUpdateSchema>

/** email_resync — re-push to Notion from the SQLite SSoT. */
export const emailResyncSchema = z.object({
  internal_id: z.number().int()
})
export type EmailResyncInput = z.infer<typeof emailResyncSchema>

// ── high-risk outbound send schema (Phase 04b) — the ONLY tool that triggers a real SMTP
//    send, and only after a blocking SendApprovalCard + the double guard (content hash +
//    idempotency, gateway + Python). Field names are the model-visible (snake_case) surface;
//    the domain client maps them to the serve-api /email/send-approved wire body. ────────────

/** email_prepare_send — propose a real outbound email for human approval. Recipients are
 *  explicit (a fresh "new" compose — it does NOT derive recipients from a source email).
 *  internal_id is optional context only (audit / which email this relates to); the send uses
 *  the explicit to/cc/bcc/subject/body. Attachments are NOT supported in v1 (the model cannot
 *  pass bytes; a future phase may reference existing attachments by id). */
export const emailPrepareSendSchema = z.object({
  to: z.array(z.string().min(3)).min(1),
  cc: z.array(z.string().min(3)).optional(),
  bcc: z.array(z.string().min(3)).optional(),
  subject: z.string().min(1),
  body_markdown: z.string().min(1),
  internal_id: z.number().int().optional()
})
export type EmailPrepareSendInput = z.infer<typeof emailPrepareSendSchema>

// ── self-mount schemas (M4) — the agent updates its own Standing Context docs + skills. Behind
//    MAILAGENT_SKILL_SELF_MOUNT. update_system_md = edit-tier write (always asks); set_skill_enabled
//    = preview-tier write; discover_skills = silent read. Field names are the model-visible surface. ──

/** update_system_md (M4b) — propose new full content for one Standing Context doc. doc_name is the
 *  fixed backend enum (PROFILE_DOC_NAMES); rules content is additionally validated server-side
 *  (jailbreak / safety-override deny-list → E_INVALID_ARG). */
export const updateSystemMdSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user']),
  content: z.string().min(1)
})
export type UpdateSystemMdInput = z.infer<typeof updateSystemMdSchema>

/** discover_skills (M4c) — list capabilities (enabled + unavailable, with reasons). No input. */
export const discoverSkillsSchema = z.object({})
export type DiscoverSkillsInput = z.infer<typeof discoverSkillsSchema>

/** set_skill_enabled (M4c) — enable/disable a skill (mount/unmount its tools). */
export const setSkillEnabledSchema = z.object({
  skill_name: z.string().min(1),
  enabled: z.boolean()
})
export type SetSkillEnabledInput = z.infer<typeof setSkillEnabledSchema>

// ── profile-config schemas (S1 R2) — the agent reads its own Standing Context docs / history
//    and proposes restores + memory.md updates. Behind MAILAGENT_OPENNESS_CONFIG_TOOLS.
//    doc_name is pinned to the backend STORABLE_DOC_NAMES enum (4 identity docs + memory —
//    wider than update_system_md's, which deliberately EXCLUDES memory: identity 边界).
//    Reads are silent; agent_profile_restore / agent_memory_update are edit-tier writes
//    (always ask, no editableFields → approve/reject only, update_system_md 先例). ──

/** agent_profile_read (S1 R2) — full content + version info of one profile doc. */
export const agentProfileReadSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory'])
})
export type AgentProfileReadInput = z.infer<typeof agentProfileReadSchema>

/** agent_profile_history (S1 R2) — version history of one profile doc (newest first). */
export const agentProfileHistorySchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory']),
  limit: z.number().int().min(1).max(100).default(20)
})
export type AgentProfileHistoryInput = z.infer<typeof agentProfileHistorySchema>

/** agent_profile_restore (S1 R2) — roll one profile doc back to a history version
 *  (target_hash = a version_hash from agent_profile_history). Edit-tier write. */
export const agentProfileRestoreSchema = z.object({
  doc_name: z.enum(['soul', 'agent', 'rules', 'user', 'memory']),
  target_hash: z.string().min(1).max(128)
})
export type AgentProfileRestoreInput = z.infer<typeof agentProfileRestoreSchema>

/** agent_memory_update (S1 R2) — propose new full content for memory.md (bounded memory;
 *  the Python endpoint enforces the hard character budget). Edit-tier write. */
export const agentMemoryUpdateSchema = z.object({
  content: z.string().min(1)
})
export type AgentMemoryUpdateInput = z.infer<typeof agentMemoryUpdateSchema>

// ── chat-session schemas (S1 R1) — the agent reads its own past conversations. Behind
//    MAILAGENT_OPENNESS_SESSION_TOOLS. All three are silent reads; returned message content
//    is untrusted (past sessions embed email bodies) and is CHAT_HISTORY-fenced by the tools. ──

/** chat_session_list — recent chat sessions (metadata + first-message preview). */
export const chatSessionListSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20)
})
const sessionQueryFields = {
  origin: z.enum(['interactive', 'agent', 'im', 'team', 'group', 'all']).optional(),
  agentId: z.string().min(1).optional(),
  agentJobId: z.string().min(1).optional(),
  triggerId: z.string().min(1).optional(),
  triggerKind: z.string().min(1).optional(),
  createdAfter: z.number().int().optional(),
  createdBefore: z.number().int().optional(),
  archived: z.boolean().optional(),
  starred: z.boolean().optional()
}
export const chatSessionListProvenanceSchema = chatSessionListSchema.extend(sessionQueryFields)
export type ChatSessionListInput = z.infer<typeof chatSessionListSchema>

/** chat_session_search — full-text search over past chat messages (query required). */
export const chatSessionSearchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10)
})
export const chatSessionSearchProvenanceSchema = chatSessionSearchSchema.extend(sessionQueryFields)
export type ChatSessionSearchInput = z.infer<typeof chatSessionSearchSchema>

/** chat_session_get — read one past session's messages (recent window, capped). */
export const chatSessionGetSchema = z.object({
  session_id: z.number().int(),
  limit: z.number().int().min(1).max(100).default(30)
})
export type ChatSessionGetInput = z.infer<typeof chatSessionGetSchema>

// ── web schemas (S1 R3) — the agent fetches a web page / searches the web. Behind
//    MAILAGENT_OPENNESS_WEB_TOOLS. BOTH are edit-tier writes (outbound network = always ask,
//    editable url/query). Returned content is untrusted → the tools WEB_CONTENT-fence it.
//    Python (routers/web.py) is the execution authority (SSRF guard, IP pinning). ──────────

/** web_fetch (S1 R3) — fetch one http/https URL's readable content. max_chars caps the
 *  extracted text (server clamps to its own hard max). */
export const webFetchSchema = z.object({
  url: z.string().min(1).max(4096),
  max_chars: z.number().int().min(200).max(200_000).default(50_000)
})
export type WebFetchInput = z.infer<typeof webFetchSchema>

/** web_search (S1 R3) — DuckDuckGo web search (best-effort). limit caps result count. */
export const webSearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5)
})
export type WebSearchInput = z.infer<typeof webSearchSchema>

/** notion_agent_chat (task 07-21) — delegate a Notion-workspace request to the notion-agent CLI.
 *  `prompt` is the natural-language ask (question OR task); `thread_id` continues a prior Notion
 *  conversation; `model` overrides the bound default. Field names mirror the Python builtin skill
 *  tool schema (src/skills/builtin/notion_agent.py) so the gateway → /api/skills/invoke body matches. */
export const notionAgentChatSchema = z.object({
  prompt: z.string().min(1).max(8000),
  thread_id: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional()
})
export type NotionAgentChatInput = z.infer<typeof notionAgentChatSchema>

// ── exec schemas (S2 W1) — the agent runs a local command / reads / writes a file. Behind
//    MAILAGENT_OPENNESS_EXEC_TOOLS. ALL THREE are edit-tier writes (local execution = always ask
//    unless a structured whitelist rule the user set matches; never auto-approved). Field names
//    mirror the Python execution endpoints (routers/exec.py: /api/exec/{run,file_read,file_write}).
//    Python is the execution authority (fixed env allowlist, inode-level deny floor, no shell). ──

/** run_command (S2 W1) — run ONE local command with an explicit argv (NO shell — argv[0] is the
 *  program, the rest are literal arguments; shell metacharacters are NOT interpreted). cwd is an
 *  optional absolute working directory. timeout_ms bounds the run (server clamps to its own max). */
export const execRunCommandSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1).max(600_000).default(60_000)
})
export type ExecRunCommandInput = z.infer<typeof execRunCommandSchema>

/** file_read (S2 W1) — read a local file's text content. max_bytes caps the returned content
 *  (server clamps to its own hard max). Sensitive targets (.env / *.db / token.dat / ssh keys /
 *  the app bundle) are refused server-side (inode-level deny floor). */
export const execFileReadSchema = z.object({
  path: z.string().min(1),
  max_bytes: z.number().int().min(1).max(2_097_152).default(262_144)
})
export type ExecFileReadInput = z.infer<typeof execFileReadSchema>

/** file_write (S2 W1) — write text to a local file. mode: create_new (default — fails if the file
 *  exists), overwrite (replace), or append. The parent directory must already exist (not created).
 *  Sensitive targets are refused server-side (inode-level deny floor). */
export const execFileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(['overwrite', 'append', 'create_new']).default('create_new')
})
export type ExecFileWriteInput = z.infer<typeof execFileWriteSchema>

// ── skill-supply schemas (S2 W4) — the agent installs / uninstalls / reads third-party skill
//    packages. Behind MAILAGENT_OPENNESS_SKILL_INSTALL. install / confirm / uninstall are
//    edit-tier writes + class capability_change (ALWAYS ask — never auto-approved, never
//    whitelist-relaxed; ADR-001 D3 row); skill_read is a silent read whose returned SKILL.md is
//    UNTRUSTED_SKILL_DOC-fenced by the tool (third-party text = injection surface, ADR-002 D4).
//    Python (routers/agent.py + skills/pack_fetch|pack_verify) is the business authority
//    (SSRF-hardened download, safe unpack, real hash, confirm re-hash TOCTOU guard). ──────────

/** skill_install (S2 W4) — stage one of the two-step install: fetch a skill package (from a URL
 *  or a local path, exactly one) into QUARANTINE. Nothing is installed yet — the server returns
 *  a preview (quarantine id + hashes + manifest summary) for the user to review. */
export const skillInstallSchema = z.object({
  source_url: z.string().min(1).max(4096).optional(),
  local_path: z.string().min(1).max(4096).optional()
})
export type SkillInstallInput = z.infer<typeof skillInstallSchema>

/** skill_install_confirm (S2 W4) — stage two: really install a quarantined package. The
 *  expected_package_hash / expected_files MUST be echoed verbatim from the skill_install preview
 *  — the server re-hashes the quarantine content and rejects (409) on any mismatch (TOCTOU
 *  guard), so a forged hash only defeats the install. */
export const skillInstallConfirmSchema = z.object({
  quarantine_id: z.string().min(1).max(64),
  expected_package_hash: z.string().min(1).max(128),
  expected_files: z.record(z.string(), z.string()).optional()
})
export type SkillInstallConfirmInput = z.infer<typeof skillInstallConfirmSchema>

/** skill_uninstall (S2 W4) — full-cleanup uninstall: DB row + on-disk directory + stored
 *  secrets all go (POST /agent/skills/uninstall — NEVER the legacy row-only DELETE). */
export const skillUninstallSchema = z.object({
  name: z.string().min(1).max(64)
})
export type SkillUninstallInput = z.infer<typeof skillUninstallSchema>

/** skill_read (S2 W4) — read an installed skill's SKILL.md (fenced + truncated by the tool). */
export const skillReadSchema = z.object({
  name: z.string().min(1).max(64)
})
export type SkillReadInput = z.infer<typeof skillReadSchema>

export const skillDraftCreateSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
  manifest: z.record(z.string(), z.unknown()).optional()
})
export type SkillDraftCreateInput = z.infer<typeof skillDraftCreateSchema>

export const skillDraftWriteFileSchema = z.object({
  draftId: z.string().min(1).max(64),
  path: z.string().min(1).max(512),
  content: z.string().max(1024 * 1024)
})
export type SkillDraftWriteFileInput = z.infer<typeof skillDraftWriteFileSchema>

export const skillDraftReadSchema = z.object({
  draftId: z.string().min(1).max(64),
  path: z.string().min(1).max(512).optional()
})
export type SkillDraftReadInput = z.infer<typeof skillDraftReadSchema>

export const skillDraftValidateSchema = z.object({
  draftId: z.string().min(1).max(64)
})
export type SkillDraftValidateInput = z.infer<typeof skillDraftValidateSchema>

export const skillDraftPublishSchema = z.object({
  draftId: z.string().min(1).max(64),
  enabled: z.boolean().default(true)
})
export type SkillDraftPublishInput = z.infer<typeof skillDraftPublishSchema>

export const skillDraftDiscardSchema = z.object({
  draftId: z.string().min(1).max(64)
})
export type SkillDraftDiscardInput = z.infer<typeof skillDraftDiscardSchema>

// ── custom-agent CRUD schemas (S5 W3; grants opened S6 W3-2) — the assistant helps the owner
//    build / edit / run a custom agent through conversation. Behind MAILAGENT_CUSTOM_AGENTS_ENABLED.
//    list/get are silent reads; create/update/delete/run_now are edit-tier writes (class
//    capability_change — always ask, never auto-approved). Deep validation lives in Python
//    (validate_agent_config_patch); the gateway schema is an ALLOWLIST and `.strict()` rejects any
//    unknown key. ADR-004 rev3.1 §7 (owner Q4) opened grant_exec / grant_web / skills into this
//    vocabulary: the model may PROPOSE grants, but every create/update is pinned behind a mandatory
//    approval card whose permission summary renders them red — the defense moved from field-level
//    deny to the always-human card. tool_policy / policy_rules / any raw policy field still
//    structurally cannot enter (rule creation stays owner-only). ──

/** A custom-agent trigger the model may propose. Mirrors CustomAgentTrigger (backend
 *  src/agents/trigger.py is the validation authority: cron 5-field + croniter, regex ReDoS caps,
 *  schedule rule/anchor deep validation in src/agents/schedule_rule.py). This schema is only the
 *  first (allowlist) gate — semantic checks (real calendar dates, IANA timezone existence) stay
 *  server-side, same discipline as cron. The `v` version bit is added by the wire construction,
 *  not the model. 🔴 The kind set + the 10 rule keys are locked against Python by
 *  tests/api/test_trigger_kind_parity.py — a 4th kind or an 11th rule key must land here too. */
export const customAgentTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cron'),
      cron: z.string().min(1).max(256),
      timezone: z.string().max(64).optional()
    })
    .strict(),
  // 07-24 structured recurrence (contract §1: all 10 rule keys required, missing OR extra rejected;
  // weekdays/weekday are 0=Sunday, NOT Python's 0=Monday). timezone is mandatory here — unlike
  // cron there is no empty→UTC fallback (an empty timezone is what forked the two schedulers).
  z
    .object({
      kind: z.literal('schedule'),
      rule: z
        .object({
          freq: z.enum(['daily', 'weekly', 'monthly']),
          interval: z.number().int().min(1),
          weekdays: z.array(z.number().int().min(0).max(6)).max(7),
          monthMode: z.enum(['date', 'nth']),
          monthDay: z.number().int().min(1).max(31),
          ordinal: z.union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal('last')
          ]),
          weekday: z.number().int().min(0).max(6),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          clamp: z.boolean()
        })
        .strict(),
      anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezone: z.string().min(1).max(64)
    })
    .strict(),
  z
    .object({
      kind: z.literal('email_filter'),
      subject_pattern: z.string().max(256).optional(),
      sender_pattern: z.string().max(256).optional(),
      folders: z.array(z.string().min(1).max(200)).max(32).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('calendar_event_change'),
      title_pattern: z.string().max(256).optional(),
      organizer_pattern: z.string().max(256).optional(),
      attendee_pattern: z.string().max(256).optional(),
      calendar_ids: z.array(z.string().min(1).max(200)).max(32).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('calendar_before_start'),
      lead_seconds: z.number().int().min(60).max(2592000),
      title_pattern: z.string().max(256).optional(),
      organizer_pattern: z.string().max(256).optional(),
      attendee_pattern: z.string().max(256).optional(),
      calendar_ids: z.array(z.string().min(1).max(200)).max(32).optional()
    })
    .strict()
])
export type CustomAgentTriggerInput = z.infer<typeof customAgentTriggerSchema>

/** A custom-agent budget the model may propose (frequency + wall-clock gates). Mirrors
 *  CustomAgentBudget; the
 *  backend clamps each field defensively (parse_budget) — these bounds match the backend ceilings. */
export const customAgentBudgetSchema = z
  .object({
    max_runs_per_day: z.number().int().min(0).max(100_000).optional(),
    max_run_seconds: z.number().int().min(1).max(1800).optional()
  })
  .strict()
export type CustomAgentBudgetInput = z.infer<typeof customAgentBudgetSchema>

/** custom_agent_list — list the owner's custom agents (silent read). */
export const customAgentListSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50)
})
export type CustomAgentListInput = z.infer<typeof customAgentListSchema>

/** custom_agent_get — one custom agent's full spec + recent runs (silent read). */
export const customAgentGetSchema = z.object({
  agent_id: z.string().min(1).max(128),
  runs_limit: z.number().int().min(0).max(20).default(5)
})
export type CustomAgentGetInput = z.infer<typeof customAgentGetSchema>

/** The per-agent web grant tier (ADR-004 rev3.1 §3.1): off = web tools absent headless; gated =
 *  registered, web_fetch card-free only on the owner's per-agent domain whitelist; open = any URL
 *  card-free. Proposing 'gated'/'open' is allowed — the approval card renders it red ('open'). */
export const customAgentWebGrantSchema = z.enum(['off', 'gated', 'open'])

/** The per-connector crud ceiling (MCP connector epic, harness-expansion stage 1 PR3 / grill
 *  Q3=B): read < write < update. 'delete' is NOT a legal ceiling — the value domain itself is the
 *  guard, not owner discipline: a connector's delete-crud tools are structurally unreachable by
 *  the AI regardless of what is granted (Q16=A). Mirrors ConnectorGrant in tools/policy.ts. */
export const customAgentConnectorGrantSchema = z.enum(['read', 'write', 'update'])

/** grant_connectors — per-connector crud ceiling map (MCP connector epic PR3). Keys are connector
 *  ids; a connector ABSENT from this map is not authorized for this agent (its tools never
 *  register, headless or otherwise). Passing `{}` clears every connector grant. Server-side is
 *  the validation authority (parse_tool_policy) — a bad value (incl. "delete") is rejected 400,
 *  never silently dropped. */
export const customAgentConnectorGrantsSchema = z.record(
  z.string().min(1),
  customAgentConnectorGrantSchema
)
export type CustomAgentConnectorGrantsInput = z.infer<typeof customAgentConnectorGrantsSchema>

const customAgentEmailCapabilitySchema = z.enum(['read', 'organize', 'draft'])
const customAgentCalendarCapabilitySchema = z.enum(['off', 'read', 'write'])
const customAgentToggleCapabilitySchema = z.enum(['off', 'on'])
const customAgentReportCapabilitySchema = z.enum(['read', 'produce'])
// task 09-02 — chat-history read radius; defaults to 'own' so a profile authored before the card
// existed still parses as a complete profile.
const customAgentSessionsCapabilitySchema = z.enum(['own', 'all'])

const customAgentCapabilityFields = {
  email: customAgentEmailCapabilitySchema,
  calendar: customAgentCalendarCapabilitySchema,
  knowledge: customAgentToggleCapabilitySchema,
  sessions: customAgentSessionsCapabilitySchema,
  reports: customAgentReportCapabilitySchema,
  web: customAgentWebGrantSchema,
  files: customAgentToggleCapabilitySchema
}

/** The capability-card contract shown in Settings. Create uses a complete profile so the
 *  approval card describes the entire capability surface (`sessions` defaults to 'own' there so a
 *  profile authored before that card existed still counts as complete); update accepts a
 *  non-empty patch — built from the UNdefaulted fields so `{}` stays empty and is rejected. */
export const customAgentCapabilityProfileSchema = z
  .object({
    ...customAgentCapabilityFields,
    sessions: customAgentSessionsCapabilitySchema.default('own')
  })
  .strict()
export type CustomAgentCapabilityProfileInput = z.infer<typeof customAgentCapabilityProfileSchema>

export const customAgentCapabilityPatchSchema = z
  .object(customAgentCapabilityFields)
  .strict()
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'capabilities must change at least one tier')
export type CustomAgentCapabilityPatchInput = z.infer<typeof customAgentCapabilityPatchSchema>

function rejectMixedCapabilityVocabulary(
  input: {
    capabilities?: unknown
    allowed_tools?: unknown
    grant_exec?: unknown
    grant_web?: unknown
    grant_connectors?: unknown
  },
  ctx: z.RefinementCtx
): void {
  if (input.capabilities === undefined) return
  for (const field of ['allowed_tools', 'grant_exec', 'grant_web', 'grant_connectors'] as const) {
    if (input[field] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} cannot be combined with capabilities; use one vocabulary`
      })
    }
  }
}

/** custom_agent_create — propose a new custom agent (edit-tier write). ALLOWLIST: title / prompt /
 *  model / enabled / trigger / allowed_tools / budget + (rev3.1 §7) grant_exec / grant_web / skills
 *  + (MCP connector epic PR3) grant_connectors. `.strict()` rejects any other key — tool_policy /
 *  policy_rules stay structurally out: the model may propose grants (surfaced red on the
 *  mandatory approval card) but has NO rule-creation path. */
export const customAgentCreateSchema = z
  .object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    prompt: z.string().max(20_000).optional(),
    model: z.string().max(128).optional(),
    enabled: z.boolean().optional(),
    trigger: customAgentTriggerSchema.nullable().optional(),
    capabilities: customAgentCapabilityProfileSchema.optional(),
    allowed_tools: z.array(z.string().min(1).max(64)).max(64).optional(),
    budget: customAgentBudgetSchema.nullable().optional(),
    grant_exec: z.boolean().optional(),
    grant_web: customAgentWebGrantSchema.optional(),
    skills: z.array(z.string().min(1).max(64)).max(32).optional(),
    grant_connectors: customAgentConnectorGrantsSchema.optional()
  })
  .strict()
  .superRefine(rejectMixedCapabilityVocabulary)
export type CustomAgentCreateInput = z.infer<typeof customAgentCreateSchema>

/** custom_agent_update — propose changes to an existing custom agent (edit-tier write). Same
 *  ALLOWLIST as create (minus id, plus agent_id); every config field optional (partial patch).
 *  `.strict()` keeps tool_policy / policy fields structurally out; grant/skill changes render as a
 *  before/after diff on the approval card (before = the SERVER's current row, never model input). */
export const customAgentUpdateSchema = z
  .object({
    agent_id: z.string().min(1).max(128),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    prompt: z.string().max(20_000).nullable().optional(),
    model: z.string().max(128).optional(),
    enabled: z.boolean().optional(),
    trigger: customAgentTriggerSchema.nullable().optional(),
    capabilities: customAgentCapabilityPatchSchema.optional(),
    allowed_tools: z.array(z.string().min(1).max(64)).max(64).optional(),
    budget: customAgentBudgetSchema.nullable().optional(),
    grant_exec: z.boolean().optional(),
    grant_web: customAgentWebGrantSchema.optional(),
    skills: z.array(z.string().min(1).max(64)).max(32).optional(),
    grant_connectors: customAgentConnectorGrantsSchema.optional()
  })
  .strict()
  .superRefine(rejectMixedCapabilityVocabulary)
export type CustomAgentUpdateInput = z.infer<typeof customAgentUpdateSchema>

/** custom_agent_delete — delete a custom agent by id (edit-tier write). */
export const customAgentDeleteSchema = z.object({
  agent_id: z.string().min(1).max(128)
})
export type CustomAgentDeleteInput = z.infer<typeof customAgentDeleteSchema>

/** custom_agent_run_now — enqueue one immediate run of a custom agent (edit-tier write). */
export const customAgentRunNowSchema = z.object({
  agent_id: z.string().min(1).max(128)
})
export type CustomAgentRunNowInput = z.infer<typeof customAgentRunNowSchema>

export const customAgentCallSchema = z
  .object({
    agent_id: z.string().min(1).max(128),
    instruction: z.string().min(1).max(8000),
    context_note: z.string().max(4000).optional(),
    source_session_id: z.number().int().positive().optional(),
    email_internal_ids: z.array(z.number().int().positive()).max(50).optional(),
    email_thread_ids: z.array(z.string().min(1).max(256)).max(50).optional(),
    calendar_event_ids: z.array(z.string().min(1).max(512)).max(50).optional(),
    notion_refs: z
      .array(
        z.object({
          connector_id: z.string().min(1).max(128),
          object_id: z.string().min(1).max(512),
          object_type: z.string().min(1).max(128).optional()
        })
      )
      .max(50)
      .optional(),
    report_ids: z.array(z.string().min(1).max(256)).max(50).optional(),
    user_requested: z.boolean().optional()
  })
  .strict()
export type CustomAgentCallInput = z.infer<typeof customAgentCallSchema>

// ── L4 群聊 g2 — group tool schemas (tools/groups.ts). Shape only: the member-count bound is
//    the same MAX_GROUP_MEMBERS the serve-api enforces, but existence / chat-capable / subset /
//    single-level-nesting are business rules that live ONLY in routers/chat.py (红线 5) — zod
//    never mirrors them. Every numeric bound is imported from groupFloors (no bare numbers). ──

/** group_history — one page of a group transcript, newest page first (`before_message_id` walks
 *  back). `session_id` omitted = the current group (member / judge runs only). */
export const groupHistorySchema = z.object({
  session_id: z.number().int().positive().optional(),
  before_message_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(GROUP_HISTORY_LIMIT_MAX).default(20)
})
export type GroupHistoryInput = z.infer<typeof groupHistorySchema>

/** group_members — roster / response modes / judge / parent-child / this hour's usage. */
export const groupMembersSchema = z.object({
  session_id: z.number().int().positive().optional()
})
export type GroupMembersInput = z.infer<typeof groupMembersSchema>

/** group_post — deliver one message into a group and wake its candidates. */
export const groupPostSchema = z.object({
  session_id: z.number().int().positive(),
  text: z.string().min(1).max(GROUP_POST_TEXT_MAX_CHARS),
  user_requested: z.boolean().optional()
})
export type GroupPostInput = z.infer<typeof groupPostSchema>

/** group_create — build a group (optionally a subgroup) with an opening message. */
export const groupCreateSchema = z.object({
  title: z.string().min(1).max(200),
  member_agent_ids: z.array(z.string().min(1).max(128)).min(1).max(MAX_GROUP_MEMBERS),
  opening_text: z.string().min(1).max(GROUP_POST_TEXT_MAX_CHARS),
  judge_agent_id: z.string().min(1).max(128).optional(),
  modes: z.record(z.string(), z.enum(RESPONSE_MODES)).optional(),
  parent_session_id: z.number().int().positive().optional(),
  user_requested: z.boolean().optional()
})
export type GroupCreateInput = z.infer<typeof groupCreateSchema>

// ── calendar schemas (calendar epic 4.1/4.2) — the agent reads the local calendar SSoT and
//    proposes reschedule / RSVP / delete. Behind MAILAGENT_CALENDAR_AGENT_TOOLS. Reads are silent
//    (summary/description/location/organizer come back CALENDAR_EVENT-fenced — meeting invites are
//    externally-authored text); the three writes are edit-tier, ALWAYS ask (D4: 恒 HITL — never
//    auto-approved, no whitelist hook). P2-4: date/datetime params accept an IANA `timezone` and
//    date-only / offset-less values are interpreted in it (default: the machine's local timezone,
//    NEVER UTC — a UTC "today" is 7-8h off for a US-west user). ──────────────────────────────────

/** calendar_events_list — occurrences in a window (RRULE expanded server-side). */
export const calendarEventsListSchema = z.object({
  from_date: z.string().min(1).max(64).optional(),
  to_date: z.string().min(1).max(64).optional(),
  days: z.number().int().min(1).max(60).default(7),
  timezone: z.string().min(1).max(64).optional(),
  calendar_name: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50)
})
export type CalendarEventsListInput = z.infer<typeof calendarEventsListSchema>

/** calendar_event_get — one event's full detail by iCalendar UID. */
export const calendarEventGetSchema = z.object({
  event_id: z.string().min(1).max(512),
  source: z.enum(['caldav', 'email_ics', 'legacy_calendar_app']).default('caldav'),
  recurrence_id: z.string().min(1).max(64).optional()
})
export type CalendarEventGetInput = z.infer<typeof calendarEventGetSchema>

/** calendar_event_reschedule — move an event (whole series / this occurrence / this-and-future). */
export const calendarEventRescheduleSchema = z.object({
  event_id: z.string().min(1).max(512),
  new_start: z.string().min(1).max(64),
  new_end: z.string().min(1).max(64),
  scope: z.enum(['series', 'occurrence', 'future']).default('series'),
  recurrence_id: z.string().min(1).max(64).optional(),
  timezone: z.string().min(1).max(64).optional()
})
export type CalendarEventRescheduleInput = z.infer<typeof calendarEventRescheduleSchema>

/** calendar_event_rsvp — send the IRREVOCABLE iTIP REPLY to the organizer. */
export const calendarEventRsvpSchema = z.object({
  event_id: z.string().min(1).max(512),
  response: z.enum(['accept', 'tentative', 'decline']),
  recurrence_id: z.string().min(1).max(64).optional()
})
export type CalendarEventRsvpInput = z.infer<typeof calendarEventRsvpSchema>

/** calendar_event_delete — CalDAV DELETE (irreversible). */
export const calendarEventDeleteSchema = z.object({
  event_id: z.string().min(1).max(512),
  calendar_name: z.string().min(1).max(200).optional()
})
export type CalendarEventDeleteInput = z.infer<typeof calendarEventDeleteSchema>

/** suggest_followups (W6) — 2-3 short next-question suggestions the model proposes AFTER its
 *  answer is complete. Length/dedup/cap-3 cleaning happens in execute (sanitizeFollowupPrompts);
 *  the schema only pins the structural contract so an off-count call errors and the model
 *  self-corrects instead of silently over-suggesting. */
export const suggestFollowupsSchema = z.object({
  prompts: z
    .array(z.string())
    .min(2)
    .max(3)
    .describe(
      '2-3 short follow-up questions the user is likely to ask next, phrased as the user ' +
        'would ask them (first person), in the same language the user is writing in.'
    )
})
export type SuggestFollowupsInput = z.infer<typeof suggestFollowupsSchema>

/** submit_feedback (task 08-27 P4a) — 主 Agent 代 owner 向产品反馈库提交一条反馈。
 *
 *  🔴 词表是 shared/feedback/contract.ts 的单源（select 传的是**显示值字符串**，不是
 *  option id），这里用 z.enum 引用它，不另抄一份中文字面量。
 *  🔴 没有截图字段 —— agent 截不了图，那一项在它提交时恒为「无截图」（诊断包由服务端
 *  按 `attach_diagnostics` 自己组装，模型不经手文件）。 */
export const submitFeedbackSchema = z.object({
  kind: z
    .enum(FEEDBACK_KINDS)
    .describe('Feedback category: 问题 (bug) / 建议 (suggestion) / 咨询 (question).'),
  title: z.string().trim().min(1).max(200).describe('One-line summary, in the user’s language.'),
  detail: z
    .string()
    .max(8000)
    .optional()
    .describe('What happened / what is expected, reproduction steps if known.'),
  freq: z
    .enum(FEEDBACK_FREQUENCIES)
    .optional()
    .describe('Reproduction frequency. ONLY meaningful when kind is 问题; ignored otherwise.'),
  email: z
    .string()
    .max(200)
    .optional()
    .describe('Optional contact email the owner explicitly provided in this conversation.'),
  attach_diagnostics: z
    .boolean()
    .optional()
    .describe(
      'Attach the diagnostics bundle (last 7 days of redacted logs + config snapshot). ' +
        'Takes about a minute to build — only set it for a reproducible defect.'
    )
})
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>

/** generate_image (task 09-02) — text → image, or edit when `source_images` is non-empty.
 *  🔴 Flat object on purpose (reference_prompt_schema_drift_trap): the generate/edit branch is
 *  decided by `source_images.length`, never by a oneOf/not schema branch. */
export const generateImageSchema = z.object({
  prompt: z.string().min(1).max(4000),
  size: z
    .string()
    .regex(/^\d{3,4}x\d{3,4}$/, 'size must look like 1024x1024')
    .optional()
    .describe('Requested "<width>x<height>" (model-dependent). Omit for the model default.'),
  n: z.number().int().min(1).max(2).default(1),
  source_images: z
    .array(z.string().min(1).max(200))
    .max(4)
    .default([])
    .describe(
      'Edit mode when non-empty: file_id values from earlier generate_image results, or ' +
        '"attached:last" / "attached:<n>" for images the user attached (1-based, conversation order).'
    )
})
export type GenerateImageInput = z.infer<typeof generateImageSchema>
