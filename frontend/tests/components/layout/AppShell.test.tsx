// @vitest-environment happy-dom
//
// AppShell 外壳单例 (task 08-20-perf-shell-prefetch-sidebar §②)。
//
// 覆盖三条行为 (08-27 标签工作区批: 底部 StatusBar 退役, 壳只剩 TitleBar + 中行):
//   1. AppShell 结构: TitleBar + 中行(Sidebar + children), children 是中行的直接
//      flex item (dock 挤压正文的前提)。
//   2. 🔴 路由切换 Sidebar 不 remount: root 层 AppShell + <Outlet/> 的接线下, 导航
//      只换内容区 —— Sidebar mount 恰一次、DOM 节点身份不变 (老架构每路由各渲染
//      一份壳, 每次导航 mount 计数 +1)。
//   3. PageFrame 已退化为纯内容容器: 不再渲染任何壳 (data-app-nav / TitleBar
//      都不该出现)。
//
// TitleBar/Sidebar mock 成带 mount 探针的轻量 stub —— 本测试测的是**接线
// 拓扑**(谁挂在哪、挂几次), 不是组件自身的渲染 (它们各有专测)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from '@tanstack/react-router'
import * as React from 'react'

const sidebarMounts = vi.fn()
vi.mock('@shared/components/layout/Sidebar', () => ({
  Sidebar: () => {
    React.useEffect(() => {
      sidebarMounts()
    }, [])
    return <aside data-testid="stub-sidebar" />
  }
}))
vi.mock('@shared/components/layout/TitleBar', () => ({
  TitleBar: () => <header data-testid="stub-titlebar" />
}))

import { AppShell } from '@shared/components/layout/AppShell'
import { PageFrame } from '@shared/components/layout/PageFrame'

beforeEach(() => sidebarMounts.mockClear())
afterEach(() => cleanup())

describe('AppShell — 结构', () => {
  test('TitleBar + 中行(Sidebar + children); children 是中行直接子节点、无底部 footer', () => {
    const { container } = render(
      <AppShell>
        <div data-testid="content">hi</div>
      </AppShell>
    )
    expect(screen.getByTestId('stub-titlebar')).toBeTruthy()
    // 08-27 批: StatusBar 退役 — 壳里不该再有 footer。
    expect(container.querySelector('footer')).toBeNull()
    const content = screen.getByTestId('content')
    const row = content.parentElement!
    // children 与 Sidebar 同为中行的直接子节点 (dock sidebar 模式挤压正文的前提)。
    expect(row.contains(screen.getByTestId('stub-sidebar'))).toBe(true)
    expect(row.className).toContain('flex-1')
    expect(container.firstElementChild!.className).toContain('flex-col')
  })
})

describe('AppShell + Outlet — 路由切换外壳不 remount', () => {
  function makeRouter() {
    const rootRoute = createRootRoute({
      component: () => (
        <AppShell>
          <Outlet />
        </AppShell>
      )
    })
    const aRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <div data-testid="page-a" />
    })
    const bRoute = createRoute({
      getParentRoute: () => rootRoute,
      // 用真实注册过的路径 —— router-instance 的全局 Register 声明把 navigate 的
      // `to` 约束成真实路由并集, 编造 '/b' 会撞 typecheck:tests 棘轮。
      path: '/settings',
      component: () => <div data-testid="page-b" />
    })
    return createRouter({
      routeTree: rootRoute.addChildren([aRoute, bRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] })
    })
  }

  test('🔴 导航换内容区, Sidebar mount 恰一次且 DOM 节点身份不变', async () => {
    const router = makeRouter()
    render(<RouterProvider router={router} />)
    await screen.findByTestId('page-a')
    const sidebarEl = screen.getByTestId('stub-sidebar')
    expect(sidebarMounts).toHaveBeenCalledTimes(1)

    // search 按全局 Register 的 SettingsSearch 类型补上 (本地测试路由无
    // validateSearch, 运行时只是随 URL 携带, 无行为影响)。
    await router.navigate({ to: '/settings', search: { tab: 'general' } })
    await screen.findByTestId('page-b')
    expect(screen.queryByTestId('page-a')).toBeNull()
    // 外壳单例: 没有第二次 mount, 且还是同一个 DOM 节点 (remount 会换新节点)。
    expect(sidebarMounts).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('stub-sidebar')).toBe(sidebarEl)

    await router.navigate({ to: '/' })
    await waitFor(() => expect(screen.queryByTestId('page-a')).toBeTruthy())
    expect(sidebarMounts).toHaveBeenCalledTimes(1)
  })
})

describe('PageFrame — 退化为纯内容容器 (§② 之后不再渲染壳)', () => {
  test('只渲染 <main> + rightDock, 不再有 TitleBar/Sidebar', () => {
    const { container } = render(
      <PageFrame ariaLabel="probe" rightDock={<div data-testid="dock" />}>
        <div data-testid="content" />
      </PageFrame>
    )
    expect(screen.queryByTestId('stub-titlebar')).toBeNull()
    expect(screen.queryByTestId('stub-sidebar')).toBeNull()
    const main = container.querySelector('main[aria-label="probe"]')!
    expect(main).toBeTruthy()
    expect(main.contains(screen.getByTestId('content'))).toBe(true)
    // rightDock 是 <main> 的兄弟 (dock sidebar 模式吃 flex 位的前提), 不是子节点。
    expect(main.contains(screen.getByTestId('dock'))).toBe(false)
    expect(screen.getByTestId('dock')).toBeTruthy()
  })
})
