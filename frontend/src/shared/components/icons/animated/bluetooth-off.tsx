// lucide-animated · bluetooth-off。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: { pathLength: [0, 1], opacity: [0, 1], pathOffset: [1, 0] }
}

const OFFLINE_VARIANTS: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: { pathLength: [0, 1], opacity: [0, 1] }
}

export function BluetoothOffIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m17 17-5 5V12l-5 5"
        transition={{ duration: 0.3, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
      <motion.path
        d="m2 2 20 20"
        transition={{ duration: 0.2, delay: 0.3, type: 'tween' as const, ease: ICON_EASE }}
        variants={OFFLINE_VARIANTS}
      />
      <motion.path
        d="M14.5 9.5 17 7l-5-5v4.5"
        transition={{ duration: 0.3, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
    </IconShell>
  )
}
