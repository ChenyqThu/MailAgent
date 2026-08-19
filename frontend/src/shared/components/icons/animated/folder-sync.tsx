// lucide-animated · folder-sync（双向环箭头转半圈）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderOrigin, folderTween } from '../folderMotion'

const SPIN: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 180, transition: folderTween(0.6) }
}

export function FolderSyncIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5" />
      <motion.g variants={SPIN} style={folderOrigin(17, 16)}>
        <path d="M12 10v4h4" />
        <path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5" />
        <path d="M22 22v-4h-4" />
        <path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5" />
      </motion.g>
    </IconShell>
  )
}
