// lucide-animated · copy。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function CopyIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect
        height="14"
        rx="2"
        ry="2"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateY: 0, translateX: 0 },
          animate: { translateY: -3, translateX: -3 }
        }}
        width="14"
        x="8"
        y="8"
      />
      <motion.path
        d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { x: 0, y: 0 }, animate: { x: 3, y: 3 } }}
      />
    </IconShell>
  )
}
