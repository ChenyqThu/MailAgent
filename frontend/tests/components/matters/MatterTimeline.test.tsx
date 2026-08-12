// @vitest-environment happy-dom
//
// 时间线渲染层：叙述句真的落到 DOM、合并条目可展开、审计档可达、既有 actor 四档筛选没坏。
// 逐 kind 的句式判定在 `tests/shared/matterTimelineModel.test.ts`（纯函数，不经 DOM）。

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import { MatterTimeline } from '@shared/components/matters/MatterTimeline'

const T0 = Date.UTC(2026, 7, 12, 17, 30, 0)

let sequence = 0
function ev(partial: Partial<MatterEvent> & { kind: string }): MatterEvent {
  sequence += 1
  return {
    id: sequence,
    matter_id: 1,
    happened_at: T0,
    actor_kind: 'user' as MatterActorKind,
    actor_id: null,
    source: 'desktop_ui',
    item_id: null,
    update_id: null,
    resource_id: null,
    reverses_event_id: null,
    dedupe_key: `dedupe-${sequence}`,
    payload: {},
    created_at: T0,
    ...partial
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(cleanup)

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('matter-timeline-entry')
}

describe('MatterTimeline', () => {
  it('渲染叙述句，不是「更新事项 / 改动字段：…」的审计日志观感', () => {
    render(
      <MatterTimeline
        events={[
          ev({
            kind: 'matter_updated',
            payload: {
              fields: ['status', 'priority'],
              changes: [
                { field: 'status', from: 'active', to: 'waiting' },
                { field: 'priority', from: 'p2', to: 'p0' }
              ]
            }
          })
        ]}
      />
    )
    expect(screen.getByText('状态 进行中 → 等待中，优先级 P2 → P0')).toBeTruthy()
    expect(screen.queryByText('更新事项')).toBeNull()
    expect(screen.queryByText(/改动：/)).toBeNull()
  })

  it('老行（payload 无 changes 键）降级到字段名，不崩也不空', () => {
    render(
      <MatterTimeline
        events={[ev({ kind: 'matter_updated', payload: { fields: ['status', 'priority'] } })]}
      />
    )
    expect(screen.getByText('更新了事项')).toBeTruthy()
    expect(screen.getByText('改动：状态、优先级')).toBeTruthy()
  })

  it('同类合并成一条带计数的条目，展开后明细一条不少', () => {
    render(
      <MatterTimeline
        events={Array.from({ length: 6 }, (_, index) =>
          ev({
            kind: 'resource_linked',
            actor_kind: 'agent',
            source: 'matter_followup',
            payload: { title: `资料 ${index}`, resource_kind: 'email' }
          })
        )}
      />
    )
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('关联了 6 份资料')).toBeTruthy()

    const toggle = screen.getByRole('button', { name: /展开 6 条明细/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const details = within(rows()[0]).getAllByRole('listitem')
    expect(details).toHaveLength(6)
    expect(details[0].textContent).toContain('关联了邮件《资料 0》')
    expect(details[5].textContent).toContain('关联了邮件《资料 5》')
  })

  // codex 反例 #10：展开态原本记在 `group.head.id` 上，同一个 burst 新到一条更新的事件
  // 会换掉 head ⇒ 组的 key 变了 ⇒ 已展开的明细**无提示地收起**。
  it('同 burst 新增更新成员后，已展开的明细不会无提示收起', () => {
    const older = Array.from({ length: 6 }, (_, index) =>
      ev({
        kind: 'resource_linked',
        happened_at: T0 - (index + 1) * 1_000,
        payload: { title: `资料 ${index}`, resource_kind: 'email' }
      })
    )
    const view = render(<MatterTimeline events={older} />)
    fireEvent.click(screen.getByRole('button', { name: /展开 6 条明细/ }))
    expect(within(rows()[0]).getAllByRole('listitem')).toHaveLength(6)

    view.rerender(
      <MatterTimeline
        events={[
          ev({
            kind: 'resource_linked',
            happened_at: T0,
            payload: { title: '资料 6', resource_kind: 'email' }
          }),
          ...older
        ]}
      />
    )
    expect(screen.getByText('关联了 7 份资料')).toBeTruthy()
    expect(within(rows()[0]).getAllByRole('listitem')).toHaveLength(7)
  })

  it('单条事件不显示展开钮', () => {
    render(<MatterTimeline events={[ev({ kind: 'matter_created' })]} />)
    expect(screen.queryByRole('button', { name: /展开/ })).toBeNull()
  })

  it('审计事件默认收起、可被显式打开（收起 ≠ 删掉）', () => {
    render(
      <MatterTimeline
        events={[
          ev({ kind: 'matter_created' }),
          ev({ kind: 'chat_scope_expanded', payload: { session_id: 's1' } }),
          ev({ kind: 'matter_updated', payload: { fields: ['tags'], changes: [] } })
        ]}
      />
    )
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('创建了事项')).toBeTruthy()
    expect(screen.queryByText('扩大了事项对话的检索范围')).toBeNull()

    const toggle = screen.getByRole('button', { name: /显示操作记录（2）/ })
    fireEvent.click(toggle)
    expect(rows()).toHaveLength(3)
    expect(screen.getByText('扩大了事项对话的检索范围')).toBeTruthy()
    expect(screen.getAllByText('操作记录').length).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: /隐藏操作记录/ }))
    expect(rows()).toHaveLength(1)
  })

  it('没有审计事件时不渲染那个开关', () => {
    render(<MatterTimeline events={[ev({ kind: 'matter_created' })]} />)
    expect(screen.queryByRole('button', { name: /操作记录/ })).toBeNull()
  })

  it('actor 四档筛选仍然工作，且与审计档是两个独立维度', () => {
    render(
      <MatterTimeline
        events={[
          ev({ kind: 'matter_created', actor_kind: 'user' }),
          ev({
            kind: 'update_proposed',
            actor_kind: 'agent',
            source: 'agent_run',
            payload: { update_id: 1, run_id: 1, change_count: 2 }
          }),
          ev({ kind: 'agent_binding_changed', actor_kind: 'agent', payload: { fields: ['tags'] } })
        ]}
      />
    )
    expect(rows()).toHaveLength(2) // agent_binding_changed 是审计档，默认不显示

    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('跟进运行完成 · 检出 2 项变化，生成 1 条更新提案')).toBeTruthy()
    // 审计计数跟着 actor 筛选走 —— 两个维度各自成立。
    expect(screen.getByRole('button', { name: /显示操作记录（1）/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '我' }))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('创建了事项')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /操作记录/ })).toBeNull()
  })

  it('空列表仍显示既有空态', () => {
    render(<MatterTimeline events={[]} />)
    expect(screen.getByText('这个筛选下还没有事件。')).toBeTruthy()
  })
})
