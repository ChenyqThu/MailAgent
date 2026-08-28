// @vitest-environment happy-dom
//
// task 08-27 P3 / dogfood 轮 2 — calendar-view store 单测:
//   · currentDate 联动 (store 侧)
//   · 组级开关 setGroupAll + 成员级排除集 toggleMember 的持久化回读与形状校验
//   · 「按日历筛选」下拉写回 setSelectedMembers (选中集 → 排除集)
//   · v1 老形状 (只有三个 bool) 迁移 → 排除集为空
// freshStore() 用 vi.resetModules 模拟 "重启后回读 localStorage"。

import { afterEach, describe, expect, test, vi } from 'vitest'

const KEY = 'mailagent.calendar.sources.v1'

async function freshStore(): Promise<typeof import('../../src/shared/state/calendar-view')> {
  vi.resetModules()
  return await import('../../src/shared/state/calendar-view')
}

function persisted(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Record<string, unknown>
}

afterEach(() => {
  window.localStorage.clear()
})

describe('calendar-view store — currentDate (task 08-27 P3)', () => {
  test('setCurrentDate → 订阅方拿到新值 (二级栏日历源树按它算聚合窗口)', async () => {
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
})

describe('calendar-view store — 组级开关 (dogfood 轮 2)', () => {
  test('setGroupAll(false) 写 localStorage; 新加载回读同一份', async () => {
    const m1 = await freshStore()
    m1.useCalendarView.getState().setGroupAll('matter', false)
    expect(m1.useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    expect(persisted()).toMatchObject({ mail: true, matter: false, agent: true })

    // 模拟重启 (fresh module) — 开关态从 localStorage 回读
    const m2 = await freshStore()
    expect(m2.useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    m2.useCalendarView.getState().setGroupAll('matter', true)
    expect(m2.useCalendarView.getState().sources.matter).toBe(true)
  })

  test('组头开/关都清空该组排除集 (组再开回来 = 全选)', async () => {
    const { useCalendarView } = await freshStore()
    useCalendarView.getState().toggleMember('agent', 'a1', ['a1', 'a2'])
    expect([...useCalendarView.getState().excluded.agent]).toEqual(['a1'])

    useCalendarView.getState().setGroupAll('agent', false)
    expect(useCalendarView.getState().sources.agent).toBe(false)
    expect(useCalendarView.getState().excluded.agent.size).toBe(0)

    useCalendarView.getState().setGroupAll('agent', true)
    expect(useCalendarView.getState().sources.agent).toBe(true)
    expect(useCalendarView.getState().excluded.agent.size).toBe(0)
    // 别的组不受影响
    expect(useCalendarView.getState().sources.mail).toBe(true)
  })
})

describe('calendar-view store — 成员排除集 (dogfood 轮 2)', () => {
  test('勾掉一条 → 进排除集; 组开关不动; 持久化回读还是 Set', async () => {
    const m1 = await freshStore()
    m1.useCalendarView.getState().toggleMember('matter', 'MAT-2', ['MAT-1', 'MAT-2', 'MAT-3'])
    expect([...m1.useCalendarView.getState().excluded.matter]).toEqual(['MAT-2'])
    expect(m1.useCalendarView.getState().sources.matter).toBe(true)
    expect(persisted().excluded).toEqual({ mail: [], matter: ['MAT-2'], agent: [] })

    const m2 = await freshStore()
    const ex = m2.useCalendarView.getState().excluded.matter
    expect(ex.has('MAT-2')).toBe(true)
    // 排除集里没有的成员 (含窗口里新冒出来的) 天然选中
    expect(ex.has('MAT-1')).toBe(false)
    expect(ex.has('MAT-9-新建的')).toBe(false)

    // 再点一次勾回来
    m2.useCalendarView.getState().toggleMember('matter', 'MAT-2', ['MAT-1', 'MAT-2', 'MAT-3'])
    expect(m2.useCalendarView.getState().excluded.matter.size).toBe(0)
  })

  test('把最后一条也勾掉 → 收敛成「组关 + 排除集清空」', async () => {
    const { useCalendarView } = await freshStore()
    const members = ['Work', 'Home']
    useCalendarView.getState().toggleMember('mail', 'Work', members)
    expect(useCalendarView.getState().sources.mail).toBe(true)

    useCalendarView.getState().toggleMember('mail', 'Home', members)
    expect(useCalendarView.getState().sources.mail).toBe(false)
    expect(useCalendarView.getState().excluded.mail.size).toBe(0)
    expect(persisted()).toMatchObject({ mail: false })
  })

  test('陈旧排除 id (已不在成员里) 不算进「是不是全关了」', async () => {
    const { useCalendarView } = await freshStore()
    // 老的排除集里有两个已经不存在的事项
    useCalendarView.getState().setSelectedMembers('matter', ['旧-1', '旧-2'], [])
    useCalendarView.getState().toggleMember('matter', '旧-1', ['旧-1', '旧-2'])
    useCalendarView.getState().toggleMember('matter', '旧-2', ['旧-1', '旧-2'])
    // 现在成员换成了另外两条, 勾掉其中一条不该把整组关掉
    useCalendarView.getState().setGroupAll('matter', true)
    useCalendarView.getState().toggleMember('matter', '新-1', ['新-1', '新-2'])
    expect(useCalendarView.getState().sources.matter).toBe(true)
    expect([...useCalendarView.getState().excluded.matter]).toEqual(['新-1'])
  })

  test('组关着时点某一条 = 只看这一条 (开组 + 排除其余)', async () => {
    const { useCalendarView } = await freshStore()
    useCalendarView.getState().setGroupAll('agent', false)
    useCalendarView.getState().toggleMember('agent', 'a2', ['a1', 'a2', 'a3'])
    expect(useCalendarView.getState().sources.agent).toBe(true)
    expect([...useCalendarView.getState().excluded.agent].sort()).toEqual(['a1', 'a3'])
  })
})

describe('calendar-view store — 「按日历筛选」下拉写回 (dogfood 轮 2)', () => {
  test('选中集 → 排除集; 空选中集 = 全选 (下拉既有语义)', async () => {
    const { useCalendarView } = await freshStore()
    const all = ['Work', 'Home', 'Shared']
    useCalendarView.getState().setSelectedMembers('mail', all, ['Work'])
    expect([...useCalendarView.getState().excluded.mail].sort()).toEqual(['Home', 'Shared'])
    // 组开关不受下拉影响
    expect(useCalendarView.getState().sources.mail).toBe(true)

    useCalendarView.getState().setSelectedMembers('mail', all, [])
    expect(useCalendarView.getState().excluded.mail.size).toBe(0)
  })
})

describe('calendar-view store — 形状校验与老形状迁移', () => {
  test('v1 老形状 (只有三个 bool) → 开关照读, 排除集为空', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ mail: true, matter: false, agent: true }))
    const m = await freshStore()
    expect(m.useCalendarView.getState().sources).toEqual({
      mail: true,
      matter: false,
      agent: true
    })
    expect(m.useCalendarView.getState().excluded).toEqual({
      mail: new Set(),
      matter: new Set(),
      agent: new Set()
    })
  })

  test('非法 JSON / 野值字段 → 回默认', async () => {
    window.localStorage.setItem(KEY, '{"mail":"yes","x":1')
    const m = await freshStore()
    expect(m.useCalendarView.getState().sources).toEqual({ mail: true, matter: true, agent: true })
    expect(m.useCalendarView.getState().excluded.mail.size).toBe(0)

    window.localStorage.setItem(KEY, JSON.stringify({ mail: false, matter: 'nope' }))
    const m2 = await freshStore()
    expect(m2.useCalendarView.getState().sources).toEqual({
      mail: false,
      matter: true,
      agent: true
    })
  })

  test('排除集野值: 非数组整段丢弃, 数组里的非字符串项剔除', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        mail: true,
        matter: true,
        agent: true,
        excluded: { mail: 'Work', matter: ['MAT-1', 7, null, 'MAT-2'], agent: null }
      })
    )
    const m = await freshStore()
    const ex = m.useCalendarView.getState().excluded
    expect(ex.mail.size).toBe(0)
    expect([...ex.matter]).toEqual(['MAT-1', 'MAT-2'])
    expect(ex.agent.size).toBe(0)
  })
})
