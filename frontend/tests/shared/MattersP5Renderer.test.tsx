// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import i18n from '@shared/i18n'
import type { Matter, MatterAttentionListResponse, MatterAttentionSignal, MatterUpdate } from '@shared/api/types/matter'
import { MatterAttentionBadge } from '@shared/components/layout/Sidebar'
import { AttnBand } from '@shared/components/matters/attention'
import { MatterList } from '@shared/components/matters/MatterList'
import { DEFAULT_MATTER_LIST_QUERY } from '@shared/components/matters/matterListQuery'
import { deriveFocusStats } from '@shared/lib/matterDerive'
import { globalAttentionKey, matterAttentionKey, useAttentionAction } from '@shared/components/matters/hooks'

await i18n.changeLanguage('zh-CN')
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const matter: Matter = {
  id: 1, public_id: 'MAT-0001', title: 'Launch', background: '', goal: '', matter_type: null, tags: [], status: 'active', health: 'on_track', priority: 'p1', owner_id: null, source: 'manual', due_at: null, waiting_context: null, next_attention_at: null, attention_reason: null, last_activity_at: null, latest_accepted_update_id: null, current_summary: 'Current', summary_at: 0, summary_by_kind: null, summary_by_id: null, version: 1, archived_at: null, archived_by_kind: null, archived_by_id: null, deleted_at: null, deleted_by_kind: null, deleted_by_id: null, purge_after: null, created_at: 1, updated_at: 1
}

const signal = (overrides: Partial<MatterAttentionSignal> = {}): MatterAttentionSignal => ({
  id: 11, matter_id: 1, kind: 'run_failed', state: 'open', severity: 'critical', why: '跟进运行失败', first_opened_at: 1, last_observed_at: 2, matter: { public_id: matter.public_id, title: matter.title, status: matter.status, health: matter.health, priority: matter.priority }, ...overrides
})

const update: MatterUpdate = {
  id: 9, matter_id: 1, review_status: 'pending', summary: 'Proposal', created_at: 2, change_count: 1, is_stale: false, agent_run_id: 7, confidence: .8, anchored_matter_version: 1, created_by_kind: 'agent', from_event_id: 1, to_event_id: 2, original_proposal: {}, reviewed_result: null, changes: [], accepted_change_ids: null, citations: [], stale_at: null, stale_reason: null
}

describe('P5 renderer surfaces', () => {
  test('Focus four metrics follow Appendix E windows', () => {
    const now = Date.UTC(2026, 7, 11)
    const active = { ...matter, due_at: now + 2 * 86_400_000, summary_at: now - 2 * 86_400_000, items: [{ id: 1, matter_id: 1, kind: 'action' as const, title: 'Send plan', description: null, position: 0, status: 'open' as const, priority: null, owner_kind: null, owner_id: null, waiting_on_stakeholder_id: null, due_at: null, completed_at: null, checklist: [], source_resource_id: null, source_locator: null, created_at: 1, updated_at: 1, deleted_at: null }] }
    const done = { ...matter, id: 2, public_id: 'MAT-0002', status: 'done' as const, due_at: now + 1_000 }
    const updates = new Map([[active.public_id, [update]]])
    // V3-13 起多出 missingNextCount（第四 tile「缺少下一步」）：active 有开放行动项 ⇒ 0。
    // V3-14 —— healthyRate 字段随第四 tile 一起退役，已从返回形状里删除。
    expect(deriveFocusStats([active, done], [signal()], updates, now)).toEqual({ openCount: 1, attentionCount: 1, reviewCount: 1, dueSoonCount: 1, missingNextCount: 0 })
  })

  test('Sidebar matter badge renders only for N > 0', () => {
    const view = render(<div><MatterAttentionBadge count={0}/><MatterAttentionBadge count={4}/></div>)
    expect(view.container.textContent).toBe('4')
  })

  test('MatterList keeps the compact row and omits tag and signal rows', () => {
    render(
      <MatterList
        matters={[{ ...matter, tags: ['launch'] }]}
        query={DEFAULT_MATTER_LIST_QUERY}
        onQueryChange={vi.fn()}
        scopeTotal={1}
        tags={[]}
        selectedId={null}
        attention={new Map([[matter.public_id, [signal()]]])}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onManageTags={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: /Launch/ }).className).toContain('py-2.5')
    expect(screen.queryByText('#launch')).toBeNull()
    expect(screen.queryByText('跟进运行失败')).toBeNull()
  })

  test('AttnBand removes needs_review when proposal card is present', () => {
    render(<AttnBand matter={matter} signals={[signal({ kind: 'needs_review', why: '审阅提案' }), signal()]} hasProposal onAction={vi.fn()} />)
    expect(screen.queryByText('审阅提案')).toBeNull()
    expect(screen.getByText('跟进运行失败')).toBeTruthy()
  })

  test('attention action optimistically removes and rolls back on failure', async () => {
    let rejectFetch: ((reason?: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectFetch = reject })))
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
    const cached: MatterAttentionListResponse = { items: [signal()] }
    client.setQueryData(globalAttentionKey(), cached)
    client.setQueryData(matterAttentionKey(matter.public_id), cached)
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    const hook = renderHook(() => useAttentionAction(), { wrapper })

    act(() => hook.result.current.mutate({ matterId: matter.public_id, signalId: 11, action: 'resolved' }))
    await waitFor(() => expect(client.getQueryData<MatterAttentionListResponse>(globalAttentionKey())?.items).toHaveLength(0))
    rejectFetch?.(new Error('offline'))
    await waitFor(() => expect(client.getQueryData<MatterAttentionListResponse>(globalAttentionKey())?.items).toHaveLength(1))
    expect(client.getQueryData<MatterAttentionListResponse>(matterAttentionKey(matter.public_id))?.items).toHaveLength(1)
  })
})
