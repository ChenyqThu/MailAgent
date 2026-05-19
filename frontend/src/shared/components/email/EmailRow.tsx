// Sprint 12 — Outlook-inspired row per mockup-inbox.html lines 1573-2027.
// Layout: 32px avatar (or cb checkbox in batch mode) + grid 1fr content
// (sender-line / subject-row / body-preview / ai-strip). Row state is
// data-attribute driven so the authored CSS in index.css (.email-row
// [data-read=…] / [data-flag=…] / [data-priority=…]) handles every state
// wash without per-state JSX branches.
//
// Sprint 12.5 (this revision): real action wiring
//   • cb checkbox visible in batch mode (CSS-gated via body[data-batch-mode]).
//   • ricon-flag → 3-state cycle (none → flagged → done) via notion.updateFlag.
//   • ricon-pin → toggles SQLite-backed pinned set via useTogglePin (v8).
//   • ricon-delete → marks processing_status='已完成' (archive semantics).
//
// CSS class names are the contract — see index.css Sprint 12 block.

import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { actionLabelChinese } from '@shared/lib/ai_labels'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useTogglePin } from '@shared/hooks/usePinnedSync'
import { useBatch } from '@shared/state/batch'
import { usePinned } from '@shared/state/pinned'
import { toastError } from '@shared/state/toast'
import type { EnrichedEmailMeta, AIPriority } from '@shared/api/types'

interface Props {
  email: EnrichedEmailMeta
  selected: boolean
  /** Set when 5s polling notices this id appeared after the prior poll. */
  isNew?: boolean
  onSelect(): void
}

const PRIORITY_SLUG: Record<AIPriority, 'crit' | 'urg' | 'impt' | 'norm' | 'low'> = {
  critical: 'crit',
  urgent: 'urg',
  important: 'impt',
  normal: 'norm',
  low: 'low'
}
const PRIORITY_UPPER: Record<AIPriority, string> = {
  critical: 'CRITICAL',
  urgent: 'URGENT',
  important: 'IMPORTANT',
  normal: 'NORMAL',
  low: 'LOW'
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

// djb2 hash for deterministic avatar slot selection (1..6).
function avatarSlot(seed: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = (hash * 33) ^ seed.charCodeAt(i)
  return (((hash >>> 0) % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6
}

function avatarInitials(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  if (/[一-鿿]/.test(t)) return t.slice(0, 2)
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase()
}

const flagSvg = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" y1="22" x2="4" y2="15" />
  </svg>
)
const doneSvg = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
)
const pinSvg = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 4v6.59l3.71 3.71A1 1 0 0 1 19 16h-6v5l-1 1-1-1v-5H5a1 1 0 0 1-.71-1.71L8 10.59V4a1 1 0 0 1-1-1V2h10v1a1 1 0 0 1-1 1z" />
  </svg>
)
const attachSvg = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)
// ❗️ 同款线性 icon —— 圆形外框 + 感叹号竖线 + 底部实心点（AlertCircle 风格）。
// 与之前的三角形 warning 区分：圆形传递的是「重要邮件」语义而非「⚠️ 警告」。
const importantSvg = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="7" x2="12" y2="13" />
    <circle cx="12" cy="17" r="1" stroke="none" fill="currentColor" />
  </svg>
)
const deleteSvg = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
)

