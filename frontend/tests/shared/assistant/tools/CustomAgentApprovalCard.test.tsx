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
  test('capability profile is human-readable and drives exec/web risk warnings', () => {
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          args: {
            id: 'tiered',
            title: 'Tiered',
            capabilities: {
              email: 'draft',
              calendar: 'write',
              knowledge: 'off',
              reports: 'produce',
              web: 'open',
              files: 'on'
            }
          }
        })}
      />
    )
    expect(screen.getByText(/邮件=起草/)).toBeTruthy()
    expect(screen.getByText(/日历=写入/)).toBeTruthy()
    expect(screen.getByText(/报告=产出/)).toBeTruthy()
    expect(screen.getByText(/开启本机执行/)).toBeTruthy()
    expect(screen.getByText(/全开放联网/)).toBeTruthy()
  })

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
    expect(screen.getByText('默认（email、search、report）')).toBeTruthy()
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

  test('facts unreachable + capability patch → reject-only', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', capabilities: { reports: 'produce' } }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/不应盲批/)).toBeTruthy())
    expect(screen.queryByText('批准修改')).toBeNull()
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

// MCP connector epic stage 1 PR3 — grant_connectors is model-proposable (customAgentCreate/
// UpdateSchema), and a connector grant hands a HEADLESS run 免卡 access to an external workspace.
// 🔴 So it must be a first-class axis of this card: invisible here = the owner approves blind,
// which is exactly the defense ADR-004 rev3.1 §7 moved onto this surface.
describe('CustomAgentApprovalCard — grant_connectors axis (PR3)', () => {
  test('create with a connector grant renders the ceiling + the red new-access warning', () => {
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          args: {
            id: 'noted',
            title: 'Noted',
            grant_connectors: { notion: 'update', jira: 'read' }
          }
        })}
      />
    )
    expect(screen.getByText('外部服务')).toBeTruthy()
    expect(screen.getByText('jira=只读 · notion=读 + 新建 + 修改')).toBeTruthy()
    expect(screen.getByText(/新增外部服务授权/)).toBeTruthy()
  })

  test('create without connector grants → 无, no warning', () => {
    render(<CustomAgentApprovalCard {...mockProps({ args: { id: 'plain', title: 'Plain' } })} />)
    expect(screen.getByText('无')).toBeTruthy()
    expect(screen.queryByText(/新增外部服务授权/)).toBeNull()
  })

  test('update: server-fact before → after, ceiling RAISE is an escalation', async () => {
    fetchMock.mockImplementation(async () =>
      agentEnvelope({ v: 1, grant_connectors: { notion: 'read' } })
    )
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', grant_connectors: { notion: 'write' } }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('notion=读 + 新建')).toBeTruthy())
    expect(screen.getByText('notion=只读')).toBeTruthy() // server truth, struck through
    expect(screen.getByText(/notion=write/)).toBeTruthy() // escalation warning names it
  })

  test('update: LOWERING a ceiling changes the row but is NOT an escalation', async () => {
    fetchMock.mockImplementation(async () =>
      agentEnvelope({ v: 1, grant_connectors: { notion: 'update' } })
    )
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', grant_connectors: { notion: 'read' } }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('notion=只读')).toBeTruthy())
    expect(screen.queryByText(/新增外部服务授权/)).toBeNull()
  })

  test('update: a patch NOT mentioning grant_connectors shows the SERVER row (model-lie negative)', async () => {
    fetchMock.mockImplementation(async () =>
      agentEnvelope({ v: 1, grant_connectors: { notion: 'update' } })
    )
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', title: 'Renamed' }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText('notion=读 + 新建 + 修改')).toBeTruthy())
    expect(screen.queryByText(/新增外部服务授权/)).toBeNull()
  })

  test("🔴 a forged 'delete' ceiling is never rendered as granted (per-entry fail-closed)", () => {
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          args: { id: 'evil', title: 'Evil', grant_connectors: { notion: 'delete', '': 'write' } }
        })}
      />
    )
    expect(screen.getByText('无')).toBeTruthy()
    expect(screen.queryByText(/notion/)).toBeNull()
  })

  test('a connector-only patch counts as a permission patch → facts miss is reject-only', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    render(
      <CustomAgentApprovalCard
        {...mockProps({
          toolName: 'custom_agent_update',
          args: { agent_id: 'dms-approver', grant_connectors: { notion: 'write' } }
        })}
      />
    )
    await waitFor(() => expect(screen.getByText(/不应盲批/)).toBeTruthy())
    expect(screen.queryByText('批准修改')).toBeNull()
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
