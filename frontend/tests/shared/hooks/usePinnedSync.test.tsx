// @vitest-environment happy-dom
//
// useTogglePin 的行为闸 —— 「点 pin 图标发出去的那一次写，方向必须和用户看到的
// 亮/暗一致」。
//
// 这条不变量之前没有测试守着，于是 dogfood 撞上了它：pin 的**显示**读
// `usePinned` zustand（模块级，活得跟 renderer 一样久），而**方向判定**曾经读
// `['pinnedIds']` 查询缓存（离开邮件视图超过 gcTime 会被回收，重进到首个 fetch
// 落地之间也是空）。两者一岔开，点「取消置顶」发出去的是 `pinned=true`——服务端
// 把已置顶的行原地重写一遍，图标照亮、行照留在已固定桶，看上去就是「点了没反应」。
//
// 测的是外部可见行为（发给 mailApi.email.pin 的那一次调用 + 图标态），不是
// 「读了哪个缓存」。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { usePinned } from '@shared/state/pinned'
import { qk } from '@shared/lib/queryKeys'
import type { EnrichedEmailMeta } from '@shared/api/types'

/** 假服务端的置顶集 —— 只有挂了 usePinnedSync 的用例会读它 (经 listPinnedIds)。 */
let serverPinned = new Set<number>()
const pinSpy = vi.fn(async (id: number, pinned: boolean): Promise<boolean> => {
  if (pinned) serverPinned.add(id)
  else serverPinned.delete(id)
  return pinned
})
const listPinnedIdsSpy = vi.fn(
  async (): Promise<number[]> => [...serverPinned].sort((a, b) => a - b)
)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { pin: pinSpy, listPinnedIds: listPinnedIdsSpy, flag: vi.fn(async () => ({})) }
  })
}))

const { EmailRow } = await import('@shared/components/email/EmailRow')
const { usePinnedSync } = await import('@shared/hooks/usePinnedSync')

await i18n.changeLanguage('en-US')

function makeEmail(over: Partial<EnrichedEmailMeta> = {}): EnrichedEmailMeta {
  return {
    internal_id: 101,
    message_id: '<msg-101@example.com>',
    thread_id: 'thread-A',
    subject: 'redis timeout',
    sender: 'alice@example.com',
    sender_name: 'Alice',
    date_received: '2026-05-15T09:00:00+08:00',
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false,
    sync_status: 'synced',
    notion_page_id: null,
    notion_url: null,
    snippet: '',
    lang: 'en',
    ai_priority: null,
    ai_action: null,
    attach_count: 0,
    is_important: false,
    ...over
  } as EnrichedEmailMeta
}

interface RowOpts {
  email?: EnrichedEmailMeta
  threadHead?: { memberIds: number[]; aggFlagged: boolean }
  /** true = 同时挂 usePinnedSync（邮件视图在场，['pinnedIds'] 查询有观察者）。
   *  省略 = 缓存永远缺席（离开邮件视图 > gcTime 被回收 / 首个 fetch 未落地）。 */
  withSync?: boolean
}

/** 邮件视图不在场：只有行，没有 ['pinnedIds'] 观察者 → 查询缓存恒空。 */
function RowOnly(props: { email: EnrichedEmailMeta; threadHead?: RowOpts['threadHead'] }) {
  return <EmailRow {...props} selected={false} onSelect={() => {}} />
}

/** 邮件视图在场：useEmailListRows 会在行旁边挂 usePinnedSync()。 */
function RowWithSync(props: { email: EnrichedEmailMeta; threadHead?: RowOpts['threadHead'] }) {
  usePinnedSync()
  return <RowOnly {...props} />
}

function renderRow(opts: RowOpts = {}): { qc: QueryClient; container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Row = opts.withSync === true ? RowWithSync : RowOnly
  const { container } = render(
    <QueryClientProvider client={qc}>
      <Row email={opts.email ?? makeEmail()} threadHead={opts.threadHead} />
    </QueryClientProvider>
  )
  return { qc, container }
}

const pinBtn = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector<HTMLElement>('.ricon-pin')
  if (el === null) throw new Error('pin button not rendered')
  return el
}
const isLit = (c: HTMLElement): boolean => pinBtn(c).getAttribute('aria-pressed') === 'true'

beforeEach(() => {
  cleanup()
  pinSpy.mockClear()
  listPinnedIdsSpy.mockClear()
  serverPinned = new Set<number>()
  usePinned.getState().setPinned([])
})

describe('useTogglePin — 方向判据与显示同源', () => {
  test('图标亮着但 pinned 查询缓存缺席 → 点击仍然发「取消置顶」', async () => {
    // 真实成因：离开邮件视图 > gcTime 后 ['pinnedIds'] 被回收 / 重进视图首个
    // fetch 落地之前，缓存是空的，而 usePinned 是模块级的、仍记得置顶集。
    usePinned.getState().setPinned([101])
    const { qc, container } = renderRow()
    expect(qc.getQueryData(qk.pinnedIds())).toBeUndefined()
    expect(isLit(container)).toBe(true)

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.[0]).toBe(101)
    expect(pinSpy.mock.calls[0]?.[1]).toBe(false) // 取消置顶, 不是原地重 pin
    await waitFor(() => expect(isLit(container)).toBe(false))
  })

  test('缓存缺席时取消其中一封, 不会把别的置顶行一起抹掉', async () => {
    // 乐观写回缓存时若把「缓存缺席」当成「一个都没置顶」, 写回去的 next 会经
    // usePinnedSync 的整表 setPinned 把 202 也一并清掉 (直到下一次 refetch)。
    usePinned.getState().setPinned([101, 202])
    const { container } = renderRow()

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(usePinned.getState().pinned).not.toContain(101))
    expect(usePinned.getState().pinned).toContain(202)
  })

  test('缓存在场且与 store 一致 → 取消置顶行为不变 (无回归)', async () => {
    serverPinned = new Set([101])
    const { qc, container } = renderRow({ withSync: true })
    await waitFor(() => expect(qc.getQueryData(qk.pinnedIds())).toEqual([101]))
    expect(isLit(container)).toBe(true)

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([101, false])
    await waitFor(() => expect(isLit(container)).toBe(false))
  })

  test('一封都没置顶 → 点击是「置顶」(方向没被钉死成 false)', async () => {
    const { container } = renderRow()
    expect(isLit(container)).toBe(false)

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([101, true])
    await waitFor(() => expect(isLit(container)).toBe(true))
  })
})

describe('useTogglePin — 线程虚拟头的级联取消', () => {
  const HEAD = { memberIds: [101, 102, 103], aggFlagged: false }

  test('任一成员置顶 → 点母行 = 级联取消整线程 (方向恒 false, 带 cascadeThread)', async () => {
    // 母邮件自己没置顶, 只有子成员置顶 —— 聚合态亮, 但「取反」会反向置顶整条线程,
    // 所以级联方向必须钉死 false。
    usePinned.getState().setPinned([102])
    const { container } = renderRow({ threadHead: HEAD })
    expect(isLit(container)).toBe(true)

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]).toEqual([101, false, { cascadeThread: true }])
    await waitFor(() => expect(isLit(container)).toBe(false))
    expect(usePinned.getState().pinned).not.toContain(102)
  })

  test('一个成员都没置顶 → 点母行 = 只置顶最新一封 (不级联)', async () => {
    const { container } = renderRow({ threadHead: HEAD })
    expect(isLit(container)).toBe(false)

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([101, true])
    expect(pinSpy.mock.calls[0]?.[2]).toBeUndefined()
    expect(usePinned.getState().pinned).toEqual([101])
  })
})
