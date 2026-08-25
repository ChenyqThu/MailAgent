// lucide-animated · switch-camera。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1 },
  animate: {
    pathLength: [0, 1],
    transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function SwitchCameraIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" variants={PATH_VARIANTS} />
      <motion.path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" variants={PATH_VARIANTS} />
      <circle cx="12" cy="12" r="3" />
      <motion.path d="m18 22-3-3 3-3" variants={PATH_VARIANTS} />
      <motion.path d="m6 2 3 3-3 3" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
