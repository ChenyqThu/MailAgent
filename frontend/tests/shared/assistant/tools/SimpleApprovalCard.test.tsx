// @vitest-environment happy-dom
//
// 1.5.0 dogfood (task 07-07) — SimpleApprovalCard render + islandless approval flow. Rendered
// standalone with mocked ToolCallMessagePartProps. Asserts: the approval-paused (requires-action)
// state shows real approve + reject buttons (NOT the buttonless ToolTraceCard spinner), that
// approve / reject wire assistant-ui's native respondToApproval (通道 A — resumes in-panel with no
// dynamic island), and that the pinned identity value (URL / query / agent id) is shown for review.
// Covers one web tool (web_fetch) and one custom-agent tool (custom_agent_delete) per the PRD.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import { SimpleApprovalCard } from '@shared/assistant/tools/generic/SimpleApprovalCard'

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'web_fetch',
    toolCallId: 'tc1',
    args: {},
    argsText: '{}',
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

afterEach(() => {
  cleanup()
})

describe('SimpleApprovalCard — pending (approval-requested)', () => {
  test('web_fetch: shows the target URL + approve/reject buttons (not a spinner)', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({ toolName: 'web_fetch', args: { url: 'https://example.test/report' } })}
      />
    )
    expect(screen.getByText('联网抓取网页')).toBeTruthy()
    expect(screen.getByText('https://example.test/report')).toBeTruthy()
    // real approve + reject buttons (the whole point — the buttonless fallback has neither).
    expect(screen.getByText('允许')).toBeTruthy()
    expect(screen.getByText('取消')).toBeTruthy()
  })

  test('web_search: shows the query as the pinned review value', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({ toolName: 'web_search', args: { query: 'anthropic 最新动向' } })}
      />
    )
    expect(screen.getByText('联网搜索')).toBeTruthy()
    expect(screen.getByText('anthropic 最新动向')).toBeTruthy()
  })

  test('custom_agent_delete: shows the agent id + red-worthy delete title', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({ toolName: 'custom_agent_delete', args: { agent_id: 'dms-approver' } })}
      />
    )
    expect(screen.getByText('删除 Custom Agent')).toBeTruthy()
    expect(screen.getByText('dms-approver')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
  })

  test('custom_agent_run_now: shows the agent id + run title', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({ toolName: 'custom_agent_run_now', args: { agent_id: 'weekly-report' } })}
      />
    )
    expect(screen.getByText('立即运行 Custom Agent')).toBeTruthy()
    expect(screen.getByText('weekly-report')).toBeTruthy()
  })

  test('missing expected field → graceful JSON degrade (review surface never blank)', () => {
    render(<SimpleApprovalCard {...mockProps({ toolName: 'web_fetch', args: { note: 'oops' } })} />)
    expect(screen.getByText('{"note":"oops"}')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
  })
})

describe('SimpleApprovalCard — approve / reject wire respondToApproval (通道 A)', () => {
  test('approve → respondToApproval({ approved: true })', () => {
    const respond = vi.fn()
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'web_fetch',
          args: { url: 'https://example.test' },
          respondToApproval: respond
        })}
      />
    )
    fireEvent.click(screen.getByText('允许'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })

  test('reject → respondToApproval({ approved: false })', () => {
    const respond = vi.fn()
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'custom_agent_delete',
          args: { agent_id: 'dms-approver' },
          respondToApproval: respond
        })}
      />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(respond).toHaveBeenCalledWith({ approved: false })
  })
})

describe('SimpleApprovalCard — terminal phases', () => {
  test('rejected → shows the "已取消" banner, no approve button', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'web_fetch',
          args: { url: 'https://example.test' },
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: false }
        })}
      />
    )
    expect(screen.getByText('已取消，未执行该操作。')).toBeTruthy()
    expect(screen.queryByText('允许')).toBeNull()
  })

  test('done (approved, result available) → echoes the pinned value, no buttons', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'custom_agent_run_now',
          args: { agent_id: 'weekly-report' },
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: { enqueued: true, job_id: 'job-9' }
        })}
      />
    )
    expect(screen.getByText('weekly-report')).toBeTruthy()
    expect(screen.queryByText('允许')).toBeNull()
    expect(screen.queryByText('取消')).toBeNull()
  })
})
