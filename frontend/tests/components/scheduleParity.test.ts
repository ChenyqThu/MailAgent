// 跨语言 parity —— 契约 §5 的裁判。
//
// 读仓库根 `tests/fixtures/schedule_occurrences.json`（由 Python 侧
// `tests/agents/gen_schedule_fixture.py` 生成），逐 case 比对前端预览的 occurrence 计算与
// Python 求值器 `src/agents/schedule_rule.py`。**PRD 验收项「预览与后端实际触发时刻一致」
// 就靠这条测试兜底** —— 两份独立手写的 recurrence 计算必然在 DST / 月末 / 相位上分叉。
//
// 比对用绝对瞬间（epoch ms）而非字符串：同一瞬间的 ISO 写法可以有多种（offset 表示、
// 秒位省略），字符串相等会把等价值判成不等。
import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { occurrences } from '@shared/components/agents/schedule/occurrences'
import { coerceRule } from '@shared/components/agents/schedule/types'

interface FixtureCase {
  id: string
  rule: Record<string, unknown>
  timezone: string
  anchor: string
  after: string
  expected: string[]
}

interface Fixture {
  note?: string
  occurrences_per_case?: number
  cases: FixtureCase[]
}

// frontend/tests/components/ → 仓库根 tests/fixtures/
const FIXTURE_PATH = resolve(__dirname, '../../../tests/fixtures/schedule_occurrences.json')

const fixture: Fixture | null = existsSync(FIXTURE_PATH)
  ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture)
  : null

describe('跨语言 occurrence parity（黄金 fixture）', () => {
  test('fixture 在场且非空（缺了 = 前后端对齐没有裁判）', () => {
    expect(fixture, `缺少 ${FIXTURE_PATH}（由 Python 侧生成）`).not.toBeNull()
    expect(fixture!.cases.length).toBeGreaterThan(0)
  })

  // 契约 §5 点名必须覆盖的 14 类场景 —— 少一条算没做完，这里锁住 fixture 本身没被削薄。
  test('fixture 覆盖契约 §5 点名的全部场景', () => {
    const ids = new Set(fixture!.cases.map((c) => c.id))
    for (const required of [
      'daily-interval1-baseline',
      'daily-interval3-anchor-phase',
      'daily-interval3-anchor-shifted',
      'weekly-multi-weekday',
      'weekly-interval2-wkst-phase',
      'weekly-interval2-anchor-shifted',
      'monthly-day31-skip',
      'monthly-day31-clamp',
      'monthly-nth-2nd-tuesday',
      'monthly-nth-last-friday',
      'monthly-interval2-phase',
      'dst-spring-forward-la',
      'dst-fall-back-la',
      'dst-gap-0230-la',
      'legacy-weekly-monday-mapping',
      'no-dst-shanghai'
    ]) {
      expect(ids, `fixture 缺 case: ${required}`).toContain(required)
    }
  })

  for (const c of fixture?.cases ?? []) {
    test(`${c.id}`, () => {
      const got = occurrences(
        coerceRule(c.rule),
        c.timezone,
        c.anchor,
        new Date(c.after).getTime(),
        c.expected.length
      ).map((r) => r.utcMs)
      const want = c.expected.map((iso) => new Date(iso).getTime())
      expect(got.length, `occurrence 条数不一致（${c.id}）`).toBe(want.length)
      expect(
        got.map((ms) => new Date(ms).toISOString()),
        `occurrence 不一致（${c.id}）`
      ).toEqual(want.map((ms) => new Date(ms).toISOString()))
    })
  }

  // anchor 差一天 / 差一周的成对 case 必须真的不同 —— 否则「相位以 anchor 为准」只是
  // 巧合通过（两侧都忽略 anchor 也能让逐条比对全绿）。
  test('anchor 移位的成对 case expected 确实不同（证明相位真的参与）', () => {
    const byId = new Map(fixture!.cases.map((c) => [c.id, c]))
    for (const [a, b] of [
      ['daily-interval3-anchor-phase', 'daily-interval3-anchor-shifted'],
      ['weekly-interval2-wkst-phase', 'weekly-interval2-anchor-shifted']
    ]) {
      const ca = byId.get(a)
      const cb = byId.get(b)
      expect(ca, `缺 case ${a}`).toBeTruthy()
      expect(cb, `缺 case ${b}`).toBeTruthy()
      expect(ca!.anchor).not.toBe(cb!.anchor)
      expect(ca!.expected).not.toEqual(cb!.expected)
    }
  })
})
