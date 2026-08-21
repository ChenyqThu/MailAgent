// @vitest-environment happy-dom
//
// V3-05 行内分组的**渲染侧**闸（模型侧在 matterGroups.test.ts）：组头出不出、折叠开关、
// 以及「选中项所在的组不会停在折叠态」这条裁定 —— 折叠是纯视图动作，不许把选中项藏起来。
//
// task 08-20 起清单虚拟化，组头与事项行一起进 react-window 的行序列（组头因此**不再 sticky**，
// 绝对定位的行里 sticky 不可能生效）；折叠态搬进 `matterWorkspaceStore`（模块级 ⇒ 每个用例前
// 必须复位，否则上一个用例折叠的组会带到下一个）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'
import { MatterList } from '@shared/components/matters/MatterList'
import { DEFAULT_MATTER_LIST_QUERY } from '@shared/components/matters/matterListQuery'
import type { MatterGroupMode } from '@shared/components/matters/matterListQuery'
import { resetMatterWorkspace } from '@shared/components/matters/matterWorkspaceStore'

await i18n.changeLanguage('zh-CN')

beforeEach(() => resetMatterWorkspace())
afterEach(() => cleanup())

const alpha = matter({ public_id: 'MAT-0001', title: 'Alpha', status: 'active' })
const beta = matter({ public_id: 'MAT-0002', title: 'Beta', status: 'blocked' })

/** 组头与清单行都是 button，且行里的状态 chip 文案与组名同字（「受阻」）—— 按
 *  `aria-expanded` 筛，只有组头有这个属性。 */
function head(label: string, expanded: boolean): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(label), expanded })
}

describe('MatterList 行内分组', () => {
  test('按语义状态出组头（组名 + 计数）且组头本身也是虚拟行，命中不到的档整条不渲染', () => {
    renderList()

    const needyou = head('需要你推进', true)
    // 🔴 组头进的是 react-window 的行序列（外层包一层带 data-react-window-index 的行容器），
    // 不是浮在列表之上的第二套 DOM —— 组头留在 List 外面会让滚动坐标与内容对不上。
    expect(needyou.parentElement?.hasAttribute('data-react-window-index')).toBe(true)
    expect(needyou.textContent).toContain('1')
    expect(head('受阻', true)).toBeTruthy()
    // 「等待对方」「监控中」等空档不出现
    expect(screen.queryByText('等待对方')).toBeNull()
    expect(screen.queryByText('监控中')).toBeNull()
  })

  test('点组头折叠本组的行，其它组不受影响', () => {
    renderList()

    fireEvent.click(head('受阻', true))

    expect(screen.queryByText('Beta')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(head('受阻', false)).toBeTruthy()
    expect(screen.getByText('已折叠')).toBeTruthy()
  })

  test('选中项落进折叠组时该组自动展开（导航到看不见的行 = 语义破损）', () => {
    const { rerender } = renderList({ selectedId: 'MAT-0001' })

    fireEvent.click(head('受阻', true))
    expect(screen.queryByText('Beta')).toBeNull()

    // 详情页「下一条」把选中挪进折叠着的「受阻」组
    rerender(list({ selectedId: 'MAT-0002' }))

    expect(screen.getByText('Beta')).toBeTruthy()
    expect(head('受阻', true)).toBeTruthy()
  })

  test('切换分组维度时折叠态复位', () => {
    const { rerender } = renderList()

    fireEvent.click(head('受阻', true))
    expect(screen.queryByText('Beta')).toBeNull()

    rerender(list({ group: 'priority' }))
    rerender(list({ group: 'status' }))

    expect(screen.getByText('Beta')).toBeTruthy()
  })

  // task 08-20 —— 折叠态提升进 store 的**行为**理由：MatterList 随 tab 切换卸载重挂，
  // 状态留在组件里就等于「去看板转一圈回来，手动折叠的组全展开了」。
  test('卸载再挂载：手动折叠的组仍是折叠的（维度没变就不复位）', () => {
    const first = renderList()
    fireEvent.click(head('受阻', true))
    expect(screen.queryByText('Beta')).toBeNull()

    first.unmount()
    renderList()

    expect(screen.queryByText('Beta')).toBeNull()
    expect(head('受阻', false)).toBeTruthy()
  })

  test('不分组维度下没有组头，行照常渲染', () => {
    renderList({ group: 'none' })

    expect(screen.queryByText('需要你推进')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Beta')).toBeTruthy()
  })
})

function list(
  options: { group?: MatterGroupMode; selectedId?: string | null } = {}
): React.ReactElement {
  return (
    <MatterList
      matters={[alpha, beta]}
      query={{ ...DEFAULT_MATTER_LIST_QUERY, group: options.group ?? 'status' }}
      onQueryChange={vi.fn()}
      scopeTotal={2}
      tags={[]}
      selectedId={options.selectedId ?? null}
      search=""
      onSearchChange={vi.fn()}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onManageTags={vi.fn()}
    />
  )
}

function renderList(
  options: { group?: MatterGroupMode; selectedId?: string | null } = {}
): ReturnType<typeof render> {
  return render(list(options))
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 1,
    public_id: 'MAT-0001',
    title: 'Alpha',
    background: '',
    goal: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'unknown',
    priority: 'p1',
    owner_id: null,
    source: 'manual',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 1,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: 1,
    updated_at: 1,
    ...overrides
  }
}
