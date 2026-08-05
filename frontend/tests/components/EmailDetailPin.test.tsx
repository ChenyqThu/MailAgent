// @vitest-environment happy-dom
//
// pin 入口审计 · 入口 3 —— 邮件详情工具栏的置顶按钮。
//
// 这条链和列表行是两套接线（EmailDetail 自己拿 useTogglePin + 把 onTogglePin/isPinned
// 传给 EmailToolbar 的 GhostBtn），所以列表行走通**不代表**详情页走通：GhostBtn 有
// `isDisabled = disabled || pending || !onClick` 的自动禁用，任何一环没传就是一个
// 点了没反应的死按钮。这里渲染真 EmailDetail、点真按钮，断言写请求发出去了。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const pinSpy = vi.fn(async (_id: number, pinned: boolean): Promise<boolean> => pinned)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      get: vi.fn(async (id: number) => ({
        internal_id: id,
        message_id: `<msg-${id}@example.com>`,
        thread_id: 'thread-A',
        subject: 'redis timeout',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        to_addr: 'me@example.com',
        date_received: '2026-05-15T09:00:00+08:00',
        mailbox: '收件箱',
        is_read: true,
        is_flagged: false,
        is_important: false,
        sync_status: 'synced',
        notion_page_id: null,
        notion_url: null,
        body_html: '<p>hi</p>',
        body_text: 'hi',
        lang: 'en',
        attachments: []
      })),
      aiFields: vi.fn(async () => null),
      listByThread: vi.fn(async () => []),
      pin: pinSpy,
      listPinnedIds: vi.fn(async () => [] as number[]),
      flag: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
      resync: vi.fn(async () => ({})),
      draft: vi.fn(async () => ({})),
      draftPlan: vi.fn(async () => ({}))
    },
    attachment: { list: vi.fn(async () => []), localPath: vi.fn() },
    ai: {
      translateBatch: vi.fn(),
      abortTranslate: vi.fn(),
      getCached: vi.fn(async () => null),
      deleteCached: vi.fn()
    },
    llm: { run: vi.fn(async () => ({})) },
    calendar: { emailLink: vi.fn(async () => null) }
  })
}))

import i18n from '@shared/i18n'
import { usePinned } from '@shared/state/pinned'
import { EmailDetail } from '../../src/shared/components/email/EmailDetail'

await i18n.changeLanguage('en-US')

function renderDetail(internalId: number): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <EmailDetail internalId={internalId} />
    </QueryClientProvider>
  ).container
}

/** 工具栏 pin 按钮 —— 恒**当场重查**, 不缓存节点。
 *
 *  EmailToolbar 的 `useContainerDensity` 在挂载后量出宽度会翻 `wantsLabels`,
 *  GhostBtn 据此在「裸 <button>」与「HoverTip 包裹的 <button>」之间换结构 ——
 *  React 会换掉真实 DOM 节点。提前抓住的引用会变成脱离文档的孤儿, 点它不触发任何
 *  handler（测试假红, 与产品无关: 真人点的永远是当下那个节点）。 */
const pinBtn = (c: HTMLElement): HTMLButtonElement => {
  const el = c.querySelector<HTMLButtonElement>(
    `button[aria-label="${i18n.t('toolbar.togglePin')}"]`
  )
  if (el === null) throw new Error('toolbar pin button not rendered')
  return el
}

async function waitForToolbar(c: HTMLElement): Promise<void> {
  await waitFor(() => expect(c.querySelector('[aria-label="inbox-main"]')).not.toBeNull())
  await waitFor(() => expect(pinBtn(c)).toBeTruthy())
}

beforeEach(() => {
  cleanup()
  pinSpy.mockClear()
  usePinned.getState().setPinned([])
})

describe('入口 3 — EmailDetail / EmailToolbar 的置顶按钮', () => {
  test('未置顶时点击 → 发出 pin 写 (按钮没被 GhostBtn 自动禁用)', async () => {
    const c = renderDetail(101)
    await waitForToolbar(c)
    expect(pinBtn(c).disabled).toBe(false)

    fireEvent.click(pinBtn(c))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([101, true])
  })

  test('已置顶时点击 → 发出取消置顶 (方向跟随 usePinned, 与列表行同源)', async () => {
    usePinned.getState().setPinned([101])
    const c = renderDetail(101)
    await waitForToolbar(c)
    // 亮态也从 usePinned 来 —— 它读的是 store 方法而非 s.pinned 数组, 这里一并钉死
    // 「订阅有效」(否则图标会停在旧态, 用户看到的和实际写的又要分家)。
    expect(pinBtn(c).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(pinBtn(c))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([101, false])
    // 详情页恒单封语义 —— 不许把级联写喷到整条线程。
    expect(pinSpy.mock.calls[0]?.[2]).toBeUndefined()
    await waitFor(() => expect(pinBtn(c).getAttribute('aria-pressed')).toBe('false'))
  })
})
