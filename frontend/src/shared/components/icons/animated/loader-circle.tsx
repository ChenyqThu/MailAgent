// lucide-animated · loader-circle。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1；去 repeat 循环 ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const G_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 360, transition: { duration: 0.8, ease: ICON_EASE, type: 'tween' as const } }
}

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function LoaderCircleIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M21 12a9 9 0 1 1-6.219-8.56"
        style={{ transformOrigin: '12px 12px' }}
        transition={DEFAULT_TRANSITION}
        variants={G_VARIANTS}
      />
    </IconShell>
  )
}
