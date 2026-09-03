// chat-panel P4 Phase 04a — A2UI payload contract + tool→card mapper (single source).
//
// A2UI is MailAgent's typed "tool UI render payload" (protocol-contracts §3): NOT a
// replacement for AI SDK / AG-UI, just a typed payload that carries WHICH card renders a
// tool's approval / result and WITH WHAT props. This module is the ONE place that
//   1. declares the A2UIPayload shape + a runtime zod validator (parseA2UIPayload), and
//   2. maps a gateway tool's (name, args, result) → an A2UIPayload (buildToolA2UIPayload).
//
// It is consumed by BOTH sides so the render and the audit can never drift:
//   - the rich tool cards (frontend, @shared) call buildToolA2UIPayload to derive their
//     typed props from the live tool part (args at approval-request time, args+result at
//     output time), then render from those props;
//   - the AI SDK Gateway write tools (relative import, pure Node) call it in `execute` to
//     stamp the SAME payload into chat_tool_call.ui_payload_json (audit). The payload is
//     NEVER added to the model-visible tool result (that would break 03b parity + add model
//     noise) — it is a UI/audit concern only.
//
// 🔴 Pure TS (types + zod, no react / electron / ai imports) so the gateway core stays
//    harness-loadable under tsx and this module is directly unit-testable. The react cards
//    that use these props live in their own *.tsx files.

import { z } from 'zod'

/** A2UI protocol identity (protocol-contracts §3 + §9 versioning). A breaking props change
 *  must bump the major (1.0 → 2.0); additive props stay 1.0. */
export const A2UI_PROTOCOL = 'a2ui.mailagent' as const
export const A2UI_VERSION = '1.0' as const

/** Risk tier carried in the audit envelope. Mirrors the write-tool confirmationTier plus
 *  the read-tool 'trace' floor (protocol-contracts §3). */
export type A2UIRisk = 'trace' | 'preview' | 'edit' | 'blocking'

/** A user-actionable intent a card MAY surface (protocol-contracts §3). Phase 04a cards
 *  drive approval through assistant-ui's native respondToApproval rather than these, so
 *  intents are carried for audit/forward-compat but not required to render. */
export interface A2UIIntent {
  id: string
  label: string
  kind: 'primary' | 'secondary' | 'danger'
  payload?: unknown
}

/** The typed tool-UI render payload (protocol-contracts §3). `component` selects the card
 *  (the ComponentRegistry key); `props` is the card's typed input. */
export interface A2UIPayload<Props = Record<string, unknown>> {
  protocol: typeof A2UI_PROTOCOL
  version: typeof A2UI_VERSION
  component: string
  props: Props
  intents?: A2UIIntent[]
  audit?: {
    risk: A2UIRisk
    requiresApproval: boolean
    approvalId?: string
    contentHash?: string
  }
}

const intentSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['primary', 'secondary', 'danger']),
  payload: z.unknown().optional()
})

/** Runtime validator — an UNTRUSTED a2ui blob (e.g. round-tripped through persistence or a
 *  remote turn) is parsed through this; a malformed payload yields null so the caller can
 *  fall back to the generic ToolTraceCard instead of throwing (registry-miss-never-blocks). */
export const a2uiPayloadSchema = z.object({
  protocol: z.literal(A2UI_PROTOCOL),
  version: z.literal(A2UI_VERSION),
  component: z.string().min(1),
  props: z.record(z.string(), z.unknown()),
  intents: z.array(intentSchema).optional(),
  audit: z
    .object({
      risk: z.enum(['trace', 'preview', 'edit', 'blocking']),
      requiresApproval: z.boolean(),
      approvalId: z.string().optional(),
      contentHash: z.string().optional()
    })
    .optional()
})

/** Parse an untrusted value into an A2UIPayload, or null when it does not validate. Never
 *  throws — a schema-invalid payload must degrade to the generic card, not break the chat. */
export function parseA2UIPayload(value: unknown): A2UIPayload | null {
  const r = a2uiPayloadSchema.safeParse(value)
  return r.success ? (r.data as A2UIPayload) : null
}

// ── component names (the ComponentRegistry keys) ─────────────────────────────

