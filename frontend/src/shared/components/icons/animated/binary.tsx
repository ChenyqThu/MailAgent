// lucide-animated · binary。源 pqoqubbw/icons（MIT，见 ./LICENSE-pqoqubbw）。
// 🔴 由 scripts/vendor-animated-icons.mjs 机器生成，勿手改 —— 要改先改脚本再重跑。
// 改造：剥 forwardRef/useAnimation/div 外壳套 IconShell。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const FLIP_DURATION = 0.12

const FLIP_STAGGER = 0.06

const FLIP_OUT_VARIANTS: Variants = {
  normal: (custom: number) => ({
    rotateX: 0,
    opacity: 1,
    transition: {
      duration: 0.12,
      delay: custom * FLIP_STAGGER + FLIP_DURATION,
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }),
  animate: (custom: number) => ({
    rotateX: -90,
    opacity: 0,
    transition: {
      duration: 0.12,
      delay: custom * FLIP_STAGGER,
      type: 'tween' as const,
      ease: ICON_EASE
    }
  })
}

const FLIP_IN_VARIANTS: Variants = {
  normal: (custom: number) => ({
    rotateX: 90,
    opacity: 0,
    transition: {
      duration: 0.12,
      delay: custom * FLIP_STAGGER,
      type: 'tween' as const,
      ease: ICON_EASE
    }
  }),
  animate: (custom: number) => ({
    rotateX: 0,
    opacity: 1,
    transition: {
      duration: 0.12,
      delay: custom * FLIP_STAGGER + FLIP_DURATION,
      type: 'tween' as const,
      ease: ICON_EASE
    }
  })
}

export function BinaryIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.rect
        custom={0}
        height="6"
        rx="2"
        variants={FLIP_OUT_VARIANTS}
        width="4"
        x="6"
        y="4"
      />
      <motion.g custom={0} variants={FLIP_IN_VARIANTS}>
        <path d="M6 4h2v6" />
        <path d="M6 10h4" />
      </motion.g>

      <motion.g custom={1} variants={FLIP_OUT_VARIANTS}>
        <path d="M14 4h2v6" />
        <path d="M14 10h4" />
      </motion.g>
      <motion.rect
        custom={1}
        height="6"
        rx="2"
        variants={FLIP_IN_VARIANTS}
        width="4"
        x="14"
        y="4"
      />

      <motion.g custom={2} variants={FLIP_OUT_VARIANTS}>
        <path d="M6 14h2v6" />
        <path d="M6 20h4" />
      </motion.g>
      <motion.rect
        custom={2}
        height="6"
        rx="2"
        variants={FLIP_IN_VARIANTS}
        width="4"
        x="6"
        y="14"
      />

      <motion.rect
        custom={3}
        height="6"
        rx="2"
        variants={FLIP_OUT_VARIANTS}
        width="4"
        x="14"
        y="14"
      />
      <motion.g custom={3} variants={FLIP_IN_VARIANTS}>
        <path d="M14 14h2v6" />
        <path d="M14 20h4" />
      </motion.g>
    </IconShell>
  )
}
