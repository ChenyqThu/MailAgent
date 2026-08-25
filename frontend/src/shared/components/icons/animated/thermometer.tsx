// lucide-animated · thermometer。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
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

export function ThermometerIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"
        style={{ transformOrigin: 'center' }}
        variants={PATH_VARIANTS}
      />
    </IconShell>
  )
}
