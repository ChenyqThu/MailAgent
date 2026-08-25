// lucide-animated · ticket。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell；spring→tween ×1；补显式 transition/duration ×1。
import * as React from 'react'
import { motion, type Variants, type Transition } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TRANSITION: Transition = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

const LEFT_VARIANTS: Variants = { normal: { x: 0 }, animate: { x: -3 } }

const RIGHT_VARIANTS: Variants = { normal: { x: 0, rotate: 0 }, animate: { x: 3, rotate: 4 } }

export function TicketIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props} svgStyle={{ overflow: 'visible' }}>
      <motion.g transition={TRANSITION} variants={LEFT_VARIANTS}>
        <path d="M13 5H4a2 2 0 0 0-2 2v2a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h9" />
        <path d="M13 5v2" />
        <path d="M13 11v2" />
        <path d="M13 17v2" />
      </motion.g>
      <motion.path
        d="M13 5h7a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2h-7"
        style={{ transformOrigin: '13px 12px' }}
        transition={TRANSITION}
        variants={RIGHT_VARIANTS}
      />
    </IconShell>
  )
}
