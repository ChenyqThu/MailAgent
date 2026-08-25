// lucide-animated · square-arrow-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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
  normal: { d: 'm16 12-4-4-4 4', translateY: 0, opacity: 1 },
  animate: {
    d: 'm16 12-4-4-4 4',
    translateY: [0, 3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

const SECOND_PATH_VARIANTS: Variants = {
  normal: { d: 'M12 16V8', opacity: 1 },
  animate: {
    d: ['M12 16V8', 'M12 16V13', 'M12 16V8'],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function SquareArrowUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect height="18" rx="2" variants={SQUARE_VARIANTS} width="18" x="3" y="3" />
      <motion.path d="m16 12-4-4-4 4" variants={PATH_VARIANTS} />
      <motion.path d="M12 16V8" variants={SECOND_PATH_VARIANTS} />
    </IconShell>
  )
}
