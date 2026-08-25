// lucide-animated · align-left。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function AlignLeftIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { x2: 21 }, animate: { x2: 21 } }}
        x1="3"
        x2="21"
        y1="6"
        y2="6"
      />

      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { x2: 15 }, animate: { x2: 19 } }}
        x1="3"
        x2="15"
        y1="12"
        y2="12"
      />

      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { x2: 17 }, animate: { x2: 12 } }}
        x1="3"
        x2="17"
        y1="18"
        y2="18"
      />
    </IconShell>
  )
}
