// @vitest-environment happy-dom
//
// macOS 系统通知点击深跳的接线测试（task 08-20-notification-center M3 批 C1）。
// 老 `matters:navigate` 链（matter_notifications.ts）退役后，通知 fanout 的
// 'notifications:navigate' → useNotificationClickNavigation 是 macOS 通知进事项的
// **唯一**入口 —— 这条链断了没有第二条兜底，且只有真点系统通知才暴露，所以在这里
// 钉死：matter 型 link 必须把 publicId 原样落进 useMatterNavigation 并切到 /matters。
//
// 解析（resolveNotificationLink）的形状判定在 notificationNavigation.test.ts；这里只测
// router-instance 里的落地分支。重量级布局组件全部 mock 成空壳 —— 测的是接线，不是渲染。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import * as React from 'react'

vi.mock('@shared/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('@shared/components/layout/InboxLayout', () => ({ InboxLayout: () => null }))
vi.mock('@shared/components/layout/MattersLayout', () => ({ MattersLayout: () => null }))
vi.mock('@shared/components/command/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@shared/components/keyboard/GlobalShortcuts', () => ({ GlobalShortcuts: () => null }))
vi.mock('@shared/components/keyboard/KeyboardHelpModal', () => ({ KeyboardHelpModal: () => null }))
vi.mock('@shared/components/email/compose/ComposeNewModal', () => ({
  ComposeNewModal: () => null
}))
vi.mock('@shared/components/dev/PopmenuShowcaseMount', () => ({ default: () => null }))

describe('useNotificationClickNavigation — matter 型', () => {
  let handler: ((payload: unknown) => void) | null = null

  beforeEach(() => {
    handler = null
    ;(window as unknown as { api?: unknown }).api = {
      notifications: {
        onNavigate: (h: (p: unknown) => void): (() => void) => {
          handler = h
          return () => {}
        }
      }
    }
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { api?: unknown }).api
  })

  test('matter link → useMatterNavigation.open(publicId) + 跳 /matters', async () => {
    const { router } = await import('../../src/shared/router-instance')
    const { useMatterNavigation } = await import('../../src/shared/components/matters/navigation')
    useMatterNavigation.getState().clear()

    // 🔴 QueryClientProvider 不是装饰：root 路由挂的是**真**组件树，里面已有用
    // react-query 的组件（FeedbackDialog 取账户邮箱做预填）。生产恒有 provider，
    // 所以这里补 harness 而不是让组件去容错。
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(handler).toBeTruthy())

    handler!({ id: 7, payload: { link: { type: 'matter', publicId: 'm_7fa3' } } })

    expect(useMatterNavigation.getState().targetPublicId).toBe('m_7fa3')
    await waitFor(() => expect(router.state.location.pathname).toBe('/matters'))
  })
})
