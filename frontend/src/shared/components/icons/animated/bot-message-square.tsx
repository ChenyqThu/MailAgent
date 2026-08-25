// lucide-animated · bot-message-square（对话框轻晃 + 框缩放 + 底部三点脉冲）。源 pqoqubbw/icons，
// 改造：去 forwardRef/div 外壳；ease easeInOut→ICON_EASE；svg 级整体晃 duration 收敛（§10）。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SVG_VARIANTS: Variants = {
  normal: { rotate: 0, y: 0, scale: 1 },
  animate: { rotate: [0, -3, 3, 0, 0], y: [0, 1.5, -1.5, 0], scale: [1, 1.03, 1] }
}
const BOX: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.04, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}
const DOT: Variants = {
  normal: { opacity: 1 },
  animate: (i: number) => ({
    opacity: [0.3, 1, 0.3],
    transition: {
      type: 'tween' as const,
      duration: 0.8,
      ease: ICON_EASE,
      delay: i * 0.15,
      times: [0, 0.5, 1]
    }
  })
}

export function BotMessageSquareIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell
      {...props}
      svgVariants={SVG_VARIANTS}
      svgTransition={{ type: 'tween', duration: 0.6, ease: ICON_EASE }}
    >
      <path d="M12 6V2H8" />
      <motion.path
        variants={BOX}
        d="M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"
      />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M9 11v2" />
      <path d="M15 11v2" />
      <motion.circle
        variants={DOT}
        custom={0}
        cx="10"
        cy="14"
        r="0.6"
        fill="currentColor"
        stroke="none"
      />
      <motion.circle
        variants={DOT}
        custom={1}
        cx="12"
        cy="14"
        r="0.6"
        fill="currentColor"
        stroke="none"
      />
      <motion.circle
        variants={DOT}
        custom={2}
        cx="14"
        cy="14"
        r="0.6"
        fill="currentColor"
        stroke="none"
      />
    </IconShell>
  )
}
