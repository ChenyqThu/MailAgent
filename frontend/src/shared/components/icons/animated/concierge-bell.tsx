// lucide-animated · concierge-bell。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const STEM_VARIANTS: Variants = {
  normal: { y: 0 },
  animate: { y: 2, transition: { duration: 0.1, type: 'tween' as const, ease: ICON_EASE } }
}

const BELL_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -2, 2, -2, 2, -1, 1, 0],
    transition: { delay: 0.1, duration: 0.28, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SOUND_WAVES_VARIANTS: Variants = {
  normal: { opacity: 0, scale: 1 },
  animate: {
    opacity: [0, 1, 0],
    scale: [0.8, 1, 1.3],
    transition: {
      delay: 0.13,
      duration: 0.7,
      ease: ICON_EASE,
      times: [0, 0.2, 1],
      type: 'tween' as const
    }
  }
}

export function ConciergeBellIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <path d="M3 20a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1Z" />

      <motion.g style={{ originX: '50%', originY: '100%' }} variants={BELL_VARIANTS}>
        <path d="M20 16a8 8 0 1 0-16 0" />

        <motion.g variants={STEM_VARIANTS}>
          <path d="M10 4h4" />
          <path d="M12 4v4" />
        </motion.g>
      </motion.g>

      <motion.g style={{ originX: '14px', originY: '18px' }} variants={SOUND_WAVES_VARIANTS}>
        <path d="M2 13a7 7 0 0 1 1-3.5" opacity="0.7" strokeWidth="1.5" />
        <path d="M21 13a7 7 0 0 0-1-3.5" opacity="0.7" strokeWidth="1.5" />
      </motion.g>
    </IconShell>
  )
}
