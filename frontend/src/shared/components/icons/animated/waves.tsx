// lucide-animated · waves。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function WavesIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2c2.5 0 2.5-2 5-2c1.3 0 1.9.5 2.5 1"
        variants={{
          normal: { pathLength: 1 },
          animate: {
            pathLength: [0, 1],
            transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      />
      <motion.path
        d="M2 12c.6.5 1.2 1 2.5 1c2.5 0 2.5-2 5-2c2.6 0 2.4 2 5 2c2.5 0 2.5-2 5-2c1.3 0 1.9.5 2.5 1"
        variants={{
          normal: { pathLength: 1 },
          animate: {
            pathLength: [0, 1],
            transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      />
      <motion.path
        d="M2 18c.6.5 1.2 1 2.5 1c2.5 0 2.5-2 5-2c2.6 0 2.4 2 5 2c2.5 0 2.5-2 5-2c1.3 0 1.9.5 2.5 1"
        variants={{
          normal: { pathLength: 1 },
          animate: {
            pathLength: [0, 1],
            transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const }
          }
        }}
      />
    </IconShell>
  )
}
