// @vitest-environment happy-dom
//
// 「将新建关联」型 change 的审阅面：owner 是在这个界面上按下"接受"的 —— 看不出这是要往
// 事项里加一份外部资料、加的是哪一份，就等于让他盲签。
// 同时钉住引用面：同提案新建的资料还没有 resource_id，不能渲染成一个点得开的 #id 芯片。

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
  background: '',
  goal: '',
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

const update: MatterUpdate = {
  id: 9,
  matter_id: 1,
  review_status: 'pending',
  summary: 'New',
  created_at: 2,
  change_count: 2,
  is_stale: false,
  agent_run_id: 7,
  confidence: 0.8,
  anchored_matter_version: 2,
  created_by_kind: 'agent',
  from_event_id: 1,
  to_event_id: 4,
  original_proposal: { open_questions: [] },
  reviewed_result: null,
  changes: [
    {
      id: 'chg_res',
      kind: 'resource',
      resource: {
        provider: 'notion',
        kind: 'doc',
        external_key: 'page:2f1a4c9e',
        title: 'Q3 上线计划',
        canonical_url: 'https://www.notion.so/2f1a4c9e'
      },
      sources: []
    },
    {
      id: 'chg_fact',
      kind: 'fact',
      text: '上线时间已定在 9/15',
      sources: [{ change_id: 'chg_res' }]
    },
    {
      id: 'chg_fact2',
      kind: 'fact',
      text: '客户已确认',
      sources: [{ resource_id: 42 }]
    }
  ],
  accepted_change_ids: null,
  citations: [],
  stale_at: null,
  stale_reason: null
}

function renderReview(overrides: Partial<Parameters<typeof MatterUpdateReview>[0]> = {}) {
  return render(
    <MatterUpdateReview
      matter={matter}
      update={update}
      onClose={vi.fn()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      {...overrides}
    />
  )
}

describe('MatterUpdateReview — new resource link', () => {
  test('shows that a new resource will be attached, with provider / title / url', () => {
    renderReview()
    expect(screen.getByText('将新建关联')).toBeTruthy()
    expect(screen.getByText('Q3 上线计划')).toBeTruthy()
    expect(screen.getByText('notion · page:2f1a4c9e')).toBeTruthy()
    expect(screen.getByText('https://www.notion.so/2f1a4c9e')).toBeTruthy()
    // 明说"接受后才关联"——这是 owner 按下接受前要理解的因果
    expect(screen.getByText('接受后这份资料才会关联进本事项')).toBeTruthy()
  })

  test('a citation of a same-proposal resource is not a clickable #id chip', () => {
    const openResource = vi.fn()
    renderReview({ onOpenResource: openResource })
    expect(screen.getByText('本提案新建的资料')).toBeTruthy()
    // 已关联资源仍是可点开的 #id
    fireEvent.click(screen.getByText('#42'))
    expect(openResource).toHaveBeenCalledWith(42)
    expect(screen.queryByText('#undefined')).toBeNull()
  })

  test('does not render the new-resource card for a plain confirm-existing change', () => {
    renderReview({
      update: {
        ...update,
        changes: [
          { id: 'chg_res', kind: 'resource', target: { entity: 'resource', id: 7 }, sources: [] }
        ]
      }
    })
    expect(screen.queryByText('将新建关联')).toBeNull()
  })
})
