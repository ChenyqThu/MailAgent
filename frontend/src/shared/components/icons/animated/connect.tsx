// lucide-animated · connect（插头拔出 + 插座分离）。源 pqoqubbw/icons，改造：spring→tween + ICON_EASE（§10）；去 forwardRef/div 外壳；PATH_VARIANTS 函数式 custom 改为直接 variants。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '../AnimatedIcon'

const TWEEN = { type: 'tween' as const, duration: 0.4, ease: ICON_EASE }

const PLUG: Variants = {
  normal: { x: 0, y: 0, transition: TWEEN },
  animate: { x: -3, y: 3, transition: TWEEN }
}

const SOCKET: Variants = {
  normal: { x: 0, y: 0, transition: TWEEN },
  animate: { x: 3, y: -3, transition: TWEEN }
}

const WIRE_A: Variants = {
  normal: { d: 'M19 5l3 -3', transition: TWEEN },
  animate: { d: 'M17 7l5 -5', transition: TWEEN }
}

const WIRE_B: Variants = {
  normal: { d: 'm2 22 3-3', transition: TWEEN },
  animate: { d: 'm2 22 6-6', transition: TWEEN }
}

const SPARK_A: Variants = {
  normal: { d: 'M7.5 13.5 l2.5 -2.5', transition: TWEEN },
  animate: { d: 'M10.43 10.57 l0.10 -0.10', transition: TWEEN }
}

const SPARK_B: Variants = {
  normal: { d: 'M10.5 16.5 l2.5 -2.5', transition: TWEEN },
  animate: { d: 'M13.43 13.57 l0.10 -0.10', transition: TWEEN }
}

export function ConnectIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <motion.path variants={WIRE_A} />
      <motion.path variants={WIRE_B} />
      <motion.path
        variants={SOCKET}
        d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"
      />
      <motion.path variants={SPARK_A} />
      <motion.path variants={SPARK_B} />
      <motion.path
        variants={PLUG}
        d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"
      />
    </IconShell>
  )
}
