// @vitest-environment happy-dom
//
// TitleBar 组装（08-27 标签工作区批重构后：44px 顶栏 = 左段 + 标签条）。
//
// 为什么值得测：右簇从「三枚条件徽标 + 铃铛 + …」删成「更新 icon + 铃铛 + …」后，
// 删/漏组件属于「看起来什么都没坏」的改动 —— 这里把簇内**顺序与成员**钉住。08-27
// 重构把右簇从 header 直子挪进 TabStrip 的 trailing 槽，本测试同步锚点：TabStrip
// mock 成「渲染 trailing 的探针」，测的仍是 TitleBar 的组装（TabStrip 自身有专测
// tests/components/tabs/TabStrip.test.tsx）。
//
// 每个 chrome 件都 mock 成探针 stub：本测试测的是 TitleBar 的组装，不是各 picker
// 自身的渲染（它们各有专测）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@shared/components/layout/AccentPickerPopover', () => ({
  AccentPickerPopover: () => <div data-testid="stub-accent" />
}))
vi.mock('@shared/components/layout/SurfacePickerPopover', () => ({
  SurfacePickerPopover: () => <div data-testid="stub-surface" />
}))
vi.mock('@shared/components/layout/ThemePickerPopover', () => ({
  ThemePickerPopover: () => <div data-testid="stub-theme" />
}))
vi.mock('@shared/components/layout/LocalePicker', () => ({
  LocalePicker: () => <div data-testid="stub-locale" />
}))
vi.mock('@shared/components/layout/UpdateIndicator', () => ({
  UpdateIndicator: () => <div data-testid="stub-update" />
}))
vi.mock('@shared/components/notifications/NotificationBellBadge', () => ({
  NotificationBellBadge: () => <div data-testid="stub-bell" />
}))
vi.mock('@shared/components/tabs/TabStrip', () => ({
  TabStrip: ({ trailing }: { trailing?: React.ReactNode }) => (
    <div data-testid="stub-tabstrip">{trailing}</div>
  )
}))

import i18n from '../../../src/shared/i18n'
import { TitleBar } from '@shared/components/layout/TitleBar'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

/** 右簇 = TitleBar 传给 TabStrip 的 trailing 节点（stub 原样渲染成唯一子节点）。 */
function rightCluster(): HTMLElement {
  const cluster = screen.getByTestId('stub-tabstrip').firstElementChild
  if (!(cluster instanceof HTMLElement)) throw new Error('右簇没有经 trailing 传入 TabStrip')
  return cluster
}

describe('TitleBar — 组装', () => {
  test('右簇成员与顺序：更新 icon · 通知铃铛 · 快捷键帮助 · 三个 picker（间以分隔点）', () => {
    render(<TitleBar />)
    const members = [...rightCluster().children].map(
      (el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase()
    )
    expect(members).toEqual([
      'stub-update',
      'stub-bell',
      'button', // 快捷键帮助
      'stub-accent',
      'span', // ·
      'stub-surface',
      'span',
      'stub-theme',
      'span',
      'stub-locale'
    ])
  })

  test('通知铃铛是右簇唯一的告警/待办入口（旧的两枚徽标已收编）', () => {
    render(<TitleBar />)
    expect(screen.getByTestId('stub-bell')).toBeTruthy()
    // 簇内除了铃铛与更新 icon，只剩帮助按钮 + 三个 picker + 分隔点 —— 再冒出第二个徽标
    // 位（无论叫什么）都会被上一条的顺序断言逮住；这里补一句可读的成员数守卫。
    expect(rightCluster().children.length).toBe(10)
  })

  test('左段紧凑 ⌘K 搜索钮还在（居中大搜索钮退役后的唯一可点搜索入口）', () => {
    const { container } = render(<TitleBar />)
    const left = container.querySelector('header .topbar-left')
    if (!(left instanceof HTMLElement)) throw new Error('左段 .topbar-left 不在 header 内')
    const kbtn = [...left.querySelectorAll('button')].find((b) => b.textContent?.includes('⌘K'))
    expect(kbtn).toBeTruthy()
  })

  test('左段在前、标签条在后（标签条吃满剩余宽度，hairline 才能延伸到行末）', () => {
    const { container } = render(<TitleBar />)
    const header = container.querySelector('header')
    const children = [...(header?.children ?? [])]
    expect(children[0]?.classList.contains('topbar-left')).toBe(true)
    expect(children[1]?.getAttribute('data-testid')).toBe('stub-tabstrip')
    expect(children.length).toBe(2)
  })
})
