// lucide-animated · folder-down（箭头下探）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, FOLDER_NUDGE } from '../folderMotion'

export function FolderDownIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_FULL} />
      <motion.g variants={FOLDER_NUDGE} custom={[0, 2.2]}>
        <path d="M12 10v6" />
        <path d="m15 13-3 3-3-3" />
      </motion.g>
    </IconShell>
  )
}
