// SortableBoard 的命中判定（dnd-kit `collisionDetection`）。
//
// 单独成文是为了能直测：命中判定是「拖不进某个组」这类 bug 的唯一现场，而它在组件里
// 只是一个 prop，靠渲染测试摸不到。这里不碰 React，只依赖 dnd-kit 的两个纯函数。

import { pointerWithin, rectIntersection, type CollisionDetection } from '@dnd-kit/core'

/**
 * 多容器板的命中判定：**pointerWithin 优先，rectIntersection 兜底**。
 *
 * 🔴 不能用 `closestCenter`：它比的是「指针到各 droppable 中心点的距离」，于是一个
 * **空的 / 很扁的**组（干系人的空「核心」区只有一条 92px 虚线）永远抢不过旁边那张
 * 高得多的卡 —— 指针明明已经在虚线框里了，命中的却还是隔壁的卡 ⇒ 表现就是
 * 「拖进空的核心组完全没反应」。
 *
 * `pointerWithin` 判的是「指针在不在这个 droppable 的矩形里」，扁的组照样命中；
 * 指针落在所有 droppable 之外（拖到边缘、组与组之间的空隙）时它返回空，这时才退回
 * `rectIntersection`，用被拖卡自己的矩形去求重叠面积兜底。
 */
export const boardCollisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}
