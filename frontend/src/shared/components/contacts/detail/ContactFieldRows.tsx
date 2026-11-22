import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mars, Minus, MoreHorizontal, Venus } from 'lucide-react'

import { CONTACT_GENDER_VALUES } from '@shared/api/types/contact'
import type {
  ContactEmailDto,
  ContactGender,
  ContactLockableField
} from '@shared/api/types/contact'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { cn } from '@shared/lib/cn'
import { toastSuccess } from '@shared/state/toast'

import { FIELD_LABEL_KEY, fmtContactMonth } from '../contactFields'
import { ContactPip, LockPill } from '../parts'

// ── 字段行（点击即编辑 → PATCH 落锁；行尾锁 pill 可切换）──────────────────────

export function FieldRow({
  field,
  value,
  locked,
  onSave,
  onToggleLock
}: {
  field: ContactLockableField
  value: string | null
  locked: boolean
  onSave(next: string): void
  onToggleLock(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const commit = (): void => {
    setEditing(false)
    if (draft.trim() !== (value ?? '')) onSave(draft.trim())
  }
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-16 shrink-0 text-meta text-ink-fg-2">{t(FIELD_LABEL_KEY[field])}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(false)
          }}
          className="h-7 min-w-0 flex-1 rounded-[var(--r-ctl)] border border-coral/50 bg-ink-1 px-2 text-body text-ink-fg outline-none"
        />
      ) : (
        <button
          type="button"
          title={t('contacts.detail.editHint')}
          onClick={() => {
            setDraft(value ?? '')
            setEditing(true)
          }}
          className="min-w-0 flex-1 truncate rounded-[var(--r-ctl)] px-1 py-0.5 text-left text-body text-ink-fg hover:bg-ink-3"
        >
          {value || <span className="text-ink-fg-3">—</span>}
        </button>
      )}
      <LockPill locked={locked} onToggle={onToggleLock} />
    </div>
  )
}

// ── 枚举行（职能 / 职级 = chips 选择）─────────────────────────────────────────

