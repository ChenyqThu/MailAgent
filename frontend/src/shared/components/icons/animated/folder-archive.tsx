// lucide-animated · folder-archive（归档件下沉入库）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_NUDGE, FOLDER_PULSE, folderOrigin } from '../folderMotion'

export function FolderArchiveIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1" />
      <motion.path variants={FOLDER_NUDGE} custom={[0, 1.5]} d="M15 11v-1" />
      <motion.path variants={FOLDER_NUDGE} custom={[0, 1.5]} d="M15 17v-2" />
      <motion.circle
        variants={FOLDER_PULSE}
        custom={1.15}
        style={folderOrigin(15, 19)}
        cx="15"
        cy="19"
        r="2"
      />
    </IconShell>
  )
}
