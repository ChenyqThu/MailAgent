// lucide-animated · pause。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const BASE_RECT_VARIANTS: Variants = {
  normal: {
    y: 0
  }
}

const BASE_RECT_TRANSITION = {
  transition: { times: [0, 0.2, 0.5, 1], duration: 0.5, type: 'tween' as const, ease: ICON_EASE }
}

const LEFT_RECT_VARIANTS: Variants = {
  ...BASE_RECT_VARIANTS,
  animate: { y: [0, 2, 0, 0], ...BASE_RECT_TRANSITION }
}

const RIGHT_RECT_VARIANTS: Variants = {
  ...BASE_RECT_VARIANTS,
  animate: { y: [0, 0, 2, 0], ...BASE_RECT_TRANSITION }
}

export function PauseIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect height="16" rx="1" variants={LEFT_RECT_VARIANTS} width="4" x="6" y="4" />
      <motion.rect height="16" rx="1" variants={RIGHT_RECT_VARIANTS} width="4" x="14" y="4" />
    </IconShell>
  )
}
