// lucide-animated · align-center。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；时长收敛 ×1。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function AlignCenterIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M17 12H7"
        variants={{
          normal: { translateX: 0 },
          animate: {
            translateX: [0, 3, -3, 2, -2, 0],
            transition: {
              ease: ICON_EASE,
              translateX: { duration: 0.6, type: 'tween' as const, ease: ICON_EASE },
              type: 'tween' as const,
              duration: 0.4
            }
          }
        }}
      />
      <path d="M19 18H5" />
      <path d="M21 6H3" />
    </IconShell>
  )
}
