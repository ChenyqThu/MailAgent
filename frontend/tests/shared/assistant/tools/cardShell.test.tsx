// @vitest-environment happy-dom
//
// 08-05 beUI tool-approval 收编（呈现层 A2–A5）—— _cardShell 的共享件 + 两个消费卡。
//
// Pins:
//   A2 `CardParams` 是 label/value 两列 `<dl>`（dt/dd 语义，不是匿名 span 对），且 McpApprovalCard
//      的 connector/tool 身份行确实消费了它；
//   A3 状态胶囊 7 态 —— 6 个 CardPhase 各自的文案 + 决策在途时 pending 精化成「审批中」
//      （approving 是 UI 态，由 ApprovalActions 经 context 上报，tool part 里没有这个信号）；
//   A4 `CardDetails` pending→非 pending 时自动收起；**只在这个跃迁上收**（直接挂进终态的历史卡
//      不收），且用户可再展开；
//   A5 操作条随 phase 离开 pending 而退场 + reduce-motion 下不做动画（motion 属性在 DOM 里不可见，
//      故判据落在纯函数 approvalActionsMotion 上）。
//
// 🔴 本文件只测**呈现**。哪些工具必须弹卡（needsApproval 判定链 / policy.ts）不在此处，也未被本轮
//    改动触及 —— 相关闸在 tests/ai-gateway/tools/ 下，原样全绿。

import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import {
  ApprovalActions,
  CardDetails,
  CardFrame,
  CardParams
} from '@shared/assistant/tools/_cardShell'
import { approvalActionsMotion, type CardPhase } from '@shared/assistant/tools/_cardShell.lib'
import { McpApprovalCard } from '@shared/assistant/tools/generic/McpApprovalCard'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mcpProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'mcp__notion__notion_update_page',
    toolCallId: 'tc1',
    args: { page_id: 'p1', command: 'update' },
    argsText: '{"page_id":"p1"}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' }, // pending: approved === undefined
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

/** The rejected counterpart of `mcpProps` — the same part after the user said no. */
function mcpRejected(): ToolCallMessagePartProps {
  return mcpProps({ status: { type: 'complete' }, approval: { id: 'apr-1', approved: false } })
}

function stubToolsFetch(tools: Array<Record<string, unknown>> = []): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'success', data: { tools } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
  )
}

/** The tracks of a tailwind `grid-cols-[a_b]` arbitrary value (`_` is tailwind's space escape).
 *  Reading the class is the only handle available — happy-dom resolves no computed grid template. */
function gridTracks(el: Element): string[] {
  const m = /grid-cols-\[([^\]]+)\]/.exec(el.className)
  expect(m, `no grid-cols-[…] class on: ${el.className}`).toBeTruthy()
  return m![1].split('_')
}

// ───────────────────────────── A2 · 参数区两列 dl ─────────────────────────────

describe('A2 — CardParams (label/value <dl> grid)', () => {
  test('renders one dt/dd pair per param, in order', () => {
    const { container } = render(
      <CardParams
        items={[
          { id: 'a', label: '外部服务', value: 'notion', accent: true },
          { id: 'b', label: '工具', value: 'notion_update_page', mono: true }
        ]}
      />
    )
    const dl = container.querySelector('dl')
    expect(dl).toBeTruthy()
    const labels = [...container.querySelectorAll('dt')].map((n) => n.textContent)
    const values = [...container.querySelectorAll('dd')].map((n) => n.textContent)
    expect(labels).toEqual(['外部服务', '工具'])
    expect(values).toEqual(['notion', 'notion_update_page'])
  })

  test('empty list renders nothing (no stray dl)', () => {
    const { container } = render(<CardParams items={[]} />)
    expect(container.querySelector('dl')).toBeNull()
  })

  test('McpApprovalCard consumes it — the identity rows are real dt/dd, not anonymous spans', () => {
    stubToolsFetch()
    const { container } = render(<McpApprovalCard {...mcpProps({})} />)
    expect(container.querySelector('dl')).toBeTruthy()
    const pairs = [...container.querySelectorAll('dt')].map((dt, i) => [
      dt.textContent,
      container.querySelectorAll('dd')[i]?.textContent
    ])
    expect(pairs).toEqual([
      ['服务', 'notion'],
      ['工具', 'notion_update_page']
    ])
  })
})

// ─────────────────── A2 · 跨行列对齐 + 标签永不截断（0805 收尾②） ───────────────────

