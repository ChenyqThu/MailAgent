// @vitest-environment happy-dom

// 通知面板 M2 交互的接线测试（批 B5）。纯函数那几条（分日 / 档位换算 / tab 值域 / 铃铛
// 判据）在 notificationModel.test.ts；这里测的是**只有真渲染才会暴露**的四件：
//   ① 切 tab 在**本地**过滤同一份数据（列表查询不带 category —— 加载体验批把按 tab 分
//      查询收敛掉了，回退的表现是切 tab 又开始各自白屏）；
//   ② hover 菜单点得动，Snooze 档位传的是前端算好的 epoch 毫秒（不是 preset 字符串）；
//   ③ 条目点击按 link 型分流到对应的落地动作（report 走 store-intent + /agents?tab=reports）；
//   ④ 首次加载渲染骨架行（不是一行「加载中」文字）。
//
// 数据层整块 mock 掉（`./hooks`）：这些事都与真实请求无关，接了真 fetch 只会把测试
// 变成「能不能连上服务端」。「切 tab 不发第二次请求」那条要看真请求，另在
// notificationPanelSingleQuery.test.tsx。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import type { NotificationItem } from '../../src/shared/api/types/notifications'

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  quitAndInstall: vi.fn(),
  listSpy: vi.fn(),
  /** 每个用例可改写的列表桩态（默认：一条 report 型通知，已加载完）。 */
  listState: { items: null as unknown[] | null, isPending: false },
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  snooze: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => hoisted.navigate }))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ updater: { quitAndInstall: hoisted.quitAndInstall } })
}))

const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 1,
  category: 'results',
  source: 'report',
  severity: 'info',
  state: 'open',
  title: '日报已生成',
  body: '今天 12 封待办',
  payload: { link: { type: 'report', reportId: 'daily-2026-08-21' } },
  recurrenceNo: 1,
  firstCreatedAt: NOW - 60_000,
  lastEventAt: NOW - 60_000,
  readAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  dismissedAt: null,
  ...over
})

// 面板把 `list.dataUpdatedAt` 当「此刻」的基准，固定它 = 相对时间不随机器时间漂。
const NOW = new Date(2026, 7, 21, 14, 30).getTime()

vi.mock('@shared/components/notifications/hooks', () => ({
  // 🔴 单参签名（open）是被测契约的一部分：category 若回到入参，就是「按 tab 分查询」
  // 的回退 —— 下面的 listSpy 断言逐字盯着这件事。
  useNotificationList: (...args: unknown[]) => {
    hoisted.listSpy(...args)
    if (hoisted.listState.isPending) {
      return { data: undefined, dataUpdatedAt: 0, isPending: true, isError: false }
    }
    const items = (hoisted.listState.items as NotificationItem[] | null) ?? [item()]
    return {
      data: { items, total: items.length, unread: 1, limit: 50, offset: 0 },
      dataUpdatedAt: NOW,
      isPending: false,
      isError: false
    }
  },
  useNotificationUnreadCount: () => ({
    data: {
      total: 5,
      byCategory: { action_required: 2, reviews: 0, results: 3, system: 0 },
      bySeverity: { info: 3, warn: 2, critical: 0 },
      openByCategory: { action_required: 2, reviews: 0, results: 3, system: 0 }
    }
  }),
  useMarkNotificationRead: () => ({ mutate: hoisted.markRead }),
  useMarkAllNotificationsRead: () => ({ mutate: hoisted.markAllRead, isPending: false }),
  useSnoozeNotification: () => ({ mutate: hoisted.snooze }),
  useResolveNotification: () => ({ mutate: hoisted.resolve })
}))

const { NotificationPanel } =
  await import('../../src/shared/components/notifications/NotificationPanel')
const { useReportNavigation } = await import('../../src/shared/components/agents/reportNavigation')

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.listState.items = null
  hoisted.listState.isPending = false
  useReportNavigation.getState().clear()
})

afterEach(cleanup)

