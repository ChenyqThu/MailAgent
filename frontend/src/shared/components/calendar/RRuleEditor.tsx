// Phase 4·#3 — RRULE builder 控件 (FREQ / INTERVAL / WEEKLY BYDAY / 结束方式).
// 受控组件: value: RRuleState + onChange. 纯逻辑在 lib/rrule.ts (build/parse).
// 视觉沿用现有 .ef-field / .ef-label / .ef-input / .view-chip 设计语言.

import { useTranslation } from 'react-i18next'

import { WEEKDAYS, type RRuleState, type RRuleFreq, type RRuleEnd } from './lib/rrule'
import { cn } from '@shared/lib/cn'

interface Props {
  value: RRuleState
  onChange: (next: RRuleState) => void
  /** edit 周期事件时显示 "影响整个系列" 提示 (切片 1b: 改 = 改整系列). */
  seriesHint?: boolean
}

export function RRuleEditor({ value, onChange, seriesHint = false }: Props): React.ReactElement {
  const { t } = useTranslation()
  const set = (patch: Partial<RRuleState>): void => onChange({ ...value, ...patch })

  const FREQ_OPTS: { v: RRuleFreq; label: string }[] = [
    { v: 'NONE', label: t('calendar.form.repeat.freqNone', '不重复') },
    { v: 'DAILY', label: t('calendar.form.repeat.freqDaily', '每天') },
    { v: 'WEEKLY', label: t('calendar.form.repeat.freqWeekly', '每周') },
    { v: 'MONTHLY', label: t('calendar.form.repeat.freqMonthly', '每月') },
    { v: 'YEARLY', label: t('calendar.form.repeat.freqYearly', '每年') }
  ]
  const DAY_LABELS: Record<string, string> = {
    MO: t('calendar.form.repeat.dayMo', '一'),
    TU: t('calendar.form.repeat.dayTu', '二'),
    WE: t('calendar.form.repeat.dayWe', '三'),
    TH: t('calendar.form.repeat.dayTh', '四'),
    FR: t('calendar.form.repeat.dayFr', '五'),
    SA: t('calendar.form.repeat.daySa', '六'),
    SU: t('calendar.form.repeat.daySu', '日')
  }
  const UNIT: Record<Exclude<RRuleFreq, 'NONE'>, string> = {
    DAILY: t('calendar.form.repeat.unitDay', '天'),
    WEEKLY: t('calendar.form.repeat.unitWeek', '周'),
    MONTHLY: t('calendar.form.repeat.unitMonth', '月'),
    YEARLY: t('calendar.form.repeat.unitYear', '年')
  }

  const toggleDay = (d: string): void => {
    set({
      byday: value.byday.includes(d)
        ? value.byday.filter((x) => x !== d)
        : [...value.byday, d]
    })
  }

  return (
    <div className="ef-field">
      <label className="ef-label" htmlFor="ef-rrule-freq">
        {t('calendar.form.repeat.label', '重复')}
      </label>
      <select
        id="ef-rrule-freq"
        className="ef-input"
        value={value.freq}
        onChange={(e) => set({ freq: e.target.value as RRuleFreq })}
      >
        {FREQ_OPTS.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>

      {value.freq !== 'NONE' && (
        <div className="mt-2 space-y-2">
          {/* INTERVAL — 每 N 单位 */}
          <div className="flex items-center gap-2 text-aux text-ink-fg-1">
            <span>{t('calendar.form.repeat.everyPrefix', '每')}</span>
            <input
              type="number"
              min={1}
              max={99}
              className="ef-input w-16 text-center"
              value={value.interval}
              onChange={(e) =>
                set({ interval: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })
              }
              aria-label={t('calendar.form.repeat.intervalAria', '重复间隔')}
            />
            <span>{UNIT[value.freq as Exclude<RRuleFreq, 'NONE'>]}</span>
          </div>

          {/* WEEKLY — 星期多选 */}
          {value.freq === 'WEEKLY' && (
            <div className="flex items-center gap-1" role="group" aria-label={t('calendar.form.repeat.bydayAria', '每周重复日')}>
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={cn('view-chip', value.byday.includes(d) && 'is-active')}
                  aria-pressed={value.byday.includes(d)}
                  onClick={() => toggleDay(d)}
                >
                  {DAY_LABELS[d]}
                </button>
              ))}
            </div>
          )}

          {/* 结束方式 */}
          <div className="flex items-center gap-2 flex-wrap text-aux text-ink-fg-1">
            <select
              className="ef-input w-auto"
              value={value.end}
              onChange={(e) => set({ end: e.target.value as RRuleEnd })}
              aria-label={t('calendar.form.repeat.endAria', '结束方式')}
            >
              <option value="never">{t('calendar.form.repeat.endNever', '永不结束')}</option>
              <option value="count">{t('calendar.form.repeat.endCount', '次数后结束')}</option>
              <option value="until">{t('calendar.form.repeat.endUntil', '直到日期')}</option>
            </select>
            {value.end === 'count' && (
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={999}
                  className="ef-input w-16 text-center"
                  value={value.count}
                  onChange={(e) =>
                    set({ count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })
                  }
                  aria-label={t('calendar.form.repeat.countAria', '重复次数')}
                />
                <span>{t('calendar.form.repeat.countSuffix', '次')}</span>
              </div>
            )}
            {value.end === 'until' && (
              <input
                type="date"
                className="ef-input w-auto mono"
                value={value.until}
                onChange={(e) => set({ until: e.target.value })}
                aria-label={t('calendar.form.repeat.untilAria', '结束日期')}
              />
            )}
          </div>

          {seriesHint && (
            <div className="text-meta text-ink-fg-3">
              {t('calendar.form.repeat.seriesHint', '修改重复规则将应用到整个系列')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
