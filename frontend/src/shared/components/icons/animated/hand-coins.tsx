// lucide-animated · hand-coins。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×4；补显式 transition/duration ×4。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CIRCLE_VARIANTS: Variants = {
  normal: {
    translateY: 0,
    opacity: 1,
    transition: {
      opacity: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    translateY: [-20, 0],
    transition: {
      opacity: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

const SECOND_CIRCLE_VARIANTS: Variants = {
  normal: {
    translateY: 0,
    opacity: 1,
    transition: {
      opacity: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      delay: 0.15,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  },
  animate: {
    opacity: [0, 1],
    translateY: [-20, 0],
    transition: {
      opacity: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE },
      delay: 0.15,
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  }
}

export function HandCoinsIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17" />
      <path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" />
      <path d="m2 16 6 6" />
      <motion.circle cx="16" cy="9" r="2.9" variants={CIRCLE_VARIANTS} />
      <motion.circle cx="6" cy="5" r="3" variants={SECOND_CIRCLE_VARIANTS} />
    </IconShell>
  )
}
