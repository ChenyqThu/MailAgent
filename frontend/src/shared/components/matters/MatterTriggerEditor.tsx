import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Play,
  Plus,
  Trash2,
  Zap
} from 'lucide-react'

import {
  MATTER_CONDITION_TRIGGER_TYPES,
  MATTER_EVENT_TRIGGER_TYPES
} from '@shared/api/types/matter'
import { ScheduleBuilder } from '@shared/components/agents/schedule/ScheduleBuilder'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import { sentenceText } from '@shared/components/agents/schedule/sentence'
import { DEFAULT_RULE, isScheduleValue } from '@shared/components/agents/schedule/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { Popmenu, type PopmenuItem } from '@shared/components/ui/Popmenu'
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
 * 事项的触发规则编辑（P6-B D6/D15；0813 dogfood #5/#11 按设计稿 `triggers.jsx::TriggerList`
 * 重做形态）。多条可并存，单条可启停。
 *
 * 形态 = 设计的**一张带框列表**：
 *   · 第一行恒是「手动」（不可删不可关）—— 它陈述的是事实：点「立即跟进」随时可跑；
 *   · 其后每条触发一行：图标 + 档名 + **一句话摘要**（排程走 `sentenceText`，与页脚「计划」同源），
 *     点行展开编辑，hover 出删除，行尾开关；
 *   · 末行「添加触发」→ 弹层里三档各带一句 hint；
 *   · 列表下一句「N 条触发生效…」/「当前只有手动运行…」。
 * 上一版那个 2×2 档位卡片网格是本仓自造的（owner：「跟进规则页面没有遵循设计」），已撤。
 *
 * 🔴 EVENT / CONDITION 的选项集**刻意小于设计稿**：只列能映射到既有判据的项。设计画的
 * 「会议结束」（日历与事项零接线）和「超过 5 天无进展」（后端无此判据）不做 —— 与其四个
 * 选项里两个永不触发，不如少给两个。`wait_overdue` 的文案也按**真实阈值 7 天**写。
 *
 * 🔴 与设计的一处有意偏离：设计把排程编辑放进 344px `Popover`，本仓的排程编辑器是**跨端
 * 契约的共享组件**（`ScheduleBuilder`，活的句子 + 真实运行预览），塞不进那个宽度、也不该
 * 为这一处 fork 出第二套排程语义。改为行内展开，信息架构与设计一致。
 *
 * 🔴 `manual` 形态的存量 entry 不在列表里渲染（它与那行固定的「手动」是同一件事，且 worker
 * 对它恒 `return False`），但**原样留在草稿里**跟着保存回去 —— 编辑器不做静默丢数据的事。
 */

const KIND_ICONS: Record<MatterTriggerKind, typeof Clock> = {
  schedule: Clock,
  event: Zap,
  condition: AlertTriangle,
  manual: Play
}

/** 可新增的档位 —— 手动不在其中（它是那行固定说明，不是一条可加可删的规则）。 */
const ADDABLE_KINDS: readonly MatterTriggerKind[] = ['schedule', 'event', 'condition']

/** 草稿里新条目的 id。
 *
 * 🔴 **不能**只拿 `entries.length` 当序号：add→delete→add 交错后长度会回退，再铸出的 id
 * 与仍留在列表里的那条**相撞** —— 近处是 React 重复 key，远处是保存时被服务端
 * `parse_trigger_set` 的 duplicate id 检查硬拒（用户看到的是「保存失败」，跟触发规则本身
 * 毫无关系）。这里直接拿**当前草稿里已用的 id** 当判据往后找空位：既与长度解耦，也不依赖
 * 任何计数器的存活周期（组件重挂 / 草稿由父组件持有时，计数器归零一样会撞），且是纯函数、
 * 可确定性断言。
 */
function mintEntryId(kind: MatterTriggerKind, entries: readonly MatterTriggerEntry[]): string {
  const used = new Set(entries.map((entry) => entry.id))
  let seq = entries.length + 1
  while (used.has(`mtr_new_${seq}_${kind}`)) seq += 1
  return `mtr_new_${seq}_${kind}`
}

