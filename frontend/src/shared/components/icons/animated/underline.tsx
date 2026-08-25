// lucide-animated · underline。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
}

export function UnderlineIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M6 4v6a6 6 0 0 0 12 0V4"
        transition={{ duration: 0.3, type: 'tween' as const, ease: ICON_EASE }}
        variants={VARIANTS}
      />
      <motion.line
        transition={{ delay: 0.2, duration: 0.4, type: 'tween' as const, ease: ICON_EASE }}
        variants={VARIANTS}
        x1="4"
        x2="20"
        y1="20"
        y2="20"
      />
    </IconShell>
  )
}
