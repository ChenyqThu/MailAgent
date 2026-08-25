// lucide-animated · arrow-down-0-1。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
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

export function ArrowDown01Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m3 16 4 4 4-4" />
      <path d="M7 20V4" />
      <motion.rect
        custom={1}
        height="6"
        ry="2"
        transition={SWAP_TRANSITION}
        variants={SWAP_VARIANTS}
        width="4"
        x="15"
        y="4"
      />
      <motion.g custom={-1} transition={SWAP_TRANSITION} variants={SWAP_VARIANTS}>
        <path d="M17 20v-6h-2" />
        <path d="M15 20h4" />
      </motion.g>
    </IconShell>
  )
}
