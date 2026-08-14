// 通讯录行/档案头的身份信号小件（设计 §3 组件清单：TwoWayBar / KindPip /
// SelfPip / HiddenPip / LockPill）。全部 v3 token，圆角只用四档。

import { Lock, LockOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import type { ContactKind } from '@shared/api/types/contact'

/** 双向条（3px 细条，填充比 = 我发出 / 总往来）——「认识的人」的唯一视觉信号。 */
export function TwoWayBar({
  sent,
  total,
  className
}: {
  sent: number
  total: number
  className?: string
}): React.ReactElement {
  const ratio = total > 0 ? Math.min(1, sent / total) : 0
  return (
    <span
      aria-hidden
      className={cn('block h-[3px] w-full overflow-hidden rounded-full bg-ink-3', className)}
    >
      <span
        className="block h-full rounded-full bg-coral/70"
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  )
}

function pipClass(tone: 'neutral' | 'green'): string {
  return cn(
    'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-micro leading-4',
    tone === 'green'
      ? 'border-ok/40 bg-ok/10 text-ok'
      : 'border-ink-border bg-ink-2 text-ink-fg-2'
  )
}

export function KindPip({ kind }: { kind: ContactKind }): React.ReactElement | null {
  const { t } = useTranslation()
  if (kind === 'person') return null
  return <span className={pipClass('neutral')}>{t(`contacts.kind.${kind}`)}</span>
}

export function SelfPip(): React.ReactElement {
  const { t } = useTranslation()
  return <span className={pipClass('green')}>{t('contacts.badge.self')}</span>
}

export function HiddenPip(): React.ReactElement {
  const { t } = useTranslation()
  return <span className={pipClass('neutral')}>{t('contacts.badge.hidden')}</span>
}

/** 字段行尾的锁 pill（已锁定 / 未锁定，点击切换）。 */
export function LockPill({
  locked,
  onToggle,
  disabled
}: {
  locked: boolean
  onToggle: () => void
  disabled?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      title={locked ? t('contacts.detail.lockHint') : t('contacts.detail.editHint')}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-micro leading-4 transition-colors',
        locked
          ? 'border-coral/40 bg-coral/10 text-coral hover:bg-coral/15'
          : 'border-ink-border bg-transparent text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-1'
      )}
    >
      {locked ? <Lock size={10} /> : <LockOpen size={10} />}
      {locked ? t('contacts.detail.locked') : t('contacts.detail.unlocked')}
    </button>
  )
}
