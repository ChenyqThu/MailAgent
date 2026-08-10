// lucide-animated · box（三条 path 描边绘制：pathLength 0→1 + 淡入）。源 pqoqubbw/icons
// （lucide-animated.com/r/box.json, MIT），改造：spring 默认 transition → 显式 tween +
// ICON_EASE（§10 红线）；去 forwardRef/useImperativeHandle/div 外壳，改由 IconShell 的
// controls 递归驱动；三条 path 共用一份 variants（上游同样是同一份，无错时）。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

// opacity 用更短的子 duration（0.1）先把线"点亮", 再由 pathLength 走完描边 ——
// 否则 0.4s 里前半段是一条正在变长的半透明线, 在 13px 工具栏尺寸下糊成一团。
const PATH_VARIANTS: Variants = {
  normal: {
    opacity: 1,
    pathLength: 1,
    transition: {
      type: 'tween' as const,
      duration: 0.3,
      ease: ICON_EASE,
      opacity: { duration: 0.1 }
    }
  },
  animate: {
    opacity: [0, 1],
    pathLength: [0, 1],
    transition: {
      type: 'tween' as const,
      duration: 0.4,
      ease: ICON_EASE,
      opacity: { duration: 0.1 }
    }
  }
}

export function BoxIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={PATH_VARIANTS}
        d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"
      />
      <motion.path variants={PATH_VARIANTS} d="m3.3 7 8.7 5 8.7-5" />
      <motion.path variants={PATH_VARIANTS} d="M12 22V12" />
    </IconShell>
  )
}
