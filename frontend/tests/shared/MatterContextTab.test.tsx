// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { Matter, MatterResourceListItem } from '../../src/shared/api/types/matter'
import i18n from '../../src/shared/i18n'
import { MatterContextRail } from '../../src/shared/components/matters/MatterContextRail'
import { MatterContextTab } from '../../src/shared/components/matters/MatterContextTab'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MatterContextTab', () => {
  test('renders canonical resource groups and subscription state', () => {
    const view = renderTab([
      resource('email', 'Vendor email', 'none'),
      resource('thread', 'Vendor thread', 'active'),
      resource('doc', 'Contract', 'none')
    ])
    expect(view.getByText('邮件与会话')).toBeTruthy()
    expect(view.getByText('文档')).toBeTruthy()
    expect(view.getByText('已订阅后续')).toBeTruthy()
  })

  test('renders stakeholder and resource empty states', () => {
    const view = renderTab([])
    expect(view.getByText('还没有干系人')).toBeTruthy()
    expect(view.getByText('还没有关联资料')).toBeTruthy()
  })

  test('distinguishes suggestions and confirms them with the backend confidence and reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'success',
      schema_version: 1,
      data: { matter: matter(), event_ids: [] }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    const item = resource('email', 'Suggested vendor email', 'none', true)
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <MatterContextTab
          matter={matter()}
          items={[]}
          resources={[item]}
          stakeholders={[]}
          onOpenResource={vi.fn()}
          onChanged={onChanged}
        />
      </QueryClientProvider>
    )

    expect(view.getAllByText('建议态').length).toBeGreaterThan(0)
    expect(view.getByText('同一会话中的近期回复')).toBeTruthy()
    expect(view.getByText(/置信度 76%/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /确认关联/ }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/matters/MAT-0042/resources/${item.resource.id}`)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ confirmed: true })
  })

  test('rejects a suggestion through the rejection-memory endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'success',
      schema_version: 1,
      data: { matter: matter(), event_ids: [] }
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onChanged = vi.fn()
    const item = resource('email', 'Irrelevant vendor email', 'none', true)
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <MatterContextTab
          matter={matter()}
          items={[]}
          resources={[item]}
          stakeholders={[]}
          onOpenResource={vi.fn()}
          onChanged={onChanged}
        />
      </QueryClientProvider>
    )

    fireEvent.click(view.getByRole('button', { name: /不相关/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/matters/MAT-0042/resources/${item.resource.id}/reject-suggestion`
    )
  })

  test('shows the same suggestion reason and actions in the context rail', () => {
    const item = resource('email', 'Rail suggestion', 'none', true)
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <MatterContextRail
          matter={matter()}
          runs={[]}
          matterAgentEnabled={false}
          onPatch={vi.fn()}
          profiles={[]}
          resources={[item]}
          stakeholders={[]}
          onOpenResource={vi.fn()}
          onTogglePin={vi.fn()}
          onChanged={vi.fn()}
        />
      </QueryClientProvider>
    )

    expect(view.getByTestId(`matter-resource-suggestion-${item.resource.id}`)).toBeTruthy()
    expect(view.getByText('同一会话中的近期回复')).toBeTruthy()
    expect(view.getByRole('button', { name: /确认关联/ })).toBeTruthy()
    expect(view.getByRole('button', { name: /不相关/ })).toBeTruthy()
  })
})

function renderTab(resources: MatterResourceListItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MatterContextTab
        matter={matter()}
        items={[]}
        resources={resources}
        stakeholders={[]}
        onOpenResource={vi.fn()}
        onChanged={vi.fn()}
      />
    </QueryClientProvider>
  )
}

function matter(): Matter {
  return {
    id: 42,
    public_id: 'MAT-0042',
    title: 'Vendor launch',
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

function resource(
  kind: MatterResourceListItem['resource']['kind'],
  title: string,
  subState: MatterResourceListItem['link']['sub_state'],
  suggested = false
): MatterResourceListItem {
  const id = title.length
  return {
    resource: {
      id,
      kind,
      provider: 'mailagent',
      external_key: `${kind}:${id}`,
      canonical_url: null,
      title,
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
      confidence: suggested ? 0.76 : null,
      provenance: suggested ? { reason: '同一会话中的近期回复' } : {},
      confirmed_at: suggested ? null : 1,
      sub_state: subState,
      deleted_at: null,
      created_at: 1,
      updated_at: 1
    }
  }
}
