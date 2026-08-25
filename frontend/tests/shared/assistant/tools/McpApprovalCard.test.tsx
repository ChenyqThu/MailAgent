// @vitest-environment happy-dom
//
// Stage 1 PR2 — McpApprovalCard + McpToolFallback (the dynamic connector tool card router).
//
// Pins:
//   1. a PENDING mcp__* part renders the actionable approval card (connector + tool rows, args
//      preview, real approve/reject buttons wired to respondToApproval) — never the buttonless
//      ToolTraceCard spinner (the 1.5.0 dogfood bug class);
//   2. the destructive warning line renders ONLY from the server-fetched manifest fact (matched
//      via the shared mcpToolName mapping) — never projected from model args;
//   3. McpToolFallback routing: non-connector tools AND non-approval phases fall through to the
//      generic ToolTraceCard byte-identically.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { McpApprovalCard, McpToolFallback } from '@shared/assistant/tools/generic/McpApprovalCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
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

/** Stub the card's live manifest fetch (GET /api/connector/{id}/tools).
 *  `source` (08-05 WP-12) rides the SAME envelope as the tool rows — that is what makes the
 *  「经 Composio 云执行」line a live fact instead of something the model could talk away. */
function stubToolsFetch(
  tools: Array<Record<string, unknown>>,
  source = 'custom_mcp'
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: 'success', data: { tools, source } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('McpApprovalCard — pending', () => {
  test('renders connector/tool rows + args preview + working approve/reject buttons', async () => {
    stubToolsFetch([])
    const respond = vi.fn()
    render(<McpApprovalCard {...mockProps({ respondToApproval: respond })} />)
    expect(screen.getByText('调用外部服务工具')).toBeTruthy()
    expect(screen.getByText('notion')).toBeTruthy()
    // no manifest facts (empty stub) → the parsed slug is shown
    expect(screen.getByText('notion_update_page')).toBeTruthy()
    expect(screen.getByText(/"page_id": "p1"/)).toBeTruthy()
    const approve = screen.getByText('允许').closest('button')!
    fireEvent.click(approve)
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })

  test('reject button (two-step, L4 批次2) responds approved:false after the confirm click', () => {
    stubToolsFetch([])
    const respond = vi.fn()
    render(<McpApprovalCard {...mockProps({ respondToApproval: respond })} />)
    fireEvent.click(screen.getByText('拒绝').closest('button')!)
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认拒绝'))
    expect(respond).toHaveBeenCalledWith({ approved: false, reason: undefined })
  })

  test('destructive warning renders ONLY from the server manifest fact', async () => {
    stubToolsFetch([
      {
        name: 'notion-update-page', // matches via the shared mcpGatewayToolName mapping
        crud_type: 'write',
        destructive: true,
        effective_mode: 'auto',
        orphan: false
      }
    ])
    render(<McpApprovalCard {...mockProps({})} />)
    expect(await screen.findByText(/破坏性操作/)).toBeTruthy()
    // the matched remote name replaces the slug
    expect(screen.getByText('notion-update-page')).toBeTruthy()
  })

  test('no destructive line when the server does not mark it (even if args claim otherwise)', async () => {
    stubToolsFetch([
      {
        name: 'notion-update-page',
        crud_type: 'write',
        destructive: false,
        effective_mode: 'auto',
        orphan: false
      }
    ])
    render(<McpApprovalCard {...mockProps({ args: { destructive: true, page_id: 'p1' } })} />)
    expect(await screen.findByText('notion-update-page')).toBeTruthy()
    expect(screen.queryByText(/破坏性操作/)).toBeNull()
  })

  test('composio connectors disclose the cloud execution path (live fact, not model-supplied)', async () => {
    stubToolsFetch(
      [{ name: 'notion-update-page', crud_type: 'write', destructive: false, orphan: false }],
      'composio'
    )
    render(<McpApprovalCard {...mockProps({})} />)
    expect(await screen.findByText(/经 Composio 云执行/)).toBeTruthy()
  })

  test('direct (custom_mcp) connectors carry no Composio line', async () => {
    stubToolsFetch([
      { name: 'notion-update-page', crud_type: 'write', destructive: false, orphan: false }
    ])
    render(<McpApprovalCard {...mockProps({})} />)
    expect(await screen.findByText('notion-update-page')).toBeTruthy()
    expect(screen.queryByText(/经 Composio/)).toBeNull()
  })

  test('facts fetch failure degrades gracefully (card still approvable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 }))
    )
    const respond = vi.fn()
    render(<McpApprovalCard {...mockProps({ respondToApproval: respond })} />)
    fireEvent.click(screen.getByText('允许').closest('button')!)
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })
})

describe('McpToolFallback — routing', () => {
  test('pending mcp__* part → the approval card (buttons present)', () => {
    stubToolsFetch([])
    render(<McpToolFallback {...mockProps({})} />)
    expect(screen.getByText('调用外部服务工具')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
  })

  test('non-connector tool → generic ToolTraceCard (no MCP approval card)', () => {
    stubToolsFetch([])
    render(<McpToolFallback {...mockProps({ toolName: 'some_future_tool' })} />)
    expect(screen.queryByText('调用外部服务工具')).toBeNull()
  })

  test('mcp__* part in a DONE phase → generic trace card, not the approval card', () => {
    stubToolsFetch([])
    render(
      <McpToolFallback
        {...mockProps({
          status: { type: 'complete' },
          approval: undefined,
          result: { content: 'ok' }
        })}
      />
    )
    expect(screen.queryByText('调用外部服务工具')).toBeNull()
    expect(screen.queryByText('允许')).toBeNull()
  })
})
