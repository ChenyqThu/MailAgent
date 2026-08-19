// lucide-animated · folder-code（尖括号左右让开）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_FULL, FOLDER_NUDGE } from '../folderMotion'

export function FolderCodeIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_FULL} />
      <motion.path variants={FOLDER_NUDGE} custom={[-1.4, 0]} d="M10 10.5 8 13l2 2.5" />
      <motion.path variants={FOLDER_NUDGE} custom={[1.4, 0]} d="m14 10.5 2 2.5-2 2.5" />
    </IconShell>
  )
}
