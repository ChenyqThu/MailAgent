// @vitest-environment happy-dom
//
// 铃铛徽标三档呈现（M3 批 C5 收编 TitleBar 旧徽标）。判据本身在 notificationModel.test.ts；
// 这里测的是**只有真渲染才暴露**的接线：哪一档在什么条件下真的出现在 chrome 上，以及
// tooltip / aria 有没有把数报出去。
//
// 🔴 值得测的那一条是「未读 0 + 有活跃待办」：收编 AgentPendingBadge 前这台机器上有两枚
// 徽标，审批挂着时 chrome 上恒有东西；收编后只剩铃铛，而铃铛的主口径（未读）是 edge 型，
// 读过一眼就清零 —— 待办点是唯一还能表达「还有事没批」的像素，掉了没有别的测试会红。
//
// 数据层整块 mock（`./hooks`）：本组件对通知面板只做开合，请求真假与这三档无关。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import type { NotificationUnreadCount } from '../../src/shared/api/types/notifications'

const hoisted = vi.hoisted(() => ({ unreadData: undefined as NotificationUnreadCount | undefined }))

vi.mock('@shared/components/notifications/hooks', () => ({
  useNotificationUnreadCount: () => ({ data: hoisted.unreadData })
}))
// 面板内容与本测试无关（它自己有 NotificationPanel.test.tsx）；桩掉省去整棵查询树。
vi.mock('@shared/components/notifications/NotificationPanel', () => ({
  NotificationPanel: () => <div data-testid="stub-panel" />
}))

const { NotificationBellBadge } =
  await import('../../src/shared/components/notifications/NotificationBellBadge')

await i18n.changeLanguage('zh-CN')

/** 服务端形状：`unread` 是未读轴，`openActionRequired` 是活跃待办（level 型，不随已读掉）。 */
function counts(unread: number, openActionRequired: number, critical = 0): NotificationUnreadCount {
  return {
    total: unread,
    byCategory: { action_required: 0, reviews: 0, results: unread, system: 0 },
    bySeverity: { info: unread - critical, warn: 0, critical },
    openByCategory: {
      action_required: openActionRequired,
      reviews: 0,
      results: unread,
      system: 0
    }
  }
}

function renderWith(data: NotificationUnreadCount | undefined): HTMLElement {
  hoisted.unreadData = data
  render(<NotificationBellBadge />)
  return screen.getByRole('button')
}

afterEach(() => {
  cleanup()
  hoisted.unreadData = undefined
})

// owner dogfood 反馈②：未读时顶部提示太弱。形态从「整枚按钮换成计数药丸」改成图标右上角
// 的叠加式数字角标（danger 红）。下面盯的是角标真的在、数上限收得住、critical 有加强档。
describe('NotificationBellBadge — 未读数字角标', () => {
  test('未读 > 0 → 铃铛右上角挂数字角标', () => {
    renderWith(counts(3, 0))
    const badge = screen.getByTestId('notification-unread-badge')
    expect(badge.textContent).toBe('3')
    expect(badge.className).toContain('bg-fail') // danger token，不是 accent
  })

  test('未读 ≥ 100 → 收成 99+（角标不被数字撑破）', () => {
    renderWith(counts(100, 0))
    expect(screen.getByTestId('notification-unread-badge').textContent).toBe('99+')
    cleanup()
    // 边界另一侧：99 仍是实数。
    renderWith(counts(99, 0))
    expect(screen.getByTestId('notification-unread-badge').textContent).toBe('99')
  })

  test('critical 未读 → 同一枚角标加强一档（多一圈同色光晕），且不带动画', () => {
    renderWith(counts(2, 0, 1))
    const badge = screen.getByTestId('notification-unread-badge')
    // 加强 = 多一圈描边，而不是换色 / 加动画（标题栏常驻的东西不该动）。
    expect(badge.style.boxShadow).toContain('--c-fail')
    expect(badge.className).not.toContain('animate')
  })

  test('普通未读 → 只有底色描边，没有 critical 那圈光晕', () => {
    renderWith(counts(2, 0))
    expect(screen.getByTestId('notification-unread-badge').style.boxShadow).not.toContain(
      '--c-fail'
    )
  })

  test('未读 0 → 没有角标（不闪一个 0）', () => {
    renderWith(counts(0, 2))
    expect(screen.queryByTestId('notification-unread-badge')).toBeNull()
  })
})

describe('NotificationBellBadge — 待办点（level 型指示）', () => {
  test('未读 0 + 有活跃待办 → 素图标上挂持久待办点，tooltip 报待办数', () => {
    const button = renderWith(counts(0, 2))
    expect(screen.getByTestId('notification-pending-dot')).toBeTruthy()
    expect(button.textContent).toBe('') // 素图标态：没有计数数字
    expect(button.getAttribute('aria-label')).toBe('通知中心 · 2 项待办')
  })

  test('未读 0 + 无待办 → 素图标，无任何点', () => {
    const button = renderWith(counts(0, 0))
    expect(screen.queryByTestId('notification-pending-dot')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('通知中心')
  })

  test('未读 > 0 时不叠待办点（计数徽标已经在说话），但 tooltip 两个数都报', () => {
    const button = renderWith(counts(3, 2))
    expect(screen.queryByTestId('notification-pending-dot')).toBeNull()
    expect(button.textContent).toContain('3')
    expect(button.getAttribute('aria-label')).toBe('通知中心 · 3 条未读 · 2 项待办')
  })

  test('计数还没到（请求未回/失败）→ 素图标、无待办点、不闪假的 0', () => {
    const button = renderWith(undefined)
    expect(screen.queryByTestId('notification-pending-dot')).toBeNull()
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe('通知中心')
  })
})

describe('NotificationBellBadge — 面板落点', () => {
  // 铃铛在右簇**簇首**，右边还挂着帮助按钮和三个 picker；`.theme-popover` 写死的
  // right:12px 会把 380px 面板整个推到视口右上角（偏出约一个面板宽）。
  test('面板右缘对齐铃铛实测位置，而不是 CSS 的 right:12px', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    const button = renderWith(counts(0, 0))
    button.getBoundingClientRect = (): DOMRect =>
      ({
        x: 880,
        y: 6,
        top: 6,
        left: 880,
        right: 900,
        bottom: 28,
        width: 20,
        height: 22,
        toJSON: () => ({})
      }) as DOMRect

    fireEvent.click(button)
    const panel = screen.getByRole('dialog')
    expect(panel.style.right).toBe('100px')
  })
})
