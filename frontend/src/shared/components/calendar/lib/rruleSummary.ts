// 重复规则的自然语言回显（「每周一、三，共 10 次」）。
//
// 与 ./rrule 的分工：那边是 RFC 5545 的 build/parse（**逻辑层，本批一行没动**），
// 这边只把同一个 `RRuleState` 说成人话。分文件是因为回显纯属呈现，且要能在 node
// 环境单测「编辑器状态 → 句子」，不该跟 RRULE 串的生成搅在一起。
//
// 文案模板由调用方从 i18n 传进来（本模块不 import i18next）：中英文的语序不同
// （中文「每周一、三」是黏着的，英文要 "on"），把差异留在词条里比在这里写
// `if (lang === 'zh')` 干净。

import { WEEKDAYS, type RRuleFreq, type RRuleState } from './rrule'

export interface RRuleSummaryLabels {
  /** freq=NONE 时的整句，如「不重复」。 */
  none: string
  /** interval=1 的句头，含 `{unit}`，如「每{unit}」。 */
  everyUnit: string
  /** interval>1 的句头，含 `{n}` `{unit}`，如「每 {n} {unit}」。 */
  everyNUnit: string
  /** 单位词，如 天 / 周 / 月 / 年。 */
  units: Record<Exclude<RRuleFreq, 'NONE'>, string>
  /** 星期词，键 = RFC 5545 BYDAY，如 MO → 一 / Mon。 */
  days: Record<string, string>
  /** 星期之间的连接，如「、」。 */
  daysJoin: string
  /** interval=1 时接星期，含 `{base}` `{days}`，如「{base}{days}」→ 每周一、三。 */
  withDays: string
  /** interval>1 时接星期（「每 2 周一、三」会读成「每两个周一」，故另给一句）。 */
  withDaysN: string
  /** 次数结束，含 `{base}` `{n}`，如「{base}，共 {n} 次」。 */
  endCount: string
  /** 日期结束，含 `{base}` `{date}`。 */
  endUntil: string
}

/** `t(key, defaultValue)` 的最小形状 —— 本模块不 import i18next，测试可直接喂 locale JSON。 */
export type RRuleLabelLookup = (key: string, defaultValue: string) => string

/**
 * 从 i18n 词条组装 labels。编辑器的控件（单位下拉 / 星期按钮）与回显那一句用**同一个**
 * bag —— 否则「按钮上写的星期」和「句子里念的星期」会各取各的词条，慢慢对不上。
 */
export function rruleSummaryLabels(t: RRuleLabelLookup): RRuleSummaryLabels {
  const k = (name: string, dflt: string): string => t(`calendar.form.repeat.${name}`, dflt)
  return {
    none: k('freqNone', '不重复'),
    everyUnit: k('summary.everyUnit', '每{unit}'),
    everyNUnit: k('summary.everyNUnit', '每 {n} {unit}'),
    units: {
      DAILY: k('unitDay', '天'),
      WEEKLY: k('unitWeek', '周'),
      MONTHLY: k('unitMonth', '月'),
      YEARLY: k('unitYear', '年')
    },
    days: {
      MO: k('dayMo', '一'),
      TU: k('dayTu', '二'),
      WE: k('dayWe', '三'),
      TH: k('dayTh', '四'),
      FR: k('dayFr', '五'),
      SA: k('daySa', '六'),
      SU: k('daySu', '日')
    },
    daysJoin: k('summary.daysJoin', '、'),
    withDays: k('summary.withDays', '{base}{days}'),
    withDaysN: k('summary.withDaysN', '{base}的{days}'),
    endCount: k('summary.endCount', '{base}，共 {n} 次'),
    endUntil: k('summary.endUntil', '{base}，到 {date} 止')
  }
}

/** `{k}` 占位替换。模板来自 i18n 词条，只做定值替换，不做表达式。 */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole
  )
}

/**
 * `RRuleState` → 一句自然语言。freq=NONE 返回 `labels.none`。
 *
 * BYDAY 按 `WEEKDAYS`（周一首序）排，与 `buildRRule` 的输出序一致 —— 用户点选的
 * 先后不该改变句子里星期的顺序。
 */
export function summarizeRRule(state: RRuleState, labels: RRuleSummaryLabels): string {
  if (state.freq === 'NONE') return labels.none
  const unit = labels.units[state.freq]
  const interval = Math.max(1, state.interval)

  let base =
    interval > 1 ? fill(labels.everyNUnit, { n: interval, unit }) : fill(labels.everyUnit, { unit })

  if (state.freq === 'WEEKLY' && state.byday.length > 0) {
    const days = WEEKDAYS.filter((d) => state.byday.includes(d))
      .map((d) => labels.days[d] ?? d)
      .join(labels.daysJoin)
    if (days) {
      base = fill(interval > 1 ? labels.withDaysN : labels.withDays, { base, days })
    }
  }

  if (state.end === 'count' && state.count >= 1) {
    return fill(labels.endCount, { base, n: state.count })
  }
  if (state.end === 'until' && state.until) {
    return fill(labels.endUntil, { base, date: state.until })
  }
  return base
}
