// lucide-animated · users-round（通讯录）。照 user.tsx 骨架：pathLength/pathOffset
// 描入 + delay stagger + 显式 tween ICON_EASE（§10 禁 spring —— 设计 §2.9 的
// stiffness 200 弹入按主 session 裁决项 3 不采用）。右侧那个人是动画段。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const HEAD: Variants = {
  normal: { pathLength: 1, pathOffset: 0, scale: 1 },
  animate: {
    pathLength: [0, 1],
    pathOffset: [1, 0],
    scale: [0.5, 1],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE }
  }
}
const BODY: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: 0.1 }
  }
}
const SECOND_PERSON: Variants = {
  normal: { pathLength: 1, opacity: 1, pathOffset: 0, x: 0 },
  animate: {
    pathLength: [0, 1],
    opacity: [0, 1],
    pathOffset: [1, 0],
    x: [-2, 0],
    transition: { type: 'tween' as const, duration: 0.5, ease: ICON_EASE, delay: 0.2 }
  }
}

export function UsersRoundIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.circle variants={HEAD} cx="10" cy="8" r="5" />
      <motion.path variants={BODY} d="M18 21a8 8 0 0 0-16 0" />
      <motion.path variants={SECOND_PERSON} d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </IconShell>
  )
}
