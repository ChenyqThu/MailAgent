// @vitest-environment happy-dom
//
// task 08-27 P3 — calendar-view store 单测: currentDate 联动 (store 侧) +
// 三源开关持久化回读 + 形状校验。freshStore() 用 vi.resetModules 模拟
// "重启后回读 localStorage"。

import { afterEach, describe, expect, test, vi } from 'vitest'

const KEY = 'mailagent.calendar.sources.v1'

async function freshStore(): Promise<typeof import('../../src/shared/state/calendar-view')> {
  vi.resetModules()
  return await import('../../src/shared/state/calendar-view')
}

afterEach(() => {
  window.localStorage.clear()
})

describe('calendar-view store (task 08-27 P3)', () => {
  test('setCurrentDate → 订阅方拿到新值 (主视图翻月 → 小月历跟随的 store 侧)', async () => {
    const { useCalendarView } = await freshStore()
    const target = new Date(2026, 10, 5)
    const seen: Date[] = []
    const unsub = useCalendarView.subscribe((s) => {
      seen.push(s.currentDate)
    })
    useCalendarView.getState().setCurrentDate(target)
    unsub()
    expect(useCalendarView.getState().currentDate.getTime()).toBe(target.getTime())
    expect(seen.at(-1)?.getTime()).toBe(target.getTime())
  })

  test('toggleSource 写 localStorage; 新加载回读同一份', async () => {
    const m1 = await freshStore()
    m1.useCalendarView.getState().toggleSource('matter')
    expect(m1.useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    // 模拟重启 (fresh module) — 开关态从 localStorage 回读
    const m2 = await freshStore()
    expect(m2.useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    // 再翻一次回到全开
    m2.useCalendarView.getState().toggleSource('matter')
    expect(m2.useCalendarView.getState().sources.matter).toBe(true)
  })

  test('形状校验: 非法 JSON / 野值字段 → 回默认', async () => {
    window.localStorage.setItem(KEY, '{"mail":"yes","x":1')
    const m = await freshStore()
    expect(m.useCalendarView.getState().sources).toEqual({ mail: true, matter: true, agent: true })

    window.localStorage.setItem(KEY, JSON.stringify({ mail: false, matter: 'nope' }))
    const m2 = await freshStore()
    expect(m2.useCalendarView.getState().sources).toEqual({
      mail: false,
      matter: true,
      agent: true
    })
  })
})
