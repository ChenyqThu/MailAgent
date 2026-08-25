// lucide-animated · tree-deciduous。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TREE_DECIDUOUS_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -10, 10, -10, 0],
    transition: { duration: 0.5, ease: ICON_EASE, type: 'tween' as const }
  }
}

export function TreeDeciduousIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={TREE_DECIDUOUS_VARIANTS}
      svgStyle={{ transformOrigin: '12px 21px' }}
    >
      <motion.path d="M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z" />
      <path d="M12 19v3" />
    </IconShell>
  )
}
