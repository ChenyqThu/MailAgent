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

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

const mockListMessages = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: { listMessages: mockListMessages }
  })
}))

import i18n from '@shared/i18n'
import type { AgentRunHistoryItem, ChatMessage } from '@shared/api/types'
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

beforeEach(() => {
  vi.clearAllMocks()
  // PendingApprovalPanel 的 gateway 探针在测试环境恒失败 → 面板静默不渲染。
  global.fetch = vi.fn().mockRejectedValue(new Error('no gateway')) as unknown as typeof fetch
  mockListMessages.mockResolvedValue([
    msg({ id: 1, role: 'user', content: SEED_MARKER }),
    msg({ id: 2, role: 'assistant', content: '这是执行输出正文' })
  ])
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