export const A2UI_COMPONENTS = {
  DraftReplyCard: 'DraftReplyCard',
  NotionSyncCard: 'NotionSyncCard',
  ApprovalActionCard: 'ApprovalActionCard',
  // Phase 04b — the high-risk outbound send card (email_prepare_send, blocking tier).
  SendApprovalCard: 'SendApprovalCard',
  // M4b — the agent's Standing Context doc edit approval card (update_system_md, edit tier;
  // soul/rules get the high-risk red treatment + the PRODUCT_SAFETY_FLOOR note).
  SystemDocApprovalCard: 'SystemDocApprovalCard',
  // M4c — the skill enable/disable (mount/unmount) approval card (set_skill_enabled, preview tier).
  SkillToggleCard: 'SkillToggleCard',
  // S2 W1 — local exec approval card (run_command / file_read / file_write, edit tier). Shows the
  // exact argv / path + a "总是允许" affordance that creates a structured whitelist rule.
  ExecApprovalCard: 'ExecApprovalCard',
  // S2 W4 — skill-supply approval cards (edit tier + capability_change; skill_read has no card).
  // SkillInstallConfirmCard renders SERVER facts fetched by quarantine id (ADR-002 §4) — never the
  // model's args content fields.
  SkillInstallCard: 'SkillInstallCard',
  SkillInstallConfirmCard: 'SkillInstallConfirmCard',
  SkillUninstallCard: 'SkillUninstallCard',
  SkillPublishCard: 'SkillPublishCard',
  // S6 W3-2 (ADR-004 rev3.1 §7 D5 / D-fix-2) — custom_agent_create / custom_agent_update approval
  // card (edit tier + capability_change). Renders a permission summary (name / purpose / requested
  // grants, exec + web-open red); for UPDATE the card fetches the agent's CURRENT row server-side
  // and renders a before/after grant/skill diff (the payload carries ONLY the model's patch —
  // "before" can never come from model input).
  CustomAgentApprovalCard: 'CustomAgentApprovalCard',
  CustomAgentCallCard: 'CustomAgentCallCard',
  // L4 群聊 g2 — group_create / group_post 的审批卡（edit tier + capability_change）。与
  // SimpleApprovalCard / MatterWriteCard 同为**只做 ComponentRegistry key**：componentForTool
  // 对这两个工具返回 null（不落 audited ui_payload），卡自己读 tool part 的 args / result。
  GroupCreateCard: 'GroupCreateCard',
  GroupPostCard: 'GroupPostCard',
  // 1.5.0 dogfood (task 07-07) — the identity-only edit-tier approval card shared by web_fetch /
  // web_search / custom_agent_delete / custom_agent_run_now. These tools deliberately produce NO
  // audited ui_payload (componentForTool returns null for them, unchanged), so this key is a
  // ComponentRegistry key only — the card reads the tool args directly. It exists so islandless
  // approval of these edit-tier tools has real approve/reject buttons instead of the buttonless
  // ToolTraceCard (which showed the approval-paused state as a permanent spinner).
  SimpleApprovalCard: 'SimpleApprovalCard',
  // calendar epic 4.2 — calendar write approval card (reschedule / rsvp / delete, edit tier +
  // 恒 HITL). Reschedule renders a before→after time diff whose "before" is fetched live from
  // serve-api (never the model's args — CustomAgentApprovalCard precedent); rsvp carries the
  // "irrevocable iTIP REPLY to the organizer" warning; delete the irreversible warning.
  CalendarApprovalCard: 'CalendarApprovalCard',
  // prd 07-27 — the new-draft / edit-draft approval card (email_draft_compose +
  // email_draft_update, edit tier). Subject / recipients / body are all editable before approval;
  // for an UPDATE the card additionally fetches the target draft's CURRENT subject/recipients from
  // serve-api and renders a before→after diff (CalendarApprovalCard precedent — "before" is never
  // projected from model args). email_draft_reply keeps its own card (reply-shaped: no subject,
  // empty recipients = server-derived reply-all).
  DraftComposeCard: 'DraftComposeCard',
  // Matters MVP P3 — the 7 matter write tools' part card. Like SimpleApprovalCard this is a
  // ComponentRegistry key ONLY: `componentForTool` deliberately returns null for the matter tools
  // (no audited ui_payload), the card reads the tool part directly. It routes an approval-paused
  // part to SimpleApprovalCard (D7 identity-level approval — otherwise these edit-tier writes hit
  // the buttonless ToolTraceCard spinner) and a completed one to the write receipt + undo inside
  // the Matter Chat panel (D9).
  MatterWriteCard: 'MatterWriteCard',
  // task 08-27 P4a — submit_feedback 的审批卡（edit tier + class outbound + 恒 HITL）。
  // 与 SimpleApprovalCard / MatterWriteCard 同为**只做 ComponentRegistry key**：
  // `componentForTool` 对它返回 null（不落 audited ui_payload），卡自己读 tool part 的 args。
  // 三个按钮里的「改一改」走 04a 的 resolve 侧信道（SendApprovalCard 先例）—— agent 整理的
  // 措辞未必对，只有「发 / 不发」两档不够用。
  FeedbackApprovalCard: 'FeedbackApprovalCard',
  // task 09-02 — generate_image 的结果卡（生成中占位 / 完成图片 / 失败重试）。与 SimpleApprovalCard
  // 同为**只做 ComponentRegistry key**：`componentForTool` 对它返回 null（tool result 只回文件
  // 引用 + url，卡自己从 tool part 的 args / result 读），审批暂停时同一张卡出 approve / reject。
  ImageGenCard: 'ImageGenCard',
  // dogfood 0903 — 资料库四个写工具（library_write / _append / _move / _delete）的富审批卡，
  // 取代它们在 P2-L1 时挂的 SimpleApprovalCard。与那张卡同为**只做 ComponentRegistry key**：
  // `componentForTool` 对这四个返回 null（不落 audited ui_payload），卡自己读 tool part 的 args；
  // overwrite / append 只有 `file_id` 时，路径由卡片向 serve-api 查一次补上（CalendarApprovalCard
  // 先例 —— 展示用的服务端事实绝不从模型参数里推）。
  LibraryWriteCard: 'LibraryWriteCard'
} as const

