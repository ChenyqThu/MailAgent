// @vitest-environment happy-dom
//
// 主标签面包屑第二段的页面侧接线（task 08-27-l4-tab-workspace P2 收口）。
//
// 钉的是 `useMainBreadcrumb` 的守卫语义 —— 这个 hook 存在的全部理由就是那道守卫：
// React 的 effect 自下而上跑，进一个承载时**页面的 effect 先跑**、RootLayout 的
// `useTabRouteSync`（setMainPage，会清第二段）后跑。页面无脑写 = 恒被清成单段。
// 守卫之后，setMainPage 落地让 isCurrent 由 false 翻 true，effect 再跑一次补上。
//
// store 的持久化走 try/catch 静默降级（同 TabStrip.test.tsx），这里不断言持久化。

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { MAIN_SLOT, useTabWorkspace, type MainPage } from '@shared/state/tab-workspace'

/** 八个承载页的接线形态（一句 hook 调用，依赖页面内的选中态）。 */
function Carrier({ page, text }: { page: MainPage; text: string | null }): null {
  useMainBreadcrumb(page, text)
  return null
}

function crumb(): string | null {
  return useTabWorkspace.getState().mainBreadcrumb
}

beforeEach(() => {
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8
  })
})

afterEach(cleanup)

describe('useMainBreadcrumb', () => {
  test('承载正是当前主标签 → 写第二段', () => {
    act(() => {
      useTabWorkspace.getState().setMainPage('settings')
    })
    render(<Carrier page="settings" text="AI" />)
    expect(crumb()).toBe('AI')
  })

  test('🔴 mainPage 还没落到本承载 → 不写；落地后自己补上', () => {
    // 进一个承载的真实时序：页面已挂载（effect 已跑）而路由收敛还没到。
    render(<Carrier page="settings" text="AI" />)
    expect(crumb()).toBeNull()

    act(() => {
      useTabWorkspace.getState().setMainPage('settings')
    })
    expect(crumb()).toBe('AI')
  })

  test('同一承载内换选中态（切分节）→ 第二段跟着变', () => {
    act(() => {
      useTabWorkspace.getState().setMainPage('settings')
    })
    const { rerender } = render(<Carrier page="settings" text="AI" />)
    expect(crumb()).toBe('AI')

    rerender(<Carrier page="settings" text="通知" />)
    expect(crumb()).toBe('通知')
  })

  test('切走承载：store 自己清成 null，且留在场的旧页面不再写回', () => {
    act(() => {
      useTabWorkspace.getState().setMainPage('settings')
    })
    const { rerender } = render(<Carrier page="settings" text="AI" />)
    expect(crumb()).toBe('AI')

    // 换承载 —— 页面卸载前 setMainPage 已经清掉（所以页面不需要在卸载时清）。
    act(() => {
      useTabWorkspace.getState().setMainPage('calendar')
    })
    expect(crumb()).toBeNull()

    // 旧页面还没卸载又 render 了一轮（新承载的第二段这时可能已经写好），
    // 守卫必须挡住它把别人的第二段覆盖掉。
    rerender(<Carrier page="settings" text="通知" />)
    expect(crumb()).toBeNull()
  })

  test('传 null = 单段（页面没有选中态时）', () => {
    act(() => {
      useTabWorkspace.getState().setMainPage('contacts')
    })
    const { rerender } = render(<Carrier page="contacts" text="张三" />)
    expect(crumb()).toBe('张三')

    rerender(<Carrier page="contacts" text={null} />)
    expect(crumb()).toBeNull()
  })
})
