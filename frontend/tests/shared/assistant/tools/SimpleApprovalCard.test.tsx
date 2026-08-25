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

import i18n from '@shared/i18n'
import { SimpleApprovalCard } from '@shared/assistant/tools/generic/SimpleApprovalCard'

await i18n.changeLanguage('zh-CN')

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
    expect(screen.getByText('拒绝')).toBeTruthy()
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

  test('notion_agent_chat: shows the prompt + approve buttons (fresh — no thread_id line)', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({ toolName: 'notion_agent_chat', args: { prompt: '更新本周日程' } })}
      />
    )
    expect(screen.getByText('咨询 Notion Agent')).toBeTruthy()
    expect(screen.getByText('更新本周日程')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
    // no thread_id in args → no continuation line rendered (codex MEDIUM-1).
    expect(screen.queryByText(/续接会话/)).toBeNull()
  })

  test('notion_agent_chat (follow-up): renders the 续接会话 <thread_id> line (codex MEDIUM-1)', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'notion_agent_chat',
          args: { prompt: '继续', thread_id: 'thr-abc' }
        })}
      />
    )
    expect(screen.getByText('继续')).toBeTruthy()
    // the continuation id is surfaced so the user reviews that this call resumes a prior conversation.
    expect(screen.getByText('续接会话 thr-abc')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
  })

  // 阶段 0.5-① G9 — the same 1.5.0 deadlock, two tools that were missed at the time: both are
  // edit-tier writes (tools/profile.ts makeWrite risk:'edit') with no registered card, so an
  // approval-paused part rendered as a buttonless permanent spinner.
  test('agent_profile_restore: shows the doc + the target version line + approve buttons', () => {
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'agent_profile_restore',
          args: { doc_name: 'rules', target_hash: 'ab12cd34' }
        })}
      />
    )
    expect(screen.getByText('回滚身份文档')).toBeTruthy()
    expect(screen.getByText('rules')).toBeTruthy()
    // BOTH halves of the pinned identity are reviewable — approving must not be a blind rollback.
    expect(screen.getByText('回滚到版本 ab12cd34')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
    expect(screen.getByText('拒绝')).toBeTruthy()
  })

  test('agent_memory_update: shows the full proposed memory.md + approve buttons', () => {
    const respond = vi.fn()
    render(
      <SimpleApprovalCard
        {...mockProps({
          toolName: 'agent_memory_update',
          args: { content: '用户在洛杉矶（PT）。' },
          respondToApproval: respond
        })}
      />
    )
    expect(screen.getByText('更新长期记忆')).toBeTruthy()
    expect(screen.getByText('用户在洛杉矶（PT）。')).toBeTruthy()
    fireEvent.click(screen.getByText('允许'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
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

  test('reject → respondToApproval({ approved: false }) (two-step, L4 批次2)', () => {
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
    fireEvent.click(screen.getByText('拒绝'))
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认拒绝'))
    expect(respond).toHaveBeenCalledWith({ approved: false, reason: undefined })
  })
})

describe('SimpleApprovalCard — terminal phases', () => {
  test('rejected → shows the "已拒绝" banner, no approve button', () => {
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
    expect(screen.getByText('已拒绝，未执行该操作。')).toBeTruthy()
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
    expect(screen.queryByText('拒绝')).toBeNull()
  })
})
