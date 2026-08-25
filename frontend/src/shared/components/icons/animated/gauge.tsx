// lucide-animated · gauge。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function GaugeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m12 14 4-4"
        transition={DEFAULT_TRANSITION}
        variants={{
          animate: { translateX: 0.5, translateY: 3, rotate: 72 },
          normal: { translateX: 0, rotate: 0, translateY: 0 }
        }}
      />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </IconShell>
  )
}
