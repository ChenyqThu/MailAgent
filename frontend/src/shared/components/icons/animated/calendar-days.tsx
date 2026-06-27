// lucide-animated · calendar-days（日期点交错脉冲）。源 pqoqubbw/icons，改造：
// 去 forwardRef/controls/div/AnimatePresence 外壳；spring → tween + ICON_EASE（§10）。
// custom stagger 通过 variants 函数保留（motion/react Variants 类型支持 TargetResolver）。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DOTS = [
  { cx: 8, cy: 14 },
  { cx: 12, cy: 14 },
  { cx: 16, cy: 14 },
  { cx: 8, cy: 18 },
  { cx: 12, cy: 18 },
  { cx: 16, cy: 18 }
]

const DOT_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0.3, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      delay: i * 0.1,
      times: [0, 0.5, 1]
    }
  })
}

export function CalendarDaysIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect height="18" rx="2" width="18" x="3" y="4" />
      <path d="M3 10h18" />
      {DOTS.map((dot, i) => (
        <motion.circle
          key={`${dot.cx}-${dot.cy}`}
          variants={DOT_VARIANTS}
          custom={i}
          cx={dot.cx}
          cy={dot.cy}
          r="1"
          fill="currentColor"
          stroke="none"
        />
      ))}
    </IconShell>
  )
}
