// @vitest-environment happy-dom
//
// task 08-20 P1-5 —— 清单虚拟化（react-window v2，与通讯录 ContactListPane 同款）。
// 这道闸钉两件事：① DOM 里的行数 ≈ 一屏的行数，不是 rows 的长度（否则「虚拟化」只是名字）；
// ② 视口外的行确实不在 DOM 里（这也是详情 j/k 导航必须带滚动的原因，见 MatterList 里的
// `scrolledSelectionRef`）。
//
// happy-dom 没有 ResizeObserver ⇒ List 量不到容器高度，回落到 `defaultHeight`（720），行高
// 回落到估值（80）—— 于是「一屏」≈ 9 行 + overscan。数字不写死，只断量级。

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

const MATTERS: readonly Matter[] = Array.from({ length: 100 }, (_unused, index) =>
  matter({
    id: index + 1,
    public_id: `MAT-${String(index + 1).padStart(4, '0')}`,
    title: `事项 ${index + 1}`
  })
)

describe('MatterList 虚拟化', () => {
  test('100 条事项只渲染一屏左右的行，末尾那条不在 DOM 里', () => {
    render(list())

    const rendered = document.querySelectorAll('[data-react-window-index]')
    // 实测 12 = 一屏 9（720/80）+ overscan 3。下界防「回落视口塌成 0 → 只渲染 4 行」
    // （那会让首帧只出三四行再补齐），上界防「其实没虚拟化」。
    expect(rendered.length).toBeGreaterThan(6)
    expect(rendered.length).toBeLessThan(25)

    expect(screen.getByText('事项 1')).toBeTruthy()
    expect(screen.queryByText('事项 100')).toBeNull()
  })

  test('头部 chrome（搜索 / 计数 / 筛选）不进虚拟列表，恒在', () => {
    render(list())

    expect(screen.getByPlaceholderText(/搜索/)).toBeTruthy()
    // 命中数读的是 matters.length（100），不是渲染出来的行数。
    expect(screen.getByText('100')).toBeTruthy()
  })
})

function list(): React.ReactElement {
  return (
    <MatterList
      matters={MATTERS}
      // `none` 维度 ⇒ 只有一个无头的组，行序列里全是事项行，便于数数。
      query={{ ...DEFAULT_MATTER_LIST_QUERY, group: 'none' }}
      onQueryChange={vi.fn()}
      scopeTotal={MATTERS.length}
      tags={[]}
      selectedId={null}
      search=""
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
