// lucide-animated · folder-key（钥匙拧一下）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderOrigin, folderTween } from '../folderMotion'

const TURN: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: [0, -22, 0], transition: { ...folderTween(0.55), times: [0, 0.45, 1] } }
}

export function FolderKeyIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M13 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v1.36" />
      <motion.g variants={TURN} style={folderOrigin(19, 20)}>
        <path d="M19 12v6" />
        <path d="M19 14h2" />
        <circle cx="19" cy="20" r="2" />
      </motion.g>
    </IconShell>
  )
}
