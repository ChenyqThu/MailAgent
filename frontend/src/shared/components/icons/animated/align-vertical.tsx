// lucide-animated · align-vertical。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function AlignVerticalIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect
        height="6"
        rx="2"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { scaleY: 1 }, animate: { scaleY: 0.8 } }}
        width="10"
        x="7"
        y="9"
      />
      <motion.path
        d="M22 20H2"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateY: 0, scaleX: 1 },
          animate: { translateY: -2, scaleX: 0.9 }
        }}
      />
      <motion.path
        d="M22 4H2"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { translateY: 0, scaleX: 1 }, animate: { translateY: 2, scaleX: 0.9 } }}
      />
    </IconShell>
  )
}
