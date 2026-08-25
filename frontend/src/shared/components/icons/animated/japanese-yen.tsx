// lucide-animated · japanese-yen。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const JAPANESE_YEN_MAIN_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      duration: 0.4,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      duration: 0.6,
      opacity: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

const JAPANESE_YEN_SECONDARY_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: {
      delay: 0.3,
      duration: 0.3,
      opacity: { duration: 0.1, delay: 0.3, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: {
      delay: 0.5,
      duration: 0.4,
      opacity: { duration: 0.1, delay: 0.5, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function JapaneseYenIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M12 9.5V21m0-11.5L6 3m6 6.5L18 3" variants={JAPANESE_YEN_MAIN_VARIANTS} />
      <motion.path d="M18 11h-12" variants={JAPANESE_YEN_SECONDARY_VARIANTS} />
      <motion.path d="M18 15h-12" variants={JAPANESE_YEN_SECONDARY_VARIANTS} />
    </IconShell>
  )
}
