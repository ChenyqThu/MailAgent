// Sprint 13 round 8 user feedback: "AI Summary 和 Suggest Reply 是最
// 重要的". Round 7 collapsed everything into a flat 3-col grid — the
// two cells that read like *actions* (Summary + Reply Suggestion) lost
// their visual hierarchy.  Round 8 brings them back as hero strips at
// the top of the block:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ Header (icon · "AI Fields · N" · Reviewed · model)              │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ ✦ Summary                                                       │
//   │ AI summary, 2-3 lines, coral-tinted hero strip                  │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ ✎ Reply Suggestion                                              │
//   │ Markdown draft, dashed accent border, copy-to-clipboard          │
//   ├─────────────────────────────────────────────────────────────────┤
//   │ Priority · Action · Sender · Category · Project · Urgency       │
//   │ (3-col grid, mockup divider style)                              │
//   └─────────────────────────────────────────────────────────────────┘
//
// Data feed:
//   ai_summary           — LLM labels_json key (was already wired)
//   reply_suggestion_md  — LLM labels_json key.  store.py used to pop
//                          this before saving the audit blob; round 8
//                          stopped stripping it so it survives into
//                          email.aiFields.labels_raw.
//
// Field-name discovery (kept from round 6 / 7 — labels_json key audit):
//   sqlite3 data/sync_store.db "SELECT DISTINCT json_each.key FROM
//   llm_processing, json_each(labels_json)"

import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  BadgeCheck,
  Briefcase,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Copy,
  Cpu,
  FilePenLine,
  Flag,
  MessageSquare,
  Pencil,
  Sparkles,
  Tag,
  User,
  Wand2
} from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { AIFields, AIPriority } from '@shared/api/types'

interface Props {
  fields: AIFields
  /** Sprint 18 follow-up — required by the Reply Suggestion `Craft` button
   *  to call `email.createDraft({ internalId, body })`. EmailDetail passes
   *  `email.internal_id` straight through. */
  internalId: number
}

const PRIORITY_TONE: Record<AIPriority, string> = {
  critical: 'text-crit',
  urgent: 'text-urg',
  important: 'text-impt',
  normal: 'text-norm',
  low: 'text-low'
}
const PRIORITY_DOT: Record<AIPriority, string> = {
  critical: 'bg-crit',
  urgent: 'bg-urg',
  important: 'bg-impt',
  normal: 'bg-norm',
  low: 'bg-low'
}
const PRIORITY_LABEL: Record<AIPriority, string> = {
  critical: 'Critical',
  urgent: 'Urgent',
  important: 'Important',
  normal: 'Normal',
  low: 'Low'
}

