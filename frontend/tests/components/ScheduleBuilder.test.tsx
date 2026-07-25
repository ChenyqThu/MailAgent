// @vitest-environment happy-dom
//
// 共享排程构建器的组件级测试 —— 锁 PRD 验收项「组件全能力可用」+「预览按规则时区」。
// 注意：happy-dom 不做真实布局，这里断言的是**结构与文案**（控件在场、值回写、预览内容），
// 视觉（flexWrap / 圆钮尺寸）仍需打包后人工确认。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'

import i18n from '@shared/i18n'
import { ScheduleBuilder } from '@shared/components/agents/schedule'
import { DEFAULT_RULE, type ScheduleValue } from '@shared/components/agents/schedule/types'

await i18n.changeLanguage('zh-CN')

beforeAll(() => {
  // Radix Select（时区）在 happy-dom 缺这些 DOM 原语；本文件不展开时区下拉，
  // 但组件挂载时 Radix 会探测它们。
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(
      () => false
    ) as unknown as typeof Element.prototype.hasPointerCapture
  }
})

afterEach(cleanup)

/** 受控外壳：把 onChange 回写进 state，测试才能看到编辑后的渲染。 */
function Harness({
  initial,
  lockFreq = false,
  onValue
}: {
  initial: ScheduleValue
  lockFreq?: boolean
  onValue?: (v: ScheduleValue) => void
}): React.ReactElement {
  const [value, setValue] = useState(initial)
  return (
    <ScheduleBuilder
      value={value}
      lockFreq={lockFreq}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
    />
  )
}

function makeValue(
  over: Partial<ScheduleValue['rule']> = {},
  tz = 'America/Los_Angeles'
): ScheduleValue {
  return {
    v: 1,
    kind: 'schedule',
    rule: { ...DEFAULT_RULE, ...over },
    anchor: '2026-07-01',
    timezone: tz
  }
}

function previewRows(): HTMLElement[] {
  return Array.from(screen.getByTestId('schedule-preview').querySelectorAll('li'))
}

