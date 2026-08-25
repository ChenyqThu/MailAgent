// lucide-animated · arrow-down-a-z。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SWAP_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

const SWAP_VARIANTS: Variants = {
  normal: { translateY: 0 },
  animate: (custom: number) => ({ translateY: custom * 10 })
}

export function ArrowDownAZIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m3 16 4 4 4-4" />
      <path d="M7 20V4" />
      <motion.g custom={1} transition={SWAP_TRANSITION} variants={SWAP_VARIANTS}>
        <path d="M20 8h-5" />
        <path d="M15 10V6.5a2.5 2.5 0 0 1 5 0V10" />
      </motion.g>
      <motion.path
        custom={-1}
        d="M15 14h5l-5 6h5"
        transition={SWAP_TRANSITION}
        variants={SWAP_VARIANTS}
      />
    </IconShell>
  )
}
