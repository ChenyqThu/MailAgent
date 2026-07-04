// @vitest-environment happy-dom
//
// S6 W3-2 (ADR-004 rev3.1 §7 D5 / D-fix-2) — CustomAgentApprovalCard render tests.
//
// Asserts the create card's permission summary (exec + web-open red warnings, skill list), the
// UPDATE card's server-fact before/after diff (before is FETCHED from serve-api, never the
// model's args — including the "model lies about before" negative: a field absent from the
// patch renders the server's real current value), the fail-closed reject-only stance when the
// permission baseline cannot be read, and approve/reject wiring.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { CustomAgentApprovalCard } from '@shared/assistant/tools/generic/CustomAgentApprovalCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'custom_agent_create',
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

/** serve-api envelope for GET /report-agents?agentId= (the update card's before-facts). */
function agentEnvelope(toolPolicy: Record<string, unknown> | null): Response {
  return new Response(
    JSON.stringify({
      status: 'success',
      data: {
        id: 'dms-approver',
        type: 'custom',
        title: 'DMS Approver',
        enabled: true,
        tool_policy: toolPolicy
      }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.history.replaceState({}, '', '/?apiPort=8200')
  fetchMock = vi.fn(async () => agentEnvelope(null))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CustomAgentApprovalCard — create (pending)', () => {
  test('permission summary renders exec/web-open red warnings + skill list; NO server fetch', () => {
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          args: {
            id: 'webby',
            title: 'Webby',
            prompt: '每天抓取网页并总结。',
            grant_exec: true,
            grant_web: 'open',
            skills: ['email', 'dms-approval']
          }
        })}
      />
    )
    expect(screen.getByText('创建 Custom Agent')).toBeTruthy()
    expect(screen.getByText('Webby')).toBeTruthy()
    expect(screen.getByText(/每天抓取网页并总结/)).toBeTruthy()
    expect(screen.getByText('所需权限')).toBeTruthy()
    // exec on + open web → both red warning lines
    expect(screen.getByText(/开启本机执行/)).toBeTruthy()
    expect(screen.getByText(/全开放联网/)).toBeTruthy()
    expect(screen.getByText('email、dms-approval')).toBeTruthy()
    expect(screen.getByText('批准创建')).toBeTruthy()
    // create diffs against safe defaults locally — no baseline fetch
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('defaults create (no grants) → off/off/default mounts, no red warnings', () => {
    render(<CustomAgentApprovalCard {...mockProps({ args: { id: 'plain', title: 'Plain' } })} />)
    expect(screen.queryByText(/开启本机执行/)).toBeNull()
    expect(screen.queryByText(/全开放联网/)).toBeNull()
    expect(screen.getByText('默认（email、search）')).toBeTruthy()
  })

  test('approve / reject wire respondToApproval', () => {
    const respond = vi.fn()
    render(
      <CustomAgentApprovalCard
        {...mockProps({ args: { id: 'x', title: 'X' }, respondToApproval: respond })}
      />
    )
    fireEvent.click(screen.getByText('批准创建'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })
})

describe('CustomAgentApprovalCard — update (server-fact before/after diff)', () => {
  test('grant_web off→open renders the server before (line-through) and the red after', async () => {
    // server truth: web absent (off), exec already true, skills ['email']
    fetchMock.mockImplementation(async () =>
      agentEnvelope({ v: 1, grant_exec: true, skills: ['email'] })
    )
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', grant_web: 'open' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('全开放（任意 URL）')).toBeTruthy())
    // the fetch went to the report-agents row (server facts)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/report-agents?agentId=dms-approver')
    // before value from the SERVER row (off), struck through; after red
    expect(screen.getByText('关闭')).toBeTruthy()
    expect(screen.getByText(/全开放联网/)).toBeTruthy() // escalation warning
    // 🔴 model-lie negative: the patch says nothing about exec/skills — the card shows the
    // server's real current values (exec 开启, skills email), not a fabricated baseline.
    expect(screen.getByText('开启')).toBeTruthy()
    expect(screen.getByText('email')).toBeTruthy()
    expect(screen.getByText('批准修改')).toBeTruthy()
  })

  test('no permission change → no red escalation warnings (title-only patch still shows perms)', async () => {
    fetchMock.mockImplementation(async () => agentEnvelope({ v: 1, grant_web: 'gated' }))
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', title: 'Renamed' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('域名白名单')).toBeTruthy())
    // unchanged gated web → no escalation warning, no gated note (not an escalation)
    expect(screen.queryByText(/全开放联网/)).toBeNull()
    expect(screen.queryByText(/域名白名单联网/)).toBeNull()
  })

  test('facts unreachable + permission patch → reject-only (fail-closed review floor)', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', grant_web: 'open' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/不应盲批/)).toBeTruthy())
    expect(screen.queryByText('批准修改')).toBeNull()
    expect(screen.getByText('拒绝')).toBeTruthy()
  })

  test('facts unreachable + non-permission patch → degraded warning, approve still offered', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', title: 'Renamed' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/仅显示提交的改动/)).toBeTruthy())
    expect(screen.getByText('批准修改')).toBeTruthy()
  })
})

describe('CustomAgentApprovalCard — terminal phases', () => {
  test('done renders the created/updated echo', () => {
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          args: { id: 'x', title: 'X' },
          result: { created: true, id: 'x' },
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true }
        })}
      />
    )
    expect(screen.getByText(/已创建/)).toBeTruthy()
  })
})
