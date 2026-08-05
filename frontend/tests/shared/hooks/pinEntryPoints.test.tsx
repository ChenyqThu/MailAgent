// @vitest-environment happy-dom
//
// pin 入口全量审计 —— 「每一个能点到 pin 的地方，点下去都真的发出一次写」。
//
// 背景：dogfood 报「取消 pin 无效」，但活库时间戳显示那段时间**一次 pin 写入都没有**
// （`set_pin_many` 对命中的行恒 bump `pinned_at`/`updated_at`，哪怕值没变）。所以除了
// 方向判错（见 usePinnedSync.test.tsx），还必须排掉「请求根本没发出」这一类：某个入口
// 的 handler 没接上 / 被 guard 静默 return / 点击被行体吞掉。
//
// 这里刻意走**真实的行模型链**：groupByThread → partitionByDate → flattenGroups →
// VirtualRow → EmailRow，而不是手捏 threadHead prop —— 「置顶桶里的行到底有没有拿到
// agg」正是要验的东西，手捏就把被测对象假设掉了。

import { describe, expect, test, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { usePinned } from '@shared/state/pinned'
import {
  flattenGroups,
  groupByThread,
  partitionByDate,
  type ListRow
} from '@shared/components/email/emailListRows'
import type { GroupKey } from '@shared/state/group-collapse'
import type { EnrichedEmailMeta } from '@shared/api/types'

const pinSpy = vi.fn(async (_id: number, pinned: boolean): Promise<boolean> => pinned)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      pin: pinSpy,
      listPinnedIds: vi.fn(async () => [] as number[]),
      flag: vi.fn(async () => ({}))
    }
  })
}))

const { VirtualRow } = await import('@shared/components/email/EmailListVirtualRow')

await i18n.changeLanguage('en-US')

function makeEmail(id: number, over: Partial<EnrichedEmailMeta> = {}): EnrichedEmailMeta {
  return {
    internal_id: id,
    message_id: `<msg-${id}@example.com>`,
    thread_id: 'thread-A',
    subject: `subject ${id}`,
    sender: 'alice@example.com',
    sender_name: 'Alice',
    // 同日递增：groupByThread 按 date_received DESC 选 head → 103 是最新一封。
    date_received: `2026-05-15T0${id - 100}:00:00+08:00`,
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

const LABELS: Record<GroupKey, string> = {
  pinned: '已固定',
  flat: '全部',
  today: '今天',
  yesterday: '昨天',
  thisWeek: '本周',
  lastWeek: '上周',
  older: '更早'
}

/** 真实行模型：一条 3 封的线程 + 给定的置顶集 → flattenGroups 的 rows。 */
function buildRows(pinnedIds: number[], expanded: boolean): ListRow[] {
  const emails = [makeEmail(101), makeEmail(102), makeEmail(103)]
  const groups = groupByThread(emails, new Map())
  const buckets = partitionByDate(groups, new Set(pinnedIds))
  return flattenGroups(
    buckets,
    LABELS,
    () => false,
    () => expanded,
    null,
    false
  )
}

interface Rendered {
  container: HTMLElement
  onSelect: ReturnType<typeof vi.fn>
}

function renderRowAt(rows: ListRow[], index: number): Rendered {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const { container } = render(
    <QueryClientProvider client={qc}>
      <VirtualRow
        index={index}
        style={{}}
        rows={rows}
        activeId={null}
        newIds={new Set<number>()}
        onSelect={onSelect}
        onToggleGroup={() => {}}
        onToggleThread={() => {}}
        onExpandThread={() => {}}
        revealThreadId={null}
        ariaAttributes={{ role: 'row', 'aria-posinset': index + 1, 'aria-setsize': rows.length }}
      />
    </QueryClientProvider>
  )
  return { container, onSelect }
}

const pinBtn = (c: HTMLElement): HTMLElement => {
  const el = c.querySelector<HTMLElement>('.ricon-pin')
  if (el === null) throw new Error('pin button not rendered')
  return el
}

/** rows 里第 n 个 email 行的下标（跳过 header / loader）。 */
function emailRowIndex(rows: ListRow[], nth: number): number {
  let seen = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.type === 'email') {
      if (seen === nth) return i
      seen++
    }
  }
  throw new Error(`no email row #${nth}`)
}

beforeEach(() => {
  cleanup()
  pinSpy.mockClear()
  usePinned.getState().setPinned([])
})

