// lucide-animated · droplet。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

export function DropletIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"
        transition={{ duration: 0.6, delay: 0.2, type: 'tween' as const, ease: ICON_EASE }}
        variants={{
          normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
          animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
        }}
      />
    </IconShell>
  )
}
