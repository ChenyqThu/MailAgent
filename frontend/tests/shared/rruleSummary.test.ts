// 重复规则「编辑器状态 ↔ RRULE 串 ↔ 自然语言回显」一致性闸（08-27 P4d）。
//
// 回显是这一批唯一新增的语义面：控件排成一句话之后，用户判断自己设对没有靠的就是
// 下面那行字。它错了不会有任何报错，所以两条方向都钉住：
//   ① 编辑器状态 → buildRRule 出的 RRULE 串
//   ② parse 原串 → 回显那句话（即「别人写的 RRULE 我也能念对」）
//
// 🔴 词条从 **真实 locale JSON** 取（不是测试里另写一份 labels）—— 组件里的默认值与
// JSON 漂了、或者哪个 key 被删了，这里当场红。

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import {
  buildRRule,
  parseRRule,
  type RRuleState
} from '../../src/shared/components/calendar/lib/rrule'
import {
  rruleSummaryLabels,
  summarizeRRule
} from '../../src/shared/components/calendar/lib/rruleSummary'

const LOCALES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/i18n/locales'
)

function labelsOf(locale: 'zh-CN' | 'en-US'): ReturnType<typeof rruleSummaryLabels> {
  const json: unknown = JSON.parse(
    readFileSync(resolve(LOCALES_DIR, locale, 'common.json'), 'utf-8')
  )
  return rruleSummaryLabels((key) => {
    let node: unknown = json
    for (const seg of key.split('.')) {
      node =
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[seg]
          : undefined
    }
    // 缺 key 就还一个显眼的哨兵，而不是悄悄回落默认值 —— 回落会让「词条被删」全绿。
    return typeof node === 'string' ? node : `<MISSING ${key}>`
  })
}

const ZH = labelsOf('zh-CN')
const EN = labelsOf('en-US')

function state(over: Partial<RRuleState>): RRuleState {
  return { freq: 'NONE', interval: 1, byday: [], end: 'never', count: 10, until: '', ...over }
}

/** 四条代表性规则：周多日 / COUNT 结束 / UNTIL 结束 / 无结束（+ interval>1 的两条）。 */
const CASES: Array<{ name: string; state: RRuleState; rrule: string; zh: string; en: string }> = [
  {
    name: '周多日 · 无结束',
    state: state({ freq: 'WEEKLY', byday: ['MO', 'WE'] }),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
    zh: '每周一、三',
    en: 'Every week(s) on Mon, Wed'
  },
  {
    name: '周多日 · COUNT 结束',
    state: state({ freq: 'WEEKLY', byday: ['MO', 'WE'], end: 'count', count: 10 }),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10',
    zh: '每周一、三，共 10 次',
    en: 'Every week(s) on Mon, Wed, 10 times'
  },
  {
    name: '每天 · UNTIL 结束',
    state: state({ freq: 'DAILY', end: 'until', until: '2026-12-31' }),
    rrule: 'FREQ=DAILY;UNTIL=20261231T235959Z',
    zh: '每天，到 2026-12-31 止',
    en: 'Every day(s), until 2026-12-31'
  },
  {
    name: '每 3 月 · 无结束',
    state: state({ freq: 'MONTHLY', interval: 3 }),
    rrule: 'FREQ=MONTHLY;INTERVAL=3',
    zh: '每 3 月',
    en: 'Every 3 month(s)'
  },
  {
    name: '每 2 周多日（interval>1 换一句，免得读成「每两个周二」）',
    state: state({ freq: 'WEEKLY', interval: 2, byday: ['TU', 'TH'] }),
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
    zh: '每 2 周的二、四',
    en: 'Every 2 week(s) on Tue, Thu'
  }
]

describe('① 编辑器状态 → RRULE 串', () => {
  test.each(CASES)('$name', ({ state: s, rrule }) => {
    expect(buildRRule(s)).toBe(rrule)
  })
})

describe('② parse 原串 → 自然语言回显', () => {
  test.each(CASES)('$name（zh）', ({ rrule, zh }) => {
    expect(summarizeRRule(parseRRule(rrule), ZH)).toBe(zh)
  })
  test.each(CASES)('$name（en）', ({ rrule, en }) => {
    expect(summarizeRRule(parseRRule(rrule), EN)).toBe(en)
  })
})

describe('回显的边角', () => {
  test('不重复时说「不重复」，不说「每 undefined」', () => {
    expect(summarizeRRule(state({}), ZH)).toBe('不重复')
    expect(summarizeRRule(state({}), EN)).toBe('Does not repeat')
  })

  test('星期按周一首序念，与 BYDAY 输出序一致（点选先后不改句子）', () => {
    const clicked = state({ freq: 'WEEKLY', byday: ['FR', 'MO', 'WE'] })
    expect(summarizeRRule(clicked, ZH)).toBe('每周一、三、五')
    expect(buildRRule(clicked)).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
  })

  test('选了「按星期」但一个都没勾 → 退回不带星期的句子（不留空挂着的「的」）', () => {
    expect(summarizeRRule(state({ freq: 'WEEKLY' }), ZH)).toBe('每周')
  })

  test('UNTIL 没填日期时不说半句', () => {
    expect(summarizeRRule(state({ freq: 'DAILY', end: 'until', until: '' }), ZH)).toBe('每天')
  })
})
