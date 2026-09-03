// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { CustomAgentCallCard } from '@shared/assistant/tools/generic/CustomAgentCallCard'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

await i18n.changeLanguage('zh-CN')

function props(resultValue: unknown, overrides: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'custom_agent_call',
    toolCallId: 'tc-call',
    args: { agent_id: 'reader', instruction: '整理本周进展。', report_ids: ['r-1'] },
    argsText: '{}',
    result: resultValue,
    isError: undefined,
    status: { type: 'complete' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...overrides
  } as unknown as ToolCallMessagePartProps
}

function result(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    agent_id: 'reader',
    agent_title: '只读专家',
    job_id: 31,
    session_id: 41,
    ...extra
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: 'success', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  window.history.replaceState({}, '', '/?apiPort=8200&aiGatewayPort=8300')
  navigate.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('CustomAgentCallCard — six states', () => {
  test.each([
    ['queued', '排队中'],
    ['running', '运行中'],
    ['waiting_approval', '等待确认'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['stopped', '已停止']
  ])('renders %s', (status, label) => {
    render(
      <CustomAgentCallCard
        {...props(
          result(status, {
            summary: '当前进度',
            final_answer: status === 'completed' ? '任务已经完成。' : undefined,
            error:
              status === 'failed' || status === 'stopped'
                ? { code: status === 'failed' ? 'E_TEST' : 'E_RUN_STOPPED', message: '结束' }
                : undefined
          })
        )}
      />
    )
    expect(screen.getByText(label)).toBeTruthy()
  })

  test('waiting approval only routes to the child session and has no approval actions', () => {
    render(<CustomAgentCallCard {...props(result('waiting_approval'))} />)
    expect(screen.getByText('打开子会话')).toBeTruthy()
    expect(screen.queryByText('批准调用')).toBeNull()
    expect(screen.queryByText('取消')).toBeNull()
  })

  test('completed view renders a library reference chip computed from args', () => {
    render(
      <CustomAgentCallCard
        {...props(result('completed', { final_answer: '已完成。' }), {
          args: { agent_id: 'reader', instruction: '整理资料。', library_file_ids: [42] }
        })}
      />
    )
    expect(screen.getByText('library:42')).toBeTruthy()
  })

  test('outer approval shows server-fact risk and wires approve', async () => {
    const respond = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        envelope({
          id: 'reader',
          type: 'custom',
          title: '只读专家',
          enabled: true,
          tool_policy: { v: 1, grant_web: 'gated', allowed_tools: ['email_get'] }
        })
      )
    )
    render(
      <CustomAgentCallCard
        {...props(undefined, {
          status: { type: 'requires-action', reason: 'interrupt' },
          approval: { id: 'apr-call' },
          respondToApproval: respond
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/联网权限/)).toBeTruthy())
    fireEvent.click(screen.getByText('批准调用'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })
})

describe('CustomAgentCallCard — polling and controls', () => {
  test('polls a non-terminal result and stops after completion', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () =>
      envelope({
        jobId: 31,
        agentId: 'reader',
        agentTitle: '只读专家',
        state: 'completed',
        outcome: 'completed',
        sessionId: 41,
        finalAnswer: '轮询完成。',
        finalAnswerTruncated: false,
        durationSeconds: 2
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<CustomAgentCallCard {...props(result('running'))} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(screen.getByText('轮询完成。')).toBeTruthy()
    const calls = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  test.each([
    ['queued', 'http://127.0.0.1:8200/api/agent-runs/31/cancel'],
    ['running', 'http://127.0.0.1:8300/api/ai/run/stop']
  ])('routes %s stop action to the correct endpoint', async (status, expectedUrl) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/agent-runs/31') && !String(url).endsWith('/cancel')) {
        return envelope({
          jobId: 31,
          agentId: 'reader',
          agentTitle: '只读专家',
          state: 'running',
          sessionId: 41
        })
      }
      return envelope({ cancelled: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CustomAgentCallCard {...props(result(status))} />)
    fireEvent.click(screen.getByText(status === 'queued' ? '取消排队' : '停止子运行'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === expectedUrl)).toBe(true)
    )
    if (status === 'running') {
      const stopCall = fetchMock.mock.calls.find(([url]) => String(url) === expectedUrl)
      expect(JSON.parse(String((stopCall?.[1] as RequestInit).body))).toEqual({ sessionId: 41 })
    }
  })
})
