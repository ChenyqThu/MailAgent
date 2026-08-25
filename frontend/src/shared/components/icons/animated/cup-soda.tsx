// lucide-animated · cup-soda。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×2；时长收敛 ×2。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const STRAW_VARIANTS: Variants = {
  normal: {
    y: 0,
    scaleY: 1,
    transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    y: [0, -0.85, 0.15, 0],
    scaleY: [1, 1.06, 0.99, 1],
    transition: {
      duration: 0.5,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 1],
      type: 'tween' as const
    }
  }
}

const WAVE_VARIANTS: Variants = {
  normal: { y: 0, transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const } },
  animate: { y: [0, -1, 0], transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const } }
}

const BUBBLE_VARIANTS: Variants = {
  normal: { opacity: 0, y: 0, scale: 1 },
  animate: (delay: number) => ({
    opacity: [0, 0.9, 0.4, 0],
    y: [0, -3, -10, -14],
    scale: [1, 1, 0.85, 0.6],
    transition: {
      duration: 0.6,
      ease: ICON_EASE,
      delay,
      times: [0, 0.08, 0.7, 1],
      type: 'tween' as const
    }
  })
}

const BUBBLES = [
  { delay: 0, cx: 8.25, cy: 20.5, r: 0.75 },
  { delay: 0.35, cx: 11.25, cy: 19.5, r: 0.6 },
  { delay: 0.7, cx: 14, cy: 20.75, r: 0.6 },
  { delay: 1.05, cx: 9.75, cy: 19, r: 0.75 },
  { delay: 0.55, cx: 12.5, cy: 20, r: 0.45 }
] as const

export function CupSodaIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8" />
      <path d="M5 8h14" />
      <motion.path d="M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0" variants={WAVE_VARIANTS} />
      <motion.path
        d="m12 8 1-6h2"
        style={{
          transformBox: 'fill-box',
          originX: '50%',
          originY: '100%'
        }}
        variants={STRAW_VARIANTS}
      />
      {BUBBLES.map((b, i) => (
        <motion.circle
          custom={b.delay}
          cx={b.cx}
          cy={b.cy}
          fill="currentColor"
          key={i}
          r={b.r}
          stroke="none"
          style={{
            transformBox: 'fill-box',
            originX: '50%',
            originY: '50%'
          }}
          variants={BUBBLE_VARIANTS}
        />
      ))}
    </IconShell>
  )
}
