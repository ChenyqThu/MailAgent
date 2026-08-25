// lucide-animated · clap。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const VARIANTS: Variants = {
  normal: { rotate: 0, originX: '4px', originY: '20px' },
  animate: {
    rotate: [-10, -10, 0],
    transition: { duration: 0.8, times: [0, 0.5, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

const CLAP_VARIANTS: Variants = {
  normal: { rotate: 0, originX: '3px', originY: '11px' },
  animate: {
    rotate: [0, -10, 16, 0],
    transition: { duration: 0.4, times: [0, 0.3, 0.6, 1], ease: ICON_EASE, type: 'tween' as const }
  }
}

export function ClapIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g variants={VARIANTS}>
        <motion.g variants={CLAP_VARIANTS}>
          <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
          <path d="m6.2 5.3 3.1 3.9" />
          <path d="m12.4 3.4 3.1 4" />
        </motion.g>
        <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </motion.g>
    </IconShell>
  )
}
