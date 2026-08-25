// lucide-animated · frame。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function FrameIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{
          animate: { translateY: -4 },
          normal: { translateX: 0, rotate: 0, translateY: 0 }
        }}
        x1={22}
        x2={2}
        y1={6}
        y2={6}
      />
      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{
          animate: { translateY: 4 },
          normal: { translateX: 0, rotate: 0, translateY: 0 }
        }}
        x1={22}
        x2={2}
        y1={18}
        y2={18}
      />
      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{
          animate: { translateX: -4 },
          normal: { translateX: 0, rotate: 0, translateY: 0 }
        }}
        x1={6}
        x2={6}
        y1={2}
        y2={22}
      />
      <motion.line
        transition={DEFAULT_TRANSITION}
        variants={{
          animate: { translateX: 4 },
          normal: { translateX: 0, rotate: 0, translateY: 0 }
        }}
        x1={18}
        x2={18}
        y1={2}
        y2={22}
      />
    </IconShell>
  )
}
