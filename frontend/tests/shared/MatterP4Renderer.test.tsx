// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { ReportAgentConfig } from '@shared/api/types'
import type {
  Matter,
  MatterResourceListItem,
  MatterRun,
  MatterUpdate
} from '@shared/api/types/matter'
import { MatterAgentCard } from '@shared/components/matters/MatterContextRail'
import { MatterRunsPane } from '@shared/components/matters/MatterRunsPane'
import { MatterUpdateReview } from '@shared/components/matters/MatterUpdateReview'
import { resolveMatterCitationTarget } from '@shared/components/matters/navigation'
import { RunOverlay } from '@shared/components/matters/RunOverlay'

await i18n.changeLanguage('zh-CN')
afterEach(cleanup)

const run = (state: MatterRun['lifecycle_state'], updateId: number | null = null): MatterRun => ({
  id: 7, matter_id: 1, agent_profile_id: null, trigger_kind: 'manual', lifecycle_state: state,
  status: state === 'ok' || state === 'noop' || state === 'warn' || state === 'fail' ? state : null,
  model: null, usage: { tool_calls: 2 }, cost_usd: null, error: state === 'fail' ? { message: 'boom' } : null,
  queued_at: 1, started_at: 1, completed_at: state === 'running' ? null : 1001,
  cancel_requested_at: null, canceled_at: state === 'canceled' ? 1001 : null,
  update_id: updateId, duration_ms: 1000
})

const matter: Matter = {
  id: 1, public_id: 'MAT-0001', title: 'Launch', description: '', matter_type: null, tags: [],
  status: 'active', health: 'on_track', priority: 'p1', owner_id: null, source: 'desktop_ui', due_at: null,
  waiting_context: null, next_attention_at: null, attention_reason: null, last_activity_at: null,
  latest_accepted_update_id: null, current_summary: 'Old', summary_at: null, summary_by_kind: null,
  summary_by_id: null, version: 2, archived_at: null, archived_by_kind: null, archived_by_id: null,
  deleted_at: null, deleted_by_kind: null, deleted_by_id: null, purge_after: null, created_at: 1, updated_at: 1
}

const update: MatterUpdate = {
  id: 9, matter_id: 1, review_status: 'pending', summary: 'New', created_at: 2, change_count: 1,
  is_stale: false, agent_run_id: 7, confidence: 0.8, anchored_matter_version: 2, created_by_kind: 'agent',
  from_event_id: 1, to_event_id: 4, original_proposal: { open_questions: [] }, reviewed_result: null,
  changes: [{ id: 'c1', kind: 'fact', text: 'Confirmed', sources: [] }], accepted_change_ids: null,
  citations: [], stale_at: null, stale_reason: null
}

const profile = {
  id: 'profile-1',
  type: 'custom',
  enabled: true,
  title: '客户推进 Agent'
} as ReportAgentConfig

const resource = (kind: 'email' | 'doc', externalKey: string): MatterResourceListItem => ({
  resource: {
    id: kind === 'email' ? 5 : 6,
    kind,
    provider: 'local',
    external_key: externalKey,
    canonical_url: null,
    title: kind === 'email' ? 'Source email' : 'Source doc',
    metadata: {},
    revision: null,
    content_hash: null,
    permission_state: null,
    sync_state: null,
    access_policy: 'private',
    last_checked_at: null,
    created_at: 1,
    updated_at: 1
  },
  link: {
    id: kind === 'email' ? 15 : 16,
    matter_id: 1,
    resource_id: kind === 'email' ? 5 : 6,
    relation_type: null,
    pinned: false,
    added_by_kind: 'user',
    added_by_id: null,
    confidence: null,
    provenance: {},
    confirmed_at: null,
    sub_state: 'active',
    deleted_at: null,
    created_at: 1,
    updated_at: 1
  }
})

