// 重复规则编辑器 —— 一句话式（08-27 P4d 重排形态）。
//
// 原来是四个并排下拉各占一行（重复 / 每 N 单位 / 星期 / 结束方式），得把四个控件的
// 值在脑子里拼起来才知道自己设了什么。现在按读的顺序排成一句：
//
//   每 [1] [周▾] 的 [一][三] · [次数后结束▾] [10] 次
//   每周一、三，共 10 次                      ← 自然语言回显，说的就是上面这行
//
// 🔴 逻辑层 `lib/rrule.ts`（build/parse）一行没动，本批只动形态；回显那一句在
// `lib/rruleSummary.ts`（纯函数 + 词条模板，可脱离 React 单测）。

import { useTranslation } from 'react-i18next'

import { WEEKDAYS, type RRuleState, type RRuleFreq, type RRuleEnd } from './lib/rrule'
import { rruleSummaryLabels, summarizeRRule } from './lib/rruleSummary'
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

  // 控件上的单位词 / 星期词与回显那一句共用同一个 bag（见 rruleSummaryLabels）。
  // 单位词兼任 FREQ 下拉的选项 —— 句子里读作「每 1 周」，不必再有一个「每周」。
  const labels = rruleSummaryLabels((key, dflt) => t(key, dflt))
  const UNIT = labels.units
  const DAY_LABELS = labels.days

  const toggleDay = (d: string): void => {
    set({
      byday: value.byday.includes(d) ? value.byday.filter((x) => x !== d) : [...value.byday, d]
    })
  }

  const repeats = value.freq !== 'NONE'

  return (
    <div className="ef-field">
      <label className="ef-label" htmlFor="ef-rrule-freq">
        {t('calendar.form.repeat.label', '重复')}
      </label>

      {/* 一行读下来就是一句话；窄宽下换行，语序不变。 */}
      <div className="flex flex-wrap items-center gap-1.5 text-aux text-ink-fg-1">
        {repeats && (
          <>
            <span>{t('calendar.form.repeat.everyPrefix', '每')}</span>
            <input
              type="number"
              min={1}
              max={99}
              className="ef-input mono w-16 text-center"
              value={value.interval}
              onChange={(e) =>
                set({ interval: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })
              }
              aria-label={t('calendar.form.repeat.intervalAria', '重复间隔')}
            />
          </>
        )}
        <select
          id="ef-rrule-freq"
          className="ef-input w-auto"
          value={value.freq}
          onChange={(e) => set({ freq: e.target.value as RRuleFreq })}
        >
          <option value="NONE">{t('calendar.form.repeat.freqNone', '不重复')}</option>
          <option value="DAILY">{UNIT.DAILY}</option>
          <option value="WEEKLY">{UNIT.WEEKLY}</option>
          <option value="MONTHLY">{UNIT.MONTHLY}</option>
          <option value="YEARLY">{UNIT.YEARLY}</option>
        </select>

        {value.freq === 'WEEKLY' && (
          <>
            <span>{t('calendar.form.repeat.onDaysPrefix', '的')}</span>
            <span
              className="flex items-center gap-1"
              role="group"
              aria-label={t('calendar.form.repeat.bydayAria', '每周重复日')}
            >
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
            </span>
          </>
        )}

        {repeats && (
          <>
            <span aria-hidden className="text-ink-fg-3">
              ·
            </span>
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
              <>
                <input
                  type="number"
                  min={1}
                  max={999}
                  className="ef-input mono w-16 text-center"
                  value={value.count}
                  onChange={(e) =>
                    set({ count: Math.max(1, parseInt(e.target.value || '1', 10) || 1) })
                  }
                  aria-label={t('calendar.form.repeat.countAria', '重复次数')}
                />
                <span>{t('calendar.form.repeat.countSuffix', '次')}</span>
              </>
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
          </>
        )}
      </div>

      {repeats && (
        <div className="mt-2 text-meta text-ink-fg-2" data-testid="rrule-summary">
          {summarizeRRule(value, labels)}
        </div>
      )}

      {repeats && seriesHint && (
        <div className="mt-1 text-meta text-ink-fg-3">
          {t('calendar.form.repeat.seriesHint', '修改重复规则将应用到整个系列')}
        </div>
      )}
    </div>
  )
}
