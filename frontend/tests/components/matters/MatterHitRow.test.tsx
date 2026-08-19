// @vitest-environment happy-dom
//
// G-26 / G-35 —— ⌘K 的事项命中行：语义 StatusChip（与清单行、聚焦页同一颗）+ 「下一步」附行。
// 改动前这里只有一个中性灰药丸写着状态名，且完全不说这件事现在卡在哪。
//
// 下一步吃的是清单端点的 `next_action` 投影（⌘K 走的就是 `GET /matters?q=`），所以这道测试
// 顺带钉住「投影缺失时 fail-soft，不许把命中行渲染成一句谎话」。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'

const { MatterHitRow } = await import('@shared/components/command/MatterHitRow')

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 1,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    background: '',
    goal: '',
    matter_type: null,
    tags: [],
    status: 'waiting',
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

function renderRow(value: Matter): void {
  render(
    <ul>
      <MatterHitRow
        matter={value}
        flatIdx={0}
        selected={false}
        setHighlight={vi.fn()}
        queryTerms={[]}
        onActivate={vi.fn()}
      />
    </ul>
  )
}

describe('MatterHitRow', () => {
  test('shows the status chip and the next step from the list projection', () => {
    renderRow(matter({ next_action: { kind: 'waiting', title: '等法务回签', due_at: null } }))
    expect(screen.getByText('MAT-0042')).toBeTruthy()
    expect(screen.getByText('等待中')).toBeTruthy()
    expect(screen.getByText('等 等法务回签')).toBeTruthy()
  })

  test('falls back to the honest "no next step" line when the projection is absent', () => {
    renderRow(matter({ status: 'active' }))
    expect(screen.getByText('缺少下一步——需要你补一个行动或等待原因')).toBeTruthy()
  })
})