describe('P4 renderer surfaces', () => {
  test('RunsPane renders terminal states and noop never offers review', () => {
    const review = vi.fn()
    render(<MatterRunsPane runs={[run('ok', 9), { ...run('noop'), id: 8 }, { ...run('warn', 9), id: 10 }, { ...run('fail'), id: 11 }]} updates={[update]} onReview={review} onCancel={vi.fn()} />)
    expect(screen.getByText('完成')).toBeTruthy()
    expect(screen.getByText('无变化')).toBeTruthy()
    expect(screen.getAllByText('部分降级').length).toBeGreaterThan(0)
    expect(screen.getAllByText('失败').length).toBeGreaterThan(0)
    expect(screen.getAllByText('查看提案')).toHaveLength(1)
  })

  test('RunOverlay renders proposal terminal action', () => {
    render(<RunOverlay run={run('ok', 9)} update={update} onReview={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/已产出提案/)).toBeTruthy()
    expect(screen.getByText('审阅')).toBeTruthy()
  })

  test('ReviewModal disables stale acceptance and requires reject reason', () => {
    const reject = vi.fn()
    const view = render(<MatterUpdateReview matter={matter} update={{ ...update, is_stale: true }} onClose={vi.fn()} onAccept={vi.fn()} onReject={reject} />)
    expect((screen.getByText('全部接受') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('拒绝'))
    const confirm = screen.getByText('确认拒绝') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(view.container.querySelector('textarea:last-of-type') as HTMLTextAreaElement, { target: { value: 'Not accurate' } })
    expect(confirm.disabled).toBe(false)
  })

  test('unbound card uses the built-in agent and can switch to a custom profile', () => {
    const patch = vi.fn()
    render(
      <MatterAgentCard
        matter={matter}
        runs={[]}
        enabled
        onPatch={patch}
        profiles={[profile]}
      />
    )

    expect(screen.getByText('跟进 Agent')).toBeTruthy()
    expect(screen.getByText('内置')).toBeTruthy()
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('下次')).toBeTruthy()
    expect(screen.getByText('上次')).toBeTruthy()
    expect(screen.getByRole('switch')).toBeTruthy()
    fireEvent.click(screen.getByText('改用 Custom Agent'))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: profile.title }))
    fireEvent.click(screen.getByText('保存'))
    expect(patch).toHaveBeenCalledWith({
      agent_profile_id: profile.id,
      agent_enabled: true,
      matter_instructions: null
    })
  })

  test('binding card renders bound toggle and three status rows', () => {
    const patch = vi.fn()
    render(
      <MatterAgentCard
        matter={{ ...matter, agent_profile_id: profile.id, agent_enabled: true }}
        runs={[run('ok')]}
        enabled
        onPatch={patch}
        profiles={[profile]}
      />
    )

    expect(screen.getByText(profile.title)).toBeTruthy()
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('下次')).toBeTruthy()
    expect(screen.getByText('上次')).toBeTruthy()
    expect(screen.getByText('手动')).toBeTruthy()
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(patch).toHaveBeenCalledWith({ agent_enabled: false })
  })

  test('binding schedule recommends weekdays at 09:00 and persists the shared rule shape', () => {
    const patch = vi.fn()
    render(<MatterAgentCard matter={{ ...matter, agent_enabled: true }} runs={[]} enabled onPatch={patch} profiles={[]} />)
    expect(screen.getByText('跟进 Agent')).toBeTruthy()
    expect(screen.getByText('内置')).toBeTruthy()
    fireEvent.click(screen.getByText('编辑排程'))
    fireEvent.click(screen.getByText('推荐：每个工作日 09:00'))
    fireEvent.click(screen.getByText('保存'))
    const payload = patch.mock.calls[0]?.[0]
    // P6-B：保存写的是 v2 envelope（多条触发并存），排程只是其中一条 entry。
    const envelope = JSON.parse(payload.schedule_json)
    expect(envelope.v).toBe(2)
    const schedule = envelope.triggers.find(
      (entry: { kind: string }) => entry.kind === 'schedule'
    )
    expect(schedule).toBeTruthy()
    expect(schedule.enabled).toBe(true)
    expect(schedule.rule).toMatchObject({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    expect(schedule.timezone).toBeTruthy()
  })

  test('ReviewModal citations call the resource opener', () => {
    const openResource = vi.fn()
    render(
      <MatterUpdateReview
        matter={matter}
        update={{
          ...update,
          changes: [{ ...update.changes[0], sources: [{ resource_id: 5 }] }]
        }}
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onOpenResource={openResource}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '打开证据 #5' }))
    expect(openResource).toHaveBeenCalledWith(5)
  })

  test('ReviewModal renders conflict guidance and semantic field chips', () => {
    render(
      <MatterUpdateReview
        matter={matter}
        update={{
          ...update,
          change_count: 2,
          changes: [
            {
              id: 'status-change',
              kind: 'field',
              target: { field: 'status' },
              before: 'planned',
              after: 'active',
              sources: []
            },
            {
              id: 'health-change',
              kind: 'field',
              target: { field: 'health' },
              before: 'on_track',
              after: 'at_risk',
              sources: []
            }
          ]
        }}
        error="事项已被更新，已刷新最新版本。请重载后重试。"
        onClose={vi.fn()}
        onAccept={vi.fn()}
        onReject={vi.fn()}
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('请重载后重试')
    expect(screen.getByText('计划中')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.getByText('正常')).toBeTruthy()
    expect(screen.getByText('有风险')).toBeTruthy()
  })

  test('citation targets route emails to mail and other resources to the drawer', () => {
    expect(resolveMatterCitationTarget(resource('email', 'email:123'))).toEqual({
      kind: 'email',
      emailId: 123
    })
    const document = resource('doc', 'notion:page-1')
    expect(resolveMatterCitationTarget(document)).toEqual({ kind: 'resource', item: document })
  })
})
