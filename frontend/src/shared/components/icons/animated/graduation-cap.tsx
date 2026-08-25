// lucide-animated · graduation-cap。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const CAP_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    y: [0, -2, 0],
    rotate: [0, -2, 2, 0],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const TASSEL_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, 15, -10, 5, 0],
    transition: { duration: 0.8, ease: ICON_EASE, delay: 0.1, type: 'tween' as const }
  }
}

export function GraduationCapIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g style={{ transformOrigin: '12px 12px' }} variants={CAP_VARIANTS}>
        <path d="M2 10l10-5 10 5-10 5z" />
        <path d="M6 12v5c3 3 9 3 12 0v-5" />

        <motion.path
          d="M22 10v6"
          style={{
            transformBox: 'fill-box',
            transformOrigin: 'top center'
          }}
          variants={TASSEL_VARIANTS}
        />
      </motion.g>
    </IconShell>
  )
}
