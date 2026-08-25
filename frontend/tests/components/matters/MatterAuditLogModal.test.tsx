// @vitest-environment happy-dom
//
// 操作日志弹窗（task 08-25 起它是事件那一路的**唯一**去处）：全量 `matter_event` 逐条、
// 按天分组、节点样式、actor 四档筛选。前身是 `MatterTimeline.test.tsx` —— 那一屏的主视图
// 换成了 curated 进展（`MatterProgressLane.test.tsx`），事件的呈现整体搬进这个弹窗。
// 逐 kind 的句式判定在 `tests/shared/matterTimelineModel.test.ts`（纯函数，不经 DOM）。

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import { MatterAuditLogModal } from '@shared/components/matters/MatterAuditLogModal'
import { NARRATIVE_CLAMP_CHARS } from '@shared/components/matters/MatterNarrativeBody'

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

function open(events: readonly MatterEvent[]): void {
  render(<MatterAuditLogModal open events={events} locale="zh-CN" onOpenChange={() => undefined} />)
}

function rows(): HTMLElement[] {
  return screen.queryAllByTestId('matter-audit-entry')
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(cleanup)

describe('MatterAuditLogModal', () => {
  it('渲染叙述句，不是「更新事项 / 改动字段：…」的裸审计观感', () => {
    open([
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
    ])
    expect(screen.getByText('状态 进行中 → 等待中，优先级 P2 → P0')).toBeTruthy()
  })

  it('老行（payload 无 changes 键）降级到字段名，不崩也不空', () => {
    open([ev({ kind: 'matter_updated', payload: { fields: ['status', 'priority'] } })])
    expect(screen.getByText('更新了事项')).toBeTruthy()
    expect(screen.getByText('改动：状态、优先级')).toBeTruthy()
  })

  it('🔴 同类事件**不合并** —— 回看与追责要的是逐条原始记录', () => {
    // 主视图时代这 6 条会收成一条「关联了 6 份资料」；弹窗要的是 6 行。
    open(
      Array.from({ length: 6 }, (_, index) =>
        ev({
          kind: 'resource_linked',
          actor_kind: 'agent',
          source: 'matter_followup',
          payload: { title: `资料 ${index}`, resource_kind: 'email' }
        })
      )
    )
    expect(rows()).toHaveLength(6)
    expect(screen.queryByText('关联了 6 份资料')).toBeNull()
    expect(screen.getAllByText('关联了邮件《资料 0》')).toHaveLength(1)
  })

  it('审计档事件同样逐条在场（收进弹窗 ≠ 删掉）', () => {
    open([
      ev({ kind: 'matter_created' }),
      ev({ kind: 'chat_scope_expanded', payload: { session_id: 's1' } }),
      ev({ kind: 'matter_updated', payload: { fields: ['tags'], changes: [] } })
    ])
    expect(rows()).toHaveLength(3)
    expect(screen.getByText('扩大了事项对话的检索范围')).toBeTruthy()
    expect(screen.getByText('3 条')).toBeTruthy() // 计数 = 全量，不是"业务档那几条"
  })

  it('curated 进展的维护动作也在日志里（谁动了哪一条）', () => {
    open([
      ev({
        kind: 'progress_added',
        actor_kind: 'agent',
        source: 'matter_chat',
        payload: { progress_id: 4, kind: 'decision', title: 'Q4 预算已定' }
      })
    ])
    expect(screen.getByText('记了一条进展「Q4 预算已定」')).toBeTruthy()
  })

  it('按天分组（跨天的两条各有一个天头）', () => {
    open([
      ev({ kind: 'matter_created', happened_at: T0 - 3 * 86_400_000 }),
      ev({ kind: 'item_created', happened_at: T0, payload: { kind: 'action', title: '跟进' } })
    ])
    expect(screen.getAllByTestId('matter-audit-day')).toHaveLength(2)
    expect(rows()).toHaveLength(2)
  })

  it('时间戳乱序的两条不会切出重复天头（后端是 id DESC，不是按时间）', () => {
    open([
      ev({ kind: 'matter_created', happened_at: T0 - 3_600_000 }),
      ev({ kind: 'item_created', happened_at: T0, payload: { kind: 'action', title: '跟进' } })
    ])
    expect(screen.getAllByTestId('matter-audit-day')).toHaveLength(1)
  })

  it('actor 四档筛选', () => {
    open([
      ev({ kind: 'matter_created', actor_kind: 'user' }),
      ev({
        kind: 'update_proposed',
        actor_kind: 'agent',
        source: 'agent_run',
        payload: { update_id: 1, run_id: 1, change_count: 2 }
      }),
      ev({ kind: 'agent_binding_changed', actor_kind: 'agent', payload: { fields: ['tags'] } })
    ])
    expect(rows()).toHaveLength(3)

    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }))
    expect(rows()).toHaveLength(2)
    expect(screen.getByText('跟进运行完成 · 检出 2 项变化，生成 1 条更新提案')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '我' }))
    expect(rows()).toHaveLength(1)
    expect(screen.getByText('创建了事项')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: '系统' }))
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('这个筛选下没有记录。')).toBeTruthy()
  })
})

