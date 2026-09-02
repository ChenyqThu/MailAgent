// @vitest-environment happy-dom
//
// TitleBar 组装（08-27 标签工作区批重构后：44px 顶栏 = 左段 + 标签条）。
//
// 为什么值得测：控件簇成员是「删/漏了看起来什么都没坏」的那一类改动 —— 这里把簇内
// **顺序与成员**钉住。dogfood 轮4 把右簇整体迁入左段（顺序 = 更新 · 搜索 · 铃铛 ·
// 亮暗 · 快捷键），顶栏右侧完全腾空给标签条：TabStrip 不再收 trailing，右侧零常驻
// 控件 —— 这两条都在下面钉着。
//
// 每个 chrome 件都 mock 成探针 stub：本测试测的是 TitleBar 的组装，不是各件自身的
// 渲染（ThemeToggleButton 有专测 ThemeToggleButton.test.tsx；TabStrip 有专测
// tests/components/tabs/TabStrip.test.tsx）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@shared/components/layout/ThemeToggleButton', () => ({
  ThemeToggleButton: () => <div data-testid="stub-theme" />
}))
vi.mock('@shared/components/layout/UpdateIndicator', () => ({
  UpdateIndicator: () => <div data-testid="stub-update" />
}))
vi.mock('@shared/components/notifications/NotificationBellBadge', () => ({
  NotificationBellBadge: () => <div data-testid="stub-bell" />
}))
vi.mock('@shared/components/tabs/TabStrip', () => ({
  // 探针把收到的 prop 键回显出来 —— 「右侧零常驻控件」的判据就是 TitleBar 什么都
  // 不再传给标签条（trailing 槽已随 dogfood 轮4 删除，传了 typecheck 也会红，这里
  // 是运行时的第二道闸）。
  TabStrip: (props: Record<string, unknown>) => (
    <div data-testid="stub-tabstrip" data-props={Object.keys(props).join(',')} />
  )
}))

import i18n from '../../../src/shared/i18n'
import { TitleBar } from '@shared/components/layout/TitleBar'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

function leftSegment(container: HTMLElement): HTMLElement {
  const left = container.querySelector('header .topbar-left')
  if (!(left instanceof HTMLElement)) throw new Error('左段 .topbar-left 不在 header 内')
  return left
}

/** 控件簇 = 左段行尾那组（stub-update 的父节点）。 */
function cluster(): HTMLElement {
  const parent = screen.getByTestId('stub-update').parentElement
  if (!(parent instanceof HTMLElement)) throw new Error('控件簇容器不在')
  return parent
}

describe('TitleBar — 组装（dogfood 轮4：簇迁左段，右侧腾空给标签条）', () => {
  test('簇内成员与顺序：更新 · 搜索 ⌘K · 通知铃铛 · 亮暗 · 快捷键帮助', () => {
    render(<TitleBar />)
    const members = [...cluster().children].map(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label')
    )
    expect(members).toEqual([
      'stub-update',
      i18n.t('search.title'),
      'stub-bell',
      'stub-theme',
      i18n.t('nav.shortcuts')
    ])
  })

  test('簇在左段内；搜索钮保住 ⌘K 可发现性锚点', () => {
    const { container } = render(<TitleBar />)
    expect(leftSegment(container).contains(cluster())).toBe(true)
    const search = screen.getByRole('button', { name: i18n.t('search.title') })
    expect(search.textContent).toContain('⌘K')
  })

  test('顶栏右侧零常驻控件：TabStrip 不再收任何 prop（trailing 槽已删）', () => {
    render(<TitleBar />)
    const strip = screen.getByTestId('stub-tabstrip')
    expect(strip.getAttribute('data-props')).toBe('')
    expect(strip.childElementCount).toBe(0)
  })

  test('品牌字「MailAgent」已删除（左段只剩红绿灯占位 + 控件簇）', () => {
    const { container } = render(<TitleBar />)
    expect(leftSegment(container).textContent).not.toContain('MailAgent')
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

// ── 09-01 侧栏批：折叠态左段 56px 装不下簇，簇迁标签条右端（design.md §2.4）──────────
// 展开态上面五条原样成立（右侧零常驻控件）；这里钉折叠态的例外：header 三个子节点，
// 簇是第三个、成员与顺序不变，左段挂 data-collapsed。
import { __resetNavShellForTest, useNavShell } from '@shared/state/nav-shell'

describe('TitleBar — 折叠态簇迁右端（09-01 侧栏批）', () => {
  afterEach(() => __resetNavShellForTest())

  test('当前域折叠：header = 左段 · 标签条 · 簇；簇成员顺序不变；左段 data-collapsed', () => {
    __resetNavShellForTest()
    useNavShell.getState().setDomain('today')
    useNavShell.getState().setCollapsed('today', true)
    const { container } = render(<TitleBar />)
    const header = container.querySelector('header')
    const children = [...(header?.children ?? [])]
    expect(children.length).toBe(3)
    expect(children[0]?.classList.contains('topbar-left')).toBe(true)
    expect(children[0]?.getAttribute('data-collapsed')).toBe('true')
    expect(children[1]?.getAttribute('data-testid')).toBe('stub-tabstrip')
    expect(children[2]?.classList.contains('topbar-cluster--trailing')).toBe(true)
    expect(leftSegment(container).contains(cluster())).toBe(false)
    const members = [...cluster().children].map(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('aria-label')
    )
    expect(members).toEqual([
      'stub-update',
      i18n.t('search.title'),
      'stub-bell',
      'stub-theme',
      i18n.t('nav.shortcuts')
    ])
  })

  test('展开态（默认）：簇回到左段，右侧仍零常驻控件', () => {
    __resetNavShellForTest()
    const { container } = render(<TitleBar />)
    expect(container.querySelector('header')?.children.length).toBe(2)
    expect(leftSegment(container).contains(cluster())).toBe(true)
  })
})