export function EnumRow({
  field,
  value,
  values,
  locked,
  labelOf,
  onSave,
  onToggleLock
}: {
  field: ContactLockableField
  value: string | null
  values: readonly string[]
  locked: boolean
  labelOf(value: string): string
  onSave(next: string | null): void
  onToggleLock(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="w-16 shrink-0 text-meta text-ink-fg-2">{t(FIELD_LABEL_KEY[field])}</span>
        <button
          type="button"
          onClick={() => setOpen((next) => !next)}
          className="min-w-0 flex-1 truncate rounded-[var(--r-ctl)] px-1 py-0.5 text-left text-body text-ink-fg hover:bg-ink-3"
        >
          {value ? labelOf(value) : <span className="text-ink-fg-3">—</span>}
        </button>
        <LockPill locked={locked} onToggle={onToggleLock} />
      </div>
      {open ? (
        <div className="ml-[74px] mt-1.5 flex flex-wrap gap-1.5">
          {values.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setOpen(false)
                if (candidate !== value) onSave(candidate)
              }}
              className={cn(
                'rounded-full border px-[9px] py-[3px] text-meta leading-4 transition-colors duration-fast ease-standard',
                candidate === value
                  ? 'border-coral/30 bg-coral/10 text-coral'
                  : 'border-ink-border text-ink-fg-2 hover:bg-ink-fg/[0.06]'
              )}
            >
              {labelOf(candidate)}
            </button>
          ))}
          {value ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onSave(null)
              }}
              className="rounded-full border border-ink-border px-[9px] py-[3px] text-meta leading-4 text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06]"
            >
              {t('contacts.enum.clear')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── 性别行（三态图标 segmented）─────────────────────────────────────────────

/** `null`（未知）在 SegmentedControl 里没法当值 —— 它是 `T extends string` 的泛型。
 *  用一个只活在控件里的哨兵段，进出各转一次。 */
const GENDER_SEGMENTS = ['unset', ...CONTACT_GENDER_VALUES] as const
type GenderSegment = (typeof GENDER_SEGMENTS)[number]

const GENDER_SEGMENT_ICON: Record<GenderSegment, typeof Minus> = {
  unset: Minus,
  male: Mars,
  female: Venus
}

/** 性别行。owner 拍板要**图标按钮切换**而不是下拉 → 复用仓库统一的 SegmentedControl
 *  （v0.7.2 dogfood 收敛出来的那一个），三段 = 未设置 / 男 / 女，点一下就 PATCH。
 *
 *  🔴 gender **不参与字段锁**（后端 `CONTACT_LOCKABLE_FIELDS` 里没有它，已豁免）
 *  → 本行不渲染 LockPill；对应地 patch 的 onSuccess 也不能把它算进「已保存并锁定」。
 *  🔴 图标是唯一的可见内容 → 每段都带 `ariaLabel`（SegmentedControl 会落到按钮的
 *  aria-label 上），否则读屏念出来是三个空按钮。 */
export function GenderRow({
  value,
  onChange
}: {
  value: ContactGender | null
  onChange(next: ContactGender | null): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="w-16 shrink-0 text-meta text-ink-fg-2">{t('contacts.field.gender')}</span>
      <SegmentedControl<GenderSegment>
        ariaLabel={t('contacts.field.gender')}
        value={value ?? 'unset'}
        onChange={(next) => onChange(next === 'unset' ? null : next)}
        options={GENDER_SEGMENTS.map((segment) => {
          const Icon = GENDER_SEGMENT_ICON[segment]
          return {
            value: segment,
            label: <Icon size={13} aria-hidden />,
            ariaLabel: t(`contacts.gender.${segment}`)
          }
        })}
      />
    </div>
  )
}

// ── 邮箱锚点行 ────────────────────────────────────────────────────────────────

export function EmailAnchorRow({
  email,
  locale,
  onSetPrimary,
  onSetFormer
}: {
  email: ContactEmailDto
  locale: string
  onSetPrimary(address: string): void
  onSetFormer(address: string, former: boolean): void
}): React.ReactElement {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const former = email.former_at != null
  const range =
    email.first_seen_at != null && email.last_seen_at != null
      ? t('contacts.email.meta', {
          n: email.mail_count,
          from: fmtContactMonth(email.first_seen_at, locale),
          to: fmtContactMonth(email.last_seen_at, locale)
        })
      : undefined
  const items: PopmenuItem[] = [
    {
      kind: 'action',
      id: 'primary',
      label: t(former ? 'contacts.email.setPrimaryRestore' : 'contacts.email.setPrimary'),
      onSelect: () => onSetPrimary(email.address)
    },
    {
      kind: 'action',
      id: 'former',
      label: t(former ? 'contacts.email.unformer' : 'contacts.email.former'),
      onSelect: () => onSetFormer(email.address, !former)
    },
    {
      kind: 'action',
      id: 'copy',
      label: t('contacts.email.copy'),
      onSelect: () => {
        void navigator.clipboard?.writeText(email.address)
        toastSuccess(t('contacts.email.copied', { email: email.address }))
      }
    }
  ]
  // 原型 `cdetail.jsx::IdentitySection`：单行卡片（地址占余宽不被挤压），
  // 主邮箱 = accent 淡描边 · 曾用 = 虚线 + 整体压暗 + 地址删除线。
  return (
    <div
      className={cn(
        'relative flex items-center gap-2.5 rounded-[var(--r-row)] border bg-ink-2 px-2.5 py-2',
        email.is_primary ? 'border-coral/25' : 'border-ink-border',
        former && 'border-dashed opacity-[0.72]'
      )}
      title={range}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-meta text-ink-fg',
          former && 'line-through decoration-ink-fg-3'
        )}
      >
        {email.address}
      </span>
      {email.is_primary ? <ContactPip>{t('contacts.email.primary')}</ContactPip> : null}
      {former ? <ContactPip>{t('contacts.email.formerPip')}</ContactPip> : null}
      <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
        {email.mail_count}
      </span>
      {!email.is_primary ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-label={t('contacts.row.more')}
            onClick={() => setMenuOpen((open) => !open)}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--r-ctl)] text-ink-fg-3 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.08] hover:text-ink-fg-1"
          >
            <MoreHorizontal size={13} />
          </button>
          <Popmenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            ariaLabel={t('contacts.row.more')}
            items={items}
            triggerRef={triggerRef}
            align="end"
            width={240}
          />
        </>
      ) : null}
    </div>
  )
}