/** Which A2UI component renders a given gateway write tool. Unknown / read tools → null
 *  (the card layer falls back to the generic ToolTraceCard; "registry miss never blocks"). */
export function componentForTool(toolName: string): string | null {
  switch (toolName) {
    case 'email_draft_reply':
      return A2UI_COMPONENTS.DraftReplyCard
    case 'email_draft_compose':
    case 'email_draft_update':
      return A2UI_COMPONENTS.DraftComposeCard
    case 'email_resync':
      return A2UI_COMPONENTS.NotionSyncCard
    case 'email_flag':
    case 'email_archive':
    case 'email_pin':
      return A2UI_COMPONENTS.ApprovalActionCard
    case 'email_prepare_send':
      return A2UI_COMPONENTS.SendApprovalCard
    case 'update_system_md':
      return A2UI_COMPONENTS.SystemDocApprovalCard
    case 'set_skill_enabled':
      return A2UI_COMPONENTS.SkillToggleCard
    case 'run_command':
    case 'file_read':
    case 'file_write':
      return A2UI_COMPONENTS.ExecApprovalCard
    case 'skill_install':
      return A2UI_COMPONENTS.SkillInstallCard
    case 'skill_install_confirm':
      return A2UI_COMPONENTS.SkillInstallConfirmCard
    case 'skill_uninstall':
      return A2UI_COMPONENTS.SkillUninstallCard
    case 'skill_draft_publish':
      return A2UI_COMPONENTS.SkillPublishCard
    case 'custom_agent_create':
    case 'custom_agent_update':
      return A2UI_COMPONENTS.CustomAgentApprovalCard
    case 'calendar_event_reschedule':
    case 'calendar_event_rsvp':
    case 'calendar_event_delete':
      return A2UI_COMPONENTS.CalendarApprovalCard
    // discover_skills / skill_read are silent reads → no card (generic ToolTraceCard);
    // custom_agent_delete / run_now keep the generic approval shell (identity-only inputs).
    default:
      return null
  }
}

// ── typed per-card props ──────────────────────────────────────────────────────

/** email_draft_reply (edit tier). At approval-request time `internalId`+`bodyMarkdown`
 *  (+ optional recipient overrides) come from the model input; the draftId/mailbox land after
 *  execution. to/cc/bcc are FULL-list overrides — empty = server-derived reply-all. `userEdited`
 *  is true once the user changed the proposed body/recipients before approving. */
export interface DraftReplyCardProps {
  internalId: number
  bodyMarkdown: string
  mode?: string
  to: string[]
  cc: string[]
  bcc: string[]
  draftId?: string | null
  mailbox?: string | null
  accountName?: string | null
  userEdited?: boolean
}

/** email_draft_compose / email_draft_update (prd 07-27, edit tier). The props carry ONLY the
 *  model's proposal — for `kind:'update'` the target draft's CURRENT subject/recipients are fetched
 *  live by the card and diffed against these (CalendarApprovalCard precedent), so a model claiming
 *  a wrong "before" changes nothing the user reviews. `subject`/`bodyMarkdown` are undefined when
 *  the model did not propose one: on compose that means "server default" (Fwd: <original> /
 *  (no subject)), on update it means "keep the current value". Recipient lists are [] when absent
 *  (compose: none; update: unchanged). */
export interface DraftComposeCardProps {
  kind: 'compose' | 'update'
  /** compose: 'new' | 'forward'. Absent on update (always a merged re-save). */
  mode?: 'new' | 'forward'
  /** compose+forward: the source email being forwarded. update: the draft being edited. */
  internalId?: number
  subject?: string
  bodyMarkdown?: string
  to: string[]
  cc: string[]
  bcc: string[]
  /** forward only — quote the original below the body (default true). */
  quoteOriginal?: boolean
  /** Result echoes (land after execute). */
  draftsFolder?: string | null
  appendedUid?: number | null
  /** update only — false means BOTH drafts remain (the delete of the old one failed). */
  oldDraftDeleted?: boolean
  warnings?: string[]
  userEdited?: boolean
}

/** email_resync (preview tier) — re-push to Notion from the SQLite SSoT. */
export interface NotionSyncCardProps {
  internalId: number
  oldPageId?: string | null
  newPageId?: string | null
  action?: string | null
}

