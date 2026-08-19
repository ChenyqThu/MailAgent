// lucide-animated · folder-cog（齿轮转 90°）。几何取自 lucide-react@1.16.0 __iconNode。
import * as React from 'react'
import { motion, type Variants } from 'motion/react'

import { IconShell, type AnimatedIconProps } from '../AnimatedIcon'
import { folderOrigin, folderTween } from '../folderMotion'

const GEAR: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 90, transition: folderTween(0.55) }
}

export function FolderCogIcon(props: AnimatedIconProps): React.ReactElement {
  return (
    <IconShell {...props}>
      <path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3" />
      <motion.g variants={GEAR} style={folderOrigin(18, 18)}>
        <path d="m14.305 19.53.923-.382" />
        <path d="m15.228 16.852-.923-.383" />
        <path d="m16.852 15.228-.383-.923" />
        <path d="m16.852 20.772-.383.924" />
        <path d="m19.148 15.228.383-.923" />
        <path d="m19.53 21.696-.382-.924" />
        <path d="m20.772 16.852.924-.383" />
        <path d="m20.772 19.148.924.383" />
        <circle cx="18" cy="18" r="3" />
      </motion.g>
    </IconShell>
  )
}
