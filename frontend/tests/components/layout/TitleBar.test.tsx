// @vitest-environment happy-dom
//
// TitleBar 右簇构成（M3 批 C5 摘掉 SystemAlertBadge + TitleBarAgentPendingBadge 之后）。
//
// 为什么值得测：这一批把右簇从「三枚条件徽标 + 铃铛 + …」删成「更新 icon + 铃铛 + …」，
// 而删组件属于「删完看起来什么都没坏」的改动 —— 少删一枚（比如 import 留着、JSX 忘了删）
// 或多删一枚（把更新 icon 顺手删掉）在别的测试里都不会红。这里把簇内**顺序与成员**钉住。
//
// 每个 chrome 件都 mock 成探针 stub：本测试测的是 TitleBar 的组装，不是各 picker 自身的
// 渲染（它们各有专测）。

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

import i18n from '../../../src/shared/i18n'
import { TitleBar } from '@shared/components/layout/TitleBar'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

/** 右簇 = header 的最后一个直接子节点（左侧是红绿灯占位 + brand，中间是 ⌘K 区）。 */
function rightCluster(container: HTMLElement): HTMLElement {
  const header = container.querySelector('header')
  const cluster = header?.lastElementChild
  if (!(cluster instanceof HTMLElement)) throw new Error('右簇不在 header 末位')
  return cluster
}

describe('TitleBar — 右簇', () => {
  test('成员与顺序：更新 icon · 通知铃铛 · 快捷键帮助 · 三个 picker（间以分隔点）', () => {
    const { container } = render(<TitleBar />)
    const cluster = rightCluster(container)
    const members = [...cluster.children].map(
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
    const { container } = render(<TitleBar />)
    expect(screen.getByTestId('stub-bell')).toBeTruthy()
    // 簇内除了铃铛与更新 icon，只剩帮助按钮 + 三个 picker + 分隔点 —— 再冒出第二个徽标
    // 位（无论叫什么）都会被上一条的顺序断言逮住；这里补一句可读的成员数守卫。
    expect(rightCluster(container).children.length).toBe(10)
  })

  test('中间的 ⌘K 按钮还在（右簇改动没有波及中区）', () => {
    render(<TitleBar />)
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('⌘K'))).toBe(true)
  })
})
