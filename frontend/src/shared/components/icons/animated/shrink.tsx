// lucide-animated · shrink。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function ShrinkIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="M9 4.2V9m0 0H4.2M9 9 3 3"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '1px', translateY: '1px' }
        }}
      />
      <motion.path
        d="M15 4.2V9m0 0h4.8M15 9l6-6"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '-1px', translateY: '1px' }
        }}
      />
      <motion.path
        d="M9 19.8V15m0 0H4.2M9 15l-6 6"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '1px', translateY: '-1px' }
        }}
      />
      <motion.path
        d="m15 15 6 6m-6-6v4.8m0-4.8h4.8"
        transition={DEFAULT_TRANSITION}
        variants={{
          normal: { translateX: '0%', translateY: '0%' },
          animate: { translateX: '-1px', translateY: '-1px' }
        }}
      />
    </IconShell>
  )
}
