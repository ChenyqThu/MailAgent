// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'

import type { Matter, MatterResourceListItem } from '../../src/shared/api/types/matter'
import i18n from '../../src/shared/i18n'
import { MatterContextTab } from '../../src/shared/components/matters/MatterContextTab'

await i18n.changeLanguage('zh-CN')

afterEach(cleanup)

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
  subState: MatterResourceListItem['link']['sub_state']
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
      added_by_kind: 'user',
      added_by_id: null,
      confidence: null,
      provenance: {},
      confirmed_at: 1,
      sub_state: subState,
      deleted_at: null,
      created_at: 1,
      updated_at: 1
    }
  }
}
