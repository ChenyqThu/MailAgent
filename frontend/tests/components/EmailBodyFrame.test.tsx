// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockBody } = vi.hoisted(() => ({ mockBody: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { body: mockBody },
    attachment: { readDataUrl: vi.fn() }
  })
}))

import i18n from '@shared/i18n'
import { EmailBodyFrame } from '../../src/shared/components/email/EmailBodyFrame'

await i18n.changeLanguage('zh-CN')

function renderFrame(): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailBodyFrame internalId={101} attachments={[]} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('EmailBodyFrame large-body preview', () => {
  test('shows truncation notice and loads the full body on demand', async () => {
    mockBody.mockImplementation(async (_id: number, opts: { mode?: string }) => ({
      internal_id: 101,
      format: 'html',
      content: opts.mode === 'full' ? '<p>full body</p>' : '<p>preview body</p>',
      size_bytes: 300_000,
      truncated: opts.mode !== 'full',
      fetched_at: 1,
      fetched_source: 'davmail'
    }))

    renderFrame()

    expect(await screen.findByText('正文较大，当前仅显示预览。')).toBeTruthy()
    const button = screen.getByRole('button', { name: '显示完整正文' })
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockBody).toHaveBeenCalledWith(101, { format: 'html', mode: 'full' })
    })
    await waitFor(() => {
      expect(screen.queryByText('正文较大，当前仅显示预览。')).toBeNull()
    })
  })

  test('does not render expansion controls for a normal body', async () => {
    mockBody.mockResolvedValue({
      internal_id: 101,
      format: 'html',
      content: '<p>normal body</p>',
      size_bytes: 120,
      truncated: false,
      fetched_at: 1,
      fetched_source: 'davmail'
    })

    renderFrame()

    await waitFor(() => expect(mockBody).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: '显示完整正文' })).toBeNull()
  })
})
