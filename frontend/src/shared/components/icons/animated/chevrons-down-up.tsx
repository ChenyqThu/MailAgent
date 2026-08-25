// lucide-animated · chevrons-down-up。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const DEFAULT_TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

export function ChevronsDownUpIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        d="m7 20 5-5 5 5"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { translateY: '0%' }, animate: { translateY: '-2px' } }}
      />
      <motion.path
        d="m7 4 5 5 5-5"
        transition={DEFAULT_TRANSITION}
        variants={{ normal: { translateY: '0%' }, animate: { translateY: '2px' } }}
      />
    </IconShell>
  )
}
