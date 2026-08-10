// @vitest-environment happy-dom
//
// Matters MVP P3 (lane ③) — MatterWriteCard, the ONE card registered for the 7 matter write tools.
// Asserts the three routes it exists for:
//   · completed write INSIDE a Matter Chat panel → 「已写入 · {写入描述}」 + a 撤销 button wired to
//     the panel's runUndo (renderer-direct REST — the card never sends a chat message). The
//     headline is keyed off the TOOL (matters.chat.writeLabels), never off undo.label — that one
//     names the reverse operation and belongs on the undo button's tooltip;
//   · the SAME completed part OUTSIDE the panel (普通 chat, no surface context) → no receipt: it
//     falls through to the generic tool card, byte-identically to the pre-P3 rendering;
//   · an approval-paused part → real approve / reject buttons (SimpleApprovalCard), never the
//     buttonless spinner these edit-tier writes would otherwise get.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { MatterWriteCard } from '@shared/assistant/tools/matters/MatterWriteCard'
import {
  MatterChatSurfaceContext,
  readUndoDescriptor,
  type MatterChatSurface,
  type MatterUndoState
} from '@shared/components/matters/matterChatContext'

await i18n.changeLanguage('zh-CN')

const UNDO = {
  tool: 'matter_item_mutate',
  input: { public_id: 'MAT-0042', operation: 'delete', item_id: 12, expected_version: 4 },
  label: '撤销新增事项条目'
}

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'matter_item_mutate',
    toolCallId: 'tc-1',
    args: { public_id: 'MAT-0042', operation: 'create' },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'complete' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

function surface(
  runUndo: MatterChatSurface['runUndo'],
  undoStates: Record<string, MatterUndoState> = {}
): MatterChatSurface {
  return { publicId: 'MAT-0042', runUndo, undoStates }
}

afterEach(cleanup)

describe('MatterWriteCard — write receipt inside the Matter Chat panel', () => {
  test('headline describes THE WRITE (per tool), not the undo; 撤销 calls the panel handler', () => {
    const runUndo = vi.fn()
    render(
      <MatterChatSurfaceContext.Provider value={surface(runUndo)}>
        <MatterWriteCard {...mockProps({ result: { matter: {}, undo: UNDO } })} />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByTestId('matter-write-receipt')).toBeTruthy()
    expect(screen.getByText('已写入 · 条目已更新')).toBeTruthy()
    // 🔴 the reverse-operation wording must NOT be the headline (it would read as "already undone").
    expect(screen.queryByText('已写入 · 撤销新增事项条目')).toBeNull()
    // it IS the undo button's tooltip — that is the action it names.
    expect(screen.getByText('撤销').closest('button')?.title).toBe('撤销新增事项条目')
    fireEvent.click(screen.getByText('撤销'))
    expect(runUndo).toHaveBeenCalledWith('tc-1', UNDO)
  })

  test('each write tool gets its own headline', () => {
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn())}>
        <MatterWriteCard
          {...mockProps({ toolName: 'matter_create', result: { matter: {}, undo: UNDO } })}
        />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('已写入 · 已创建事项')).toBeTruthy()
  })

  test('an unknown tool falls back to the undo label, then to the plain 已写入', () => {
    const view = render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn())}>
        <MatterWriteCard
          {...mockProps({ toolName: 'matter_future_tool', result: { matter: {}, undo: UNDO } })}
        />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('已写入 · 撤销新增事项条目')).toBeTruthy()
    view.unmount()
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn())}>
        <MatterWriteCard
          {...mockProps({ toolName: 'matter_future_tool', result: { matter: {}, undo: null } })}
        />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('已写入')).toBeTruthy()
  })

  test('an irreversible write (undo: null) keeps its headline but has no undo affordance', () => {
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn())}>
        <MatterWriteCard {...mockProps({ result: { matter: {}, undo: null } })} />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('已写入 · 条目已更新')).toBeTruthy()
    expect(screen.queryByText('撤销')).toBeNull()
  })

  test('after a successful undo the card is terminal: 已撤销, no second undo', () => {
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn(), { 'tc-1': 'done' })}>
        <MatterWriteCard {...mockProps({ result: { matter: {}, undo: UNDO } })} />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('已撤销')).toBeTruthy()
    expect(screen.queryByText('撤销')).toBeNull()
  })

  test('the undo button is disabled while the reversal is in flight', () => {
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn(), { 'tc-1': 'busy' })}>
        <MatterWriteCard {...mockProps({ result: { matter: {}, undo: UNDO } })} />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.getByText('撤销').closest('button')?.disabled).toBe(true)
  })
})

describe('MatterWriteCard — outside the Matter Chat panel', () => {
  test('普通 chat: the same completed part renders no receipt (generic tool card)', () => {
    render(<MatterWriteCard {...mockProps({ result: { matter: {}, undo: UNDO } })} />)
    expect(screen.queryByTestId('matter-write-receipt')).toBeNull()
    expect(screen.queryByText('撤销')).toBeNull()
  })
})

describe('MatterWriteCard — approval-paused', () => {
  test('shows real approve / reject buttons instead of a buttonless spinner', () => {
    const respondToApproval = vi.fn()
    render(
      <MatterChatSurfaceContext.Provider value={surface(vi.fn())}>
        <MatterWriteCard
          {...mockProps({
            toolName: 'matter_resource_mutate',
            status: { type: 'requires-action', reason: 'interrupt' },
            approval: { id: 'apr-1' },
            respondToApproval
          } as Partial<ToolCallMessagePartProps>)}
        />
      </MatterChatSurfaceContext.Provider>
    )
    expect(screen.queryByTestId('matter-write-receipt')).toBeNull()
    fireEvent.click(screen.getByText('允许'))
    expect(respondToApproval).toHaveBeenCalledWith({ approved: true })
  })
})

describe('readUndoDescriptor', () => {
  test('accepts a well-formed descriptor and rejects everything else', () => {
    expect(readUndoDescriptor({ undo: UNDO })).toEqual(UNDO)
    expect(readUndoDescriptor({ undo: null })).toBeNull()
    expect(readUndoDescriptor({})).toBeNull()
    expect(readUndoDescriptor({ undo: { tool: 'x' } })).toBeNull()
    expect(readUndoDescriptor({ undo: { tool: 'x', input: {}, label: 3 } })).toBeNull()
    expect(readUndoDescriptor('nope')).toBeNull()
  })
})
