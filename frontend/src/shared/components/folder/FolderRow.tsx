// Phase C — 存档 / 草稿箱列表行. Sprint 18 视觉重写 → ref/mockup-archive.html
// + mockup-drafts.html 的 .folder-row: 独立 grid (avatar + 三行: 身份 / 主题 /
// 摘要), 比 inbox 的 .email-row 更安静 — 无 thread 折叠 / 无 AI strip / 无 batch
// checkbox。
//
//   草稿 (recipient-led): 身份行 = 「致 收件人」, 空收件人 → 斜体占位; avatar
//     用 blank 铅笔徽。主题空 → 斜体「（无主题）」。
//   存档 (sender-led):    身份行 = 发件人, avatar 用 hue 圆盘。
//
// hover 右下角浮现浮动删除按钮 (mockup .fr-delete); 点击走 onRequestDelete
// (FolderLayout 统一弹 ConfirmDialog + 复用 mailApi.folder.deleteMsg)。
// 数据契约只用 FolderEmailMeta (无 AI / 无 thread / 无已读态)。

import { memo, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip, Pencil, Trash2 } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR, gsap, useGSAP } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { parseSender, cleanSnippet } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { FolderEmailMeta } from '@shared/api/types'

interface Props {
  email: FolderEmailMeta
  selected: boolean
  onSelect(): void
  /** hover 浮动删除 — 不传则不渲染该按钮 (FolderLayout 注入). */
  onRequestDelete?: () => void
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
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1.5} aria-hidden>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" y1="22" x2="4" y2="15" />
  </svg>
)

function FolderRowInner({ email, selected, onSelect, onRequestDelete }: Props): React.ReactElement {
  const { t } = useTranslation()
  const isDrafts = email.folder === 'drafts'

  // 挂载淡入 — folder 列表非虚拟, 但归档/删除走 react-query invalidate→refetch,
  // 行从 data 移除即被父级 unmount, 无法在行内延迟卸载做 collapse 退场 (需把移除
  // 队列上提到 FolderList 并 diff query data, 属重构父级数据流, 超出微交互范畴)。
  // 故保守只做挂载 autoAlpha 淡入, 不碰父级移除链路。reduced-motion no-op。
  const rowRef = useRef<HTMLElement>(null)
  const reduce = useReducedMotion()
  useGSAP(
    () => {
      if (reduce || !rowRef.current) return
      gsap.from(rowRef.current, { autoAlpha: 0, duration: DUR.base })
    },
    { dependencies: [reduce], scope: rowRef }
  )

  // 草稿: sender 是自己, To 才是关键 — 身份行展示收件人。存档: 展示发件人。
  const recipientParsed = parseSender(email.to_addr)
  const senderParsed = parseSender(email.sender)
  const recipientName = recipientParsed.name || recipientParsed.email || email.to_addr || ''
  const senderName =
    email.sender_name || senderParsed.name || senderParsed.email.split('@')[0] || ''

  const hasRecipient = isDrafts && recipientName.trim().length > 0
  const snippet = cleanSnippet(email.snippet)
  const hasSubject = email.subject.trim().length > 0

  // avatar — 草稿无收件人时用 blank 铅笔徽, 否则按身份 hash 取 hue 圆盘。
  const showBlankAvatar = isDrafts && !hasRecipient
  const identitySeed = isDrafts
    ? email.to_addr || String(email.id)
    : email.sender || String(email.id)
  const slot = avatarSlot(identitySeed)
  const initials = avatarInitials(isDrafts ? recipientName : senderName)

  const handleKey = useCallback(
    (evt: React.KeyboardEvent) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return
      evt.preventDefault()
      onSelect()
    },
    [onSelect]
  )

  const handleDelete = useCallback(
    (evt: React.MouseEvent) => {
      evt.stopPropagation()
      onRequestDelete?.()
    },
    [onRequestDelete]
  )

  return (
    <article
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKey}
      data-folder-id={email.id}
      data-flag={email.is_flagged ? 'flagged' : 'none'}
      className={cn('folder-row', selected && 'is-selected')}
    >
      {showBlankAvatar ? (
        <span className="folder-avatar folder-avatar-blank" aria-hidden>
          <Pencil size={15} strokeWidth={1.9} />
        </span>
      ) : (
        <span className={cn('folder-avatar', `avatar-${slot}`)} aria-hidden>
          {initials}
        </span>
      )}

      <div className="fr-body">
        <div className="fr-top">
          <span className="fr-sender">
            {isDrafts ? (
              hasRecipient ? (
                <>
                  <span className="to-prefix">{t('folder.row.toPrefix')} </span>
                  {recipientName}
                </>
              ) : (
                <span className="to-none">{t('folder.row.noRecipient')}</span>
              )
            ) : (
              senderName || senderParsed.email || t('folder.row.unknownSender')
            )}
          </span>
          <span className="fr-time">{shortTime(email.date_received)}</span>
        </div>

        <div className={cn('fr-subject', !hasSubject && 'is-empty')}>
          {hasSubject ? email.subject : t('folder.row.noSubject')}
        </div>

        <div className="fr-snippet">
          <span className="fr-text">{snippet ?? ' '}</span>
          <span className="fr-marks">
            {email.has_attachments && (
              <Paperclip size={13} strokeWidth={2} aria-label={t('folder.attachments')} />
            )}
            {email.is_flagged && (
              <span className="mk-flag inline-grid place-items-center w-3 h-3" aria-label="Flagged">
                {flagSvg}
              </span>
            )}
          </span>
        </div>
      </div>

      {onRequestDelete && (
        <button
          type="button"
          className="fr-delete"
          title={isDrafts ? t('folder.toolbar.delete') : t('folder.toolbar.deletePermanent')}
          aria-label={isDrafts ? t('folder.toolbar.delete') : t('folder.toolbar.deletePermanent')}
          onClick={handleDelete}
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      )}
    </article>
  )
}

function propsEqual(prev: Props, next: Props): boolean {
  if (prev.selected !== next.selected) return false
  if (prev.onSelect !== next.onSelect) return false
  if (prev.onRequestDelete !== next.onRequestDelete) return false
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