export function MatterTriggerEditor({
  entries,
  onChange
}: {
  entries: readonly MatterTriggerEntry[]
  onChange(next: MatterTriggerEntry[]): void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)

  const update = (index: number, patch: Partial<MatterTriggerEntry>): void => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  const add = (kind: MatterTriggerKind): void => {
    const id = mintEntryId(kind, entries)
    const base = { id, kind, enabled: true }
    const seeded: MatterTriggerEntry =
      kind === 'schedule'
        ? { ...(newScheduleValue(DEFAULT_RULE) as unknown as Record<string, unknown>), ...base }
        : kind === 'event'
          ? { ...base, event_type: MATTER_EVENT_TRIGGER_TYPES[0] }
          : kind === 'condition'
            ? { ...base, condition: MATTER_CONDITION_TRIGGER_TYPES[0] }
            : base
    onChange([...entries, seeded])
    // 新加的那条直接展开：加完还要再点一下才能配，是上一版最常被绊住的地方。
    setExpandedId(id)
  }

  /** 一条触发的一句话摘要（设计 `triggerLabel`）。排程与页脚「计划」同一个句子生成器。 */
  const summaryOf = (entry: MatterTriggerEntry): string => {
    if (entry.kind === 'schedule') {
      return isScheduleValue(entry)
        ? sentenceText(t, i18n.language || 'zh-CN', entry.rule)
        : t('matters.trigger.hint.schedule')
    }
    if (entry.kind === 'event') {
      const value = entry.event_type ?? MATTER_EVENT_TRIGGER_TYPES[0]
      return t('matters.trigger.whenEvent', { event: t(`matters.trigger.event.${value}`) })
    }
    if (entry.kind === 'condition') {
      const value = entry.condition ?? MATTER_CONDITION_TRIGGER_TYPES[0]
      return t(`matters.trigger.condition.${value}`)
    }
    return t('matters.trigger.hint.manual')
  }

  const rows = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind !== 'manual')
  const activeCount = rows.filter(({ entry }) => entry.enabled !== false).length

  const addItems: PopmenuItem[] = ADDABLE_KINDS.map((kind) => {
    const Icon = KIND_ICONS[kind]
    return {
      kind: 'action' as const,
      id: kind,
      label: t(`matters.trigger.kind.${kind}`),
      hint: t(`matters.trigger.hint.${kind}`),
      icon: <Icon size={13} className="text-ink-fg-2" />,
      onSelect: () => add(kind)
    }
  })

  return (
    <div>
      {/* 🔴 定位上下文放在**带框列表之外**：列表自己是 `overflow-hidden`（行底色要贴着圆角
          裁），而 Popmenu 是 absolute —— 挂在列表内部会被那层裁掉、菜单只露出一条边。 */}
      <div className="relative">
        <div className="overflow-hidden rounded-[var(--r-ctl)] border border-ink-border">
          {/* 固定首行：手动。设计 `triggers.jsx:284-288` —— 陈述，不是开关。 */}
          <div className="flex items-center gap-2 px-2.5 py-2">
            <Play size={12} className="shrink-0 text-ink-fg-2" />
            <span className="text-aux text-ink-fg">{t('matters.trigger.kind.manual')}</span>
            <span className="min-w-0 truncate text-meta text-ink-fg-3">
              {t('matters.trigger.manualAlways')}
            </span>
          </div>

          {rows.map(({ entry, index }) => {
            const Icon = KIND_ICONS[entry.kind]
            const off = entry.enabled === false
            const expanded = expandedId === entry.id
            return (
              <div key={entry.id} className="border-t border-ink-border-soft">
                <div className="group flex items-center gap-2 px-2.5 py-2">
                  <Icon
                    size={12}
                    className={cn('shrink-0', off ? 'text-ink-fg-3' : 'text-coral')}
                  />
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    className={cn(
                      'flex min-w-0 flex-1 items-baseline gap-2 text-left',
                      off && 'opacity-50'
                    )}
                  >
                    <span className="shrink-0 text-aux text-ink-fg">
                      {t(`matters.trigger.kind.${entry.kind}`)}
                    </span>
                    <span className="min-w-0 truncate text-meta text-ink-fg-2">
                      {summaryOf(entry)}
                    </span>
                    {expanded ? (
                      <ChevronDown size={11} className="shrink-0 text-ink-fg-3" />
                    ) : (
                      <ChevronRight size={11} className="shrink-0 text-ink-fg-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={t('matters.trigger.remove')}
                    onClick={() => {
                      if (expanded) setExpandedId(null)
                      onChange(entries.filter((_, i) => i !== index))
                    }}
                    className="rounded-[var(--r-ctl)] p-1 text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!off}
                    aria-label={t('matters.trigger.toggle')}
                    onClick={() => update(index, { enabled: off })}
                    className={cn(
                      'h-4 w-8 shrink-0 rounded-full p-0.5',
                      off ? 'bg-ink-4' : 'bg-ai'
                    )}
                  >
                    <span
                      className={cn(
                        'block size-3 rounded-full bg-white transition-transform',
                        off ? '' : 'translate-x-4'
                      )}
                    />
                  </button>
                </div>

                <CollapsibleRegion
                  expanded={expanded}
                  bodyClassName="border-t border-ink-border-soft px-2.5 py-2.5"
                >
                  {entry.kind === 'schedule' ? (
                    <ScheduleBuilder
                      value={entry as unknown as ScheduleValue}
                      onChange={(value) =>
                        update(index, value as unknown as Partial<MatterTriggerEntry>)
                      }
                      occurrences={2}
                    />
                  ) : null}

                  {/* 0811 D2：原生 `<select>` 一律映射 Radix Select（本仓唯一的下拉基座；原生控件
                    在暗色主题下由系统绘制，与 token 体系完全脱节）。`z-[70]` 与 custom-agent 侧
                    同值 —— 这两个下拉都活在模态里，低于它的层会被遮罩吃掉。 */}
                  {entry.kind === 'event' ? (
                    <Select
                      value={entry.event_type ?? MATTER_EVENT_TRIGGER_TYPES[0]}
                      onValueChange={(value) => update(index, { event_type: value })}
                    >
                      <SelectTrigger aria-label={t('matters.trigger.kind.event')}>
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
                      <SelectTrigger aria-label={t('matters.trigger.kind.condition')}>
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
                </CollapsibleRegion>
              </div>
            )
          })}

          <button
            ref={addRef}
            type="button"
            onClick={() => setAddOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 border-t border-ink-border-soft px-2.5 py-2 text-left text-aux text-ink-fg-2 hover:bg-ink-fg/[0.04]"
          >
            <Plus size={12} />
            {t('matters.trigger.add')}
          </button>
        </div>
        <Popmenu
          open={addOpen}
          onClose={() => setAddOpen(false)}
          ariaLabel={t('matters.trigger.add')}
          triggerRef={addRef}
          align="start"
          width={248}
          items={addItems}
        />
      </div>

      <p className="mt-1.5 text-meta leading-5 text-ink-fg-3">
        {activeCount > 0
          ? t('matters.trigger.activeHint', { count: activeCount })
          : t('matters.trigger.manualOnlyHint')}
      </p>
    </div>
  )
}
