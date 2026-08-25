// lucide-animated · bluetooth-connected。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [0, 1, 0.5, 1],
    transition: { duration: 0.3, delay: 0.2, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function BluetoothConnectedIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="m7 7 10 10-5 5V2l5 5L7 17" variants={PATH_VARIANTS} />
      <motion.line
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: {
            pathLength: [0, 1],
            opacity: [0, 1],
            pathOffset: [1, 0],
            transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
        x1="18"
        x2="21"
        y1="12"
        y2="12"
      />
      <motion.line
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: {
            pathLength: [0, 1],
            opacity: [0, 1],
            pathOffset: [-1, 0],
            transition: { duration: 0.2, type: 'tween' as const, ease: ICON_EASE }
          }
        }}
        x1="3"
        x2="6"
        y1="12"
        y2="12"
      />
    </IconShell>
  )
}
