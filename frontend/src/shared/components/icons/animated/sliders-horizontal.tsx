// lucide-animated · sliders-horizontal（滑块交错移动）。源 pqoqubbw/icons，改造：
// spring(stiffness/damping/mass) → 显式 tween + ICON_EASE（§10）；
// 去 forwardRef/controls/div 外壳；9 条 motion.line 保留各自 x 位置动画。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const T = { type: 'tween', duration: 0.4, ease: ICON_EASE } as const

export function SlidersHorizontalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {/* 顶轨左段 */}
      <motion.line
        variants={{ normal: { x2: 14 }, animate: { x2: 10 } }}
        transition={T}
        x1="21"
        x2="14"
        y1="4"
        y2="4"
      />
      {/* 顶轨右段 */}
      <motion.line
        variants={{ normal: { x1: 10 }, animate: { x1: 5 } }}
        transition={T}
        x1="10"
        x2="3"
        y1="4"
        y2="4"
      />
      {/* 中轨左段 */}
      <motion.line
        variants={{ normal: { x2: 12 }, animate: { x2: 18 } }}
        transition={T}
        x1="21"
        x2="12"
        y1="12"
        y2="12"
      />
      {/* 中轨右段 */}
      <motion.line
        variants={{ normal: { x1: 8 }, animate: { x1: 13 } }}
        transition={T}
        x1="8"
        x2="3"
        y1="12"
        y2="12"
      />
      {/* 底轨左段 */}
      <motion.line
        variants={{ normal: { x2: 12 }, animate: { x2: 4 } }}
        transition={T}
        x1="3"
        x2="12"
        y1="20"
        y2="20"
      />
      {/* 底轨右段 */}
      <motion.line
        variants={{ normal: { x1: 16 }, animate: { x1: 8 } }}
        transition={T}
        x1="16"
        x2="21"
        y1="20"
        y2="20"
      />
      {/* 顶滑块竖线 */}
      <motion.line
        variants={{ normal: { x1: 14, x2: 14 }, animate: { x1: 9, x2: 9 } }}
        transition={T}
        x1="14"
        x2="14"
        y1="2"
        y2="6"
      />
      {/* 中滑块竖线 */}
      <motion.line
        variants={{ normal: { x1: 8, x2: 8 }, animate: { x1: 14, x2: 14 } }}
        transition={T}
        x1="8"
        x2="8"
        y1="10"
        y2="14"
      />
      {/* 底滑块竖线 */}
      <motion.line
        variants={{ normal: { x1: 16, x2: 16 }, animate: { x1: 8, x2: 8 } }}
        transition={T}
        x1="16"
        x2="16"
        y1="18"
        y2="22"
      />
    </IconShell>
  )
}
