// lucide-animated · brain。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；去 repeat 循环 ×5；时长收敛 ×5。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BRAIN_STEM_VARIANTS: Variants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.4, 1],
    pathOffset: [0, 0.25, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const BRAIN_SIDE_VARIANTS: Variants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.5, 1],
    pathOffset: [0, 0.25, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const BRAIN_TOP_ARC_VARIANTS: Variants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.8, 1],
    pathOffset: [0, 0.07, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const BRAIN_LOWER_ARC_VARIANTS: Variants = {
  normal: { pathLength: 1, pathOffset: 0 },
  animate: {
    pathLength: [1, 0.8, 1],
    pathOffset: [0, 0.14, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function BrainIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={{
        normal: { scale: 1, strokeWidth: 2 },
        animate: {
          scale: [1, 1.08, 1],
          strokeWidth: [2, 2.25, 2],
          transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
        }
      }}
    >
      <motion.path d="M12 18V5" variants={BRAIN_STEM_VARIANTS} />
      <motion.path
        d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"
        variants={BRAIN_SIDE_VARIANTS}
      />

      <motion.path d="M12 5A3 3 0 1 1 17.598 6.5" variants={BRAIN_TOP_ARC_VARIANTS} />
      <motion.path d="M12 5A3 3 0 1 0 6.402 6.5" variants={BRAIN_TOP_ARC_VARIANTS} />

      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />

      <motion.path d="M18 18a4 4 0 0 0 2-7.464" variants={BRAIN_LOWER_ARC_VARIANTS} />

      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />

      <motion.path d="M6 18a4 4 0 0 1-2-7.464" variants={BRAIN_LOWER_ARC_VARIANTS} />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </IconShell>
  )
}
