// lucide-animated · folder-dot（圆点脉冲）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { FOLDER_BODY_ROUND, FOLDER_PULSE, folderOrigin } from '../folderMotion'

export function FolderDotIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d={FOLDER_BODY_ROUND} />
      <motion.circle
        variants={FOLDER_PULSE}
        custom={2.1}
        style={folderOrigin(12, 13)}
        cx="12"
        cy="13"
        r="1"
      />
    </IconShell>
  )
}
