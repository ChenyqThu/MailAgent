// lucide-animated · stamp。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const STAMP_VARIANTS: Variants = {
  normal: { translateY: 0, transition: { duration: 0.4, ease: ICON_EASE, type: 'tween' as const } },
  animate: {
    translateY: [0, 4, 4, -1, 0],
    transition: {
      duration: 0.8,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 0.82, 1],
      type: 'tween' as const
    }
  }
}

const INK_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    scaleX: 1,
    transition: { duration: 0.4, type: 'tween' as const, ease: ICON_EASE }
  },
  animate: {
    opacity: [1, 0.4, 1.4, 1],
    scaleX: [1, 0.85, 0.85, 1],
    transition: {
      duration: 0.8,
      ease: ICON_EASE,
      times: [0, 0.35, 0.65, 1],
      type: 'tween' as const
    }
  }
}

export function StampIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"
        variants={STAMP_VARIANTS}
      />
      <motion.path
        d="M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z"
        variants={STAMP_VARIANTS}
      />
      <motion.path d="M5 22h14" style={{ transformOrigin: '12px 22px' }} variants={INK_VARIANTS} />
    </IconShell>
  )
}
