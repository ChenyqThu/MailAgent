// @vitest-environment happy-dom
//
// WP3 —— 多选底部条的「合并这两条」gating：按钮恒渲染；恰 2 条才触发 onMergePair；
// 其余数量点按只给提示（aria-disabled，不进入合并流程）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import {
  ContactListPane,
  type ContactListPaneProps
} from '@shared/components/contacts/ContactListPane'
import type { ContactRowActions } from '@shared/components/contacts/ContactRow'

await i18n.changeLanguage('zh-CN')

const actions: ContactRowActions = {
  onOpen: vi.fn(),
  onCompose: vi.fn(),
  onComposeCc: vi.fn(),
  onSetKind: vi.fn(),
  onToggleSelf: vi.fn(),
  onToggleHidden: vi.fn(),
  onEnterSelection: vi.fn(),
  onToggleCheck: vi.fn()
}

function renderPane(
  checkedIds: ReadonlySet<number>,
  onMergePair: (pair: [number, number]) => void
) {
  const props: ContactListPaneProps = {
    view: 'known',
    onViewChange: vi.fn(),
    onSearchChange: vi.fn(),
    sort: 'density',
    onSortChange: vi.fn(),
    groupBy: 'none',
    onGroupByChange: vi.fn(),
    density: 'compact',
    onDensityChange: vi.fn(),
    kindFilter: new Set(['person']),
    onKindFilterToggle: vi.fn(),
    // rows 空 + q 空 → 空态渲染（避开 react-window，本测试只关心底部条）。
    rows: [],
    total: 0,
    loading: false,
    onLoadMore: vi.fn(),
    hasMore: false,
    progress: undefined,
    selectedId: null,
    selectionMode: true,
    checkedIds,
    onExitSelection: vi.fn(),
    onMergePair,
    menuOpenId: null,
    onMenuOpenChange: vi.fn(),
    onToggleGroup: vi.fn(),
    actions,
    agentEnabled: false,
    pendingCount: 0,
    onOpenAgent: vi.fn()
  }
  return render(<ContactListPane {...props} />)
}

afterEach(() => cleanup())

describe('ContactListPane 多选条 · 合并 gating', () => {
  test('恰 2 条：按钮可用，点击回传 pair', () => {
    const onMergePair = vi.fn()
    renderPane(new Set([11, 22]), onMergePair)
    const button = screen.getByText('合并这两条')
    expect(button.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(button)
    expect(onMergePair).toHaveBeenCalledWith([11, 22])
  })

  test('1 条：按钮渲染但 aria-disabled，点击不触发合并', () => {
    const onMergePair = vi.fn()
    renderPane(new Set([11]), onMergePair)
    const button = screen.getByText('合并这两条')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(onMergePair).not.toHaveBeenCalled()
  })

  test('3 条：同样只提示不触发', () => {
    const onMergePair = vi.fn()
    renderPane(new Set([1, 2, 3]), onMergePair)
    fireEvent.click(screen.getByText('合并这两条'))
    expect(onMergePair).not.toHaveBeenCalled()
  })
})
