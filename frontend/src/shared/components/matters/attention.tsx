import { BellRing, Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Matter, MatterAttentionSignal } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'

// 词表与 tone 判定住在 ./attentionMeta（非组件导出不能与组件同住，见该文件头注）。
import { ATTENTION_META, attentionTone } from './attentionMeta'

export function AttentionPip({ signal }: { signal: MatterAttentionSignal }): React.ReactElement {
  const { t } = useTranslation()
  const meta = ATTENTION_META[signal.kind]
  const tone = attentionTone(signal)
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2 py-0.5 text-meta',
        tone === 'critical'
          ? 'bg-fail/10 text-fail'
          : tone === 'warn'
            ? 'bg-warn/10 text-warn'
            : 'bg-ai/10 text-ai'
      )}
    >
      <Icon size={10} />
      {t(`matters.attention.kind.${signal.kind}`)}
    </span>
  )
}

export function AttentionActions({
  matterId,
  signal,
  onAction,
  compact = false
}: {
  matterId: string
  signal: MatterAttentionSignal
  onAction(matterId: string, signalId: number, action: 'resolved' | 'snoozed' | 'dismissed'): void
  compact?: boolean
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (signal.id == null) return null
  const buttonClass = compact
    ? 'rounded p-1 hover:bg-ink-4'
    : 'inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-2 py-1 text-meta hover:bg-ink-4'
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        title={t('matters.attention.resolve')}
        aria-label={t('matters.attention.resolve')}
        onClick={() => onAction(matterId, signal.id as number, 'resolved')}
        className={buttonClass}
      >
        <Check size={12} />
        {compact ? null : t('matters.attention.resolve')}
      </button>
      <button
        type="button"
        title={t('matters.attention.snooze')}
        aria-label={t('matters.attention.snooze')}
        onClick={() => onAction(matterId, signal.id as number, 'snoozed')}
        className={buttonClass}
      >
        <BellRing size={12} />
        {compact ? null : t('matters.attention.snoozeShort')}
      </button>
      <button
        type="button"
        title={t('matters.attention.dismiss')}
        aria-label={t('matters.attention.dismiss')}
        onClick={() => onAction(matterId, signal.id as number, 'dismissed')}
        className={buttonClass}
      >
        <X size={12} />
      </button>
    </div>
  )
}

export function AttnBand({
  matter,
  signals,
  onAction,
  hasProposal
}: {
  matter: Matter
  signals: readonly MatterAttentionSignal[]
  onAction(matterId: string, signalId: number, action: 'resolved' | 'snoozed' | 'dismissed'): void
  hasProposal: boolean
}): React.ReactElement | null {
  const visible = signals.filter(
    (signal) => signal.state === 'open' && !(hasProposal && signal.kind === 'needs_review')
  )
  if (visible.length === 0) return null
  return (
    <section className="space-y-2" aria-label="matter attention">
      {visible.map((signal, index) => {
        const tone = attentionTone(signal)
        const Icon = ATTENTION_META[signal.kind].icon
        return (
          <div
            key={signal.id ?? `${signal.kind}-${index}`}
            className={cn(
              'flex items-center gap-3 rounded-[var(--r-card)] border px-3 py-2.5',
              tone === 'critical'
                ? 'border-fail/25 bg-fail/[0.07]'
                : tone === 'warn'
                  ? 'border-warn/25 bg-warn/[0.07]'
                  : 'border-ai/25 bg-ai/[0.07]'
            )}
          >
            <Icon
              size={16}
              className={
                tone === 'critical' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-ai'
              }
            />
            <p className="min-w-0 flex-1 text-body text-ink-fg">{signal.why}</p>
            <AttentionActions matterId={matter.public_id} signal={signal} onAction={onAction} />
          </div>
        )
      })}
    </section>
  )
}
