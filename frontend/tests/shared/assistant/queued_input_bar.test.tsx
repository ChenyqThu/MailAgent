// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { QueuedInput } from '@shared/api/types'
import i18n from '@shared/i18n'

const setText = vi.fn()
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText }) })
}))

let queuedHandler: ((payload: { sessionId: number }) => void) | undefined
let turnHandler:
  | ((payload: {
      sessionId: number
      status: 'finished' | 'paused' | 'compacted'
      runId: string | null
    }) => void)
  | undefined
const disposeQueued = vi.fn()
const disposeTurn = vi.fn()
const mailApi = {
  chat: {
    onQueuedInputChanged: vi.fn((handler: typeof queuedHandler) => {
      queuedHandler = handler
      return disposeQueued
    }),
    onTurnPersisted: vi.fn((handler: typeof turnHandler) => {
      turnHandler = handler
      return disposeTurn
    })
  }
}
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))

import { QueuedInputBar } from '@shared/assistant/components/QueuedInputBar'

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  setText.mockClear()
  disposeQueued.mockClear()
  disposeTurn.mockClear()
  mailApi.chat.onQueuedInputChanged.mockClear()
  mailApi.chat.onTurnPersisted.mockClear()
  queuedHandler = undefined
  turnHandler = undefined
  vi.unstubAllGlobals()
})

function item(overrides: Partial<QueuedInput> = {}): QueuedInput {
  return {
    id: 1,
    sessionId: 7,
    runId: null,
    mode: 'follow_up',
    content: 'queued text',
    status: 'queued',
    createdAt: 1,
    updatedAt: 1,
    deliveredMessageId: null,
    ...overrides
  }
}

function renderBar(
  items: QueuedInput[],
  options: { approvalPendingExists?: boolean; queryClient?: QueryClient } = {}
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/ai/queued-input?')) {
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <QueuedInputBar
        enabled
        gatewayBaseUrl="http://gateway"
        sessionId={7}
        approvalPendingExists={options.approvalPendingExists === true}
      />
    </QueryClientProvider>
  )
  return { ...view, fetchMock, queryClient }
}

describe('QueuedInputBar', () => {
  test('empty queue renders zero DOM', async () => {
    renderBar([])
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByTestId('queued-input-bar')).toBeNull()
  })

  test('queued copy switches for approval waiting; claimed has no action buttons', async () => {
    const first = renderBar([item()])
    expect(await screen.findByText('Will send after the current task finishes')).toBeTruthy()
    first.unmount()

    renderBar([item()], { approvalPendingExists: true })
    expect(await screen.findByText('Will deliver after approval is resolved')).toBeTruthy()
    cleanup()

    renderBar([item({ status: 'claimed' })])
    expect(await screen.findByText('Sending…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('restored row exposes send action', async () => {
    renderBar([item({ status: 'restored' })])
    expect(await screen.findByText('Task interrupted · confirmation required')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send queued message' })).toBeTruthy()
  })

  test('edit cancels then restores text; delete cancels; restored send uses send endpoint', async () => {
    const editView = renderBar([item()])
    fireEvent.click(await screen.findByRole('button', { name: 'Edit queued message' }))
    expect(setText).toHaveBeenCalledWith('queued text')
    await waitFor(() =>
      expect(editView.fetchMock).toHaveBeenCalledWith(
        'http://gateway/api/ai/queued-input/cancel',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
    )
    editView.unmount()

    const deleteView = renderBar([item({ id: 2 })])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete queued message' }))
    await waitFor(() =>
      expect(deleteView.fetchMock).toHaveBeenCalledWith(
        'http://gateway/api/ai/queued-input/cancel',
        expect.any(Object)
      )
    )
    deleteView.unmount()

    const sendView = renderBar([item({ id: 3, status: 'restored' })])
    fireEvent.click(await screen.findByRole('button', { name: 'Send queued message' }))
    await waitFor(() =>
      expect(sendView.fetchMock).toHaveBeenCalledWith(
        'http://gateway/api/ai/queued-input/send',
        expect.any(Object)
      )
    )
  })

  test('queued-input broadcast invalidates only matching session and disposers run on unmount', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const view = renderBar([item()], { queryClient })
    await screen.findByTestId('queued-input-bar')
    invalidate.mockClear()

    queuedHandler?.({ sessionId: 8 })
    expect(invalidate).not.toHaveBeenCalled()
    queuedHandler?.({ sessionId: 7 })
    expect(invalidate).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(disposeQueued).toHaveBeenCalledOnce()
    expect(disposeTurn).toHaveBeenCalledOnce()
  })
})
