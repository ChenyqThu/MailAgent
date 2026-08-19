// lucide-animated · folder-clock（分针走一圈）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderOrigin, folderTween } from '../folderMotion'

const HAND: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 360, transition: folderTween(0.7) }
}

export function FolderClockIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2" />
      <circle cx="16" cy="16" r="6" />
      <motion.path variants={HAND} style={folderOrigin(16, 16)} d="M16 14v2.2l1.6 1" />
    </IconShell>
  )
}
