// lucide-animated · layers。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1；多阶段序列压成关键帧。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function LayersIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <motion.path
        d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { y: 0 },
          animate: {
            y: [0, -9, 0],
            transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
          }
        }}
      />
      <motion.path
        d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { y: 0 },
          animate: {
            y: [0, -5, 0],
            transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
          }
        }}
      />
    </IconShell>
  )
}