// ── 入口 1：置顶桶里的行 ────────────────────────────────────────────────
describe('入口 1 — 「📌 已固定」桶里的行', () => {
  test('置顶桶的母行是虚拟头形态 (拿得到 agg + memberIds 非空)', () => {
    const rows = buildRows([102], false)
    // 第一行是 pinned 组标题, 说明整条线程确实被 threadPinned 收进置顶桶。
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned' })
    const head = rows[emailRowIndex(rows, 0)]
    if (head?.type !== 'email') throw new Error('not an email row')
    expect(head.groupKey).toBe('pinned')
    expect(head.thread?.isHead).toBe(true)
    const agg = head.thread?.isHead === true ? head.thread.agg : undefined
    expect(agg).toBeDefined()
    // memberIds 恒含母邮件自己 —— 不存在「聚合亮但 memberIds 为空」的形态。
    expect(agg?.memberIds).toEqual([103, 102, 101])
  })

  test('置顶桶母行点 pin → 发出级联取消 (请求真的出去了)', async () => {
    usePinned.getState().setPinned([102])
    const rows = buildRows([102], false)
    const { container } = renderRowAt(rows, emailRowIndex(rows, 0))
    expect(pinBtn(container).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]).toEqual([103, false, { cascadeThread: true }])
  })
})

// ── 入口 2：展开态的虚拟头 / 子行 ───────────────────────────────────────
describe('入口 2 — 展开态的虚拟头与子行', () => {
  test('展开时同一封邮件出现两行 (虚拟头 + 首个子行), 语义不同', () => {
    const rows = buildRows([102], true)
    const head = rows[emailRowIndex(rows, 0)]
    const firstChild = rows[emailRowIndex(rows, 1)]
    if (head?.type !== 'email' || firstChild?.type !== 'email') throw new Error('bad rows')
    expect(head.email.internal_id).toBe(103)
    expect(firstChild.email.internal_id).toBe(103) // 同一封
    expect(head.thread?.isHead).toBe(true)
    expect(firstChild.thread?.isHead).toBe(false) // 子行 = 纯单封语义
  })

  test('展开态虚拟头点 pin → 仍走级联 (展开不改变母行语义)', async () => {
    usePinned.getState().setPinned([102])
    const rows = buildRows([102], true)
    const { container } = renderRowAt(rows, emailRowIndex(rows, 0))

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]).toEqual([103, false, { cascadeThread: true }])
  })

  test('展开态「最新一封」的重复子行点 pin → 单封写, 不级联', async () => {
    usePinned.getState().setPinned([103])
    const rows = buildRows([103], true)
    const { container } = renderRowAt(rows, emailRowIndex(rows, 1))

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([103, false])
    expect(pinSpy.mock.calls[0]?.[2]).toBeUndefined()
  })

  test('展开态的普通子行点 pin → 只动自己那封', async () => {
    usePinned.getState().setPinned([102])
    const rows = buildRows([102], true)
    // 子行序: 103(重复) / 102 / 101 → 第 2 个 email 行 = 102
    const idx = emailRowIndex(rows, 2)
    const row = rows[idx]
    if (row?.type !== 'email') throw new Error('bad row')
    expect(row.email.internal_id).toBe(102)
    const { container } = renderRowAt(rows, idx)
    expect(pinBtn(container).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(pinSpy.mock.calls[0]?.slice(0, 2)).toEqual([102, false])
    expect(pinSpy.mock.calls[0]?.[2]).toBeUndefined()
  })
})

// ── 入口 5：点击热区 / 冒泡 ─────────────────────────────────────────────
describe('入口 5 — 点击不被行体吞掉', () => {
  test('点 pin 图标: 发出写请求, 且不触发行选中 (stopPropagation 生效)', async () => {
    usePinned.getState().setPinned([102])
    const rows = buildRows([102], false)
    const { container, onSelect } = renderRowAt(rows, emailRowIndex(rows, 0))

    fireEvent.click(pinBtn(container))

    await waitFor(() => expect(pinSpy).toHaveBeenCalledTimes(1))
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('点行体: 走选中, 不误发 pin 写', () => {
    const rows = buildRows([102], false)
    const { container, onSelect } = renderRowAt(rows, emailRowIndex(rows, 0))

    fireEvent.click(container.querySelector('article.email-row')!)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(pinSpy).not.toHaveBeenCalled()
  })
})