describe('MatterAuditLogModal —— 事件正文', () => {
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

  it('摘要正文落到 DOM —— 时间线上看得见「事情本身写了什么」', () => {
    open([summaryEvent({ text: PROSE })])
    expect(screen.getByText('改写了当前状态摘要')).toBeTruthy()
    expect(screen.getByTestId('matter-narrative-body').textContent).toContain(PROSE)
  })

  it('🔴 存量老行（无 narrative）不渲染正文块，也不崩', () => {
    open([
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '旧', to: '新' }]
        }
      })
    ])
    expect(screen.getByText('改写了当前状态摘要')).toBeTruthy()
    expect(screen.queryByTestId('matter-narrative-body')).toBeNull()
  })

  it('短正文不 clamp、不给展开钮（否则按钮点开什么也没多）', () => {
    // 🔴 规则是「过门槛才 clamp」而不是「一律 clamp、过门槛才给按钮」—— 后者会在窄
    // 容器下切掉短正文却不给展开入口（藏内容）。这条断言就是那条规则的看门人。
    expect(PROSE.length).toBeLessThanOrEqual(NARRATIVE_CLAMP_CHARS)
    open([summaryEvent({ text: PROSE })])
    expect(screen.queryByRole('button', { name: '展开全文' })).toBeNull()
    expect(screen.getByTestId('matter-narrative-body').querySelector('p')?.className).not.toContain(
      'line-clamp-3'
    )
  })

  it('长正文 clamp 到 3 行 + 展开全文可逆', () => {
    open([summaryEvent({ text: LONG })])
    const paragraph = (): Element | null =>
      screen.getByTestId('matter-narrative-body').querySelector('p')
    expect(paragraph()?.className).toContain('line-clamp-3')

    const toggle = screen.getByRole('button', { name: '展开全文' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(paragraph()?.className).not.toContain('line-clamp-3')
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(paragraph()?.className).toContain('line-clamp-3')
  })

  it('后端截断过才加省略号 + 「只是摘录」提示；clamp 不加（展开就能看全）', () => {
    const { unmount } = render(
      <MatterAuditLogModal
        open
        events={[summaryEvent({ text: PROSE })]}
        locale="zh-CN"
        onOpenChange={() => undefined}
      />
    )
    expect(screen.getByTestId('matter-narrative-body').textContent).not.toContain(`${PROSE}…`)
    expect(screen.queryByText(/只是摘录/)).toBeNull()
    unmount()

    open([summaryEvent({ text: PROSE, truncated: true })])
    expect(screen.getByTestId('matter-narrative-body').textContent).toContain(`${PROSE}…`)
    expect(screen.getByText(/只是摘录/)).toBeTruthy()
  })

  it('合并没了 ⇒ 每条备注各自带各自的正文，一条不丢', () => {
    open([
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
    ])
    expect(screen.getAllByTestId('matter-narrative-body').map((node) => node.textContent)).toEqual([
      '备注甲的正文',
      '备注乙的正文'
    ])
  })
})