/** email_flag / email_archive / email_pin (preview tier) — a generic approve/reject card.
 *  `summary` is a short human description of the proposed change; `applied` echoes the
 *  result (set after execution). */
export interface ApprovalActionCardProps {
  toolName: string
  internalId: number
  summary: string
  applied?: Record<string, unknown> | null
}

/** email_prepare_send (blocking tier) — the high-risk outbound send card. At approval-request
 *  time the recipients / subject / body come from the model input (all editable); after the send
 *  runs, the result fields (sent / messageId / archivedToSent) land. `internalId` is optional
 *  source context, pinned (not editable). */
export interface SendApprovalCardProps {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  bodyMarkdown: string
  internalId?: number
  sent?: boolean
  messageId?: string | null
  archivedToSent?: boolean
}

/** update_system_md (M4b, edit tier) — the agent proposes new content for a Standing Context doc.
 *  `highRisk` is true for soul/rules (identity + hard constraints) → the card uses the red high-risk
 *  treatment + the PRODUCT_SAFETY_FLOOR note. `contentPreview` is a truncated view of the proposed
 *  markdown (the full content rides the editable approval input). `appliedHash` lands after execute. */
export interface SystemDocApprovalCardProps {
  docName: string
  highRisk: boolean
  contentPreview: string
  contentLength: number
  userEdited?: boolean
  appliedHash?: string | null
}

/** set_skill_enabled (M4c, preview tier) — enable/disable a skill (mount/unmount its tools). */
export interface SkillToggleCardProps {
  skillName: string
  enabled: boolean
  applied?: boolean
}

/** run_command / file_read / file_write (S2 W1, edit tier) — the local exec approval card.
 *  `kind` picks the header + which fields matter; `argv`/`cwd` for run_command, `path`/`mode`
 *  for file ops. `summary` is a one-line human description; result fields (exitCode/bytesWritten)
 *  land after execute. The card shows a "总是允许" affordance (creates a structured whitelist rule). */
export interface ExecApprovalCardProps {
  kind: 'run_command' | 'file_read' | 'file_write'
  summary: string
  argv?: string[]
  cwd?: string | null
  path?: string | null
  mode?: string | null
  exitCode?: number | null
  bytesWritten?: number | null
  /** run_command only, result-phase — per-skill secret NAMES injected into the child env.
   *  A security disclosure the owner cannot get anywhere else: it says which stored secrets
   *  the command they approved was able to read. Values never cross the wire. Only ever
   *  populated after execute — the overlay is resolved server-side inside /exec/run. */
  injectedSecretNames?: string[] | null
  /** run_command only, result-phase — skill entrypoints this run recorded as first-run approved. */
  firstRunRecorded?: string[] | null
}

/** skill_install (S2 W4, edit tier) — stage 1: fetch into quarantine. Only the SOURCE (url/path)
 *  matters at approval time (nothing is installed); result fields land after the fetch. */
export interface SkillInstallCardProps {
  sourceUrl?: string | null
  localPath?: string | null
  quarantineId?: string | null
  packageHash?: string | null
  fileCount?: number | null
  userEdited?: boolean
}

/** skill_install_confirm (S2 W4, edit tier) — stage 2. 🔴 The card renders SERVER facts fetched
 *  live by quarantineId (GET /agent/skills/quarantine/{qid} re-hashes on disk) — these props carry
 *  only the identity (quarantineId) + result echoes, NEVER the model's content claims. */
export interface SkillInstallConfirmCardProps {
  quarantineId: string
  installedName?: string | null
  installed?: boolean
}

/** skill_uninstall (S2 W4, edit tier) — full cleanup (row + dir + secrets). The card additionally
 *  fetches the stored secret names live (GET /agent/skills/{name}/secrets). */
export interface SkillUninstallCardProps {
  skillName: string
  removed?: boolean
  removedSecrets?: number | null
}

/** custom_agent_create / custom_agent_update (S6 W3-2, edit tier + capability_change — ADR-004
 *  rev3.1 §7). The props carry ONLY the model's proposed fields (create: the full spec; update:
 *  the partial patch — `undefined` = field not in the patch). 🔴 For update, "before" is NEVER in
 *  this payload: the card fetches the agent's current row live from the server and diffs against
 *  it (a model lying about the current permissions changes nothing). Grants absent on create mean
 *  the safe defaults (no exec, web off, default skill mounts). */
