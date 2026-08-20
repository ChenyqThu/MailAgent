// @vitest-environment happy-dom
//
// 线程展开的子行入场动画接线（2026-07-20 owner 反馈「emaillist 的线程折叠没动效」）。
//
// 🔴 这里锁的是**一条容易悄悄回退的不变量**：入场必须由一次性的 `revealThreadId`
// 驱动，**不能**由 `thread.expanded` 驱动。邮件列表是 react-window 虚拟列表，子行
// 随滚动卸载/重挂；若按静态的 expanded 驱动 CSS 动画，用户每次把已展开的线程滚出
// 再滚回，子行就会重播一遍入场 —— 而且这种回退在肉眼 code review 里极难看出来。
//
// 另锁：stagger 序号封顶（长线程最后一行不该等大半秒）、母邮件行不参与入场。

import { describe, expect, test, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock('@shared/components/email/EmailRow', () => ({
  EmailRow: ({ email }: { email: { internal_id: number } }) => (
    <div data-testid={`row-${email.internal_id}`} />
  )
}))

const { VirtualRow } = await import('@shared/components/email/EmailListVirtualRow')
import type { RowProps } from '@shared/components/email/EmailListVirtualRow'
import type { ListRow } from '@shared/components/email/emailListRows'

function email(internal_id: number, thread: ListRow extends never ? never : unknown): ListRow {
  return {
    type: 'email',
    email: { internal_id, subject: 's', sender: 'a@b' },
    groupKey: 'today',
    bundleSelected: false,
    thread
  } as unknown as ListRow
}

const HEAD = email(1, {
  isHead: true,
  threadId: 't1',
  childCount: 2,
  expanded: true,
  agg: { memberIds: [1, 2, 3], aggFlagged: false }
})
const CHILD0 = email(2, { isHead: false, threadId: 't1', childIndex: 0 })
const CHILD1 = email(3, { isHead: false, threadId: 't1', childIndex: 1 })
const CHILD_BIG = email(4, { isHead: false, threadId: 't1', childIndex: 42 })
const OTHER_CHILD = email(5, { isHead: false, threadId: 't2', childIndex: 0 })

function renderRow(index: number, rows: ListRow[], revealThreadId: string | null): HTMLElement {
  const props: RowProps = {
    rows,
    activeId: null,
    newIds: new Set<number>(),
    onSelect: () => {},
    onToggleGroup: () => {},
    onToggleThread: () => {},
    onExpandThread: () => {},
    revealThreadId
  }
  const { container } = render(
    <VirtualRow
      index={index}
      style={{ top: 0, height: 60 }}
      // react-window 每行注入的无障碍属性（1-based 序号 / 集合总数 / 列表项角色）——
      // 真实渲染时由列表容器算好传进来，这里照它的口径给。
      ariaAttributes={{
        'aria-posinset': index + 1,
        'aria-setsize': rows.length,
        role: 'listitem'
      }}
      {...props}
    />
  )
  return container.firstElementChild as HTMLElement
}

describe('线程子行入场标记', () => {
  test('刚展开的线程 → 子行带 data-thread-reveal + stagger 序号', () => {
    const el = renderRow(1, [HEAD, CHILD0, CHILD1], 't1')
    expect(el.getAttribute('data-thread-reveal')).toBe('true')
    expect(el.style.getPropertyValue('--thread-reveal-i')).toBe('0')
    cleanup()

    const el1 = renderRow(2, [HEAD, CHILD0, CHILD1], 't1')
    expect(el1.style.getPropertyValue('--thread-reveal-i')).toBe('1')
    cleanup()
  })

  test('🔴 revealThreadId=null 时不标记 —— 即使该行仍属于已展开的线程', () => {
    // 这正是虚拟列表滚动重挂的场景：线程还开着，但入场窗口早过了。
    // 若哪天有人把判据改回 thread.expanded，这条会红。
    const el = renderRow(1, [HEAD, CHILD0, CHILD1], null)
    expect(el.hasAttribute('data-thread-reveal')).toBe(false)
    expect(el.style.getPropertyValue('--thread-reveal-i')).toBe('')
    cleanup()
  })

  test('别的线程刚展开 → 本线程子行不参与（手风琴切换时旧线程不该闪）', () => {
    const el = renderRow(1, [HEAD, CHILD0], 't2')
    expect(el.hasAttribute('data-thread-reveal')).toBe(false)
    cleanup()

    const other = renderRow(1, [HEAD, OTHER_CHILD], 't2')
    expect(other.getAttribute('data-thread-reveal')).toBe('true')
    cleanup()
  })

  test('母邮件行永不入场（它本来就在原地，动了反而像跳）', () => {
    const el = renderRow(0, [HEAD, CHILD0], 't1')
    expect(el.hasAttribute('data-thread-reveal')).toBe(false)
    cleanup()
  })

  test('stagger 序号封顶 6 —— 30 封的线程最后一行不该等大半秒', () => {
    const el = renderRow(1, [HEAD, CHILD_BIG], 't1')
    expect(el.style.getPropertyValue('--thread-reveal-i')).toBe('6')
    cleanup()
  })

  test('react-window 的定位 style 被原样保留（动画只加 opacity/translate，不抢定位）', () => {
    const el = renderRow(1, [HEAD, CHILD0], 't1')
    expect(el.style.height).toBe('60px')
    expect(el.style.top).toBe('0px')
    cleanup()
  })
})
