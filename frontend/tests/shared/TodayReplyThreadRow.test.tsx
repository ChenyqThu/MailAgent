// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@shared/i18n'
import { TodayReplyThreadRow } from '@shared/components/today/TodayReplyThreadRow'
import { buildReplyItems } from '@shared/components/today/todaySections'
import { __resetToastStore, useToastStore } from '@shared/state/toast'
import type { TodayReplyItem } from '@shared/api/types'

const { dismiss, undo } = vi.hoisted(() => ({
  dismiss: vi.fn(async () => ({ operationId: 'op-1' })),
  undo: vi.fn(async () => ({ operationId: 'op-1' }))
}))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => ({ today: { dismiss, undo } }) }))
await i18n.changeLanguage('zh-CN')
afterEach(() => {
  cleanup()
  __resetToastStore()
  vi.clearAllMocks()
})

test('默认折叠；展开打开具体邮件；整组只提交当前 IDs，toast 可撤销', async () => {
  const message: TodayReplyItem = {
    id: 'mail:1',
    source: 'mail',
    title: '确认报价',
    meta: 'Alice',
    why: '需要回复',
    atIso: '2026-09-09T00:00:00Z',
    waitedMs: 3600000,
    actionable: true,
    link: { kind: 'mail', internalId: 1 }
  }
  const second: TodayReplyItem = {
    ...message,
    id: 'mail:2',
    meta: 'Bob',
    link: { kind: 'mail', internalId: 2 }
  }
  const item = buildReplyItems([
    { ...second, id: 'thread:t', threadId: 't', internalIds: [1, 2], messages: [second, message] }
  ])[0]
  const onOpen = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TodayReplyThreadRow item={item} onOpen={onOpen} />
    </QueryClientProvider>
  )
  expect(screen.queryByText('Alice · 确认报价')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '2 封待回邮件' }))
  fireEvent.click(screen.getByText('Alice · 确认报价'))
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ link: { kind: 'mail', internalId: 1 } })
  )
  fireEvent.click(screen.getByRole('button', { name: '待回邮件操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '这 2 封无需回复' }))
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith([1, 2]))
  await waitFor(() => expect(useToastStore.getState().items).toHaveLength(1))
  useToastStore.getState().items[0].action?.onClick()
  await waitFor(() => expect(undo).toHaveBeenCalledWith('op-1'))
  client.clear()
})
