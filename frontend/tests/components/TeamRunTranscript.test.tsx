// @vitest-environment happy-dom
//
// task 08-27 P4a（lane team-shell）— 执行详情 transcript：触发气泡由前端合成。
//
// 🔴 r8 §A.2：run 会话的第一条 user 消息是 4-7KB 任务契约 prompt —— **绝不直接渲染**。
// 本文件钉三件事：① 合成的紫色「⚡自动触发」气泡在场；② 原始 prompt 不出现在可见
// transcript 里（收进默认收起的折叠块，展开后才可见）；③ 其余消息正常渲染。
// 变异验证目标：把 TeamRunTranscript 改成渲染全量 messages（含首条）必红。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})

// 「去报告」的跳转载荷由 navigateToReport（registry 单源）拼，测试只截 navigate 调用。
const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

const mockListMessages = vi.fn()
const mockRunLogSteps = vi.fn()
const mockReportGet = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: { listMessages: mockListMessages },
    report: { runLogSteps: mockRunLogSteps, get: mockReportGet }
  })
}))

import i18n from '@shared/i18n'
import type { AgentRunHistoryItem, AgentRunLogItem, ChatMessage } from '@shared/api/types'
import { TeamRunTranscript } from '../../src/shared/components/agents/team/TeamRecordDetail'

await i18n.changeLanguage('zh-CN')

const SEED_MARKER = 'CONTRACT_PROMPT_MARKER_4KB'

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 254,
    role: 'user',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'done',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    ...over
  } as ChatMessage
}

const RUN: AgentRunHistoryItem = {
  jobId: 42,
  agentId: 'dms_helper',
  state: 'completed',
  createdAt: 1_700_000_000_000,
  sessionId: 254,
  summary: '跑完了',
  triggerKind: 'email_filter',
  triggerFiredAtIso: '2026-08-30T10:00:00+08:00'
} as AgentRunHistoryItem

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

/** 08-31 — 无 session 的执行台账行（报告 / 画像 / 项目周报）。 */
const RUN_LOG: AgentRunLogItem = {
  kind: 'run_log',
  runLogId: 7,
  jobId: 7,
  agentId: 'daily_report',
  state: 'completed',
  createdAt: '2026-08-31T04:00:00.000Z',
  summary: '日报已生成',
  triggerKind: 'schedule',
  triggerFiredAtIso: '2026-08-31T04:00:00.000Z',
  triggerDetail: '按日排程 · 2026-08-31'
} as AgentRunLogItem

