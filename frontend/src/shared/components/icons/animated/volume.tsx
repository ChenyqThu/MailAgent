// lucide-animated · volume（静止 = 静音叉号，hover = 音波淡入）。源 pqoqubbw/icons
// （MIT，见 ./LICENSE-pqoqubbw），**人工改造**（批量脚本转不了：上游靠 useState +
// AnimatePresence 在两组子元素之间整体换装）。本仓改成两组元素常驻、用 normal/animate
// 互斥淡入淡出 —— 语义与上游一致（hover 才出声波），但不进出 DOM、无状态。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

/** 音波：静止隐藏、hover 依次淡入。 */
const WAVE_VARIANTS: Variants = {
  normal: { opacity: 0, transition: { type: 'tween' as const, duration: 0.2, ease: ICON_EASE } },
  animate: (i: number) => ({
    opacity: 1,
    transition: { type: 'tween' as const, duration: 0.3, ease: ICON_EASE, delay: i * 0.1 }
  })
}

/** 静音叉号：与音波互斥。 */
const MUTE_VARIANTS: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: 0,
    transition: { type: 'tween' as const, duration: 0.2, ease: ICON_EASE }
  }
}

export function VolumeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <motion.path variants={WAVE_VARIANTS} custom={0} d="M16 9a5 5 0 0 1 0 6" />
      <motion.path variants={WAVE_VARIANTS} custom={1} d="M19.364 18.364a9 9 0 0 0 0-12.728" />
      <motion.line variants={MUTE_VARIANTS} x1="22" x2="16" y1="9" y2="15" />
      <motion.line variants={MUTE_VARIANTS} x1="16" x2="22" y1="9" y2="15" />
    </IconShell>
  )
}
