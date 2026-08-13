import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Hand, Trash2, Zap } from 'lucide-react'

import {
  MATTER_CONDITION_TRIGGER_TYPES,
  MATTER_EVENT_TRIGGER_TYPES
} from '@shared/api/types/matter'
import { ScheduleBuilder } from '@shared/components/agents/schedule/ScheduleBuilder'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import { DEFAULT_RULE } from '@shared/components/agents/schedule/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { cn } from '@shared/lib/cn'

import type { MatterTriggerEntry, MatterTriggerKind } from './matterSchedule'

/**
 * 事项的触发规则编辑（P6-B D6/D15）。多条可并存，单条可启停。
 *
 * 🔴 EVENT / CONDITION 的选项集**刻意小于设计稿**：只列能映射到既有判据的项。设计画的
 * 「会议结束」（日历与事项零接线）和「超过 5 天无进展」（后端无此判据）不做 —— 与其四个
 * 选项里两个永不触发，不如少给两个。`wait_overdue` 的文案也按**真实阈值 7 天**写。
 *
 * 🔴 四档说明卡与多触发模型的调和（0812 dogfood D-B）：设计 `matter-agent.jsx:402-420`
 * 把四档画成 2×2 单选卡（一件事只有一种触发方式），而本仓的存储是 v2 envelope、**多条
 * 并存**。砍掉多触发去像设计是功能倒退，于是取设计的**说明力**、留实现的**表达力**：
 * 卡片保留 icon + 档名 + hint 文案与选中态，语义从「单选」改成「加一条这种触发」——
 * 已有该档时卡片呈选中态（点它不重复添加），删除仍走下面每条自己的删除钮。
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
        ? { ...(newScheduleValue(DEFAULT_RULE) as unknown as Record<string, unknown>), ...base }
        : kind === 'event'
          ? { ...base, event_type: MATTER_EVENT_TRIGGER_TYPES[0] }
          : kind === 'condition'
            ? { ...base, condition: MATTER_CONDITION_TRIGGER_TYPES[0] }
            : base
    onChange([...entries, seeded])
  }

  return (
    <div className="space-y-2">
      {/* 设计 `matter-agent.jsx:402-420` 的 2×2 说明卡：icon + 档名 + hint。 */}
      <div className="grid grid-cols-2 gap-1.5">
        {KINDS.map((kind) => {
          const Icon = KIND_ICONS[kind]
          const on = entries.some((entry) => entry.kind === kind && entry.enabled !== false)
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              // 已经有这一档 ⇒ 卡片退成状态指示（下面那条 entry 才是可编辑/可删的本体）。
              // 留着可点会让人以为还能再点出点什么，实际是 no-op。
              disabled={on}
              onClick={() => add(kind)}
              className={cn(
                'flex items-start gap-2 rounded-[var(--r-ctl)] border p-2.5 text-left transition-colors duration-fast ease-standard',
                on
                  ? 'cursor-default border-coral/45 bg-coral/[0.08]'
                  : 'border-ink-border bg-ink-2 hover:border-coral/25'
              )}
            >
              <Icon
                size={13}
                className={cn('mt-0.5 shrink-0', on ? 'text-coral' : 'text-ink-fg-3')}
              />
              <span className="min-w-0">
                <span
                  className={cn('block text-aux', on ? 'font-semibold text-coral' : 'text-ink-fg')}
                >
                  {t(`matters.trigger.kind.${kind}`)}
                </span>
                <span className="mt-0.5 block text-meta leading-[1.45] text-ink-fg-3">
                  {t(`matters.trigger.hint.${kind}`)}
                </span>
              </span>
            </button>
          )
        })}
      </div>

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

            {/* 0811 D2：原生 `<select>` 一律映射 Radix Select（本仓唯一的下拉基座；原生控件
                在暗色主题下由系统绘制，与 token 体系完全脱节）。`z-[70]` 与 custom-agent 侧
                同值 —— 这两个下拉都活在模态里，低于它的层会被遮罩吃掉。 */}
            {entry.kind === 'event' ? (
              <Select
                value={entry.event_type ?? MATTER_EVENT_TRIGGER_TYPES[0]}
                onValueChange={(value) => update(index, { event_type: value })}
              >
                <SelectTrigger className="mt-2" aria-label={t('matters.trigger.kind.event')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {MATTER_EVENT_TRIGGER_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`matters.trigger.event.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {entry.kind === 'condition' ? (
              <Select
                value={entry.condition ?? MATTER_CONDITION_TRIGGER_TYPES[0]}
                onValueChange={(value) => update(index, { condition: value })}
              >
                <SelectTrigger className="mt-2" aria-label={t('matters.trigger.kind.condition')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {MATTER_CONDITION_TRIGGER_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`matters.trigger.condition.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            {entry.kind === 'manual' ? (
              <p className="mt-2 text-meta leading-5 text-ink-fg-3">
                {t('matters.trigger.manualHint')}
              </p>
            ) : null}
          </div>
        )
      })}

      <p className="text-meta leading-5 text-ink-fg-3">{t('matters.trigger.independentHint')}</p>
    </div>
  )
}