function pickString(raw: Record<string, unknown> | null, key: string): string | null {
  if (!raw) return null
  const v = raw[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

type LucideIcon = React.ComponentType<{
  size?: number
  strokeWidth?: number
  className?: string
}>

interface CellSpec {
  label: string
  value: React.ReactNode
  Icon?: LucideIcon
}

// Reply Suggestion content is markdown the LLM wrote (see
// llm_agent/processor.py:185 prompt — "`reply_suggestion_md` 仅在
// action_required=true 时填"). Sprint 18 follow-up bolts on:
//   · collapse toggle (default expanded; chevron flips state)
//   · inline Edit (textarea → Save commits to local state, Copy + Craft
//     pick up the edited copy until the AI re-runs and overwrites markdown)
//   · Craft button — round-trips through email.createDraft to open a
//     Mail.app reply window prefilled with the (possibly edited) body.
function ReplyDraftHero({
  markdown,
  internalId
}: {
  markdown: string
  internalId: number
}): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const [copied, setCopied] = useState(false)
  // Default collapsed — Reply Suggestion is one strip among many on the
  // email detail; user opens it explicitly when they want to act on it.
  const [collapsed, setCollapsed] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editedBody, setEditedBody] = useState(markdown)
  const [crafting, setCrafting] = useState(false)

  // Reset edited body when a fresh AI reply overwrites markdown — but only
  // when the user is NOT actively editing, so an in-progress edit survives
  // a no-op rerender. Mirrors the DraftPreviewCard pattern in chat/MessageList.
  const [lastMarkdown, setLastMarkdown] = useState(markdown)
  if (markdown !== lastMarkdown) {
    setLastMarkdown(markdown)
    if (!editing) setEditedBody(markdown)
  }

  // Effective body for Copy / Craft. We treat any divergence from the
  // original `markdown` as a user edit and stick with it; reverting is
  // available via "Cancel" while editing or by clearing the textarea.
  const effectiveBody = editedBody !== markdown ? editedBody : markdown

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(effectiveBody)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard may be denied in sandbox; the textarea below stays
      // selectable so the user can ⌘C manually.
    }
  }

  const craft = async (): Promise<void> => {
    if (crafting) return
    setCrafting(true)
    try {
      await mailApi.email.createDraft({ internalId, body: effectiveBody })
      toastSuccess(t('chat.draftReply.toast.sendOk'))
    } catch (err) {
      const e = err as { code?: string; message?: string }
      const key =
        e.code === 'E_AUTOMATION_DENIED'
          ? 'chat.draftReply.toast.sendFailAuto'
          : e.code === 'E_MAIL_NOT_RUNNING'
            ? 'chat.draftReply.toast.sendFailMail'
            : e.code === 'E_NO_MAILBOX' || e.code === 'E_NOT_FOUND'
              ? 'chat.draftReply.toast.sendFailNoBin'
              : 'chat.draftReply.toast.sendFailGeneric'
      const detail = e.code ? `${e.code} · ${e.message ?? ''}` : (e.message ?? String(err))
      toastError(t(key), detail)
    } finally {
      setCrafting(false)
    }
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setEditedBody(markdown)
  }
  const saveEdit = (): void => {
    setEditing(false)
  }
  const startEdit = (): void => {
    setEditedBody(effectiveBody)
    setEditing(true)
    setCollapsed(false)
  }

  const actionBtn =
    'inline-flex items-center gap-1 px-2 py-1 rounded text-micro ' +
    'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast ' +
    'disabled:opacity-50 disabled:hover:bg-transparent'

  return (
    <div
      className="aif-reply px-4 py-2.5 border-b border-ink-border"
      style={{
        background: 'rgb(var(--c-accent) / 0.04)',
        boxShadow: 'inset 0 0 0 1px rgb(var(--c-accent) / 0.12)'
      }}
    >
      <div className={cn('flex items-center gap-2', !collapsed && 'mb-1')}>
        {/* Whole title strip is a single click target — chevron + icon +
            caption all flip the collapsed state. Chevron rotates rather
            than swapping ChevronRight/ChevronDown so the vertical
            metrics stay identical between states (was a ~1px header
            jitter on toggle). Negative margins keep the hover halo
            tight without shifting siblings. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={t(collapsed ? 'ai.replySuggestion.expand' : 'ai.replySuggestion.collapse')}
          aria-expanded={!collapsed}
          className={cn(
            // Same vertical box as actionBtn (px-2 py-1) so the row height
            // doesn't change between collapsed (button alone) and expanded
            // (button + Edit/Craft/Copy siblings) states — otherwise the
            // title gets re-centered 2px lower when the taller actionBtn
            // siblings appear.
            'flex items-center gap-2 -ml-2 px-2 py-1 rounded cursor-pointer',
            'hover:bg-coral/10 transition-colors duration-fast'
          )}
        >
          <ChevronDown
            size={12}
            strokeWidth={2.25}
            className={cn(
              'text-coral transition-transform duration-fast',
              collapsed && '-rotate-90'
            )}
          />
          <MessageSquare size={12} strokeWidth={2.25} className="text-coral" />
          <span
            className="text-micro font-mono uppercase tracking-wider text-coral"
            style={{ letterSpacing: '0.08em' }}
          >
            Reply Suggestion
            {editedBody !== markdown && (
              <span className="ml-1 text-ink-fg-2 normal-case">
                · {t('ai.replySuggestion.editedTag')}
              </span>
            )}
          </span>
        </button>
        {!collapsed && (
          <div className="ml-auto flex items-center gap-1">
            {editing ? (
              <>
                <button type="button" onClick={cancelEdit} className={actionBtn}>
                  {t('ai.replySuggestion.cancel')}
                </button>
                <button type="button" onClick={saveEdit} className={actionBtn}>
                  <ClipboardCheck size={12} strokeWidth={2.25} />
                  {t('ai.replySuggestion.save')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  aria-label={t('ai.replySuggestion.edit')}
                  className={actionBtn}
                >
                  <Pencil size={12} strokeWidth={2.25} />
                  {t('ai.replySuggestion.edit')}
                </button>
                <button
                  type="button"
                  onClick={() => void craft()}
                  disabled={crafting || effectiveBody.trim().length === 0}
                  aria-label={t('ai.replySuggestion.craft')}
                  className={actionBtn}
                >
                  <FilePenLine size={12} strokeWidth={2.25} />
                  {t(crafting ? 'ai.replySuggestion.crafting' : 'ai.replySuggestion.craft')}
                </button>
                <button
                  type="button"
                  onClick={() => void copy()}
                  aria-label={t('ai.replySuggestion.copy')}
                  className={actionBtn}
                >
                  {copied ? (
                    <ClipboardCheck size={12} strokeWidth={2.25} />
                  ) : (
                    <Copy size={12} strokeWidth={2.25} />
                  )}
                  {t(copied ? 'ai.replySuggestion.copied' : 'ai.replySuggestion.copy')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {!collapsed &&
        (editing ? (
          <textarea
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            rows={Math.min(Math.max(editedBody.split('\n').length, 5), 16)}
            className={cn(
              'w-full mt-1 px-2 py-1.5 rounded border border-ink-border-soft',
              'bg-ink-2 text-meta text-ink-fg leading-snug font-sans',
              'focus:outline-none focus:border-coral resize-y'
            )}
          />
        ) : (
          <pre
            className={cn(
              'text-meta text-ink-fg leading-snug font-sans whitespace-pre-wrap break-words m-0'
              // Sprint 14 round 14 — no max-height / inner scrollbar; the
              // outer email-pane container is the single scroll surface,
              // long replies push the rest of the page down.
            )}
          >
            {effectiveBody}
          </pre>
        ))}
    </div>
  )
}

export function AIFieldsBlock({ fields, internalId }: Props): React.ReactElement {
  const raw = fields.labels_raw
  const reviewed = fields.ai_review_status === 'reviewed'
  const pending = fields.ai_review_status === 'pending'

  const summary = pickString(raw, 'ai_summary') ?? pickString(raw, 'summary')
  const replyMarkdown =
    pickString(raw, 'reply_suggestion_md') ?? pickString(raw, 'reply_suggestion')
  const category = pickString(raw, 'category')
  const project = pickString(raw, 'related_project') ?? pickString(raw, 'project')
  const senderPriority = pickString(raw, 'sender_priority')
  const urgencyReason = pickString(raw, 'urgency_reason')
  // AI 模型/来源: 优先 fields.ai_model (llm_processing.model 列, 新路径), fallback
  // labels_json.model (老数据兼容; agent 现只写列不写 labels_json → 之前头部空了)。
  const model = fields.ai_model ?? pickString(raw, 'model')
  const actionLabel = actionLabelChinese(fields.ai_action)

  // Secondary classifiers — keep the grid mockup-faithful but trimmed
  // to the high-signal cells the user actually reads.
  const cells: CellSpec[] = []
  if (fields.ai_priority) {
    cells.push({
      label: 'Priority',
      Icon: Flag,
      value: (
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-medium',
            PRIORITY_TONE[fields.ai_priority]
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', PRIORITY_DOT[fields.ai_priority])} />
          {PRIORITY_LABEL[fields.ai_priority]}
        </span>
      )
    })
  }
  if (actionLabel) {
    cells.push({
      label: 'Action',
      Icon: Wand2,
      value: <span className="text-ink-fg">{actionLabel}</span>
    })
  }
  if (senderPriority) {
    cells.push({
      label: 'Sender Priority',
      Icon: User,
      value: (
        <span className="inline-flex items-center gap-1.5 text-impt">
          <span className="w-1.5 h-1.5 rounded-full bg-impt" />
          {senderPriority}
        </span>
      )
    })
  }
  if (category) cells.push({ label: 'Category', Icon: Tag, value: category })
  if (project) cells.push({ label: 'Project', Icon: Briefcase, value: project })
  if (urgencyReason) {
    cells.push({
      label: 'Urgency Reason',
      Icon: AlertTriangle,
      value: <span className="text-urg">{urgencyReason}</span>
    })
  }

  // Total non-empty count surfaced in the header pill.
  const nonNullCount = cells.length + (summary ? 1 : 0) + (replyMarkdown ? 1 : 0)

  return (
    <section
      aria-label="ai-fields"
      className="ai-fields rounded-lg border border-ink-border overflow-hidden"
    >
      {/* Header — icon + "AI Fields · N" + reviewed chip + model name.
          Sprint 14 round 20: tighter — py-2 → py-1.5, chip dropped one
          step to text-[10px], BadgeCheck/Clock icons 10→8px so the
          whole strip reads as a single thin caption bar. */}
      <div className="px-4 py-1.5 bg-ink-2 border-b border-ink-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={12} strokeWidth={2} className="text-info" />
          <span
            className="text-meta font-mono uppercase tracking-wider text-ink-fg-1"
            style={{ letterSpacing: '0.06em' }}
          >
            AI Fields · {nonNullCount}
          </span>
          {(reviewed || pending) && (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wide',
                'leading-none px-1.5 py-[3px] rounded',
                reviewed ? 'text-ok bg-ok/12' : 'text-warn bg-warn/12'
              )}
            >
              {reviewed ? (
                <BadgeCheck size={9} strokeWidth={2.25} />
              ) : (
                <Clock size={9} strokeWidth={2.25} />
              )}
              {reviewed ? 'Reviewed' : 'Pending'}
            </span>
          )}
        </div>
        {model && <div className="text-meta font-mono text-ink-fg-1">{model}</div>}
      </div>

      {/* Summary hero — coral-tinted strip.  This is the single sentence
          the user reads first to decide whether to open the body. */}
      {summary && (
        <div
          className="aif-summary px-4 py-2 border-b border-ink-border"
          style={{ background: 'rgb(var(--c-accent) / 0.06)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={11} strokeWidth={2.25} className="text-coral" />
            <span
              className="text-micro font-mono uppercase tracking-wider text-coral"
              style={{ letterSpacing: '0.08em' }}
            >
              Summary
            </span>
          </div>
          <div className="text-aux text-ink-fg leading-snug">{summary}</div>
        </div>
      )}

      {/* Reply Suggestion hero — accent-ringed draft card with collapse /
          edit / craft (open Mail.app draft) / copy actions. */}
      {replyMarkdown && <ReplyDraftHero markdown={replyMarkdown} internalId={internalId} />}

      {/* Secondary cells — inline 紧凑布局, label·value · pipe · label·value…
          空间不够 flex-wrap 换行. 之前 3-col grid 把每个 cell 撑成 padded box
          视觉太"窒息"; 新版只用一行 px-4 py-2 容器, gap-x-3 分隔 pair, items
          内 label-value 用 gap-1.5 紧靠. whitespace-nowrap 保证 pair 不被拆散. */}
      {cells.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-aux text-ink-fg-1 bg-ink-3">
          {cells.map((cell, idx) => (
            <Fragment key={`${cell.label}-${idx}`}>
              {idx > 0 && (
                <span className="text-ink-fg-3 select-none" aria-hidden>
                  |
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                {cell.Icon && (
                  <cell.Icon size={12} strokeWidth={2} className="text-ink-fg-3 shrink-0" />
                )}
                <span
                  className="text-micro font-mono uppercase tracking-wider text-ink-fg-2"
                  style={{ letterSpacing: '0.08em' }}
                >
                  {cell.label}
                </span>
                {cell.value}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </section>
  )
}
