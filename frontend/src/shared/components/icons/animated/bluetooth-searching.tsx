// lucide-animated · bluetooth-searching。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×2；去 repeat 循环 ×4。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const PATH_VARIANTS: Variants = {
  normal: { scale: 1, transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE } },
  animate: { scale: [0, 1, 0.8] }
}

const SECOND_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0.8, 1],
    transition: { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

export function BluetoothSearchingIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path d="m7 7 10 10-5 5V2l5 5L7 17" variants={SECOND_VARIANTS} />
      <motion.path
        d="M20.83 14.83a4 4 0 0 0 0-5.66"
        transition={{ duration: 0.6, delay: 0.2, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
      <motion.path
        d="M18 12h.01"
        transition={{ duration: 0.6, type: 'tween' as const, ease: ICON_EASE }}
        variants={PATH_VARIANTS}
      />
    </IconShell>
  )
}
