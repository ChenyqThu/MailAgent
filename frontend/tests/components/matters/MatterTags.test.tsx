// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { createMattersApi } from '@shared/api/matters'
import type { Matter } from '@shared/api/types/matter'
import i18n from '@shared/i18n'
import { MatterList } from '@shared/components/matters/MatterList'
import {
  applyMatterListQuery,
  DEFAULT_MATTER_LIST_QUERY
} from '@shared/components/matters/matterListQuery'

await i18n.changeLanguage('zh-CN')

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Matter tags UI and API', () => {
  test('uses the matter tag API routes with mutation envelopes', async () => {
    const fetchMock = vi.fn(async () =>
      envelope({
        items: [
          { name: 'launch', color: '--c-accent', shape: 'circle', created_at: null, usage_count: 2 }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createMattersApi('https://mail.example/api')

    await api.listTags()
    await api.setTagStyle('launch', { color: '--c-info', shape: 'diamond' })
    await api.renameTag('launch', 'rollout')
    await api.deleteTag('rollout')

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://mail.example/api/matters/tags',
      'https://mail.example/api/matters/tags/launch',
      'https://mail.example/api/matters/tags/launch/rename',
      'https://mail.example/api/matters/tags/rollout'
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      color: '--c-info',
      shape: 'diamond',
      mutation: { expected_version: null }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      name: 'rollout',
      mutation: { expected_version: null }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({
      mutation: { expected_version: null }
    })
  })

  test('searches matter tags by name (E16 dogfood 轮 2：清单行本身不再渲染标签 chip)', () => {
    const tagged = matter({ tags: ['launch'] })
    const other = matter({ public_id: 'MAT-0002', title: 'Unrelated', tags: [] })

    // 搜索仍按标签名匹配（applyMatterListQuery 不消费 tagDefinitions，行为不变；
    // getOrderedVisibleMatters 已随 v3 查询模型并入 applyMatterListQuery）。
    expect(
      applyMatterListQuery([other, tagged], DEFAULT_MATTER_LIST_QUERY, 'launch', {
        now: Date.now()
      })
    ).toEqual([tagged])

    render(
      <MatterList
        matters={[tagged]}
        query={DEFAULT_MATTER_LIST_QUERY}
        onQueryChange={vi.fn()}
        scopeTotal={1}
        tags={[]}
        selectedId={null}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onManageTags={vi.fn()}
      />
    )

    // E16 —— 行 3 右下角已换成事项类型徽标，标签名不再是清单行的展示面（该矩阵没设
    // matter_type，故整块不渲染）；旧断言「标签名会出现在行里」已随设计变更过期。
    expect(screen.queryByText('launch')).toBeNull()
    expect(screen.queryByText('#launch')).toBeNull()
  })
})

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 1,
    public_id: 'MAT-0001',
    title: 'Vendor launch',
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
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 3,
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
