// lucide-animated · align-horizontal。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function AlignHorizontalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect
        height="10"
        rx="2"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { scaleX: 1 }, animate: { scaleX: 0.85 } }}
        width="6"
        x="9"
        y="7"
      />
      <motion.path
        d="M4 22V2"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { translateX: 0, scaleY: 1 }, animate: { translateX: 2, scaleY: 0.9 } }}
      />
      <motion.path
        d="M20 22V2"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: 0, scaleY: 1 },
          animate: { translateX: -2, scaleY: 0.9 }
        }}
      />
    </IconShell>
  )
}