describe('NotificationPanel — tab 行', () => {
  test('渲染 5 个 tab，未读数取 byCategory / total', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((el) => el.textContent)).toEqual(['全部5', '待办2', '审阅', '结果3', '系统'])
  })

  test('切 tab → 本地过滤同一份数据，查询不带 category', () => {
    hoisted.listState.items = [
      item({ id: 1, category: 'results', title: '日报已生成' }),
      item({ id: 2, category: 'action_required', title: '有一条审批待处理' }),
      item({ id: 3, category: 'system', title: '同步异常' })
    ]
    render(<NotificationPanel onClose={vi.fn()} />)
    // All：三条都在
    expect(screen.getByText('日报已生成')).toBeTruthy()
    expect(screen.getByText('有一条审批待处理')).toBeTruthy()
    expect(screen.getByText('同步异常')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(screen.getByText('有一条审批待处理')).toBeTruthy()
    expect(screen.queryByText('日报已生成')).toBeNull()
    expect(screen.queryByText('同步异常')).toBeNull()

    // 🔴 全程只有 `open` 一个入参：tab 不进查询 = 5 个 tab 共用一份缓存、切 tab 不重取。
    // 把 category 加回入参（按 tab 分键的回退形状）这里必红。
    expect(hoisted.listSpy.mock.calls.every((call) => call.length === 1)).toBe(true)
    expect(hoisted.listSpy).toHaveBeenLastCalledWith(true)
  })

  test('「全部标为已读」标的是当前 tab（All = 全部 → undefined）', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /全部标为已读/ }))
    expect(hoisted.markAllRead).toHaveBeenCalledWith(undefined)

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    fireEvent.click(screen.getByRole('button', { name: /全部标为已读/ }))
    expect(hoisted.markAllRead).toHaveBeenLastCalledWith('action_required')
  })

  test('当前 tab 没有未读时「全部标为已读」是禁用的（点了也不发请求）', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: '审阅' })) // byCategory.reviews = 0

    const button = screen.getByRole('button', { name: /全部标为已读/ })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(hoisted.markAllRead).not.toHaveBeenCalled()
  })
})

describe('NotificationPanel — 行菜单', () => {
  test('⋯ 打开菜单：Snooze 三档 + 标记为已处理', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))

    expect(screen.getByRole('menuitem', { name: /稍后提醒/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /标记为已处理/ })).toBeTruthy()
  })

  test('标记为已处理 → resolve 该行', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /标记为已处理/ }))

    expect(hoisted.resolve).toHaveBeenCalledWith(1)
  })

  test('Snooze「明天早上」→ 传的是前端算好的次日 08:00 epoch 毫秒', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /稍后提醒/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '明天早上' }))

    expect(hoisted.snooze).toHaveBeenCalledTimes(1)
    const arg = hoisted.snooze.mock.calls[0][0] as { id: number; untilMs: number }
    expect(arg.id).toBe(1)
    const until = new Date(arg.untilMs)
    // 用「此刻」现算期望值（用例不钉死运行日期）：次日 08:00 本地时区。
    const now = new Date()
    const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8)
    expect(until.getTime()).toBe(expected.getTime())
  })
})

describe('NotificationPanel — 首次加载', () => {
  test('isPending → 渲染骨架行（不是一行「加载中」文字，也不是空态）', () => {
    hoisted.listState.isPending = true
    render(<NotificationPanel onClose={vi.fn()} />)

    expect(screen.getByTestId('notification-list-skeleton')).toBeTruthy()
    // 空态与骨架互斥：数据还没来就说「没有新通知」是最糟的一种误导。
    expect(screen.queryByText('没有新通知')).toBeNull()
  })

  test('加载完 → 骨架让位真实行', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    expect(screen.queryByTestId('notification-list-skeleton')).toBeNull()
    expect(screen.getByText('日报已生成')).toBeTruthy()
  })

  // 头部与 tab 行在数据到达前就能用（全部标为已读读的是另一条查询）—— 骨架只吃列表体。
  test('骨架期间头部与 tab 行照常渲染', () => {
    hoisted.listState.isPending = true
    render(<NotificationPanel onClose={vi.fn()} />)
    expect(screen.getAllByRole('tab').length).toBe(5)
    expect(screen.getByRole('button', { name: /全部标为已读/ })).toBeTruthy()
  })
})

describe('NotificationPanel — 条目点击', () => {
  test('report 型：标已读 + store-intent 点名报告 + 跳 /agents?tab=reports', () => {
    const onClose = vi.fn()
    render(<NotificationPanel onClose={onClose} />)

    fireEvent.click(screen.getByText('日报已生成'))

    expect(hoisted.markRead).toHaveBeenCalledWith(1)
    expect(useReportNavigation.getState().targetReportId).toBe('daily-2026-08-21')
    expect(hoisted.navigate).toHaveBeenCalledWith({ to: '/agents', search: { tab: 'reports' } })
    expect(onClose).toHaveBeenCalled()
  })
})