describe('A2 — 两列对齐是结构保证的，标签列永不截断', () => {
  // 🔴 happy-dom 不做布局，量不了像素 —— 但对齐在这里本来就不是靠像素，是**结构**：
  //    dt/dd 全是同一个 `<dl>` 的直接子元素 + grid 落在 `<dl>` 上 ⇒ 所有行的 dd 落在同一条
  //    grid 列 ⇒ 左边缘同一个 x。改回「每行一个 wrapper div 各自 grid」（本次改动之前的形态）
  //    时跨行对齐就只剩巧合，下面第一条当场红。CalendarApprovalCard 的 原时间→新时间 diff
  //    整个立在这条上（旧的 flex 版本让 label 自然宽度把两个时间戳错开 19px，才换成 grid）。
  const PARAMS = [
    { id: 'before', label: '原时间', value: '2026-08-05 09:00 → 10:00' },
    { id: 'after', label: '新时间', value: '2026-08-06 18:00 → 19:00', accent: true }
  ]

  test('grid 在 <dl> 上，dt/dd 是它的直接子元素（不是每行一个 grid）', () => {
    const { container } = render(<CardParams items={PARAMS} />)
    const dl = container.querySelector('dl')!
    expect(dl.className).toContain('grid')
    for (const cell of container.querySelectorAll('dt, dd')) {
      expect(cell.parentElement, cell.outerHTML).toBe(dl)
    }
    // 恰好两条轨：label | value。value 恒在第 2 列 ⇒ 跨行左边缘对齐。
    expect(gridTracks(dl)).toHaveLength(2)
  })

  test('🔴 标签轨是内容自适应的 auto，不是定宽 —— 定宽会静默截断安全标签', () => {
    // 病根实证：曾是 `minmax(0,5.5rem)`(88px) + dt 上 truncate，而 en-US 最长标签
    // "Current time" ≈81px —— 只剩 7px 余量。换字体 / 放大系统字号 / 出现更长标签，
    // 日历改期审批卡上的标签就会被截成 "Current tim…"，安全呈现被削掉一角。
    const { container } = render(<CardParams items={PARAMS} />)
    const tracks = gridTracks(container.querySelector('dl')!)
    expect(tracks[0]).toBe('auto')
    // 绝对长度单位（rem/px/em/ch）出现在标签轨里 = 定宽回归。
    expect(tracks[0]).not.toMatch(/\d+(rem|px|em|ch)/)
    // value 轨仍是 minmax(0,1fr)：长值换行，不撑破卡片。
    expect(tracks[1]).toBe('minmax(0,1fr)')
  })

  test('超长标签整体在场且不带 truncate', () => {
    const long = 'Current time (organizer local wall clock)'
    const { container } = render(
      <CardParams items={[{ id: 'x', label: long, value: 'v' }, ...PARAMS]} />
    )
    const dts = [...container.querySelectorAll('dt')]
    expect(dts[0]?.textContent).toBe(long)
    for (const dt of dts) expect(dt.className).not.toContain('truncate')
  })
})

// ───────────────────────────── A3 · 状态胶囊 7 态 ─────────────────────────────

