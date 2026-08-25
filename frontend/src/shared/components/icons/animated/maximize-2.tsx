// lucide-animated · maximize-2。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function Maximize2Icon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M3 16.2V21m0 0h4.8M3 21l6-6"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '-2px', translateY: '2px' }
        }}
      />
      <motion.path
        d="M21 7.8V3m0 0h-4.8M21 3l-6 6"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '2px', translateY: '-2px' }
        }}
      />
    </IconShell>
  )
}
