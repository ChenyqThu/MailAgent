// lucide-animated · arrow-big-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { d: 'M9 18v-6H5l7-7 7 7h-4v6H9z', translateY: 0 },
  animate: {
    d: 'M9 18v-6H5l7-7 7 7h-4v6H9z',
    translateY: [0, -3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function ArrowBigUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M9 18v-6H5l7-7 7 7h-4v6H9z" variants={PATH_VARIANTS} />
    </IconShell>
  )
}
