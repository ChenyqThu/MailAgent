// lucide-animated · square-arrow-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SQUARE_VARIANTS: Variants = {
  normal: { transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE } },
  animate: { transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const } }
}

const PATH_VARIANTS: Variants = {
  normal: { d: 'm12 8-4 4 4 4', translateX: 0, opacity: 1 },
  animate: {
    d: 'm12 8-4 4 4 4',
    translateX: [0, 3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: 'M16 12H8', opacity: 1 },
  animate: {
    d: ['M16 12H8', 'M16 12H13', 'M16 12H8'],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function SquareArrowLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect height="18" rx="2" variants={SQUARE_VARIANTS} width="18" x="3" y="3" />
      <motion.path d="m12 8-4 4 4 4" variants={PATH_VARIANTS} />
      <motion.path d="M16 12H8" variants={SECOND_PATH_VARIANTS} />
    </IconShell>
  )
}
