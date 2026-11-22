// Custom-agent CRUD/call and group-chat tool zod input schemas.
import { z } from 'zod'
import {
  GROUP_HISTORY_LIMIT_MAX,
  GROUP_POST_TEXT_MAX_CHARS,
  MAX_GROUP_MEMBERS,
  RESPONSE_MODES
} from '../../groupFloors'

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

/** Wave 6 — bounded Computer Use grant for custom agents (`grant_computer_use`).
 *  Requires concrete non-wildcard `allowed_domains` (for browser_use) and/or `allowed_apps`
 *  (for desktop_use). */
export const customAgentComputerUseGrantSchema = z
  .object({
    enabled: z.literal(true).default(true),
    submit_mode: z.enum(['stop_before_submit', 'allow_submit']).default('stop_before_submit'),
    allowed_domains: z
      .array(z.string().min(1).max(253))
      .max(32)
      .optional()
      .describe(
        'Exact/parent domains allowed for browser automation (e.g. ["dms.company.com"], no "*").'
      ),
    allowed_apps: z
      .array(z.string().min(1).max(128))
      .max(32)
      .optional()
      .describe('Exact desktop app names allowed (e.g. ["Microsoft Teams", "Notion"], no "*").')
  })
  .strict()
  .refine(
    (v) => (v.allowed_domains?.length ?? 0) > 0 || (v.allowed_apps?.length ?? 0) > 0,
    'grant_computer_use requires at least one entry in allowed_domains or allowed_apps'
  )
export type CustomAgentComputerUseGrantInput = z.infer<typeof customAgentComputerUseGrantSchema>

const customAgentEmailCapabilitySchema = z.enum(['read', 'organize', 'draft'])
const customAgentCalendarCapabilitySchema = z.enum(['off', 'read', 'write'])
const customAgentToggleCapabilitySchema = z.enum(['off', 'on'])
const customAgentReportCapabilitySchema = z.enum(['read', 'produce'])
// task 09-02 资料库 —— 第 8 张能力卡，三档逐级 superset（write ⊃ read ⊃ off）。
const customAgentLibraryCapabilitySchema = z.enum(['off', 'read', 'write'])
// task 09-02 — chat-history read radius; defaults to 'own' so a profile authored before the card
// existed still parses as a complete profile.
const customAgentSessionsCapabilitySchema = z.enum(['own', 'all'])

const customAgentCapabilityFields = {
  email: customAgentEmailCapabilitySchema,
  calendar: customAgentCalendarCapabilitySchema,
  knowledge: customAgentToggleCapabilitySchema,
  sessions: customAgentSessionsCapabilitySchema,
  reports: customAgentReportCapabilitySchema,
  library: customAgentLibraryCapabilitySchema,
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
    sessions: customAgentSessionsCapabilitySchema.default('own'),
    // 同 sessions：09-03 才有的卡，缺省成 'off' 才不会把此前写好的完整 profile 判成不完整。
    library: customAgentLibraryCapabilitySchema.default('off')
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
    grant_connectors: customAgentConnectorGrantsSchema.optional(),
    grant_computer_use: customAgentComputerUseGrantSchema.optional()
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
    grant_connectors: customAgentConnectorGrantsSchema.optional(),
    grant_computer_use: z.union([customAgentComputerUseGrantSchema, z.null()]).optional()
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
    library_file_ids: z.array(z.number().int().positive()).max(50).optional(),
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
