// lucide-animated · italic。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const LINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
}

export function ItalicIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.line
        transition={{ duration: 0.2, type: 'tween' as const, ease: ICON_EASE }}
        variants={LINE_VARIANTS}
        x1="19"
        x2="10"
        y1="4"
        y2="4"
      />
      <motion.line
        transition={{ duration: 0.2, type: 'tween' as const, ease: ICON_EASE }}
        variants={LINE_VARIANTS}
        x1="14"
        x2="5"
        y1="20"
        y2="20"
      />
      <motion.line
        transition={{ delay: 0.1, duration: 0.4, type: 'tween' as const, ease: ICON_EASE }}
        variants={{
          normal: { pathLength: 1, pathOffset: 0 },
          animate: { pathLength: [0, 1], pathOffset: [1, 0] }
        }}
        x1="15"
        x2="9"
        y1="4"
        y2="20"
      />
    </IconShell>
  )
}
