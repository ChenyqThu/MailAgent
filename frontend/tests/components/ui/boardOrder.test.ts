import { describe, expect, it } from 'vitest'

import {
  applyBoardDrag,
  groupDroppableId,
  groupIdOfContainer,
  groupIdOfHeader,
  headerDroppableId,
  sameBoardOrder,
  type BoardGroupOrder
} from '@shared/components/ui/boardOrder'

/**
 * SortableBoard 的落位算法（grid + 跨组拖拽的核心）。
 *
 * 这些是「只有真拖才会发现」的一类 bug，所以逻辑抽出来直测：跨组插到第几位、空组能不能
 * 接、拖到自己身上、拖到折叠标题上、以及「没变化要返回同一个引用」（每帧调用，造新对象
 * 会让整块板每帧重渲）。
 */

const A: BoardGroupOrder = { id: 'core', itemIds: ['1', '2'] }
const B: BoardGroupOrder = { id: 'normal', itemIds: ['3', '4'] }
const board = [A, B]

const drag = (active: string, over: string | null) => ({
  active: { id: active },
  over: over == null ? null : { id: over }
})

const ids = (groups: readonly BoardGroupOrder[]): Record<string, string[]> =>
  Object.fromEntries(groups.map((group) => [group.id, [...group.itemIds]]))

describe('droppable id 编解码', () => {
  it('组容器与折叠标题各自可辨认，互不误判', () => {
    expect(groupIdOfContainer(groupDroppableId('core'))).toBe('core')
    expect(groupIdOfHeader(headerDroppableId('normal'))).toBe('normal')
    expect(groupIdOfContainer(headerDroppableId('normal'))).toBeNull()
    expect(groupIdOfHeader(groupDroppableId('core'))).toBeNull()
    expect(groupIdOfContainer('7')).toBeNull()
  })
})

describe('组内重排', () => {
  it('拖到同组另一张卡上 → 插到它的位置', () => {
    expect(ids(applyBoardDrag(board, drag('1', '2')))).toEqual({
      core: ['2', '1'],
      normal: ['3', '4']
    })
  })

  it('🔴 向后拖：占据 over 的原下标（先移除自己再找下标会差一位 → 拖了等于没拖）', () => {
    const three = [{ id: 'core', itemIds: ['1', '2', '3'] }]
    expect(ids(applyBoardDrag(three, drag('1', '3')))).toEqual({ core: ['2', '3', '1'] })
  })

  it('向前拖：同样占据 over 的原下标', () => {
    const three = [{ id: 'core', itemIds: ['1', '2', '3'] }]
    expect(ids(applyBoardDrag(three, drag('3', '1')))).toEqual({ core: ['3', '1', '2'] })
  })

  it('拖到同组容器上 → 落到本组末尾', () => {
    expect(ids(applyBoardDrag(board, drag('1', groupDroppableId('core'))))).toEqual({
      core: ['2', '1'],
      normal: ['3', '4']
    })
  })
})

describe('跨组搬运', () => {
  it('拖到另一组的某张卡上 → 插到那张卡的位置', () => {
    expect(ids(applyBoardDrag(board, drag('1', '4')))).toEqual({
      core: ['2'],
      normal: ['3', '1', '4']
    })
  })

  it('拖到另一组的容器上 → 落到那组末尾', () => {
    expect(ids(applyBoardDrag(board, drag('1', groupDroppableId('normal'))))).toEqual({
      core: ['2'],
      normal: ['3', '4', '1']
    })
  })

  it('🔴 空组也能接：否则最后一个 item 拖出去后再也拖不回来', () => {
    const emptied = [
      { id: 'core', itemIds: [] },
      { id: 'normal', itemIds: ['1', '2'] }
    ]
    expect(ids(applyBoardDrag(emptied, drag('1', groupDroppableId('core'))))).toEqual({
      core: ['1'],
      normal: ['2']
    })
  })

  it('搬走后原组的相对次序不变', () => {
    const wide = [
      { id: 'core', itemIds: ['1', '2', '3'] },
      { id: 'normal', itemIds: [] }
    ]
    expect(ids(applyBoardDrag(wide, drag('2', groupDroppableId('normal'))))).toEqual({
      core: ['1', '3'],
      normal: ['2']
    })
  })
})

describe('不该动数据的情形', () => {
  it('over 为空 → 同一个引用（每帧都调，造新对象会让整块板每帧重渲）', () => {
    expect(applyBoardDrag(board, drag('1', null))).toBe(board)
  })

  it('拖到自己身上 → 同一个引用', () => {
    expect(applyBoardDrag(board, drag('1', '1'))).toBe(board)
  })

  it('悬停在折叠标题上 → 数据不动（展开由组件那侧负责）', () => {
    // ⚠️ 这条守的是**行为**，不是那行短路：把 `groupIdOfHeader` 短路删掉它照样绿
    // （header id 不属于任何组，找 targetGroupId 会落空并原样返回）。变异验证时确认过。
    expect(applyBoardDrag(board, drag('1', headerDroppableId('normal')))).toBe(board)
  })

  it('落回原位 → 同一个引用（拖起来又放回是常态，不该触发提交）', () => {
    // '1' 本来就在 core 的第 0 位，拖到 core 容器会落到末尾 → 这是**变化**；
    // 真正的「没变」是拖到自己所在位置的那张卡上，上面已覆盖。这里验的是 sameBoardOrder
    // 与引用保持的配合：把 '2' 插回它自己的位置。
    const single = [{ id: 'core', itemIds: ['1'] }]
    expect(applyBoardDrag(single, drag('1', groupDroppableId('core')))).toBe(single)
  })

  it('拖的 item 不在任何组里 → 不搅乱数据', () => {
    expect(applyBoardDrag(board, drag('999', '2'))).toBe(board)
  })

  it('over 是未知的 droppable → 不搅乱数据', () => {
    expect(applyBoardDrag(board, drag('1', 'something-else'))).toBe(board)
  })
})

describe('sameBoardOrder', () => {
  it('同序为真，换序为假', () => {
    expect(sameBoardOrder(board, [{ ...A }, { ...B }])).toBe(true)
    expect(sameBoardOrder(board, [{ id: 'core', itemIds: ['2', '1'] }, B])).toBe(false)
  })

  it('跨组搬运也算变化（组内顺序相同但归属变了）', () => {
    expect(
      sameBoardOrder(board, [
        { id: 'core', itemIds: ['1'] },
        { id: 'normal', itemIds: ['2', '3', '4'] }
      ])
    ).toBe(false)
  })
})
