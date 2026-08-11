import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Hand, Plus, Trash2, Zap } from 'lucide-react'

import {
  MATTER_CONDITION_TRIGGER_TYPES,
  MATTER_EVENT_TRIGGER_TYPES
} from '@shared/api/types/matter'
import { ScheduleBuilder } from '@shared/components/agents/schedule/ScheduleBuilder'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'
import { cn } from '@shared/lib/cn'

import type { MatterTriggerEntry, MatterTriggerKind } from './matterSchedule'

/**
 * 事项的触发规则编辑（P6-B D6/D15）。多条可并存，单条可启停。
 *
 * 🔴 EVENT / CONDITION 的选项集**刻意小于设计稿**：只列能映射到既有判据的项。设计画的
 * 「会议结束」（日历与事项零接线）和「超过 5 天无进展」（后端无此判据）不做 —— 与其四个
 * 选项里两个永不触发，不如少给两个。`wait_overdue` 的文案也按**真实阈值 7 天**写。
 */

const KIND_ICONS: Record<MatterTriggerKind, typeof Clock> = {
  schedule: Clock,
  event: Zap,
  condition: AlertTriangle,
  manual: Hand
}

const KINDS: readonly MatterTriggerKind[] = ['schedule', 'event', 'condition', 'manual']

export function MatterTriggerEditor({
  entries,
  onChange
}: {
  entries: readonly MatterTriggerEntry[]
  onChange(next: MatterTriggerEntry[]): void
}): React.ReactElement {
  const { t } = useTranslation()

  const update = (index: number, patch: Partial<MatterTriggerEntry>): void => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  const add = (kind: MatterTriggerKind): void => {
    const base = { id: `mtr_new_${entries.length}_${kind}`, kind, enabled: true }
    const seeded: MatterTriggerEntry =
      kind === 'schedule'
        ? { ...base, ...(newScheduleValue() as unknown as Record<string, unknown>) }
        : kind === 'event'
          ? { ...base, event_type: MATTER_EVENT_TRIGGER_TYPES[0] }
          : kind === 'condition'
            ? { ...base, condition: MATTER_CONDITION_TRIGGER_TYPES[0] }
            : base
    onChange([...entries, seeded])
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => {
        const Icon = KIND_ICONS[entry.kind]
        return (
          <div
            key={entry.id}
            className={cn(
              'rounded-[var(--r-ctl)] border p-2.5',
              entry.enabled === false
                ? 'border-ink-border bg-ink-2/40 opacity-70'
                : 'border-ai/25 bg-ink-2'
            )}
          >
            <div className="flex items-center gap-2">
              <Icon size={13} className="shrink-0 text-ai" />
              <span className="min-w-0 flex-1 truncate text-meta font-medium">
                {t(`matters.trigger.kind.${entry.kind}`)}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={entry.enabled !== false}
                aria-label={t('matters.trigger.toggle')}
                onClick={() => update(index, { enabled: entry.enabled === false })}
                className={`h-4 w-8 rounded-full p-0.5 ${entry.enabled === false ? 'bg-ink-4' : 'bg-ai'}`}
              >
                <span
                  className={`block size-3 rounded-full bg-white transition-transform ${entry.enabled === false ? '' : 'translate-x-4'}`}
                />
              </button>
              <button
                type="button"
                aria-label={t('matters.trigger.remove')}
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
                className="rounded p-1 text-ink-fg-3 hover:bg-ink-3 hover:text-fail"
              >
                <Trash2 size={12} />
              </button>
            </div>

            {entry.kind === 'schedule' ? (
              <div className="mt-2">
                <ScheduleBuilder
                  value={entry as unknown as ScheduleValue}
                  onChange={(value) =>
                    update(index, value as unknown as Partial<MatterTriggerEntry>)
                  }
                  occurrences={2}
                />
              </div>
            ) : null}

            {entry.kind === 'event' ? (
              <select
                value={entry.event_type ?? MATTER_EVENT_TRIGGER_TYPES[0]}
                onChange={(event) => update(index, { event_type: event.target.value })}
                aria-label={t('matters.trigger.kind.event')}
                className="mt-2 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2 py-1.5 text-meta"
              >
                {MATTER_EVENT_TRIGGER_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`matters.trigger.event.${value}`)}
                  </option>
                ))}
              </select>
            ) : null}

            {entry.kind === 'condition' ? (
              <select
                value={entry.condition ?? MATTER_CONDITION_TRIGGER_TYPES[0]}
                onChange={(event) => update(index, { condition: event.target.value })}
                aria-label={t('matters.trigger.kind.condition')}
                className="mt-2 w-full rounded-[var(--r-ctl)] border border-ink-border bg-ink-1 px-2 py-1.5 text-meta"
              >
                {MATTER_CONDITION_TRIGGER_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`matters.trigger.condition.${value}`)}
                  </option>
                ))}
              </select>
            ) : null}

            {entry.kind === 'manual' ? (
              <p className="mt-2 text-meta leading-5 text-ink-fg-3">
                {t('matters.trigger.manualHint')}
              </p>
            ) : null}
          </div>
        )
      })}

      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => add(kind)}
            className="inline-flex items-center gap-1 rounded-[var(--r-pill)] border border-dashed border-ink-border px-2 py-1 text-meta text-ink-fg-2 hover:border-ai/40 hover:text-ai"
          >
            <Plus size={11} />
            {t(`matters.trigger.kind.${kind}`)}
          </button>
        ))}
      </div>
      <p className="text-meta leading-5 text-ink-fg-3">{t('matters.trigger.independentHint')}</p>
    </div>
  )
}