describe('A3 — status pill', () => {
  // The 6 phases deriveCardPhase can produce. `approving` is the 7th and has its own test below
  // (it is a UI-only state — no tool-part signal carries it).
  const CASES: Array<[CardPhase, string]> = [
    ['pending', '待确认'],
    ['authorized', '执行中'],
    ['done', '已完成'],
    ['rejected', '已拒绝'],
    ['expired', '已过期'],
    ['error', '失败']
  ]
  test.each(CASES)('phase %s → pill "%s"', (phase, label) => {
    render(
      <CardFrame icon={null} title="t" phase={phase}>
        <div />
      </CardFrame>
    )
    expect(screen.getByText(label)).toBeTruthy()
  })

  test('a decision in flight refines the pending pill to 审批中 (the 7th state)', async () => {
    // A never-settling approve → the row stays busy, which is exactly the window the old pill
    // could not express (it kept reading 待确认 while the edit-tier POST / server-side resume ran).
    let release: (() => void) | null = null
    const onApprove = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    render(
      <CardFrame icon={null} title="t" phase="pending">
        <ApprovalActions onApprove={onApprove} onReject={vi.fn()} />
      </CardFrame>
    )
    expect(screen.getByText('待确认')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    await waitFor(() => expect(screen.getByText('审批中')).toBeTruthy())
    expect(screen.queryByText('待确认')).toBeNull()
    await act(async () => {
      release?.()
    })
  })

  test('a FAILED decision returns the pill to 待确认 (the card is still live)', async () => {
    const onApprove = (): Promise<void> => Promise.reject(new Error('E_NO_GATEWAY'))
    render(
      <CardFrame icon={null} title="t" phase="pending">
        <ApprovalActions onApprove={onApprove} onReject={vi.fn()} />
      </CardFrame>
    )
    fireEvent.click(screen.getByText('允许'))
    await waitFor(() => expect(screen.getByText(/操作失败/)).toBeTruthy())
    expect(screen.getByText('待确认')).toBeTruthy()
    expect(screen.queryByText('审批中')).toBeNull()
  })

  test('the in-flight flag can never leak into a terminal phase', () => {
    // Same frame, phase moved on: whatever ApprovalActions last reported must not colour the pill.
    function Harness(): React.JSX.Element {
      const [phase, setPhase] = useState<CardPhase>('pending')
      return (
        <>
          <button type="button" onClick={() => setPhase('done')}>
            advance
          </button>
          <CardFrame icon={null} title="t" phase={phase}>
            <ApprovalActions onApprove={() => new Promise<void>(() => {})} onReject={vi.fn()} />
          </CardFrame>
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByText('允许'))
    fireEvent.click(screen.getByText('advance'))
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.queryByText('审批中')).toBeNull()
  })
})

// ───────────────────────── A4 · 决策后自动收起详情 ─────────────────────────

describe('A4 — CardDetails auto-collapse', () => {
  test('open while pending; the pending → 非 pending transition folds it', () => {
    stubToolsFetch()
    const { rerender } = render(<McpApprovalCard {...mcpProps({})} />)
    // pending: the payload the user is approving is on screen without a click.
    expect(screen.getByText(/"page_id": "p1"/)).toBeTruthy()
    rerender(<McpApprovalCard {...mcpRejected()} />)
    expect(screen.queryByText(/"page_id": "p1"/)).toBeNull()
    // the disclosure itself stays — collapsed, not deleted.
    expect(screen.getByText('查看详情')).toBeTruthy()
  })

  test('the user can re-expand after the collapse', () => {
    stubToolsFetch()
    const { rerender } = render(<McpApprovalCard {...mcpProps({})} />)
    rerender(<McpApprovalCard {...mcpRejected()} />)
    expect(screen.queryByText(/"page_id": "p1"/)).toBeNull()
    fireEvent.click(screen.getByText('查看详情'))
    expect(screen.getByText(/"page_id": "p1"/)).toBeTruthy()
  })

  test('a card mounted STRAIGHT into a terminal phase stays open (no transition happened)', () => {
    // Reloaded history: there was never a pending → decided moment to collapse on, and hiding the
    // payload behind a click would be a regression, not a tidy-up.
    stubToolsFetch()
    render(<McpApprovalCard {...mcpRejected()} />)
    expect(screen.getByText(/"page_id": "p1"/)).toBeTruthy()
  })

  test('a non-pending → non-pending change does NOT collapse', () => {
    function Harness(): React.JSX.Element {
      const [phase, setPhase] = useState<CardPhase>('authorized')
      return (
        <>
          <button type="button" onClick={() => setPhase('done')}>
            advance
          </button>
          <CardFrame icon={null} title="t" phase={phase}>
            <CardDetails>
              <div>payload</div>
            </CardDetails>
          </CardFrame>
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByText('advance'))
    expect(screen.getByText('payload')).toBeTruthy()
  })

  test('the aria wiring is a real disclosure (aria-expanded + aria-controls)', () => {
    render(
      <CardFrame icon={null} title="t" phase="pending">
        <CardDetails>
          <div>payload</div>
        </CardDetails>
      </CardFrame>
    )
    const toggle = screen.getByText('查看详情').closest('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const panelId = toggle.getAttribute('aria-controls')!
    expect(document.getElementById(panelId)?.textContent).toBe('payload')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})

// ─────────────────────── A5 · 操作条退场 + 按压反馈 ───────────────────────

describe('A5 — action row exit + press feedback', () => {
  test('reduce-motion ⇒ no press scale and a zero-duration exit', () => {
    expect(approvalActionsMotion(true).whileTap).toBeUndefined()
    expect(approvalActionsMotion(true).transition.duration).toBe(0)
  })

  test('normal motion ⇒ whileTap scale 0.97 on the approved ease curve', () => {
    const m = approvalActionsMotion(false)
    expect(m.whileTap).toEqual({ scale: 0.97 })
    expect(m.transition.duration).toBeGreaterThan(0)
    // the shared token, not an inline curve (motion-gsap.md 边界规则 2)
    expect([...m.transition.ease]).toEqual([0.16, 1, 0.3, 1])
  })

  test('the row leaves when the frame phase leaves pending (hosted outside the branches)', async () => {
    stubToolsFetch()
    const { rerender } = render(<McpApprovalCard {...mcpProps({})} />)
    expect(screen.getByText('允许')).toBeTruthy()
    rerender(<McpApprovalCard {...mcpRejected()} />)
    await waitFor(() => expect(screen.queryByText('允许')).toBeNull())
    expect(screen.queryByText('拒绝')).toBeNull()
  })

  test('the buttons still decide (respondToApproval unchanged)', () => {
    stubToolsFetch()
    const respond = vi.fn()
    render(<McpApprovalCard {...mcpProps({ respondToApproval: respond })} />)
    fireEvent.click(screen.getByText('允许'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
    cleanup()
    const respond2 = vi.fn()
    render(<McpApprovalCard {...mcpProps({ respondToApproval: respond2 })} />)
    fireEvent.click(screen.getByText('拒绝'))
    expect(respond2).toHaveBeenCalledWith({ approved: false })
  })
})