beforeEach(() => {
  vi.clearAllMocks()
  // PendingApprovalPanel 的 gateway 探针在测试环境恒失败 → 面板静默不渲染。
  global.fetch = vi.fn().mockRejectedValue(new Error('no gateway')) as unknown as typeof fetch
  mockListMessages.mockResolvedValue([
    msg({ id: 1, role: 'user', content: SEED_MARKER }),
    msg({ id: 2, role: 'assistant', content: '这是执行输出正文' })
  ])
  mockRunLogSteps.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TeamRunTranscript — 触发气泡合成 + 首条 prompt 摘除', () => {
  test('合成触发气泡在场；原始 prompt 不在可见流里；输出消息正常渲染', async () => {
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => {
      expect(container.querySelector('[data-run-trigger-bubble]')).toBeTruthy()
    })
    // 触发气泡 = triggerKind 的人话（收信触发），不是那 4-7KB 的 prompt。
    expect(screen.getByText(/收信触发/)).toBeTruthy()
    // 🔴 首条 user 消息（任务契约 prompt）不得出现在可见 DOM（折叠块默认收起）。
    expect(screen.queryByText(new RegExp(SEED_MARKER))).toBeNull()
    // 其余消息照常渲染。
    await waitFor(() => expect(screen.getByText('这是执行输出正文')).toBeTruthy())
    // 折叠块在场，展开后才能看到原文。
    const rawBlock = container.querySelector('[data-run-raw-prompt]')
    expect(rawBlock).toBeTruthy()
    fireEvent.click(rawBlock!.querySelector('button')!)
    expect(screen.getByText(new RegExp(SEED_MARKER))).toBeTruthy()
  })

  // 08-31 dogfood — 折叠块原来挂在流末尾（有输出走 pendingSlot、无输出走分支末尾），
  // owner 根本没发现它。现在它收进触发气泡本身：完整触发指令属于触发这件事。
  test('🔴 完整触发指令的折叠块挂在触发气泡内部，且全流只有一处（末尾不再重复）', async () => {
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    const bubble = await waitFor(() => {
      const el = container.querySelector('[data-run-trigger-bubble]')
      expect(el).toBeTruthy()
      return el!
    })
    await waitFor(() => expect(screen.getByText('这是执行输出正文')).toBeTruthy())
    // 只有一个折叠块，且它在气泡里。
    expect(container.querySelectorAll('[data-run-raw-prompt]')).toHaveLength(1)
    const inBubble = bubble.querySelector('[data-run-raw-prompt]')
    expect(inBubble).toBeTruthy()
    // 默认收起 → 原文不可见；点气泡里的展开钮才出现。
    expect(screen.queryByText(new RegExp(SEED_MARKER))).toBeNull()
    fireEvent.click(inBubble!.querySelector('button')!)
    expect(screen.getByText(new RegExp(SEED_MARKER))).toBeTruthy()
  })

  test('无输出分支同样从气泡里看完整触发指令（两支行为一致）', async () => {
    mockListMessages.mockResolvedValue([msg({ id: 1, role: 'user', content: SEED_MARKER })])
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    const bubble = await waitFor(() => {
      const el = container.querySelector('[data-run-trigger-bubble]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(container.querySelectorAll('[data-run-raw-prompt]')).toHaveLength(1)
    expect(bubble.querySelector('[data-run-raw-prompt]')).toBeTruthy()
  })

  test('run 未产生输出（只有 seed prompt）→ 触发气泡 + 无输出说明，不渲染欢迎空态', async () => {
    mockListMessages.mockResolvedValue([msg({ id: 1, role: 'user', content: SEED_MARKER })])
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => {
      expect(container.querySelector('[data-run-trigger-bubble]')).toBeTruthy()
    })
    expect(screen.getByText('这次运行没有产生任何输出。')).toBeTruthy()
    expect(screen.queryByText(new RegExp(SEED_MARKER))).toBeNull()
    expect(container.querySelector('[data-run-raw-prompt]')).toBeTruthy()
  })
})

// 08-31 — 同一个组件的第二条路：run_log 行没有 session，transcript 由步骤合成。
describe('TeamRunTranscript — run_log 走步骤合成（不查会话）', () => {
  test('步骤合成成 transcript：触发气泡带 triggerDetail，输出与工具行在场', async () => {
    mockRunLogSteps.mockResolvedValue([
      { seq: 0, kind: 'trig', detail: '按日排程', payload: null, ok: null, ms: null },
      {
        seq: 1,
        kind: 'tool',
        name: 'fetch_report_briefs',
        detail: '取数 · 窗口内 34 封邮件',
        payload: { counts: { total: 34 } },
        ok: true,
        ms: 120
      },
      { seq: 2, kind: 'out', detail: '日报输出正文', payload: null, ok: null, ms: null }
    ])
    const { container } = render(<TeamRunTranscript run={RUN_LOG} agentName="日报" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('日报输出正文')).toBeTruthy())
    // 触发气泡走 run 行单源（triggerKind 的人话 + triggerDetail），不是 trig 步骤。
    expect(container.querySelector('[data-run-trigger-bubble]')).toBeTruthy()
    expect(screen.getByText(/排程触发 · 按日排程 · 2026-08-31/)).toBeTruthy()
    // 🔴 run_log 没有 session：绝不去查会话消息（查了就会渲染出别人的 transcript）。
    expect(mockListMessages).not.toHaveBeenCalled()
    // 没有任务契约 prompt 可摘 → 原始 prompt 折叠块不出现。
    expect(container.querySelector('[data-run-raw-prompt]')).toBeNull()
  })

  test('零步骤 → 无输出说明，不挂 AgentThread（其空态是「新对话」欢迎屏，会撒谎）', async () => {
    const { container } = render(<TeamRunTranscript run={RUN_LOG} agentName="日报" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => {
      expect(container.querySelector('[data-run-trigger-bubble]')).toBeTruthy()
    })
    expect(screen.getByText('这次运行没有产生任何输出。')).toBeTruthy()
  })
})

