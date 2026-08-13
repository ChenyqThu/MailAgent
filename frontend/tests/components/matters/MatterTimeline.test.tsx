// @vitest-environment happy-dom
//
// 时间线渲染层：叙述句真的落到 DOM、合并条目可展开、审计档可达、既有 actor 四档筛选没坏。
// 逐 kind 的句式判定在 `tests/shared/matterTimelineModel.test.ts`（纯函数，不经 DOM）。

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import {
  MatterTimeline,
  NARRATIVE_CLAMP_CHARS
} from '@shared/components/matters/MatterTimeline'

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

  it('审计事件不进主视图，在「操作日志」弹窗里逐条可达（收进弹窗 ≠ 删掉）', () => {
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

    // 脚注计数说的是全部事件（弹窗就是完整时间线）。
    expect(screen.getByText(/都在操作日志里（3 条）/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看操作日志' }))
    expect(screen.getAllByTestId('matter-audit-entry')).toHaveLength(3)
    expect(screen.getByText('扩大了事项对话的检索范围')).toBeTruthy()
    // 主视图不受弹窗影响。
    expect(rows()).toHaveLength(1)
  })

  it('没有审计事件时操作日志入口仍在（它是完整时间线，不是审计专属）', () => {
    render(<MatterTimeline events={[ev({ kind: 'matter_created' })]} />)
    expect(screen.getByRole('button', { name: '操作日志' })).toBeTruthy()
    expect(screen.getByText(/都在操作日志里（1 条）/)).toBeTruthy()
  })

  it('actor 四档筛选仍然工作，弹窗有自己独立的筛选', () => {
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
    expect(rows()).toHaveLength(2) // agent_binding_changed 是审计档，不进主视图

    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('跟进运行完成 · 检出 2 项变化，生成 1 条更新提案')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '我' }))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('创建了事项')).toBeTruthy()

    // 弹窗清单不吃主视图的筛选（自带四档），全量 3 条都在。
    fireEvent.click(screen.getByRole('button', { name: '查看操作日志' }))
    expect(screen.getAllByTestId('matter-audit-entry')).toHaveLength(3)
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Agent' }))
    expect(screen.getAllByTestId('matter-audit-entry')).toHaveLength(2)
  })

  it('业务事件按天分组（跨天的两条各有一个天头）', () => {
    render(
      <MatterTimeline
        events={[
          ev({ kind: 'matter_created', happened_at: T0 - 3 * 86_400_000 }),
          ev({ kind: 'item_created', happened_at: T0, payload: { kind: 'action', title: '跟进' } })
        ]}
      />
    )
    expect(screen.getAllByTestId('matter-timeline-day')).toHaveLength(2)
    expect(rows()).toHaveLength(2)
  })

  it('空列表仍显示既有空态', () => {
    render(<MatterTimeline events={[]} />)
    expect(screen.getByText('这个筛选下还没有进展。')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 事件正文（0813 轮 3）—— owner：「进展仍然像操作日志」。
// 判定层在 matterTimelineModel.test.ts；这里只管「正文真的进了 DOM」与 clamp 行为。
// ---------------------------------------------------------------------------
describe('MatterTimeline —— 事件正文', () => {
  const PROSE = '对方法务已回签补充协议，卡在我方财务开票；下一步 8/15 前把发票寄出。'
  // 🔴 两侧都锚在**同一个常量**上，别写死字数：门槛调一档时，写死的 fixture 会静默
  // 落到门槛的另一侧，于是「短正文不 clamp」和「长正文有展开钮」两条同时变成空转。
  const LONG = '进'.repeat(NARRATIVE_CLAMP_CHARS + 1)

  function summaryEvent(narrative: Record<string, unknown>): MatterEvent {
    return ev({
      kind: 'matter_updated',
      payload: {
        fields: ['current_summary'],
        changes: [{ field: 'current_summary', from: '旧摘要', to: '新摘要' }],
        narrative
      }
    })
  }

  it('摘要正文落到 DOM —— 时间线第一次有「事情本身写了什么」', () => {
    render(<MatterTimeline events={[summaryEvent({ text: PROSE })]} />)
    expect(screen.getByText('改写了当前状态摘要')).toBeTruthy()
    expect(screen.getByTestId('matter-timeline-body').textContent).toContain(PROSE)
  })

  it('🔴 存量老行（无 narrative）不渲染正文块，也不崩', () => {
    render(
      <MatterTimeline
        events={[
          ev({
            kind: 'matter_updated',
            payload: {
              fields: ['current_summary'],
              changes: [{ field: 'current_summary', from: '旧', to: '新' }]
            }
          })
        ]}
      />
    )
    expect(screen.getByText('改写了当前状态摘要')).toBeTruthy()
    expect(screen.queryByTestId('matter-timeline-body')).toBeNull()
  })

  it('短正文不 clamp、不给展开钮（否则按钮点开什么也没多）', () => {
    // 🔴 规则是「过门槛才 clamp」而不是「一律 clamp、过门槛才给按钮」—— 后者会在窄
    // 容器下切掉短正文却不给展开入口（藏内容）。这条断言就是那条规则的看门人。
    expect(PROSE.length).toBeLessThanOrEqual(NARRATIVE_CLAMP_CHARS)
    render(<MatterTimeline events={[summaryEvent({ text: PROSE })]} />)
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull()
    expect(screen.getByTestId('matter-timeline-body').querySelector('p')?.className).not.toContain(
      'line-clamp-3'
    )
  })

  it('长正文 clamp 到 3 行 + 展开全文可逆', () => {
    render(<MatterTimeline events={[summaryEvent({ text: LONG })]} />)
    const paragraph = (): Element | null =>
      screen.getByTestId('matter-timeline-body').querySelector('p')
    expect(paragraph()?.className).toContain('line-clamp-3')

    const toggle = screen.getByRole('button', { name: '展开全文' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(paragraph()?.className).not.toContain('line-clamp-3')
    expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(paragraph()?.className).toContain('line-clamp-3')
  })

  it('后端截断过才加省略号 + 「只是摘录」提示；clamp 不加（展开就能看全）', () => {
    const { unmount } = render(<MatterTimeline events={[summaryEvent({ text: PROSE })]} />)
    expect(screen.getByTestId('matter-timeline-body').textContent).not.toContain(`${PROSE}…`)
    expect(screen.queryByText(/只是摘录/)).toBeNull()
    unmount()

    render(<MatterTimeline events={[summaryEvent({ text: PROSE, truncated: true })]} />)
    expect(screen.getByTestId('matter-timeline-body').textContent).toContain(`${PROSE}…`)
    expect(screen.getByText(/只是摘录/)).toBeTruthy()
  })

  it('合并组的正文在展开的明细里一条不丢', () => {
    render(
      <MatterTimeline
        events={[
          ev({
            kind: 'item_created',
            happened_at: T0,
            payload: { kind: 'note', title: '甲', narrative: { text: '备注甲的正文' } }
          }),
          ev({
            kind: 'item_created',
            happened_at: T0 - 3_000,
            payload: { kind: 'note', title: '乙', narrative: { text: '备注乙的正文' } }
          })
        ]}
      />
    )
    // 计数句本身不挂正文（挑一条当"进展"是撒谎）。
    expect(screen.getByText('新增了 2 个条目')).toBeTruthy()
    expect(screen.queryByTestId('matter-timeline-body')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /展开 2 条明细/ }))
    const bodies = screen.getAllByTestId('matter-timeline-body')
    expect(bodies.map((node) => node.textContent)).toEqual(['备注甲的正文', '备注乙的正文'])
  })
})
