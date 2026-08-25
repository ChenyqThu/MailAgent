// lucide-animated · grip-vertical。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLES = [
  { cx: 9, cy: 5 },
  { cx: 9, cy: 12 },
  { cx: 9, cy: 19 },
  { cx: 15, cy: 5 },
  { cx: 15, cy: 12 },
  { cx: 15, cy: 19 }
]

const ROWS = 3

const VARIANTS: Variants = {
  normal: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: (data: { index: number }) => {
    const row = data.index % ROWS
    const col = Math.floor(data.index / ROWS)
    const delay = row * 0.15 + col * (ROWS * 0.15 - 0.2)

    return {
      opacity: [1, 0.4, 1],
      scale: [1, 0.85, 1],
      transition: { delay, duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
    }
  }
}

export function GripVerticalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {CIRCLES.map((circle, index) => (
        <motion.circle
          custom={{ index }}
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
