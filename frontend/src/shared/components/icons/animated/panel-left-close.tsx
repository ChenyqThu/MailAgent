// lucide-animated · panel-left-close。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = {
  times: [0, 0.4, 1],
  duration: 0.5,
  type: 'tween' as const,
  ease: ICON_EASE
}

const PATH_VARIANTS: Variants = { normal: { x: 0 }, animate: { x: [0, -1.5, 0] } }

export function PanelLeftCloseIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M9 3v18" />
      <motion.path d="m16 15-3-3 3-3" transition={DEFAULT_TRANSITION} variants={PATH_VARIANTS} />
    </IconShell>
  )
}