// 08-31 收敛批 — 产物行已被记录列按 reportId 去重掉，报告只能从这里进。
describe('TeamRunTranscript — 「去报告」产物入口', () => {
  test('有 reportId：按钮在场，跳转载荷与 report 详情那一处同源', async () => {
    const run = { ...RUN_LOG, reportId: 'rep-2026-08-31' } as AgentRunLogItem
    const { container } = render(<TeamRunTranscript run={run} agentName="日报" />, {
      wrapper: makeQcWrapper()
    })
    const btn = await waitFor(() => {
      const el = container.querySelector('[data-run-open-report="rep-2026-08-31"]')
      expect(el).toBeTruthy()
      return el
    })
    fireEvent.click(btn as Element)
    // navigateToReport(navigate, id) 的载荷 —— 路由字面量只许出现在 registry 里。
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/reports/$reportId',
      params: { reportId: 'rep-2026-08-31' }
    })
  })

  test('reportId 为 null（画像 / 项目周报）→ 不出按钮', async () => {
    const { container } = render(<TeamRunTranscript run={RUN_LOG} agentName="日报" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => {
      expect(container.querySelector('[data-run-trigger-bubble]')).toBeTruthy()
    })
    expect(container.querySelector('[data-run-open-report]')).toBeNull()
  })

  test('async_jobs run 行（无 reportId 概念）→ 不出按钮', async () => {
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('这是执行输出正文')).toBeTruthy())
    expect(container.querySelector('[data-run-open-report]')).toBeNull()
  })
})

// 08-31 dogfood — 日报/周报的 run 有完整 transcript，但 out 步骤只有 headline；报告本体
// 内嵌进详情（默认折叠），「去报告」按钮保留。
describe('TeamRunTranscript — 内嵌报告全文', () => {
  test('有 reportId：折叠块在场且默认收起，展开前不拉 report:get', async () => {
    mockReportGet.mockResolvedValue({
      id: 'rep-2026-08-31',
      doc: { cadence: 'daily', model: 'claude-fable-5', generated_at: '', blocks: [] }
    })
    const run = { ...RUN_LOG, reportId: 'rep-2026-08-31' } as AgentRunLogItem
    const { container } = render(<TeamRunTranscript run={run} agentName="日报" />, {
      wrapper: makeQcWrapper()
    })
    const block = await waitFor(() => {
      const el = container.querySelector('[data-run-report-full="rep-2026-08-31"]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(screen.getByText('报告全文')).toBeTruthy()
    // 🔴 懒加载：折叠时 query 是 disabled 的，记录列每选一条 run 不该多一次 report:get。
    expect(mockReportGet).not.toHaveBeenCalled()
    fireEvent.click(block.querySelector('button')!)
    await waitFor(() => expect(mockReportGet).toHaveBeenCalledWith('rep-2026-08-31'))
  })

  test('无 reportId（画像 / 项目周报 / async_jobs run）→ 不挂折叠块', async () => {
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('这是执行输出正文')).toBeTruthy())
    expect(container.querySelector('[data-run-report-full]')).toBeNull()
  })
})

// 08-31 dogfood — 超宽详情面板里 44rem 的消息列两侧各空 ~400px（owner 观感「太靠右」）。
// 🔴 变量定义在 AgentThread Root 的 inline style 上，外层包一层 CSS 变量覆盖无效 → 走 prop。
describe('TeamRunTranscript — 消息列宽度', () => {
  const WIDE = 'min(58rem, 100%)'

  test('有输出分支：AgentThread 收到放宽后的 --thread-max-width', async () => {
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('这是执行输出正文')).toBeTruthy())
    const withVar = Array.from(container.querySelectorAll<HTMLElement>('[style]')).filter(
      (el) => el.style.getPropertyValue('--thread-max-width') !== ''
    )
    expect(withVar.length).toBeGreaterThan(0)
    for (const el of withVar) {
      expect(el.style.getPropertyValue('--thread-max-width')).toBe(WIDE)
    }
  })

  test('🔴 无输出分支不经过 AgentThread：它必须自己定义同一个变量，否则列宽塌成整幅面板', async () => {
    mockListMessages.mockResolvedValue([msg({ id: 1, role: 'user', content: SEED_MARKER })])
    const { container } = render(<TeamRunTranscript run={RUN} agentName="跟进员" />, {
      wrapper: makeQcWrapper()
    })
    const bubble = await waitFor(() => {
      const el = container.querySelector('[data-run-trigger-bubble]')
      expect(el).toBeTruthy()
      return el!
    })
    // 从气泡往上找，必须有一个祖先真的定义了这个变量（值与有输出分支一致）。
    let node: HTMLElement | null = bubble.parentElement
    let found: string | null = null
    while (node != null && found == null) {
      const v = node.style?.getPropertyValue('--thread-max-width') ?? ''
      if (v !== '') found = v
      node = node.parentElement
    }
    expect(found).toBe(WIDE)
  })
})