export function EmailRow({ email, selected, isNew, onSelect }: Props): React.ReactElement {
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const batchMode = useBatch((s) => s.mode)
  const batchToggle = useBatch((s) => s.toggle)
  const batchIsSelected = useBatch((s) => s.selectedIds.includes(email.internal_id))
  const pinned = usePinned((s) => s.pinned.includes(email.internal_id))
  const togglePin = useTogglePin()

  const unread = !email.is_read
  const isDone = email.sync_status === 'deleted' // archived / completed sentinel
  const isFlagged = email.is_flagged && !isDone
  const failed = email.sync_status === 'failed' || email.sync_status === 'dead_letter'
  const parsed = parseSender(email.sender)
  const senderName = email.sender_name || parsed.name || parsed.email.split('@')[0] || ''
  const senderEmail = parsed.email
  const snippet = cleanSnippet(email.snippet)
  const actionLabel = actionLabelChinese(email.ai_action)

  // 「❗ 重要」语义现在来自邮件原生 Importance / X-Priority 头部
  // （reader._parse_importance → email_metadata.is_important）。
  // ai_priority 仍然驱动 data-priority 颜色 wash，但不参与 ❗ 判定 —— 这两条
  // 信号互相独立：发件人主动标 high priority vs LLM 推断的紧急度。
  const important = email.is_important === true

  const slot = avatarSlot(email.sender || String(email.internal_id))
  const initials = avatarInitials(senderName || senderEmail)

  const aiStripVisible = Boolean(email.ai_priority || actionLabel || failed || isNew)

  // Flag state for the .ricon-flag[data-flag-state=...] CSS hook.
  // 0 = none, 1 = flagged (coral), 2 = done (green check).
  const flagState: '0' | '1' | '2' = isDone ? '2' : isFlagged ? '1' : '0'
  const flagSvgEl = flagState === '2' ? doneSvg : flagSvg

  // Row-level click — batch toggle in batch mode, otherwise standard select.
  const handleRowClick = useCallback(() => {
    if (batchMode === 'on') batchToggle(email.internal_id)
    else onSelect()
  }, [batchMode, batchToggle, email.internal_id, onSelect])

  const handleRowKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return
      evt.preventDefault()
      handleRowClick()
    },
    [handleRowClick]
  )

  // Write actions — every one stops propagation so the parent row doesn't
  // also fire select / toggle on the same click.
  const stopAnd = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    handler()
  }

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['emails'] })
  }, [queryClient])

  const handleFlagClick = useCallback(async () => {
    try {
      if (flagState === '0') {
        // none → flagged
        await mailApi.notion.updateFlag(email.internal_id, { isFlagged: true })
      } else if (flagState === '1') {
        // flagged → done (clear flag + processing_status=已完成)
        await mailApi.notion.updateFlag(email.internal_id, {
          isFlagged: false,
          processingStatus: '已完成'
        })
      } else {
        // done → none (clear processing — write empty processing isn't supported,
        // we just toggle flag back; the user can clear status in Notion).
        await mailApi.notion.updateFlag(email.internal_id, { isFlagged: false })
      }
      await invalidate()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError('Flag toggle failed', msg)
    }
  }, [email.internal_id, flagState, invalidate, mailApi])

  const handleDeleteClick = useCallback(async () => {
    try {
      await mailApi.notion.updateFlag(email.internal_id, {
        isFlagged: false,
        processingStatus: '已完成'
      })
      await invalidate()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError('Archive failed', msg)
    }
  }, [email.internal_id, invalidate, mailApi])

  const cbClass = useMemo(() => cn('cb', batchIsSelected && 'cb-on'), [batchIsSelected])

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={handleRowKey}
      data-internal-id={email.internal_id}
      data-read={String(!unread)}
      data-flag={flagState === '2' ? 'done' : flagState === '1' ? 'flagged' : 'none'}
      data-pinned={String(pinned)}
      data-important={String(important)}
      data-priority={email.ai_priority ? PRIORITY_SLUG[email.ai_priority] : 'norm'}
      className={cn('row email-row', selected && 'is-selected')}
    >
      {/* Batch checkbox — visible when body[data-batch-mode='true']. */}
      <span
        className={cbClass}
        role="checkbox"
        aria-checked={batchIsSelected}
        aria-hidden={batchMode === 'off'}
      />
      <span className={cn('avatar', `avatar-${slot}`)} aria-hidden>
        {initials}
      </span>

      <div className="row-content">
        <div className="row-top">
          <span className="sender-line">
            <span className="sender-name">{senderName || senderEmail || '(unknown sender)'}</span>
            {senderEmail && senderName && <span className="recipient-hint">, {senderEmail}</span>}
            {email.lang === 'en' && (
              <>
                {' '}
                <span className="lang-pip" aria-label="English">
                  EN
                </span>
              </>
            )}
          </span>
          <span className="row-time">{shortTime(email.date_received)}</span>
        </div>

        <div className="subject-row">
          <span className="subject-text">{email.subject || '(no subject)'}</span>
          <span className="row-actions">
            <button
              type="button"
              className="ricon ricon-flag"
              data-flag-state={flagState}
              aria-label="Toggle flag"
              onClick={stopAnd(() => void handleFlagClick())}
            >
              {flagSvgEl}
            </button>
            <button
              type="button"
              className="ricon ricon-pin"
              aria-pressed={pinned}
              aria-label="Toggle pin"
              onClick={stopAnd(() => {
                void togglePin(email.internal_id)
              })}
            >
              {pinSvg}
            </button>
            {email.attach_count > 0 && (
              <span
                className="ricon ricon-attach"
                aria-label={`${email.attach_count} attachment${email.attach_count > 1 ? 's' : ''}`}
              >
                {attachSvg}
              </span>
            )}
            {important && (
              <span className="ricon ricon-important" aria-label="Important">
                {importantSvg}
              </span>
            )}
            <button
              type="button"
              className="ricon ricon-delete"
              aria-label="Archive"
              onClick={stopAnd(() => void handleDeleteClick())}
            >
              {deleteSvg}
            </button>
          </span>
        </div>

        {snippet && <div className="body-preview">{snippet}</div>}

        {aiStripVisible && (
          <div className="ai-strip">
            {email.ai_priority && (
              <>
                <span className="pdot" aria-hidden />
                <span className="pname">{PRIORITY_UPPER[email.ai_priority]}</span>
              </>
            )}
            {actionLabel && (
              <>
                {email.ai_priority && <span className="sep">·</span>}
                <span className="ai-reply ai-bit" title={email.ai_action ?? undefined}>
                  {actionLabel}
                </span>
              </>
            )}
            {failed && (
              <>
                {(email.ai_priority || actionLabel) && <span className="sep">·</span>}
                <span className="ai-failed ai-bit">SYNC FAILED</span>
              </>
            )}
            {isNew && (
              <>
                {(email.ai_priority || actionLabel || failed) && <span className="sep">·</span>}
                <span className="ai-bit" style={{ color: 'rgb(var(--c-accent))' }}>
                  NEW
                </span>
              </>
            )}
            {email.attach_count > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-ink-fg-3">
                <Paperclip size={10} strokeWidth={2} />
                <span className="tabular-nums">{email.attach_count}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
