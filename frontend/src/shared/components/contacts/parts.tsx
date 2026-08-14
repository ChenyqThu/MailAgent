// 通讯录行/档案头的身份信号小件（设计 §3 组件清单：TwoWayBar / KindPip /
// SelfPip / HiddenPip / LockPill / SecHead）。全部 v3 token，圆角只用四档。
//
// 🔴 图标纪律（对齐批 2026-08-13）：原型 `cui.jsx` 给 KindPip/SelfPip 传的
// `bot` / `megaphone` / `usercheck` 在 `helpers.jsx::ICON_PATHS` 里**没有 path**，
// `Icon` 对未知 name 渲染空 svg —— 即 owner 在 Contacts.html 里看到的就是「只有
// 文字、没有图标」。故这三个 pip 不补图标；`eyeoff` 有 path、真渲染，HiddenPip
// 照原型带图标。

import { EyeOff, Lock, LockOpen } from 'lucide-react'
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
      className={cn('block h-[3px] overflow-hidden rounded-full bg-ink-fg/10', className)}
    >
      <span
        className="block h-full rounded-full bg-coral/85"
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  )
}

type PipTone = 'neutral' | 'ok' | 'info'

/** 原型 `ui.jsx::Pip size="sm"`（10.5px / 2px 5px / 细描边）的仓库映射：
 *  圆角走仓库 pill 惯例（v3 四档圆角里没有 5px 档）。 */
export function ContactPip({
  tone = 'neutral',
  icon,
  children,
  className
}: {
  tone?: PipTone
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-micro leading-4',
        // 语义调的底/边比例照原型 `ui.jsx::Pip`（底 12% / 边 25%）。
        tone === 'ok'
          ? 'border-ok/25 bg-ok/[0.12] text-ok'
          : tone === 'info'
            ? 'border-info/25 bg-info/[0.12] text-info'
            : 'border-ink-border bg-ink-fg/[0.05] text-ink-fg-1',
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function KindPip({ kind }: { kind: ContactKind }): React.ReactElement | null {
  const { t } = useTranslation()
  if (kind === 'person') return null
  // 原型 `cui.jsx::KindPip`：list = info 调，robot = neutral 调。
  return (
    <ContactPip tone={kind === 'list' ? 'info' : 'neutral'}>{t(`contacts.kind.${kind}`)}</ContactPip>
  )
}

export function SelfPip(): React.ReactElement {
  const { t } = useTranslation()
  return <ContactPip tone="ok">{t('contacts.badge.self')}</ContactPip>
}

export function HiddenPip(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ContactPip icon={<EyeOff size={9.5} aria-hidden />}>{t('contacts.badge.hidden')}</ContactPip>
  )
}

/** 详情页分区头（原型 `cui.jsx::SecHead`）：标题 + 计数 + 一根填满余宽的细线。 */
export function SecHead({
  title,
  count,
  right,
  className
}: {
  title: string
  count?: number | string
  right?: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div className={cn('mb-2.5 flex items-center gap-2', className)}>
      <h3 className="shrink-0 text-meta font-semibold tracking-[-0.01em] text-ink-fg">{title}</h3>
      {count !== undefined ? (
        <span className="shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">{count}</span>
      ) : null}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-ink-border-soft" />
      {right}
    </div>
  )
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
          ? 'border-ink-border bg-ink-fg/[0.05] text-ink-fg-1 hover:bg-ink-fg/[0.09]'
          : 'border-transparent bg-transparent text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg-1'
      )}
    >
      {locked ? <Lock size={9.5} /> : <LockOpen size={9.5} />}
      {locked ? t('contacts.detail.locked') : t('contacts.detail.unlocked')}
    </button>
  )
}
