// Calendar, followups, feedback, image generation, tool_search, and computer_use schemas.
import { z } from 'zod'
import { FEEDBACK_FREQUENCIES, FEEDBACK_KINDS } from '../../../shared/feedback/contract'

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

/** tool_search (WS-2 Plane 1) — search and activate deferred tools on demand.
 *  All fields are flat top-level primitives/enums (no root refine/union) for cross-provider
 *  JSON-schema strictness; at-least-one-of (query | connector_id) is enforced in tool run. */
export const toolSearchSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Keywords matching the desired action, connector, or tool name (English or Chinese).'
    ),
  connector_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Exact MCP connector ID (for example "notion", "chrome_devtools", "computer_use") to filter its tools.'
    ),
  category: z
    .enum(['all', 'connector', 'builtin'])
    .default('all')
    .describe('Restrict search to connector tools, built-in tools, or all deferred tools.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe('Maximum number of matching deferred tools to activate and return (1-25).')
})
export type ToolSearchInput = z.infer<typeof toolSearchSchema>

/** computer_use_run (WS-4) — launch a bounded browser/desktop operator sub-agent loop.
 *  Flat schema fields; allowlists and `stop_before_submit` guardrails are enforced deterministically
 *  at policy evaluation, tool pre-flight, and post-step verification inside `computer_use.ts`. */
export const computerUseRunSchema = z.object({
  goal: z
    .string()
    .min(1)
    .max(4000)
    .describe('Clear, bounded task objective for the browser or desktop operator sub-agent.'),
  target_hint: z
    .enum(['auto', 'browser', 'desktop'])
    .default('auto')
    .describe('Surface preference: browser (Playwright/Chrome), desktop (macOS AX), or auto.'),
  allowed_apps: z
    .array(z.string().min(1).max(128))
    .max(16)
    .optional()
    .describe(
      'Optional allowlist of desktop application names or bundle IDs permitted for this task.'
    ),
  allowed_domains: z
    .array(z.string().min(1).max(255))
    .max(16)
    .optional()
    .describe('Optional allowlist of website domains permitted for browser navigation.'),
  stop_before_submit: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), pause before clicking irreversible submit/send/approve/pay/delete actions and return a confirmation draft.'
    ),
  max_steps: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(15)
    .describe('Maximum step budget for the operator sub-agent loop (1-30, default 15).')
})
export type ComputerUseRunInput = z.infer<typeof computerUseRunSchema>