export interface CustomAgentApprovalCardProps {
  kind: 'create' | 'update'
  agentId: string
  title?: string
  /** The steering prompt (full text — the review surface is never truncated; the card scrolls). */
  prompt?: string | null
  model?: string
  enabled?: boolean
  /** Compact human trigger summary; null = trigger explicitly cleared (agent disabled). */
  triggerSummary?: string | null
  capabilities?: {
    email?: 'read' | 'organize' | 'draft'
    calendar?: 'off' | 'read' | 'write'
    knowledge?: 'off' | 'on'
    reports?: 'read' | 'produce'
    web?: 'off' | 'gated' | 'open'
    files?: 'off' | 'on'
  }
  allowedTools?: string[]
  grantExec?: boolean
  grantWeb?: 'off' | 'gated' | 'open'
  skills?: string[]
  /** MCP connector epic stage 1 PR3 — the proposed per-connector crud ceilings
   *  ({connectorId: 'read'|'write'|'update'}; `{}` = clear every connector grant). 🔴 This axis
   *  MUST reach the card: `grant_connectors` is part of the model-proposable CRUD vocabulary
   *  (customAgentCreate/UpdateSchema), and a connector grant hands a headless run 免卡 access to
   *  an external workspace — an approval card that cannot show it is not a review surface.
   *  'delete' is unrepresentable (rejected by the zod enum and by Python's parse_tool_policy). */
  connectors?: Record<string, 'read' | 'write' | 'update'>
  /** Result echoes (land after execute). */
  applied?: boolean
}

/** calendar_event_reschedule / calendar_event_rsvp / calendar_event_delete (edit tier, 恒 HITL).
 *  The props carry ONLY the model's proposed input (event id + new times / response) plus result
 *  echoes — the "before" facts (current title / times / organizer) are fetched live from serve-api
 *  by the card (GET /calendar/events/{uid}), never projected from model args, so a model lying
 *  about the current schedule changes nothing the user reviews. */
export interface CalendarApprovalCardProps {
  kind: 'reschedule' | 'rsvp' | 'delete'
  eventId: string
  /** reschedule only. */
  scope?: 'series' | 'occurrence' | 'future'
  recurrenceId?: string | null
  newStart?: string | null
  newEnd?: string | null
  timezone?: string | null
  /** rsvp only. */
  response?: 'accept' | 'tentative' | 'decline'
  /** delete only. */
  calendarName?: string | null
  /** Result echo (lands after execute). */
  applied?: boolean
}

function asNum(v: unknown, fallback = -1): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Compact human summary of a proposed custom-agent trigger (from raw tool args — mirrors the
 *  gateway triggerSummary shape so the card and custom_agent_list read alike). '' on junk. */
function summarizeAgentTrigger(trigger: Record<string, unknown> | null): string {
  if (!trigger) return ''
  if (trigger.kind === 'cron') {
    const tz = asStr(trigger.timezone)
    return `cron ${asStr(trigger.cron) ?? '?'}${tz ? ` (${tz})` : ''}`
  }
  // 07-24 结构化排程（kind:'schedule'，与 cron 并存，backend parse_trigger 接受）——
  // 审批卡必须能呈现，否则 owner 批的是一个看不见的触发。形状镜像 gateway triggerSummary。
  if (trigger.kind === 'schedule') {
    const rule = asObj(trigger.rule)
    if (!rule) return 'schedule (invalid rule)'
    const freq = asStr(rule.freq) ?? '?'
    const pad2 = (n: number): string => String(Math.max(0, n)).padStart(2, '0')
    const parts = [`schedule ${freq}`]
    const interval = asNum(rule.interval, 1)
    if (interval > 1) parts.push(`every ${interval}`)
    if (freq === 'weekly') {
      const days = Array.isArray(rule.weekdays)
        ? rule.weekdays.filter((x): x is number => typeof x === 'number')
        : []
      parts.push(`byday=[${days.join(',')}]`)
    }
    if (freq === 'monthly') {
      parts.push(
        rule.monthMode === 'nth'
          ? `nth=${String(rule.ordinal ?? '?')} weekday=${String(rule.weekday ?? '?')}`
          : `day=${String(rule.monthDay ?? '?')}${rule.clamp === true ? ' (clamped)' : ''}`
      )
    }
    const tz = asStr(trigger.timezone)
    parts.push(
      `at ${pad2(asNum(rule.hour, 0))}:${pad2(asNum(rule.minute, 0))}${tz ? ` (${tz})` : ''}`
    )
    return parts.join(' ')
  }
  if (trigger.kind === 'email_filter') {
    const preds: string[] = []
    const subject = asStr(trigger.subject_pattern)
    const sender = asStr(trigger.sender_pattern)
    const folders = asStrArray(trigger.folders)
    if (subject) preds.push(`subject~/${subject}/`)
    if (sender) preds.push(`sender~/${sender}/`)
    if (folders.length > 0) preds.push(`folders=[${folders.join(',')}]`)
    return `email_filter ${preds.join(' ') || '(no predicates)'}`
  }
  if (trigger.kind === 'calendar_event_change') {
    const calendars = asStrArray(trigger.calendar_ids)
    return `calendar_event_change${calendars.length ? ` calendars=[${calendars.join(',')}]` : ''}`
  }
  if (trigger.kind === 'calendar_before_start') {
    const calendars = asStrArray(trigger.calendar_ids)
    return `calendar_before_start lead=${asNum(trigger.lead_seconds, 0)}s${calendars.length ? ` calendars=[${calendars.join(',')}]` : ''}`
  }
  return ''
}

