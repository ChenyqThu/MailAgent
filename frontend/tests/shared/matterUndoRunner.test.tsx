// @vitest-environment happy-dom
//
// Matters MVP P3 (lane ③) — the write-receipt undo runner (D9). Two outcomes matter:
//   · success → the card goes terminal ('done') and the matter's queries are invalidated so the
//     detail/list reflect the reversal without a reload;
//   · E_VERSION_CONFLICT → the card returns to 'idle' and the user is told the matter moved on
//     (a blind retry is exactly the wrong response to "there were later changes").
// Also pinned: the undo is a renderer-direct REST call (no chat message) carrying reason=撤销.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { MatterUndoDescriptor } from '@shared/api/matters'

const { chatApi, toastError } = vi.hoisted(() => ({
  chatApi: { contextSnapshot: vi.fn(), recordChatScope: vi.fn(), applyUndo: vi.fn() },
  toastError: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({}),
  useMatterChatApi: () => chatApi,
  useMattersEnabled: () => true
}))
vi.mock('@shared/state/toast', () => ({
  toastError,
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { useMatterUndoRunner, MATTER_UNDO_REASON } =
  await import('@shared/components/matters/useMatterUndoRunner')

await i18n.changeLanguage('zh-CN')

const DESCRIPTOR: MatterUndoDescriptor = {
  tool: 'matter_item_mutate',
  input: { public_id: 'MAT-0042', operation: 'delete', item_id: 12, expected_version: 4 },
  label: '撤销新增事项条目'
}

function renderRunner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const view = renderHook(() => useMatterUndoRunner('MAT-0042'), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  })
  return { ...view, invalidate }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('useMatterUndoRunner', () => {
  test('success: card goes terminal, REST carries reason=撤销, matter queries invalidated', async () => {
    chatApi.applyUndo.mockResolvedValue({})
    const { result, invalidate } = renderRunner()
    act(() => result.current.runUndo('tc-1', DESCRIPTOR))
    await waitFor(() => expect(result.current.undoStates['tc-1']).toBe('done'))
    expect(chatApi.applyUndo).toHaveBeenCalledWith(DESCRIPTOR, { reason: MATTER_UNDO_REASON })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['matters', 'detail', 'MAT-0042'] })
  })

  test('E_VERSION_CONFLICT: card returns to idle with the "matter moved on" message', async () => {
    chatApi.applyUndo.mockRejectedValue(
      Object.assign(new Error('matter version changed'), { code: 'E_VERSION_CONFLICT' })
    )
    const { result } = renderRunner()
    act(() => result.current.runUndo('tc-1', DESCRIPTOR))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('事项已被后续修改，无法直接撤销'))
    expect(result.current.undoStates['tc-1']).toBe('idle')
  })

  test('any other failure reports the error and leaves the undo retryable', async () => {
    chatApi.applyUndo.mockRejectedValue(Object.assign(new Error('offline'), { code: 'E_NETWORK' }))
    const { result } = renderRunner()
    act(() => result.current.runUndo('tc-1', DESCRIPTOR))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError.mock.calls[0][0]).toBe('撤销失败')
    expect(result.current.undoStates['tc-1']).toBe('idle')
  })

  test('a double click cannot fire two reversals', async () => {
    let resolveUndo: (() => void) | null = null
    chatApi.applyUndo.mockImplementation(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveUndo = () => resolve({})
        })
    )
    const { result } = renderRunner()
    act(() => result.current.runUndo('tc-1', DESCRIPTOR))
    act(() => result.current.runUndo('tc-1', DESCRIPTOR))
    expect(chatApi.applyUndo).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveUndo?.()
    })
    await waitFor(() => expect(result.current.undoStates['tc-1']).toBe('done'))
  })
})
