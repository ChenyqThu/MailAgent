// lucide-animated · grip-horizontal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLES = [
  { cx: 5, cy: 9 },
  { cx: 12, cy: 9 },
  { cx: 19, cy: 9 },
  { cx: 5, cy: 15 },
  { cx: 12, cy: 15 },
  { cx: 19, cy: 15 }
]

const VARIANTS: Variants = {
  normal: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: (index: number) => {
    const row = Math.floor(index / 3)
    const col = index % 3

    const delay = col * 0.15 + row * 0.25

    return {
      opacity: [1, 0.4, 1],
      scale: [1, 0.85, 1],
      transition: { delay, duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
    }
  }
}

export function GripHorizontalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {CIRCLES.map((circle, index) => (
        <motion.circle
          custom={index}
          cx={circle.cx}
          cy={circle.cy}
          key={`${circle.cx}-${circle.cy}`}
          r="1"
          variants={VARIANTS}
        />
      ))}
    </IconShell>
  )
}
