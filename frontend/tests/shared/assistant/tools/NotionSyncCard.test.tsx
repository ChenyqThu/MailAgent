// @vitest-environment happy-dom
//
// chat-panel P4 Phase 04a — NotionSyncCard (email_resync, preview tier). preview = approve /
// reject only (no editable fields, no resolve POST). Asserts the pending prompt + approval
// routing and the done state (old → new page id + action).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { NotionSyncCard } from '@shared/assistant/tools/notion/NotionSyncCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'email_resync',
    toolCallId: 'tc1',
    args: { internal_id: 42 },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

afterEach(() => cleanup())

describe('NotionSyncCard — pending', () => {
  test('shows the resync prompt + approve/reject; no editable textarea (preview tier)', () => {
    render(<NotionSyncCard {...mockProps({})} />)
    expect(screen.getByText(/重新把邮件 #42 推送到 Notion/)).toBeTruthy()
    expect(screen.getByText('重新同步')).toBeTruthy()
    expect(screen.getByText('拒绝')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  test('approve → respondToApproval(true); reject → respondToApproval(false)', async () => {
    const respondToApproval = vi.fn()
    render(<NotionSyncCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('重新同步'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))

    cleanup()
    const reject = vi.fn()
    render(<NotionSyncCard {...mockProps({ respondToApproval: reject })} />)
    fireEvent.click(screen.getByText('拒绝'))
    await waitFor(() => expect(reject).toHaveBeenCalledWith({ approved: false }))
  })
})

describe('NotionSyncCard — done', () => {
  test('shows old → new page id + the action', () => {
    render(
      <NotionSyncCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: {
            internal_id: 42,
            old_page_id: 'oldpage123456',
            new_page_id: 'newpage789012',
            action: 'recreated'
          }
        })}
      />
    )
    expect(screen.getByText(/已重建 Notion 页面/)).toBeTruthy()
    expect(screen.getByText(/oldpage1/)).toBeTruthy()
    expect(screen.getByText(/newpage7/)).toBeTruthy()
  })
})
