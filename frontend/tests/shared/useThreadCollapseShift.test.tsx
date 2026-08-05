// @vitest-environment happy-dom
//
// 线程收起的位移过渡（方案 A，2026-08）—— 手工 FLIP 的接线契约。
//
// 这里锁的是三条容易悄悄回退的不变量（几何差分本身在 emailListRows.test.ts）：
//
// 1. 🔴 **一次性**：位移由「收起前 capture 的快照」驱动，快照在 layout effect 里
//    立刻消费掉。邮件列表是 react-window 虚拟列表，行随滚动卸载/重挂；若哪天改成
//    按「线程是否折叠」之类的静态状态驱动，用户每次滚动、每次新邮件到达都会看到
//    整列再滑一遍 —— 而这种回退在肉眼 code review 里极难看出来。
// 2. 🔴 **只写独立 `translate` 属性**：react-window v2 把行定位写成 inline
//    `transform: translateY(...)`，动 transform 会连定位一起冲掉。
// 3. 🔴 **任何一次行重排都先收掉在途位移**：行的 translateY 已经变了，残留的
//    translate 会把行画到错的地方（快速连点「收起 A → 立刻展开 B」正好撞上）。

import { useCallback, useEffect, useRef } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ListImperativeAPI } from 'react-window'

import { useThreadCollapseShift } from '../../src/shared/hooks/useThreadCollapseShift'
import { rowIdentityKey, rowKeyAttrs, type ListRow } from '@shared/components/email/emailListRows'

// ─── Fixtures ─────────────────────────────────────────────────────────

function emailRow(internal_id: number, thread?: unknown): ListRow {
  return {
    type: 'email',
    email: { internal_id, subject: 's', sender: 'a@b.test' },
    groupKey: 'today',
    bundleSelected: false,
    thread
  } as unknown as ListRow
}

const HEADER: ListRow = { type: 'header', key: 'today', label: 'T', count: 1, collapsed: false }
const AGG = { memberIds: [1, 2, 3], aggFlagged: false }
const HEAD_OPEN = emailRow(1, {
  isHead: true,
  threadId: 't1',
  childCount: 2,
  expanded: true,
  agg: AGG
})
const HEAD_SHUT = emailRow(1, {
  isHead: true,
  threadId: 't1',
  childCount: 2,
  expanded: false,
  agg: AGG
})
const CHILD_A = emailRow(1, { isHead: false, threadId: 't1', childIndex: 0 })
const CHILD_B = emailRow(2, { isHead: false, threadId: 't1', childIndex: 1 })
const TAIL = emailRow(9)

const EXPANDED: ListRow[] = [HEADER, HEAD_OPEN, CHILD_A, CHILD_B, TAIL]
const EXPANDED_H = [28, 60, 60, 60, 60]
const COLLAPSED: ListRow[] = [HEADER, HEAD_SHUT, TAIL]
const COLLAPSED_H = [28, 60, 60]

// ─── Harness ──────────────────────────────────────────────────────────
//
// 复刻 react-window v2 的行渲染形态：绝对定位 + inline `transform: translateY(top)`
// + 外层 div 带 data-row-key。listRef 用一个只有 .element 的 fake ListImperativeAPI
// （生产里 element 就是滚动容器，既有的手风琴锚定 tween 也直接读它的 scrollTop）。

interface Api {
  captureCollapse: () => void
}

function Harness({
  rows,
  heights,
  reduceMotion,
  api
}: {
  rows: ListRow[]
  heights: number[]
  reduceMotion: boolean
  api: Api
}): React.ReactElement {
  const listRef = useRef<ListImperativeAPI | null>(null)
  const setEl = useCallback((el: HTMLDivElement | null): void => {
    listRef.current = el ? ({ element: el } as unknown as ListImperativeAPI) : null
  }, [])
  const { captureCollapse } = useThreadCollapseShift({
    rows,
    rowHeights: heights,
    listRef,
    reduceMotion
  })
  // 每次 render 后刷新，测试拿到的恒是当前闭包（captureCollapse 随 rows 变身份）。
  useEffect(() => {
    api.captureCollapse = captureCollapse
  })
  let top = 0
  return (
    <div ref={setEl} data-testid="scroller">
      {rows.map((r, i) => {
        const y = top
        top += heights[i] ?? 0
        return (
          <div
            key={rowIdentityKey(r)}
            {...rowKeyAttrs(r)}
            style={{ position: 'absolute', left: 0, transform: `translateY(${y}px)` }}
          />
        )
      })}
    </div>
  )
}

interface Harnessed {
  api: Api
  rerender: (rows: ListRow[], heights: number[]) => void
  rowEl: (r: ListRow) => HTMLElement
  /** 该行当前的位移值（未位移 = ''）。走 getPropertyValue：`translate` 的驼峰
   *  别名在 happy-dom 里只是个普通 JS 属性，读它会绕过真正的 CSS 声明块。 */
  shiftOf: (r: ListRow) => string
}

