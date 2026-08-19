// @vitest-environment happy-dom

/**
 * 「全部确认 / 全部忽略」（0812 dogfood P0 第二条：「一大堆关联只能一个一个关联，没有批量
 * 接口么」）。逐条钮保留，这里盯整批口本身：只送**未确认**的那些 id、执行期间禁用、
 * 结果如实说出「成了几条 / 跳过几条」。
 */

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { Matter, MatterResourceListItem } from '../../src/shared/api/types/matter'
import i18n from '../../src/shared/i18n'
import { MatterSuggestedResourceBulkActions } from '../../src/shared/components/matters/MatterSuggestedResourceActions'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderBulk(resources: MatterResourceListItem[], onChanged = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return render(
    <QueryClientProvider client={client}>
      <MatterSuggestedResourceBulkActions
        matter={matter()}
        resources={resources}
        onChanged={onChanged}
      />
    </QueryClientProvider>
  )
}

function stubBulk(applied: number[], skipped: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          schema_version: 1,
          data: {
            matter: matter(),
            event_ids: applied.map((_, index) => index + 1),
            action: 'confirm',
            applied,
            skipped: [],
            counts: { applied: applied.length, skipped }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('MatterSuggestedResourceBulkActions', () => {
  test('没有建议时整条不渲染', () => {
    const view = renderBulk([resource(1, false), resource(2, false)])
    expect(view.queryByTestId('matter-resource-suggestion-bulk')).toBeNull()
  })

  test('「全部确认」只送未确认的 id，一次请求', async () => {
    const fetchMock = stubBulk([2, 3], 0)
    const onChanged = vi.fn()
    const view = renderBulk([resource(1, false), resource(2, true), resource(3, true)], onChanged)

    expect(view.getByText('2 条 Agent 建议待处置')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /全部确认/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/matters/MAT-0042/resource-suggestions/bulk'
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      action: 'confirm',
      resource_ids: [2, 3],
      mutation: { expected_version: 3 }
    })
  })

  test('「全部忽略」走 reject 动作', async () => {
    const fetchMock = stubBulk([2], 0)
    const view = renderBulk([resource(2, true)])

    fireEvent.click(view.getByRole('button', { name: /全部忽略/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      action: 'reject',
      resource_ids: [2]
    })
  })
})

function matter(): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
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
    updated_at: 1
  }
}

function resource(id: number, suggested: boolean): MatterResourceListItem {
  return {
    resource: {
      id,
      kind: 'email',
      provider: 'mailagent',
      external_key: `email:${id}`,
      canonical_url: null,
      title: `Email ${id}`,
      metadata: {},
      revision: null,
      content_hash: null,
      permission_state: null,
      sync_state: null,
      access_policy: 'allowed',
      last_checked_at: null,
      created_at: 1,
      updated_at: 1,
      available: true
    },
    link: {
      id,
      matter_id: 42,
      resource_id: id,
      relation_type: null,
      pinned: false,
      added_by_kind: suggested ? 'agent' : 'user',
      added_by_id: null,
      confidence: suggested ? 0.7 : null,
      provenance: {},
      confirmed_at: suggested ? null : 1,
      sub_state: 'none',
      deleted_at: null,
      created_at: 1,
      updated_at: 1
    }
  }
}
