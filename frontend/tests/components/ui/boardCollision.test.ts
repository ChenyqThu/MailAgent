// SortableBoard 的命中判定闸（`ui/boardCollision.ts`）。
//
// 现场：干系人「核心」组为空时是一条很扁的虚线落点（92px），它下面是一整排高卡。
// 用 `closestCenter`（改动前）时，比的是**被拖卡矩形的中心**到各 droppable 中心的距离
// —— 指针明明已经在虚线框里，命中的却是下面那张卡 ⇒ owner 报的「拖不进空的核心组，
// 完全没反应」。下面第一个用例把这个几何关系原样搭出来，并当场对照 `closestCenter`
// 会给出什么，防止有人改回去。

import { closestCenter, type CollisionDetection } from '@dnd-kit/core'
import { describe, expect, test } from 'vitest'

import { boardCollisionDetection } from '@shared/components/ui/boardCollision'
import { groupDroppableId } from '@shared/components/ui/boardOrder'

type CollisionArgs = Parameters<CollisionDetection>[0]

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

const CORE = groupDroppableId('core')
const NORMAL = groupDroppableId('normal')

/** 扁核心落点在上（0..20），一张高卡在下（40..200），指针停在核心落点里。 */
function args(pointer: { x: number; y: number } | null): CollisionArgs {
  const droppableRects = new Map<string, ReturnType<typeof rect>>([
    [CORE, rect(0, 0, 600, 20)],
    [NORMAL, rect(0, 40, 600, 160)],
    ['card-1', rect(0, 40, 240, 160)]
  ])
  return {
    active: { id: 'card-9', data: { current: undefined }, rect: { current: {} } },
    // 被拖的卡跟着指针走，但它有 160px 高 —— 中心落在下面那张卡附近。
    collisionRect: rect(20, 5, 240, 160),
    droppableRects,
    droppableContainers: [...droppableRects.keys()].map((id) => ({ id })),
    pointerCoordinates: pointer
  } as unknown as CollisionArgs
}

describe('boardCollisionDetection', () => {
  test('🔴 指针在扁的空组落点里 → 命中该组（closestCenter 会命中下面那张高卡）', () => {
    const hit = boardCollisionDetection(args({ x: 100, y: 15 }))
    expect(hit[0]?.id).toBe(CORE)

    // 对照：改回 closestCenter 就是这个结果 —— 指针在核心区里，却命中了别的东西。
    expect(closestCenter(args({ x: 100, y: 15 }))[0]?.id).not.toBe(CORE)
  })

  test('指针落在所有落点之外 → 退回 rectIntersection（用被拖卡的矩形求重叠），不返回空', () => {
    const hit = boardCollisionDetection(args({ x: 5000, y: 5000 }))
    expect(hit.length).toBeGreaterThan(0)
  })

  test('没有指针坐标（键盘拖拽）→ 同样走 rectIntersection 兜底', () => {
    const hit = boardCollisionDetection(args(null))
    expect(hit.length).toBeGreaterThan(0)
  })
})