/** Build a short human summary for the generic approval card from a flag/archive/pin input. */
function summarizeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'email_flag': {
      const parts: string[] = []
      if (typeof args.is_read === 'boolean') parts.push(args.is_read ? '标为已读' : '标为未读')
      if (typeof args.is_flagged === 'boolean') parts.push(args.is_flagged ? '加旗标' : '去旗标')
      if (typeof args.processing_status === 'string' && args.processing_status)
        parts.push(`处理状态→${String(args.processing_status)}`)
      return parts.length ? parts.join('，') : '更新邮件标记'
    }
    case 'email_archive':
      return '归档邮件（移入存档文件夹）'
    case 'email_pin':
      return args.pinned === false ? '取消置顶' : '置顶邮件'
    default:
      return '执行写操作'
  }
}

/**
 * Map a gateway write tool's (name, args, result?) to its A2UIPayload. `args` is the model
 * input (or, post-edit, the effective executed input); `result` is the tool output once
 * available. Returns null for any tool with no registered card (the caller falls back to the
 * generic ToolTraceCard). This is the SINGLE mapper both the cards (render) and the gateway
 * (audit) call, so what the user sees and what is audited can never diverge.
 */
export function buildToolA2UIPayload(
  toolName: string,
  io: { args: unknown; result?: unknown; userEdited?: boolean; risk?: A2UIRisk }
): A2UIPayload | null {
  const component = componentForTool(toolName)
  if (!component) return null
  const args = asObj(io.args) ?? {}
  const result = asObj(io.result)
  const requiresApproval = true // every write card is approval-gated (preview/edit)

  if (component === A2UI_COMPONENTS.DraftReplyCard) {
    const props: DraftReplyCardProps = {
      internalId: asNum(result?.internal_id ?? args.internal_id),
      // result.final_body_markdown is the EXECUTED body (post-edit); fall back to the
      // proposed input body at approval-request time.
      bodyMarkdown: asStr(result?.final_body_markdown) ?? asStr(args.body_markdown) ?? '',
      mode: asStr(args.mode),
      // Recipient overrides (empty = server-derived reply-all); final_* echo the executed lists.
      to: asStrArray(result?.final_to ?? args.to),
      cc: asStrArray(result?.final_cc ?? args.cc),
      bcc: asStrArray(result?.final_bcc ?? args.bcc),
      draftId: asStr(result?.draft_id) ?? null,
      mailbox: asStr(result?.mailbox) ?? null,
      accountName: asStr(result?.account_name) ?? null,
      userEdited: io.userEdited ?? result?.user_edited === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.DraftComposeCard) {
    // 🔴 props = the model's PROPOSAL only. The update card's "before" (current subject /
    // recipients of the target draft) is fetched server-side by the component; projecting any
    // "current state" from args here would let the model spoof the diff it is reviewed against.
    const update = toolName === 'email_draft_update'
    const mode = asStr(args.mode)
    const props: DraftComposeCardProps = {
      kind: update ? 'update' : 'compose',
      to: asStrArray(result?.final_to ?? args.to),
      cc: asStrArray(result?.final_cc ?? args.cc),
      bcc: asStrArray(result?.final_bcc ?? args.bcc),
      draftsFolder: asStr(result?.drafts_folder) ?? null,
      appendedUid: typeof result?.appended_uid === 'number' ? result.appended_uid : null,
      warnings: asStrArray(result?.warnings),
      userEdited: io.userEdited ?? result?.user_edited === true
    }
    if (update) {
      props.internalId = asNum(args.draft_internal_id)
      props.oldDraftDeleted = result ? result.old_draft_deleted === true : undefined
    } else {
      props.mode = mode === 'forward' ? 'forward' : 'new'
      if (typeof args.internal_id === 'number') props.internalId = args.internal_id
      if (props.mode === 'forward') props.quoteOriginal = args.quote_original !== false
    }
    // final_* echo the EXECUTED content (post-edit); args are the proposal at approval time.
    const subject = asStr(result?.final_subject) ?? asStr(args.subject)
    if (subject !== undefined) props.subject = subject
    const body = asStr(result?.final_body_markdown) ?? asStr(args.body_markdown)
    if (body !== undefined) props.bodyMarkdown = body
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.NotionSyncCard) {
    const props: NotionSyncCardProps = {
      internalId: asNum(result?.internal_id ?? args.internal_id),
      oldPageId: asStr(result?.old_page_id) ?? null,
      newPageId: asStr(result?.new_page_id) ?? null,
      action: asStr(result?.action) ?? null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'preview', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SendApprovalCard) {
    const props: SendApprovalCardProps = {
      // at approval-request time the fields come from args; after the send the result echoes
      // the exact sent recipients/subject (final source of truth).
      to: asStrArray(result?.to ?? args.to),
      cc: asStrArray(result?.cc ?? args.cc),
      bcc: asStrArray(args.bcc),
      subject: asStr(result?.subject) ?? asStr(args.subject) ?? '',
      bodyMarkdown: asStr(args.body_markdown) ?? '',
      internalId: typeof args.internal_id === 'number' ? args.internal_id : undefined,
      sent: result?.sent === true,
      messageId: asStr(result?.message_id) ?? null,
      archivedToSent: result?.archived_to_sent === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'blocking', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SystemDocApprovalCard) {
    const docName = asStr(args.doc_name) ?? ''
    // M4b review MED-3 — soul/agent/rules are high-risk (identity / operating memory / hard rules);
    // user (preferences) is normal. The flag drives the card's red treatment + safety-floor note.
    const highRisk = docName === 'soul' || docName === 'agent' || docName === 'rules'
    // M4b review HIGH-2 — update_system_md is a FULL doc replacement; NEVER truncate the review
    // surface. The card shows the COMPLETE proposed content (scrollable) so the user reviews exactly
    // what will be written (approve/reject of the full content — the card has no edit UI).
    const content = asStr(result?.content) ?? asStr(args.content) ?? ''
    const props: SystemDocApprovalCardProps = {
      docName,
      highRisk,
      contentPreview: content,
      contentLength: [...content].length,
      userEdited: io.userEdited ?? result?.user_edited === true,
      appliedHash: asStr(result?.content_hash) ?? null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SkillToggleCard) {
    const props: SkillToggleCardProps = {
      skillName: asStr(args.skill_name) ?? '',
      enabled: args.enabled === true,
      applied: typeof result?.enabled === 'boolean' ? (result.enabled as boolean) : undefined
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'preview', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.ExecApprovalCard) {
    const kind = (
      toolName === 'file_read' || toolName === 'file_write' ? toolName : 'run_command'
    ) as 'run_command' | 'file_read' | 'file_write'
    const argv = asStrArray(args.argv)
    const path = asStr(args.path) ?? null
    const summary =
      kind === 'run_command'
        ? `运行命令：${argv.join(' ') || '(空)'}`
        : kind === 'file_read'
          ? `读文件：${path ?? '?'}`
          : `写文件：${path ?? '?'}`
    const props: ExecApprovalCardProps = {
      kind,
      summary,
      argv: kind === 'run_command' ? argv : undefined,
      cwd: asStr(args.cwd) ?? null,
      path,
      mode: asStr(args.mode) ?? null,
      exitCode: typeof result?.exit_code === 'number' ? (result.exit_code as number) : null,
      bytesWritten:
        typeof result?.bytes_written === 'number' ? (result.bytes_written as number) : null,
      injectedSecretNames:
        kind === 'run_command' ? asStrArray(result?.injected_secret_names) : null,
      firstRunRecorded: kind === 'run_command' ? asStrArray(result?.first_run_recorded) : null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SkillInstallCard) {
    const props: SkillInstallCardProps = {
      sourceUrl: asStr(args.source_url) ?? null,
      localPath: asStr(args.local_path) ?? null,
      quarantineId: asStr(result?.quarantine_id) ?? null,
      packageHash: asStr(result?.package_hash) ?? null,
      fileCount:
        result?.files && typeof result.files === 'object' && !Array.isArray(result.files)
          ? Object.keys(result.files as Record<string, unknown>).length
          : null,
      userEdited: io.userEdited ?? result?.user_edited === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SkillInstallConfirmCard) {
    // 🔴 identity only — the card fetches the quarantine facts server-side; args content fields
    // (expected_package_hash / expected_files) are deliberately NOT projected (ADR-002 §4).
    const props: SkillInstallConfirmCardProps = {
      quarantineId: asStr(args.quarantine_id) ?? '',
      installedName: asStr(result?.name) ?? null,
      installed: result?.installed === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.SkillUninstallCard) {
    const props: SkillUninstallCardProps = {
      skillName: asStr(args.name) ?? '',
      removed: result?.removed === true,
      removedSecrets:
        typeof result?.removed_secrets === 'number' ? (result.removed_secrets as number) : null
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.CustomAgentApprovalCard) {
    // 🔴 props = the model's PROPOSAL only (create: full spec; update: partial patch — an absent
    // key stays absent). The update card's "before" is fetched server-side by the component;
    // projecting any "current state" claim from args here would let the model spoof the diff.
    const kind = toolName === 'custom_agent_create' ? ('create' as const) : ('update' as const)
    const props: CustomAgentApprovalCardProps = {
      kind,
      agentId: asStr(kind === 'create' ? args.id : args.agent_id) ?? ''
    }
    if (typeof args.title === 'string') props.title = args.title
    if ('prompt' in args) props.prompt = asStr(args.prompt) ?? null
    if (typeof args.model === 'string') props.model = args.model
    if (typeof args.enabled === 'boolean') props.enabled = args.enabled
    if ('trigger' in args) {
      props.triggerSummary =
        args.trigger === null ? null : summarizeAgentTrigger(asObj(args.trigger))
    }
    const capabilities = asObj(args.capabilities)
    if (capabilities) {
      const parsed: NonNullable<CustomAgentApprovalCardProps['capabilities']> = {}
      const email = asStr(capabilities.email)
      if (email === 'read' || email === 'organize' || email === 'draft') parsed.email = email
      const calendar = asStr(capabilities.calendar)
      if (calendar === 'off' || calendar === 'read' || calendar === 'write') {
        parsed.calendar = calendar
      }
      const knowledge = asStr(capabilities.knowledge)
      if (knowledge === 'off' || knowledge === 'on') parsed.knowledge = knowledge
      const reports = asStr(capabilities.reports)
      if (reports === 'read' || reports === 'produce') parsed.reports = reports
      const web = asStr(capabilities.web)
      if (web === 'off' || web === 'gated' || web === 'open') parsed.web = web
      const files = asStr(capabilities.files)
      if (files === 'off' || files === 'on') parsed.files = files
      if (Object.keys(parsed).length > 0) props.capabilities = parsed
    }
    if (Array.isArray(args.allowed_tools)) props.allowedTools = asStrArray(args.allowed_tools)
    if (typeof args.grant_exec === 'boolean') props.grantExec = args.grant_exec
    const gw = asStr(args.grant_web)
    if (gw === 'off' || gw === 'gated' || gw === 'open') props.grantWeb = gw
    if (Array.isArray(args.skills)) props.skills = asStrArray(args.skills)
    // MCP connector PR3 — per-entry discrimination (mirror of parseConnectorGrants / the zod
    // enum): only exact 'read'|'write'|'update' under a non-empty key survives, so a junk or
    // 'delete' entry can neither reach the card nor be rendered as if it were granted. The KEY
    // presence is preserved even when every entry drops (an explicit `{}` = "clear all" is itself
    // a permission change the owner must see).
    const gc = asObj(args.grant_connectors)
    if (gc) {
      const parsed: Record<string, 'read' | 'write' | 'update'> = {}
      for (const [cid, ceiling] of Object.entries(gc)) {
        if (!cid) continue
        if (ceiling === 'read' || ceiling === 'write' || ceiling === 'update') parsed[cid] = ceiling
      }
      props.connectors = parsed
    }
    if (result) props.applied = result.created === true || result.updated === true
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  if (component === A2UI_COMPONENTS.CalendarApprovalCard) {
    // props = the model's PROPOSAL only (new times / response / target id) — the card fetches the
    // current event facts server-side (SkillInstallConfirmCard / CustomAgentApprovalCard 先例).
    const kind =
      toolName === 'calendar_event_rsvp'
        ? ('rsvp' as const)
        : toolName === 'calendar_event_delete'
          ? ('delete' as const)
          : ('reschedule' as const)
    const props: CalendarApprovalCardProps = {
      kind,
      eventId: asStr(args.event_id) ?? ''
    }
    if (kind === 'reschedule') {
      const scope = asStr(args.scope)
      props.scope = scope === 'occurrence' || scope === 'future' ? scope : ('series' as const)
      props.recurrenceId = asStr(args.recurrence_id) ?? null
      props.newStart = asStr(args.new_start) ?? null
      props.newEnd = asStr(args.new_end) ?? null
      props.timezone = asStr(args.timezone) ?? null
    }
    if (kind === 'rsvp') {
      const r = asStr(args.response)
      if (r === 'accept' || r === 'tentative' || r === 'decline') props.response = r
    }
    if (kind === 'delete') props.calendarName = asStr(args.calendar_name) ?? null
    if (result) {
      props.applied =
        result.rescheduled === true || result.rsvp_sent === true || result.deleted === true
    }
    return {
      protocol: A2UI_PROTOCOL,
      version: A2UI_VERSION,
      component,
      props: props as unknown as Record<string, unknown>,
      audit: { risk: io.risk ?? 'edit', requiresApproval }
    }
  }

  // ApprovalActionCard (flag / archive / pin)
  const props: ApprovalActionCardProps = {
    toolName,
    internalId: asNum(result?.internal_id ?? args.internal_id),
    summary: summarizeAction(toolName, args),
    applied: result ?? null
  }
  return {
    protocol: A2UI_PROTOCOL,
    version: A2UI_VERSION,
    component,
    props: props as unknown as Record<string, unknown>,
    audit: { risk: io.risk ?? 'preview', requiresApproval }
  }
}
