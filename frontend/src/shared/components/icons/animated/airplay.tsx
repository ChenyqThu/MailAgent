// lucide-animated · airplay。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SCREEN_VARIANTS = {
  normal: {
    opacity: 1,
    pathLength: 1,
    pathOffset: 0,
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    pathOffset: [1, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const TRIANGLE_VARIANTS = {
  normal: {
    scale: 1,
    opacity: 1,
    transition: { duration: 0.3, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    scale: [0.6, 1.1, 1],
    opacity: [0, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function AirplayIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"
        variants={SCREEN_VARIANTS}
      />
      <motion.path d="M12 15l5 6H7z" variants={TRIANGLE_VARIANTS} />
    </IconShell>
  )
}
