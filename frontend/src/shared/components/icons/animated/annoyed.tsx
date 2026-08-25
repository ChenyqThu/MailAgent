// lucide-animated · annoyed。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const faceVariants: Variants = {
  normal: { scale: 1, transition: { duration: 0.2, ease: ICON_EASE, type: 'tween' as const } },
  animate: { scale: 1.05, transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const } }
}

const mouthVariants: Variants = {
  normal: {
    scaleX: 1,
    y: 0,
    transition: { duration: 0.2, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    scaleX: 0.8,
    y: 1,
    transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
  }
}

const leftEyebrowVariants: Variants = {
  normal: {
    rotate: 0,
    y: 0,
    x: 0,
    transition: { duration: 0.2, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    rotate: 15,
    y: -1,
    x: -0.5,
    transition: { duration: 0.25, ease: ICON_EASE, type: 'tween' as const }
  }
}

const rightEyebrowVariants: Variants = {
  normal: {
    rotate: 0,
    y: 0,
    x: 0,
    transition: { duration: 0.2, ease: ICON_EASE, type: 'tween' as const }
  },
  animate: {
    rotate: 15,
    y: -1,
    x: 0.5,
    transition: { duration: 0.25, ease: ICON_EASE, delay: 0.05, type: 'tween' as const }
  }
}

export function AnnoyedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgVariants={faceVariants}>
      <circle cx="12" cy="12" r="10" />
      <motion.path d="M8 15h8" variants={mouthVariants} />
      <motion.path d="M8 9h2" variants={leftEyebrowVariants} />
      <motion.path d="M14 9h2" variants={rightEyebrowVariants} />
    </IconShell>
  )
}
