// @vitest-environment happy-dom
//
// 提案失效面：文案说的是"基线变了"而不是"到期"，且卡上直接给一颗重新跑的出口
// （原来失效后只能拒绝，再自己回详情页点「立即跟进」）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterUpdate } from '@shared/api/types/matter'
import { MatterUpdateReview } from '@shared/components/matters/MatterUpdateReview'

await i18n.changeLanguage('zh-CN')
afterEach(cleanup)

const matter: Matter = {
  id: 1,
  public_id: 'MAT-0001',
  title: 'Launch',
  description: '',
  matter_type: null,
  tags: [],
  status: 'active',
  health: 'on_track',
  priority: 'p1',
  owner_id: null,
  source: 'desktop_ui',
  due_at: null,
  waiting_context: null,
  next_attention_at: null,
  attention_reason: null,
  last_activity_at: null,
  latest_accepted_update_id: null,
  current_summary: 'Old',
  summary_at: null,
  summary_by_kind: null,
  summary_by_id: null,
  version: 2,
  archived_at: null,
  archived_by_kind: null,
  archived_by_id: null,
  deleted_at: null,
  deleted_by_kind: null,
  deleted_by_id: null,
  purge_after: null,
  created_at: 1,
  updated_at: 1
}

const staleUpdate: MatterUpdate = {
  id: 9,
  matter_id: 1,
  review_status: 'pending',
  summary: 'New',
  created_at: 2,
  change_count: 1,
  is_stale: true,
  agent_run_id: 7,
  confidence: 0.8,
  anchored_matter_version: 2,
  created_by_kind: 'agent',
  from_event_id: 1,
  to_event_id: 4,
  original_proposal: { open_questions: [] },
  reviewed_result: null,
  changes: [{ id: 'c1', kind: 'fact', text: 'Confirmed', sources: [] }],
  accepted_change_ids: null,
  citations: [],
  stale_at: 3,
  stale_reason: 'matter_version_advanced'
}

describe('MatterUpdateReview stale surface', () => {
  test('labels the stale state as a changed baseline, not an expiry', () => {
    render(
      <MatterUpdateReview
        matter={matter}
        update={staleUpdate}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByText('基线已变')).toBeTruthy()
    expect(screen.queryByText(/已过期/)).toBeNull()
  })

  test('offers a rerun escape hatch when the parent wires it', () => {
    const rerun = vi.fn()
    render(
      <MatterUpdateReview
        matter={matter}
        update={staleUpdate}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRerun={rerun}
      />
    )
    fireEvent.click(screen.getByText('重新跑一轮'))
    expect(rerun).toHaveBeenCalledTimes(1)
  })

  test('hides the rerun button when the parent did not wire it', () => {
    render(
      <MatterUpdateReview
        matter={matter}
        update={staleUpdate}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.queryByText('重新跑一轮')).toBeNull()
  })

  test('does not render the stale surface on a healthy proposal', () => {
    render(
      <MatterUpdateReview
        matter={matter}
        update={{ ...staleUpdate, is_stale: false, stale_at: null, stale_reason: null }}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onRerun={vi.fn()}
      />
    )
    expect(screen.queryByText('基线已变')).toBeNull()
    expect(screen.queryByText('重新跑一轮')).toBeNull()
  })
})
