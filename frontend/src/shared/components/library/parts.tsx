// 资料库内容区的小件（mockup `parts/kit.tsx` 里进产品的那几件：Pill / Notice / 三种状态徽标）。
// 颜色一律 token（亮暗都成立），样式逐属性对齐原型。

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Info } from 'lucide-react'

import type { LibraryFile } from '@shared/api/types/library'
import { cn } from '@shared/lib/cn'

import { sourceTone, trashDaysLeft } from './fileMeta'

export type PillTone = 'ink' | 'accent' | 'ok' | 'warn' | 'fail' | 'info' | 'ai'

export function Pill({
  tone = 'ink',
  children,
  title,
  className
}: {
  tone?: PillTone
  children: ReactNode
  title?: string
  className?: string
}): React.ReactElement {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-micro font-medium',
        tone === 'ink' && 'bg-ink-4 text-ink-fg-2',
        tone === 'accent' && 'bg-coral/15 text-coral',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'fail' && 'bg-fail/15 text-fail',
        tone === 'info' && 'bg-info/15 text-info',
        tone === 'ai' && 'bg-ai/15 text-ai',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Notice({
  tone = 'info',
  children,
  className
}: {
  tone?: 'info' | 'warn' | 'fail'
  children: ReactNode
  className?: string
}): React.ReactElement {
  const Icon = tone === 'info' ? Info : AlertTriangle
  return (
    <div
      role={tone === 'info' ? undefined : 'alert'}
      className={cn(
        'flex items-start gap-2 rounded-[var(--r-ctl)] border px-2.5 py-1.5 text-meta leading-relaxed',
        tone === 'info' && 'border-info/25 bg-info/[0.07] text-ink-fg-1',
        tone === 'warn' && 'border-warn/30 bg-warn/[0.07] text-ink-fg-1',
        tone === 'fail' && 'border-fail/30 bg-fail/[0.07] text-ink-fg-1',
        className
      )}
    >
      <Icon
        size={13}
        strokeWidth={2}
        aria-hidden
        className={cn(
          'mt-0.5 shrink-0',
          tone === 'info' && 'text-info',
          tone === 'warn' && 'text-warn',
          tone === 'fail' && 'text-fail'
        )}
      />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** text_status 徽标：只露异常态（pending / failed / unsupported），extracted 不显示（mockup F7）。 */
export function TextStatusPill({
  file
}: {
  file: Pick<LibraryFile, 'text_status'>
}): React.ReactElement | null {
  const { t } = useTranslation()
  switch (file.text_status) {
    case 'pending':
      return <Pill tone="info">{t('library.preview.textStatusPending')}</Pill>
    case 'failed':
      return <Pill tone="fail">{t('library.preview.textStatusFailed')}</Pill>
    case 'unsupported':
      return <Pill tone="ink">{t('library.preview.textStatusUnsupported')}</Pill>
    default:
      return null
  }
}

/** 文件行状态徽标：missing / trashed；present 不显示。 */
export function FileStatusPill({
  file
}: {
  file: Pick<LibraryFile, 'status' | 'updated_at'>
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (file.status === 'missing') {
    return (
      <Pill tone="warn" title={t('library.preview.fileStatusMissingHint')}>
        {t('library.preview.fileStatusMissing')}
      </Pill>
    )
  }
  if (file.status === 'trashed') {
    return (
      <Pill tone="ink" title={t('library.trash.fileTrashedHint', { days: trashDaysLeft(file) })}>
        {t('library.trash.fileTrashedLabel')}
      </Pill>
    )
  }
  return null
}

export function SourcePill({ file }: { file: Pick<LibraryFile, 'source'> }): React.ReactElement {
  const { t } = useTranslation()
  return <Pill tone={sourceTone(file.source)}>{t(`library.common.sourceLabel.${file.source}`)}</Pill>
}
