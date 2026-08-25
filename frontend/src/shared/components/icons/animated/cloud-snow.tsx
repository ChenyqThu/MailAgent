// lucide-animated · cloud-snow。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；补显式 transition/duration ×1；去 repeat 循环 ×1；时长收敛 ×1。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SNOWFLAKE_VARIANTS: Variants = {
  animate: {
    transition: { staggerChildren: 0.3, type: 'tween' as const, duration: 0.4, ease: ICON_EASE }
  }
}

const SNOWFLAKE_CHILD_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0.3, 1],
    transition: { duration: 0.6, ease: ICON_EASE, type: 'tween' as const }
  }
}

const SNOWFLAKE_PATH = [
  { id: 'snowflake1', d: 'M8 15h.01' },
  { id: 'snowflake2', d: 'M8 19h.01' },
  { id: 'snowflake3', d: 'M12 17h.01' },
  { id: 'snowflake4', d: 'M12 21h.01' },
  { id: 'snowflake5', d: 'M16 15h.01' },
  { id: 'snowflake6', d: 'M16 19h.01' }
]

export function CloudSnowIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <motion.g variants={SNOWFLAKE_VARIANTS}>
        {SNOWFLAKE_PATH.map((path) => (
          <motion.path d={path.d} key={path.id} variants={SNOWFLAKE_CHILD_VARIANTS} />
        ))}
      </motion.g>
    </IconShell>
  )
}
