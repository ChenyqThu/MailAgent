// lucide-animated · rocking-chair。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

const ROCKING_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [-5, 5, -5],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function RockingChairIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={ROCKING_VARIANTS}
      svgStyle={{ originX: '10%', originY: '90%' }}
    >
      <motion.polyline points="3.5 2 6.5 12.5 18 12.5" transition={DEFAULT_TRANSITION} />
      <motion.line transition={DEFAULT_TRANSITION} x1="9.5" x2="5.5" y1="12.5" y2="20" />
      <motion.line transition={DEFAULT_TRANSITION} x1="15" x2="18.5" y1="12.5" y2="20" />
      <motion.path d="M2.75 18a13 13 0 0 0 18.5 0" transition={DEFAULT_TRANSITION} />
    </IconShell>
  )
}
