// lucide-animated · folder-output（箭头往外走）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_NUDGE } from '../folderMotion'

export function FolderOutputIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M2 7.5V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1.5" />
      <motion.g variants={FOLDER_NUDGE} custom={[-2.2, 0]}>
        <path d="M2 13h10" />
        <path d="m5 10-3 3 3 3" />
      </motion.g>
    </IconShell>
  )
}
