// Phase C — 存档 / 草稿箱列表行. 复用 EmailRow 的 .email-row 视觉 (authored
// CSS in renderer/index.css), 但精简: 无 thread 折叠 / 无 AI strip / 无 batch
// checkbox / 无 flag·pin·delete 行内操作 (这些是 inbox 专属). 只渲染 avatar +
// sender + subject + 时间 + snippet + 附件角标 + flag 角标 (只读)。
//
// grid 列对齐靠保留空的 .thread-chevron-cell (col 1) + .avatar (col 2) +
// .row-content (col 3), 跟 EmailRow 完全一致, 这样视觉与收件箱一致。

import { memo, useCallback } from 'react'
import { Paperclip } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { FolderEmailMeta } from '@shared/api/types'

interface Props {
  email: FolderEmailMeta
  selected: boolean
  onSelect(): void
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

// djb2 hash for deterministic avatar slot selection (1..6). Mirrors
// EmailRow.tsx avatarSlot — kept local since EmailRow doesn't export it.
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
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" y1="22" x2="4" y2="15" />
  </svg>
)
const attachSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

function FolderRowInner({ email, selected, onSelect }: Props): React.ReactElement {
  // 草稿箱: sender 通常是自己, To 才是关键 — 展示 To 让用户知道发给谁。
  // 存档: 跟收件箱一样展示发件人。
  const isDrafts = email.folder === 'drafts'
  const parsed = parseSender(isDrafts ? email.to_addr : email.sender)
  const primaryName = isDrafts
    ? parsed.name || parsed.email || '(无收件人)'
    : email.sender_name || parsed.name || parsed.email.split('@')[0] || '(unknown sender)'
  const primaryEmail = parsed.email
  const snippet = cleanSnippet(email.snippet)

  const slot = avatarSlot(email.sender || email.to_addr || String(email.id))
  const initials = avatarInitials(primaryName || primaryEmail)

  const handleKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return
      evt.preventDefault()
      onSelect()
    },
    [onSelect]
  )

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKey}
      data-folder-id={email.id}
      data-read="true"
      data-flag={email.is_flagged ? 'flagged' : 'none'}
      className={cn('row email-row', selected && 'is-selected')}
    >
      {/* col 1 — empty chevron cell, 仅占位让 grid 与收件箱列对齐 */}
      <span className="thread-chevron-cell" aria-hidden />
      <span className={cn('avatar', `avatar-${slot}`)} aria-hidden>
        {initials}
      </span>

      <div className="row-content">
        <div className="row-top">
          <span className="sender-line">
            <span className="sender-name">{primaryName}</span>
            {isDrafts && (
              <span className="recipient-hint"> · {primaryEmail || email.to_addr || '—'}</span>
            )}
            {!isDrafts && primaryEmail && email.sender_name && (
              <span className="recipient-hint">, {primaryEmail}</span>
            )}
          </span>
          <span className="row-time">{shortTime(email.date_received)}</span>
        </div>

        <div className="subject-row">
          <span className="subject-text">{email.subject || '(no subject)'}</span>
          <span className="row-actions inline-flex items-center gap-1 shrink-0">
            {email.is_flagged && (
              <span
                className="ricon ricon-flag inline-grid place-items-center w-[15px] h-[15px] text-coral"
                aria-label="Flagged"
              >
                {flagSvg}
              </span>
            )}
            {email.has_attachments && (
              <span
                className="ricon ricon-attach inline-grid place-items-center w-[15px] h-[15px] text-ink-fg-3"
                aria-label="Has attachments"
              >
                {attachSvg}
              </span>
            )}
          </span>
        </div>

        {snippet && <div className="body-preview">{snippet}</div>}

        {email.has_attachments && (
          <div className="mt-1 flex items-center gap-1 text-meta font-mono text-ink-fg-3">
            <Paperclip size={10} strokeWidth={2} />
            <span className="tabular-nums">{email.attachments.length || 1}</span>
          </div>
        )}
      </div>
    </article>
  )
}

function propsEqual(prev: Props, next: Props): boolean {
  if (prev.selected !== next.selected) return false
  if (prev.onSelect !== next.onSelect) return false
  const a = prev.email
  const b = next.email
  if (a === b) return true
  return (
    a.id === b.id &&
    a.is_flagged === b.is_flagged &&
    a.has_attachments === b.has_attachments &&
    a.subject === b.subject &&
    a.sender === b.sender &&
    a.sender_name === b.sender_name &&
    a.to_addr === b.to_addr &&
    a.snippet === b.snippet &&
    a.date_received === b.date_received
  )
}

export const FolderRow = memo(FolderRowInner, propsEqual)
