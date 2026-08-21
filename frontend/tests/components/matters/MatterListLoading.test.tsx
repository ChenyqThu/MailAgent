// @vitest-environment happy-dom
//
// task 08-20 P0-2 —— 清单的加载态。这道闸钉的是**「加载中永远不许出空态」**这一条裁定：
// 冷启动时列表里一行都没有，旧代码直接落到「暂无事项 + 新建按钮」的空态上，用户读到的是
// 「你没有事项」而不是「还在加载」。
//
// 三条分叉必须互斥：loading 且无行 → 骨架；有行 → 行（哪怕仍在后台刷新，也不许把已经能看的
// 内容换成骨架）；不 loading 且无行 → 才是真空态。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'
import { MatterList } from '@shared/components/matters/MatterList'
import { DEFAULT_MATTER_LIST_QUERY } from '@shared/components/matters/matterListQuery'
import { resetMatterWorkspace } from '@shared/components/matters/matterWorkspaceStore'

await i18n.changeLanguage('zh-CN')

beforeEach(() => resetMatterWorkspace())
afterEach(() => cleanup())

describe('MatterList 加载态', () => {
  test('加载中且一行都没有 → 出骨架，绝不出「暂无事项」空态', () => {
    render(list({ matters: [], loading: true }))

    expect(screen.getByTestId('matter-list-skeleton')).toBeTruthy()
    expect(screen.queryByText(/暂无/)).toBeNull()
    expect(screen.queryByRole('button', { name: '新建事项' })).toBeNull()
  })

  test('已经有行时不出骨架（后台刷新不许把能看的内容藏起来）', () => {
    render(list({ matters: [alpha], loading: true }))

    expect(screen.queryByTestId('matter-list-skeleton')).toBeNull()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  test('不在加载且确实没有事项 → 才是空态', () => {
    render(list({ matters: [], loading: false }))

    expect(screen.queryByTestId('matter-list-skeleton')).toBeNull()
    expect(screen.getByRole('button', { name: '新建事项' })).toBeTruthy()
  })
})

const alpha = matter({ public_id: 'MAT-0001', title: 'Alpha' })

function list({
  matters,
  loading
}: {
  matters: readonly Matter[]
  loading: boolean
}): React.ReactElement {
  return (
    <MatterList
      matters={matters}
      query={DEFAULT_MATTER_LIST_QUERY}
      onQueryChange={vi.fn()}
      scopeTotal={matters.length}
      tags={[]}
      selectedId={null}
      search=""
      loading={loading}
      onSearchChange={vi.fn()}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
      onManageTags={vi.fn()}
    />
  )
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
