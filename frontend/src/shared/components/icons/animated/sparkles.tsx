// lucide-animated · sparkles（主星上浮+填充，碎星闪烁）。源 pqoqubbw/icons，改造：
// 去 bounce/spring（§10），variant 名统一 normal/animate，时长收敛到 standard tween。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const SPARKLE: Variants = {
  normal: { y: 0, fill: 'transparent' },
  animate: {
    y: [0, -1, 0],
    fill: 'currentColor',
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}

const STAR: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [0, 1, 0, 1],
    transition: { type: 'tween' as const, duration: 0.7, ease: ICON_EASE, delay: 0.12 }
  }
}

export function SparklesIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path
        variants={SPARKLE}
        d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
      />
      <motion.path variants={STAR} d="M20 3v4" />
      <motion.path variants={STAR} d="M22 5h-4" />
      <motion.path variants={STAR} d="M4 17v2" />
      <motion.path variants={STAR} d="M5 18H3" />
    </IconShell>
  )
}
