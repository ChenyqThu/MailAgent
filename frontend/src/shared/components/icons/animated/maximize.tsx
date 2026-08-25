// lucide-animated · maximize。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function MaximizeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M8 3H5a2 2 0 0 0-2 2v3"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '-2px', translateY: '-2px' }
        }}
      />

      <motion.path
        d="M21 8V5a2 2 0 0 0-2-2h-3"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '2px', translateY: '-2px' }
        }}
      />

      <motion.path
        d="M3 16v3a2 2 0 0 0 2 2h3"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '-2px', translateY: '2px' }
        }}
      />

      <motion.path
        d="M16 21h3a2 2 0 0 0 2-2v-3"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '2px', translateY: '2px' }
        }}
      />
    </IconShell>
  )
}
