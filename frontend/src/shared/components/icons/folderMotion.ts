// folder 家族动效图标的共用原型 —— 非图标模块，只放 variants / 路径常量。
//
// 24 个 folder 图标（`animated/folder-*.tsx` + `animated/folders.tsx` +
// `animated/folder.tsx`）里，动作只有五种原型：描线 / 位移 / 缩放 / 旋转 / 分层。
// 逐文件抄一遍 DRAW·NUDGE·PULSE 是同一个事实存二十份，改曲线得改二十处，所以
// 收在这里单源。曲线守 motion-gsap.md §10：显式 tween + ICON_EASE，禁 spring。
//
// 几何常量（BODY_FULL / BODY_ROUND）取自 lucide-react@1.16.0 的 __iconNode
// （`node_modules/lucide-react/dist/esm/icons/folder-*.mjs`），不是手打。

import type { MotionStyle, Transition, Variants } from 'motion/react'

import { ICON_EASE } from './AnimatedIcon'

/** 显式 tween —— motion 默认 spring 违 §8 红线。 */
export function folderTween(duration = 0.4, delay = 0): Transition {
  return { type: 'tween', duration, ease: ICON_EASE, delay }
}

/** 把 SVG 变换基准钉到 viewBox 坐标。
 *
 *  🔴 两个坑，都实测踩过：
 *  1. 必须写 `originX/originY`，**不能**写 `transformOrigin` —— motion 每帧自己
 *     根据 originX/originY（默认 0.5）重写 transform-origin，手写的那条会被无声
 *     覆盖成 `50% 50%`。症状是齿轮/时针绕整个 24×24 画布中心转，而不是绕自己。
 *  2. 同时钉 `transformBox: 'view-box'`，让上面那对 px 值按 viewBox 坐标解释
 *     （否则落到元素自身包围盒上，又偏了）。 */
export function folderOrigin(x: number, y: number): MotionStyle {
  return { transformBox: 'view-box', originX: `${x}px`, originY: `${y}px` }
}

/** 描线：从无到有画出来。custom = 第几笔（错开 0.1s）。 */
export const FOLDER_DRAW: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number = 0) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: folderTween(0.4, custom * 0.1)
  })
}

/** 位移后归位。custom = [dx, dy]。 */
export const FOLDER_NUDGE: Variants = {
  normal: { x: 0, y: 0 },
  animate: (custom: [number, number] = [0, 0]) => ({
    x: [0, custom[0], 0],
    y: [0, custom[1], 0],
    transition: { ...folderTween(0.5), times: [0, 0.4, 1] }
  })
}

/** 原地放大再收回。custom = 峰值倍数。 */
export const FOLDER_PULSE: Variants = {
  normal: { scale: 1 },
  animate: (custom: number = 1.2) => ({
    scale: [1, custom, 1],
    transition: { ...folderTween(0.45), times: [0, 0.45, 1] }
  })
}

/** 方角文件夹主体（folder / folder-check / -code / -down / -git / -minus /
 *  -plus / -up / -x 共用的静止外壳，不参与动画）。 */
export const FOLDER_BODY_FULL =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'

/** 圆角文件夹主体（folder-dot / -kanban / -root 共用）。 */
export const FOLDER_BODY_ROUND =
  'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'
