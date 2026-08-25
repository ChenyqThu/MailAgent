// lucide-animated · message-circle-more。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DOT_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: (custom: number) => ({
    opacity: [1, 0, 0, 1, 1, 0, 0, 1],
    transition: {
      opacity: {
        times: [
          0,
          0.1,
          0.1 + custom * 0.1,
          0.1 + custom * 0.1 + 0.1,
          0.5,
          0.6,
          0.6 + custom * 0.1,
          0.6 + custom * 0.1 + 0.1
        ],
        duration: 0.6,
        type: 'tween' as const,
        ease: ICON_EASE
      },
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE
    }
  })
}

export function MessageCircleMoreIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      <motion.path custom={0} d="M8 12h.01" variants={DOT_VARIANTS} />
      <motion.path custom={1} d="M12 12h.01" variants={DOT_VARIANTS} />
      <motion.path custom={2} d="M16 12h.01" variants={DOT_VARIANTS} />
    </IconShell>
  )
}
