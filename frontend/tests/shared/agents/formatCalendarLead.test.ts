// 承接 CustomAgentTab.test 里「calendar_before_start 卡片摘要按天 / 小数分钟展示 lead」
// 那条随 AgentsTab 卡片网格退役的断言。展示串现在由 formatCalendarLead 单独产出，三个
// 消费点（团队页配置的触发摘要 / CustomAgentDrawer / 日历 agent 投影详情）共用它 ——
// 单位选择错了三处一起说错话，所以钉在这个纯函数上而不是某一处渲染上。
//
// 🔴 判据是「整除才升单位」：86400 秒是 1 天不是 1440 分钟；90 秒不整除 60 分钟档以上的
// 单位，落分钟并保留小数（1.5 分钟）—— 取整会把「提前 90 秒」说成「提前 1 分钟」。
import { describe, expect, test } from 'vitest'

import i18n from '@shared/i18n'
import {
  formatCalendarLead,
  leadParts
} from '../../../src/shared/components/agents/custom-agent/shared'

await i18n.changeLanguage('zh-CN')

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string

describe('leadParts — 整除才升单位', () => {
  test('86400 → 1 天；7200 → 2 小时；90 → 1.5 分钟（不取整）', () => {
    expect(leadParts(86400)).toEqual({ amount: 1, unit: 'days' })
    expect(leadParts(7200)).toEqual({ amount: 2, unit: 'hours' })
    expect(leadParts(90)).toEqual({ amount: 1.5, unit: 'minutes' })
  })

  test('不能被 86400 整除的大值落小时档，不四舍五入成天', () => {
    // 25 小时：升到天会显示成「1 天」，把 1 小时的提前量说没了。
    expect(leadParts(90000)).toEqual({ amount: 25, unit: 'hours' })
  })
})

describe('formatCalendarLead — 渲染串', () => {
  test('按单位选对 i18n key（天 / 小时 / 分钟）', () => {
    expect(formatCalendarLead(t, 86400)).toBe('提前 1 天')
    expect(formatCalendarLead(t, 7200)).toBe('提前 2 小时')
    expect(formatCalendarLead(t, 90)).toBe('提前 1.5 分钟')
  })
})
