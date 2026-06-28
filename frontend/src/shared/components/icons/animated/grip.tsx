// lucide-animated · grip（9 点交错脉冲）。源 pqoqubbw/icons，改造：去 forwardRef/controls/
// div 外壳 + 串行 start 逻辑；duration 1.1→0.5 收敛 + ICON_EASE（§10）；保留 custom stagger。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DOTS = [
  { cx: 19, cy: 5 },
  { cx: 19, cy: 12 },
  { cx: 12, cy: 5 },
  { cx: 19, cy: 19 },
  { cx: 12, cy: 12 },
  { cx: 5, cy: 5 },
  { cx: 12, cy: 19 },
  { cx: 5, cy: 12 },
  { cx: 5, cy: 19 }
]

const DOT: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0.3, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.5,
      ease: ICON_EASE,
      delay: i * 0.06,
      times: [0, 0.5, 1]
    }
  })
}

export function GripIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      {DOTS.map((d, i) => (
        <motion.circle
          key={`${d.cx}-${d.cy}`}
          variants={DOT}
          custom={i}
          cx={d.cx}
          cy={d.cy}
          r="1"
        />
      ))}
    </IconShell>
  )
}
