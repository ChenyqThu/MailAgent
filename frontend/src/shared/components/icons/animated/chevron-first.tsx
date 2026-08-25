// lucide-animated · chevron-first。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function ChevronFirstIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m17 18-6-6 6-6"
        variants={{
          normal: {
            translateX: 0,
            transition: { duration: 0.3, ease: ICON_EASE, type: 'tween' as const }
          },
          animate: {
            translateX: [-2, 1, -1, 0],
            transition: {
              duration: 0.6,
              ease: ICON_EASE,
              times: [0, 0.3, 0.7, 1],
              type: 'tween' as const
            }
          }
        }}
      />

      <path d="M7 6v12" />
    </IconShell>
  )
}
