// @vitest-environment happy-dom
//
// 0813 dogfood #5/#11 —— 跟进规则的触发列表按设计稿 `triggers.jsx::TriggerList` 重做。
//
// 钉的是**形态与信息**，不是像素：固定的「手动」首行 · 每条一行 + 一句话摘要 · 「添加触发」
// 弹层的三档 · 单条启停/删除 · 底部「N 条触发生效」。上一版那个 2×2 档位卡片网格（本仓自造）
// 一并在这里防止回潮 —— 它正是 owner 说「没有遵循设计」的那块。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { newScheduleValue } from '@shared/components/agents/schedule/migrate'
import { DEFAULT_RULE } from '@shared/components/agents/schedule/types'
import { MatterTriggerEditor } from '@shared/components/matters/MatterTriggerEditor'
import type { MatterTriggerEntry } from '@shared/components/matters/matterSchedule'

await i18n.changeLanguage('zh-CN')
afterEach(cleanup)

// 用与编辑器同一个工厂造 entry —— 手写 anchor/timezone 会造出一份库里不可能出现的形状
// （rrule 的 dtstart 当场炸），测的就不是这里要测的东西了。
const scheduleEntry: MatterTriggerEntry = {
  ...(newScheduleValue({ ...DEFAULT_RULE, freq: 'weekly', weekdays: [1] }) as unknown as Record<
    string,
    unknown
  >),
  id: 'trg_1',
  kind: 'schedule',
  enabled: true
}

describe('MatterTriggerEditor — 设计稿形态', () => {
  test('空列表：只有固定的「手动」首行 + 添加入口 + 「只有手动运行」的说明', () => {
    render(<MatterTriggerEditor entries={[]} onChange={vi.fn()} />)

    expect(screen.getByText('手动')).toBeTruthy()
    expect(screen.getByText('你随时可以在事项对话里让它跑一轮')).toBeTruthy()
    expect(screen.getByText('当前只有手动运行，Agent 不会自己跟进。')).toBeTruthy()
    // 「手动」是陈述不是开关：空列表里一个 switch 都不该有。
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
  })

  test('每条触发一行：档名 + 一句话摘要（排程走与「计划」同源的句子）', () => {
    render(<MatterTriggerEditor entries={[scheduleEntry]} onChange={vi.fn()} />)

    // 行本体 = 那颗可展开的按钮：档名 + 摘要都在它里面（摘要是真的排程句子，
    // 不是「按固定节奏检查一次」这种档位说明）。
    const row = screen.getByRole('button', { expanded: false })
    expect(row.textContent).toContain('定时')
    expect(row.textContent).toMatch(/每周/)
    expect(
      screen.getByText('1 条触发生效，命中任意一条就跑一次；同一时间窗内只跑一次，不会重复触发。')
    ).toBeTruthy()
  })

  test('「添加触发」弹层给三档（手动不在其中——它是那行固定说明），选中即新增一条', () => {
    const onChange = vi.fn()
    render(<MatterTriggerEditor entries={[]} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '添加触发' }))
    const menu = screen.getByRole('menu', { name: '添加触发' })
    expect(within(menu).getByRole('menuitem', { name: /定时/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /事件驱动/ })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /条件/ })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: /手动/ })).toBeNull()
    // 🔴 弹层是 absolute，带框列表是 overflow-hidden —— 菜单落在那层里面就会被裁成一条边。
    // 这条断言钉的正是它的宿主，happy-dom 量不出裁切，但「在不在被裁的盒子里」是确定的。
    expect(menu.closest('.overflow-hidden')).toBeNull()

    fireEvent.click(within(menu).getByRole('menuitem', { name: /事件驱动/ }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as MatterTriggerEntry[]
    expect(next).toHaveLength(1)
    expect(next[0].kind).toBe('event')
    expect(next[0].enabled).toBe(true)
  })

  test('单条可停用、可删除', () => {
    const onChange = vi.fn()
    render(<MatterTriggerEditor entries={[scheduleEntry]} onChange={onChange} />)

    fireEvent.click(screen.getByRole('switch', { name: '启用这条触发' }))
    expect((onChange.mock.calls[0][0] as MatterTriggerEntry[])[0].enabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '删除这条触发' }))
    expect(onChange.mock.calls[1][0]).toEqual([])
  })

  test('存量的 manual entry 不单独占一行，但**留在草稿里**跟着保存回去', () => {
    const manual: MatterTriggerEntry = { id: 'trg_m', kind: 'manual', enabled: true }
    const onChange = vi.fn()
    render(<MatterTriggerEditor entries={[manual, scheduleEntry]} onChange={onChange} />)

    // 「手动」只出现一次 = 那行固定说明（manual entry 没有再画一行）。
    expect(screen.getAllByText('手动')).toHaveLength(1)
    expect(screen.queryAllByRole('switch')).toHaveLength(1)
    // 删掉排程那条，manual entry 原样还在。
    fireEvent.click(screen.getByRole('button', { name: '删除这条触发' }))
    expect(onChange.mock.calls[0][0]).toEqual([manual])
  })
})
