// lucide-animated · palette。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DASH_LENGTH = 70

const DRAW_DURATION = 0.45

const DOT_STAGGER = 0.08

const DOTS = [
  { cx: 6.5, cy: 12.5 },
  { cx: 8.5, cy: 7.5 },
  { cx: 13.5, cy: 6.5 },
  { cx: 17.5, cy: 10.5 }
]

const OUTLINE_VARIANTS: Variants = {
  normal: { strokeDashoffset: 0 },
  animate: {
    strokeDashoffset: [DASH_LENGTH, 0],
    transition: { duration: 0.45, ease: ICON_EASE, type: 'tween' as const }
  }
}

const DOTS_GROUP_VARIANTS: Variants = {
  normal: {},
  animate: {
    transition: {
      delayChildren: DRAW_DURATION,
      staggerChildren: DOT_STAGGER,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

const DOT_VARIANTS: Variants = {
  normal: { scale: 1, transition: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE } },
  animate: { scale: [0, 1], transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } }
}

export function PaletteIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M12 2a1 1 0 0 0 0 20l.25 0a1.75 1.75 0 0 0 1.4-2.8l-.3-.4a1.75 1.75 0 0 1 1.4-2.8h2.25a5 5 0 0 0 5-5 10 9 0 0 0-10-9z"
        strokeDasharray={DASH_LENGTH}
        variants={OUTLINE_VARIANTS}
      />
      <motion.g variants={DOTS_GROUP_VARIANTS}>
        {DOTS.map((dot) => (
          <motion.circle
            cx={dot.cx}
            cy={dot.cy}
            fill="currentColor"
            key={`${dot.cx}-${dot.cy}`}
            r=".5"
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            variants={DOT_VARIANTS}
          />
        ))}
      </motion.g>
    </IconShell>
  )
}
