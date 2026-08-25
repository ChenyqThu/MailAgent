// lucide-animated · vibrate。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RECT_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -5, 5, -5, 5, 0],
    transition: {
      duration: 0.4,
      times: [0, 0.2, 0.4, 0.6, 0.8, 1],
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }
}

export function VibrateIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m2 8 2 2-2 2 2 2-2 2" />
      <path d="m22 8-2 2 2 2-2 2 2 2" />
      <motion.rect
        height="14"
        rx="1"
        style={{ transformOrigin: 'center' }}
        variants={RECT_VARIANTS}
        width="8"
        x="8"
        y="5"
      />
    </IconShell>
  )
}