describe('组件全能力（PRD 验收）', () => {
  test('每 N 天：interval 步进上下界 + 回写', () => {
    let last: ScheduleValue | null = null
    render(<Harness initial={makeValue({ freq: 'daily' })} onValue={(v) => (last = v)} />)
    // 下界：interval=1 时「降低频率」禁用
    expect(screen.getByRole('button', { name: '降低频率' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '提高频率' }))
    expect(screen.getByTestId('schedule-interval').textContent).toBe('2')
    expect(last!.rule.interval).toBe(2)
  })

  test('每 N 周 + 多选周几（至少保留一天）', () => {
    render(<Harness initial={makeValue({ freq: 'weekly', weekdays: [2] })} />)
    const tue = screen.getByRole('button', { name: '周二' })
    const thu = screen.getByRole('button', { name: '周四' })
    expect(tue.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(thu)
    expect(screen.getByRole('button', { name: '周四' }).getAttribute('aria-pressed')).toBe('true')
    // 取消到只剩一天后，再点最后一天不生效（周规则至少要有一天）
    fireEvent.click(screen.getByRole('button', { name: '周四' }))
    fireEvent.click(screen.getByRole('button', { name: '周二' }))
    expect(screen.getByRole('button', { name: '周二' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('每月第 N 个星期几 / 最后一个星期几', () => {
    let last: ScheduleValue | null = null
    render(
      <Harness
        initial={makeValue({ freq: 'monthly', monthMode: 'nth' })}
        onValue={(v) => (last = v)}
      />
    )
    fireEvent.change(screen.getByLabelText('第几个'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('星期'), { target: { value: '2' } })
    expect(last!.rule).toMatchObject({ ordinal: 2, weekday: 2 })
    expect(screen.getByTestId('schedule-sentence').textContent).toContain('第 2 个周二')

    fireEvent.change(screen.getByLabelText('第几个'), { target: { value: 'last' } })
    expect(last!.rule.ordinal).toBe('last')
    expect(screen.getByTestId('schedule-sentence').textContent).toContain('最后一个周二')
  })

  test('月末策略 clamp/skip：>28 号才出现，切换即改预览', () => {
    render(<Harness initial={makeValue({ freq: 'monthly', monthMode: 'date', monthDay: 15 })} />)
    // 15 号撞不上短月 → 不渲染月末策略
    expect(screen.queryByRole('button', { name: '跳过该月' })).toBeNull()

    fireEvent.change(screen.getByLabelText('每月几号'), { target: { value: '31' } })
    expect(screen.getByRole('button', { name: '跳过该月' })).toBeTruthy()
    // skip 档：预览里出现「已跳过」ghost 行
    expect(screen.getByTestId('schedule-preview').textContent).toContain('已跳过')

    fireEvent.click(screen.getByRole('button', { name: '顺延到月末' }))
    const text = screen.getByTestId('schedule-preview').textContent ?? ''
    expect(text).toContain('已顺延')
    expect(text).not.toContain('已跳过')
  })

  test('任意小时 + 任意分钟（24 × 60 全域）', () => {
    let last: ScheduleValue | null = null
    render(<Harness initial={makeValue({ freq: 'daily' })} onValue={(v) => (last = v)} />)
    const hour = screen.getByLabelText('小时') as HTMLSelectElement
    const minute = screen.getByLabelText('分钟') as HTMLSelectElement
    expect(within(hour).getAllByRole('option')).toHaveLength(24)
    expect(within(minute).getAllByRole('option')).toHaveLength(60)
    fireEvent.change(hour, { target: { value: '23' } })
    fireEvent.change(minute, { target: { value: '47' } })
    expect(last!.rule).toMatchObject({ hour: 23, minute: 47 })
    // 12 小时制 + AM/PM（dogfood）：23:47 → 11:47 PM
    expect(screen.getByTestId('schedule-sentence').textContent).toContain('11:47 PM')
  })

  test('分钟下拉是纯两位数字，不带前导冒号（dogfood）', () => {
    render(<Harness initial={makeValue({ freq: 'daily' })} />)
    const minute = screen.getByLabelText('分钟') as HTMLSelectElement
    const labels = within(minute)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(labels.slice(0, 4)).toEqual(['00', '01', '02', '03'])
    expect(labels.some((l) => l?.startsWith(':'))).toBe(false)
  })

  test('小时下拉是 AM/PM 制（中文 UI 下也是 AM/PM，不是「上午」）', () => {
    render(<Harness initial={makeValue({ freq: 'daily' })} />)
    const hour = screen.getByLabelText('小时') as HTMLSelectElement
    const labels = within(hour)
      .getAllByRole('option')
      .map((o) => o.textContent)
    expect(labels[0]).toBe('12 AM')
    expect(labels[9]).toBe('9 AM')
    expect(labels[13]).toBe('1 PM')
    expect(labels.some((l) => l?.includes('上午') || l?.includes('时'))).toBe(false)
  })

  test('lockFreq：频率段不渲染（报告 Agent 用）', () => {
    render(<Harness initial={makeValue({ freq: 'weekly' })} lockFreq />)
    expect(screen.queryByRole('button', { name: '按天' })).toBeNull()
    // 频率之外的能力仍在
    expect(screen.getByRole('button', { name: '周一' })).toBeTruthy()
    expect(screen.getByLabelText('小时')).toBeTruthy()
  })
})

describe('🔴 预览按规则时区，不是浏览器本地时区', () => {
  // vitest 全局 TZ 钉死 America/Los_Angeles（vitest.config.ts）。
  test('选 Asia/Shanghai：预览时刻是上海墙钟 9:00 AM + GMT+8', () => {
    render(<Harness initial={makeValue({ freq: 'daily', hour: 9 }, 'Asia/Shanghai')} />)
    const rows = previewRows()
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.textContent).toContain('9:00 AM')
      expect(row.textContent).toContain('GMT+8')
    }
  })

  test('选 America/Los_Angeles：同一规则显示 LA 偏移（GMT-7/-8）', () => {
    render(<Harness initial={makeValue({ freq: 'daily', hour: 9 }, 'America/Los_Angeles')} />)
    for (const row of previewRows()) {
      expect(row.textContent).toContain('9:00 AM')
      expect(row.textContent).toMatch(/GMT-[78]/)
    }
  })

  test('换时区后预览立刻跟着变（不是只改了存储值）', () => {
    // 构建器是受控组件 —— 直接换 value.timezone 重渲染，验证预览真的重算。
    const noop = (): void => {}
    const { rerender } = render(
      <ScheduleBuilder
        value={makeValue({ freq: 'daily', hour: 9 }, 'Asia/Shanghai')}
        onChange={noop}
      />
    )
    expect(previewRows()[0].textContent).toContain('GMT+8')
    rerender(
      <ScheduleBuilder
        value={makeValue({ freq: 'daily', hour: 9 }, 'Europe/Berlin')}
        onChange={noop}
      />
    )
    expect(previewRows()[0].textContent).toMatch(/GMT\+[12]/)
    expect(previewRows()[0].textContent).toContain('9:00 AM')
  })

  // dogfood：默认值本来就是设备时区，但夹在 418 项字母序 IANA 里看不出来 → 顶部加带标注的
  // 快捷项。vitest 全局 TZ 钉死 America/Los_Angeles，故设备时区就是 LA、缩写取到 PT。
  test('时区下拉顶部有「设备时区」标注项，且缩写取到 PT', () => {
    render(<Harness initial={makeValue({ freq: 'daily' })} />)
    const tzSelect = screen.getByLabelText('时区') as HTMLSelectElement
    const first = within(tzSelect).getAllByRole('option')[0]
    expect(first.textContent).toContain('America/Los_Angeles')
    expect(first.textContent).toContain('设备时区')
    expect(first.textContent).toContain('PT')
  })

  test('🔴 顶部快捷项与列表项同 value（存的仍是 IANA 名，无 local 哨兵）', () => {
    render(<Harness initial={makeValue({ freq: 'daily' })} />)
    const tzSelect = screen.getByLabelText('时区') as HTMLSelectElement
    const opts = within(tzSelect).getAllByRole('option') as HTMLOptionElement[]
    expect(opts[0].value).toBe('America/Los_Angeles')
    // 绝不能出现 'local' / '' 这类哨兵：空/哨兵时区正是本批契约消灭的东西
    expect(opts.some((o) => o.value === 'local' || o.value === '')).toBe(false)
    // 同 value 在列表里仍有本体（用户按字母序也找得到）
    expect(opts.filter((o) => o.value === 'America/Los_Angeles')).toHaveLength(2)
  })

  test('选中设备时区时，select 回显带标注那条（同 value 取首个匹配）', () => {
    render(<Harness initial={makeValue({ freq: 'daily' }, 'America/Los_Angeles')} />)
    const tzSelect = screen.getByLabelText('时区') as HTMLSelectElement
    expect(tzSelect.value).toBe('America/Los_Angeles')
    expect(tzSelect.selectedIndex).toBe(0)
  })
})

describe('句子随 locale 切换', () => {
  test('en-US 渲染英文句子 + 12 小时制', async () => {
    await i18n.changeLanguage('en-US')
    try {
      render(<Harness initial={makeValue({ freq: 'weekly', weekdays: [2, 4], hour: 9 })} />)
      expect(screen.getByTestId('schedule-sentence').textContent).toBe(
        'Every week on Tuesday and Thursday at 9:00 AM'
      )
    } finally {
      await i18n.changeLanguage('zh-CN')
    }
  })

  test('zh-CN 是中文语序（不是英文直译）+ AM/PM 时刻', () => {
    render(<Harness initial={makeValue({ freq: 'weekly', weekdays: [2, 4], hour: 9 })} />)
    expect(screen.getByTestId('schedule-sentence').textContent).toBe('每周 周二和周四 9:00 AM')
  })
})