function mount(rows: ListRow[], heights: number[], reduceMotion = false): Harnessed {
  const api: Api = { captureCollapse: () => {} }
  const utils = render(
    <Harness rows={rows} heights={heights} reduceMotion={reduceMotion} api={api} />
  )
  const rowEl = (r: ListRow): HTMLElement =>
    utils.container.querySelector<HTMLElement>(`[data-row-key="${rowIdentityKey(r)}"]`)!
  return {
    api,
    rerender: (next, nextH) =>
      utils.rerender(<Harness rows={next} heights={nextH} reduceMotion={reduceMotion} api={api} />),
    rowEl,
    shiftOf: (r) => rowEl(r).style.getPropertyValue('translate')
  }
}

afterEach(() => cleanup())

// ─── Tests ────────────────────────────────────────────────────────────

describe('useThreadCollapseShift — 收起位移的接线', () => {
  test('capture 之后收起 → 下方行以「旧位置」为起点（inline translate 同步写在 paint 前）', () => {
    const { api, rerender, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    // 两个子行各 60px 被摘掉 → 尾随行的旧视觉位置比新位置低 120px。
    expect(shiftOf(TAIL)).toBe('0 120px')
  })

  test('🔴 只写独立 translate，react-window 的 transform 定位原样保留', () => {
    const { api, rerender, rowEl, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('0 120px')
    // 收起后 TAIL 的 react-window 定位 = 28 + 60 = 88px，未被动画覆盖。
    expect(rowEl(TAIL).style.transform).toBe('translateY(88px)')
  })

  test('收起点上方的行与收起行本身不动（无 clamp 时 dy=0）', () => {
    const { api, rerender, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(HEADER)).toBe('')
    expect(shiftOf(HEAD_SHUT)).toBe('')
  })

  test('🔴 一次性：快照被消费后，下一次行重排（分页 / 新邮件到达）不重播', () => {
    const { api, rerender, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('0 120px')
    // 没有新的 capture —— 这次重排纯粹是列表数据变了（多来一封邮件）。
    const extra = emailRow(42)
    rerender([HEADER, HEAD_SHUT, extra, TAIL], [28, 60, 60, 60])
    expect(shiftOf(TAIL)).toBe('')
    expect(shiftOf(extra)).toBe('')
  })

  test('🔴 在途位移被下一次重排收掉（收起 A 立刻展开 B 不留 translate 残留）', () => {
    const { api, rerender, rowEl, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('0 120px')
    // tween 还没跑完就重新展开 → 行的 transform 定位已经变了，残留的 translate
    // 会把它画到错的地方，必须在新一轮开始前清掉。
    rerender(EXPANDED, EXPANDED_H)
    expect(shiftOf(TAIL)).toBe('')
    // 只清 translate，不动 react-window 的定位（28+60×3 = 208px）。
    expect(rowEl(TAIL).style.transform).toBe('translateY(208px)')
  })

  test('reduced-motion → capture 是 no-op，行直接落位', () => {
    const { api, rerender, shiftOf } = mount(EXPANDED, EXPANDED_H, true)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('')
  })

  test('没 capture 的重排（手风琴隐式收起 / 轮询刷新）不产生位移', () => {
    const { rerender, shiftOf } = mount(EXPANDED, EXPANDED_H)
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('')
  })

  test('capture 后几何没变 → 不起 tween，也不留残留', () => {
    const { api, rerender, shiftOf } = mount(COLLAPSED, COLLAPSED_H)
    api.captureCollapse()
    // 同样的 rows 内容、新的数组引用（例如 useMemo 因无关依赖重算）。
    rerender([...COLLAPSED], [...COLLAPSED_H])
    expect(shiftOf(TAIL)).toBe('')
  })

  test('tween 跑完后 translate 被摘干净（残留 = 该行永久错位）', async () => {
    const { api, rerender, shiftOf } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    expect(shiftOf(TAIL)).toBe('0 120px')
    // DUR.base = 220ms；等到 onComplete 真的把属性移除（而不是停在 `0 0px`）。
    await waitFor(() => expect(shiftOf(TAIL)).toBe(''), { timeout: 2000 })
  })

  test('卸载时 tween 随之 kill（虚拟列表红线，不留下每帧写 detached 节点的 ticker）', () => {
    const { api, rerender, rowEl } = mount(EXPANDED, EXPANDED_H)
    api.captureCollapse()
    rerender(COLLAPSED, COLLAPSED_H)
    const el = rowEl(TAIL)
    cleanup()
    expect(el.style.getPropertyValue('translate')).toBe('')
  })
})
