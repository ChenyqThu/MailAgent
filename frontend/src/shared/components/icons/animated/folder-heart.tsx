// lucide-animated · folder-heart（心跳，双拍）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderOrigin, folderTween } from '../folderMotion'

const HEARTBEAT: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.18, 0.96, 1.1, 1],
    transition: { ...folderTween(0.6), times: [0, 0.25, 0.45, 0.7, 1] }
  }
}

export function FolderHeartIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M10.638 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.417" />
      <motion.path
        variants={HEARTBEAT}
        style={folderOrigin(18, 18)}
        d="M14.62 18.8A2.25 2.25 0 1 1 18 15.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"
      />
    </IconShell>
  )
}
