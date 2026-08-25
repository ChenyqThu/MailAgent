// lucide-animated · arrow-big-down-dash。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DASH_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, 1, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

const ARROW_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: {
    translateY: [0, 3, 0],
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  }
}

export function ArrowBigDownDashIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="M15 5H9" variants={DASH_VARIANTS} />
      <motion.path d="M15 9v3h4l-7 7-7-7h4V9z" variants={ARROW_VARIANTS} />
    </IconShell>
  )
}
