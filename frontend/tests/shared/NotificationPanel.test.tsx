// @vitest-environment happy-dom

// 通知面板 M2 交互的接线测试（批 B5）。纯函数那几条（分日 / 档位换算 / tab 值域 / 铃铛
// 判据）在 notificationModel.test.ts；这里测的是**只有真渲染才会暴露**的三件：
//   ① 切 tab 真的把 category 传给了列表查询（漏传的表现是「切了 tab 列表没变」）；
//   ② hover 菜单点得动，Snooze 档位传的是前端算好的 epoch 毫秒（不是 preset 字符串）；
//   ③ 条目点击按 link 型分流到对应的落地动作（report 走 store-intent + /agents?tab=reports）。
//
// 数据层整块 mock 掉（`./hooks`）：这三件事都与真实请求无关，接了真 fetch 只会把测试
// 变成「能不能连上服务端」。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import type { NotificationItem } from '../../src/shared/api/types/notifications'

const hoisted = vi.hoisted(() => ({
  navigate: vi.fn(),
  quitAndInstall: vi.fn(),
  listSpy: vi.fn(),
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
  useNotificationList: (open: boolean, category: string | null) => {
    hoisted.listSpy(open, category)
    return {
      data: { items: [item()], total: 1, unread: 1, limit: 50, offset: 0 },
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
  useReportNavigation.getState().clear()
})

afterEach(cleanup)

describe('NotificationPanel — tab 行', () => {
  test('渲染 5 个 tab，未读数取 byCategory / total', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((el) => el.textContent)).toEqual(['全部5', '待办2', '审阅', '结果3', '系统'])
  })

  test('切 tab → 列表查询带上该 category（默认 All 不带）', () => {
    render(<NotificationPanel onClose={vi.fn()} />)
    expect(hoisted.listSpy).toHaveBeenLastCalledWith(true, null)

    fireEvent.click(screen.getByRole('tab', { name: '待办' }))
    expect(hoisted.listSpy).toHaveBeenLastCalledWith(true, 'action_required')
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
