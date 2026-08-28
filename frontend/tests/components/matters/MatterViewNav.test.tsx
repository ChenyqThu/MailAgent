// @vitest-environment happy-dom
//
// 事项二级栏顶部视图行的渲染侧闸。编排侧（切视图后主区换什么、创建弹窗开不开）在
// MattersWorkspaceSelection.test.tsx —— 这里只钉组件自己的三件事：单行三个入口、选中态落在
// 当前视图上、看板角标按数值显隐。角标经 MattersWorkspace 的口径算出后由 props 传进来，
// 从工作台那侧的桩数据永远是 0，只有直接渲染才测得到。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import { MatterViewNav } from '@shared/components/matters/MatterViewNav'
import type { MatterTab } from '@shared/components/matters/matterListQuery'

await i18n.changeLanguage('zh-CN')

afterEach(() => cleanup())

function renderNav(
  overrides: Partial<{
    tab: MatterTab
    boardBadge: number
    onSelectTab: (tab: MatterTab) => void
    onCreate: () => void
  }> = {}
): { onSelectTab: (tab: MatterTab) => void; onCreate: () => void; host: HTMLElement } {
  const onSelectTab = overrides.onSelectTab ?? vi.fn()
  const onCreate = overrides.onCreate ?? vi.fn()
  render(
    <MatterViewNav
      tab={overrides.tab ?? 'board'}
      boardBadge={overrides.boardBadge ?? 0}
      onSelectTab={onSelectTab}
      onCreate={onCreate}
    />
  )
  const host = document.querySelector('[data-matter-view-nav]')
  if (!host) throw new Error('view nav not rendered')
  return { onSelectTab, onCreate, host: host as HTMLElement }
}

describe('MatterViewNav — 单行形态', () => {
  test('两个视图钮与「新建」同在一行，选中态落在当前视图上', () => {
    const { host } = renderNav({ tab: 'list' })

    const names = within(host)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(names).toEqual(['今日看板', '事项', '新建事项'])

    expect(within(host).getByRole('button', { name: '事项' }).getAttribute('aria-current')).toBe(
      'page'
    )
    expect(
      within(host).getByRole('button', { name: '今日看板' }).getAttribute('aria-current')
    ).toBeNull()
  })

  test('点视图钮回调对应的 tab，点「新建」回调创建', () => {
    const { host, onSelectTab, onCreate } = renderNav({ tab: 'board' })

    fireEvent.click(within(host).getByRole('button', { name: '事项' }))
    expect(onSelectTab).toHaveBeenCalledWith('list')

    fireEvent.click(within(host).getByRole('button', { name: '新建事项' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('看板角标 >0 才出，0 时整块不渲染（不留一个空圆点）', () => {
    const { host } = renderNav({ boardBadge: 3 })
    expect(within(host).getByRole('button', { name: /今日看板/ }).textContent).toContain('3')

    cleanup()
    const zero = renderNav({ boardBadge: 0 })
    expect(within(zero.host).getByRole('button', { name: '今日看板' }).textContent).toBe('今日看板')
  })

  test('「新建」可视文案压短，无障碍名仍是完整的「新建事项」', () => {
    renderNav()
    const create = screen.getByRole('button', { name: '新建事项' })
    expect(create.textContent).toBe('新建')
  })
})
