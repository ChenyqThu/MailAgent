// @vitest-environment happy-dom
//
// V3-05 行内分组的**渲染侧**闸（模型侧在 matterGroups.test.ts）：粘性组头出不出、折叠开关、
// 以及「选中项所在的组不会停在折叠态」这条裁定 —— 折叠是纯视图动作，不许把选中项藏起来。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'
import { MatterList } from '@shared/components/matters/MatterList'
import { DEFAULT_MATTER_LIST_QUERY } from '@shared/components/matters/matterListQuery'
import type { MatterGroupMode } from '@shared/components/matters/matterListQuery'

await i18n.changeLanguage('zh-CN')

afterEach(() => cleanup())

const alpha = matter({ public_id: 'MAT-0001', title: 'Alpha', status: 'active' })
const beta = matter({ public_id: 'MAT-0002', title: 'Beta', status: 'blocked' })

/** 组头与清单行都是 button，且行里的状态 chip 文案与组名同字（「受阻」）—— 按
 *  `aria-expanded` 筛，只有组头有这个属性。 */
function head(label: string, expanded: boolean): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(label), expanded })
}

describe('MatterList 行内分组', () => {
  test('按语义状态出粘性组头（组名 + 计数），命中不到的档整条不渲染', () => {
    renderList()

    const needyou = head('需要你推进', true)
    expect(needyou.className).toContain('sticky')
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
