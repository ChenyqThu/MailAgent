// lucide-animated · square-stack。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const RECT_VARIANTS: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 0.8, 1],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

const PATH_VARIANTS: Variants = { normal: { scale: 1 }, animate: { scale: [1, 0.9, 1] } }

export function SquareStackIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M4 10c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"
        transition={{ delay: 0.3, duration: 0.4, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
      <motion.path
        d="M10 16c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2"
        transition={{ delay: 0.2, duration: 0.2, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
      <motion.rect height="8" rx="2" variants={RECT_VARIANTS} width="8" x="14" y="14" />
    </IconShell>
  )
}
