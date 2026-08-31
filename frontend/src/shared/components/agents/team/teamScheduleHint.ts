// task 08-27 P4b — 「它什么时候会自己动」一句话（团队对话欢迎屏 hint）。
//
// 纯函数叶子（TeamChatHost 是组件文件，react-refresh/only-export-components 不许它
// 兼职导出函数）。粗粒度模式命名 + 排程句子生成器复用（sentenceText/coerceRule ——
// 语义单源 schedule-rule-contract.md），不展开 occurrence（那是日历/排程预览的事）。

import type { ReportAgentConfig } from '@shared/api/types'

import { coerceRule, isScheduleValue } from '../schedule'
import { sentenceText } from '../schedule/sentence'

type Translate = (key: string, opts?: Record<string, unknown>) => string

export function memberScheduleHint(
  cfg: ReportAgentConfig | null,
  t: Translate,
  locale: string
): string {
  if (!cfg) return t('team.welcome.schedule.manual')
  if (cfg.type === 'report') {
    if (isScheduleValue(cfg.schedule)) {
      return t('team.welcome.schedule.timed', {
        sentence: sentenceText(t, locale, coerceRule(cfg.schedule.rule))
      })
    }
    const cadence = cfg.schedule?.cadence
    const cadenceLabel =
      cadence === 'weekly' || cadence === 'monthly'
        ? t(`team.welcome.cadence.${cadence}`)
        : t('team.welcome.cadence.daily')
    return t('team.welcome.schedule.report', { cadence: cadenceLabel })
  }
  if (cfg.type === 'contact_profile' || cfg.type === 'contact_governance') {
    return t('team.welcome.schedule.daily')
  }
  // custom：trigger envelope（v2 集合 / 单条 legacy / null）→ 三档。
  const trigger = cfg.trigger
  const entries =
    trigger == null
      ? []
      : 'triggers' in trigger
        ? trigger.triggers.filter((entry) => entry.enabled)
        : [trigger]
  if (entries.length === 0) return t('team.welcome.schedule.manual')
  const scheduleEntry = entries.find((entry) => entry.kind === 'schedule')
  if (scheduleEntry != null && 'rule' in scheduleEntry) {
    return t('team.welcome.schedule.timed', {
      sentence: sentenceText(t, locale, coerceRule(scheduleEntry.rule))
    })
  }
  if (entries.some((entry) => entry.kind === 'cron')) return t('team.welcome.schedule.timedPlain')
  return t('team.welcome.schedule.event')
}
