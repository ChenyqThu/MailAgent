// lucide-animated · delete（垃圾桶，hover 掀盖）。源 lucide-animated.com/r/delete.json（造型即 trash-2），
// 改造：spring→tween + ICON_EASE（§10）；去 forwardRef/useAnimation/div 外壳；controls 作 variant root
// 递归驱动盖子组。盖子整组上抬 + 右端微翘 = 掀盖；桶身/竖线静止。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

// 盖子（横盖 M3 6h18 + 把手）整组上抬 + 绕自身中心微旋 = 掀盖。translateY 主导，小 rotate 增强。
const LID_VARIANTS: Variants = {
  normal: { y: 0, rotate: 0 },
  animate: {
    y: -2.4,
    rotate: -7,
    transition: { type: 'tween' as const, duration: 0.32, ease: ICON_EASE }
  }
}

export function DeleteIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.g
        variants={LID_VARIANTS}
        style={{ transformOrigin: 'center', transformBox: 'fill-box' }}
      >
        <path d="M3 6h18" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      </motion.g>
      <path d="M19 8v12c0 1-1 2-2 2H7c-1 0-2-1-2-2V8" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </IconShell>
  )
}
