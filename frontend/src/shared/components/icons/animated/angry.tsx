// lucide-animated · angry。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const EYEBROW_ROTATION = 20

const PATH_VARIANTS_FACE: Variants = {
  normal: { scale: 1, rotate: 0 },
  animate: {
    scale: [1, 1.2, 1.2, 1.2, 1],
    rotate: [0, -3, 3, -1, 1, 0],
    transition: {
      duration: 0.6,
      times: [0, 0.2, 0.4, 0.6, 1],
      ease: ICON_EASE,
      type: 'tween' as const
    }
  }
}

const PATH_VARIANTS_LEFT_EYEBROW: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, EYEBROW_ROTATION, 0],
    transition: { duration: 0.8, type: 'tween' as const, ease: ICON_EASE }
  }
}

const PATH_VARIANTS_RIGHT_EYEBROW: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -EYEBROW_ROTATION, 0],
    transition: { duration: 0.8, type: 'tween' as const, ease: ICON_EASE }
  }
}

const PATH_VARIANTS_EYE: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.2, 1],
    transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
  }
}

const PATH_VARIANTS_MOUTH: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, -0.5, 0],
    transition: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function AngryIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={PATH_VARIANTS_FACE}>
      <circle cx="12" cy="12" r="10" />
      <motion.path d="M16 16s-1.5-2-4-2-4 2-4 2" variants={PATH_VARIANTS_MOUTH} />
      <motion.path d="M7.5 8 10 9" variants={PATH_VARIANTS_LEFT_EYEBROW} />
      <motion.path d="m14 9 2.5-1" variants={PATH_VARIANTS_RIGHT_EYEBROW} />
      <motion.path d="M9 10h.01" variants={PATH_VARIANTS_EYE} />
      <motion.path d="M15 10h.01" variants={PATH_VARIANTS_EYE} />
    </IconShell>
  )
}
