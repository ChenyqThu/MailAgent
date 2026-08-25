// lucide-animated · chart-scatter。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DOT_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: i * 0.15 }
  })
}

export function ChartScatterIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle
        custom={0}
        cx="7.5"
        cy="7.5"
        fill="currentColor"
        r=".5"
        variants={DOT_VARIANTS}
      />
      <motion.circle
        custom={1}
        cx="18.5"
        cy="5.5"
        fill="currentColor"
        r=".5"
        variants={DOT_VARIANTS}
      />
      <motion.circle
        custom={2}
        cx="11.5"
        cy="11.5"
        fill="currentColor"
        r=".5"
        variants={DOT_VARIANTS}
      />
      <motion.circle
        custom={3}
        cx="7.5"
        cy="16.5"
        fill="currentColor"
        r=".5"
        variants={DOT_VARIANTS}
      />
      <motion.circle
        custom={4}
        cx="17.5"
        cy="14.5"
        fill="currentColor"
        r=".5"
        variants={DOT_VARIANTS}
      />
      <path d="M3 3v16a2 2 0 0 0 2 2h16" strokeWidth="2" />
    </IconShell>
  )
}
