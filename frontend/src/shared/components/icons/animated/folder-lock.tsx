// lucide-animated · folder-lock（锁扣抬起再合上）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_NUDGE } from '../folderMotion'

export function FolderLockIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5" />
      <motion.path variants={FOLDER_NUDGE} custom={[0, -1.8]} d="M20 17v-2a2 2 0 1 0-4 0v2" />
      <rect width="8" height="5" x="14" y="17" rx="1" />
    </IconShell>
  )
}
