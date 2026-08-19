// lucide-animated · folder 家族 24 个动效图标（mockup 版）。
//
// ── 来源与授权 ────────────────────────────────────────────────────────────
// owner 给的参考站 lucide-animated.com 是 **pqoqubbw/icons** 的展示站，
// 该项目 MIT。本仓早就按同一路子收编了 46 个（src/shared/components/icons/
// animated/*.tsx，文件头逐个写着「源 pqoqubbw/icons，改造：…」）。所以这批
// **不是新引入外部依赖**，是沿用本仓既有做法：
//   · 外壳直接复用主仓 `IconShell`（@shared/components/icons）——
//     它已经收口 size/strokeWidth/className、active 触发通道、
//     以及 `prefers-reduced-motion` 降级（reduce 时 controls.set('normal')，
//     不挂任何 hover 监听）。owner 的第 5 条要求由它兜住，本文件不用重写。
//   · 曲线守 motion-gsap.md §10：显式 tween + ICON_EASE，禁 spring / 回弹。
//   · §10 第 3 条：动画只动形状，不引颜色 —— 全部 currentColor。
// folder 家族 pqoqubbw 上游只有寥寥几个，这 24 个的动效是**按同样思路自己写的**
// （逐个拆 lucide 的内部 path 做各自语义的动作），没有拷贝上游代码。
//
// ── 几何 ──────────────────────────────────────────────────────────────────
// path 数据全部取自本仓 lucide-react@1.16.0 的 __iconNode（node_modules 里直接
// 读的，不是手打）。
//
// ⚠️ 主仓 `src/shared/components/icons/animated/` 已经有其中三个
// （folder-input / folder-plus / folders）。逐字符比对 src 的 d 串 vs
// node_modules 的 __iconNode 后（2026-08-19 实测）：
//   · folder-input —— **完全相同**，不用刷。
//   · folder-plus  —— **完全相同**（只是 __iconNode 里加号在前），不用刷。
//   · folders      —— 🔴 **确实不同**：src 还是旧几何
//     `M20 17a2 2 0 0 0 2-2V9…` + `M2 8v11a2 2 0 0 0 2 2h14`；
//     1.16.0 是 `M20 5a2 2 0 0 1 2 2v7…` + `M3 8.268a2 2 0 0 0-1 1.738V19…`。
//     本文件的 FoldersIcon24 是刷新版；页面底部「旧版 vs 刷新版」卡把两者并排。
// 🔴 本 mockup **不改** src/ 下那三个文件 —— 刷新是另一批的事。
//
// ── 移植 ──────────────────────────────────────────────────────────────────
// 主仓约定是**一个图标一个文件** `icons/animated/<name>.tsx`。这里为了 mockup
// 目录干净收在一个文件里，每块之间有分隔注释，切成 24 个文件是纯机械操作。
//
// ── 动效档案（按动作原型分组，便于 review 是不是「贴合语义」）─────────────
//   描线 draw   : check / x / minus / plus / git / root / tree / open
//   位移 nudge  : down / up / input / output / archive / code / lock
//   旋转 spin   : sync / cog / clock / key
//   缩放 pulse  : dot / heart / git-2 / kanban
//   分层 offset : folders

import * as React from 'react'
import { motion, type MotionStyle, type Transition, type Variants } from 'motion/react'

import { IconShell, ICON_EASE, type AnimatedIconProps } from '@shared/components/icons'

export type FolderIconComponent = (props: AnimatedIconProps) => React.ReactElement

const T = (duration = 0.4, delay = 0): Transition => ({
  type: 'tween',
  duration,
  ease: ICON_EASE,
  delay
})

/** SVG 变换基准钉到 viewBox 坐标。
 *
 *  🔴 两个坑，都实测踩过：
 *  1. 必须写 `originX/originY`，**不能**写 `transformOrigin` —— motion 每帧自己
 *     根据 originX/originY（默认 0.5）重写 transform-origin，手写的那条会被无声
 *     覆盖成 `50% 50%`。症状是齿轮/时针绕整个 24×24 画布中心转，而不是绕自己。
 *  2. 同时钉 `transformBox: 'view-box'`，让上面那对 px 值按 viewBox 坐标解释
 *     （否则落到元素自身包围盒上，又偏了）。 */
const org = (x: number, y: number): MotionStyle => ({
  transformBox: 'view-box',
  originX: `${x}px`,
  originY: `${y}px`
})

/* ── 通用原型 variants ──────────────────────────────────────────────── */

/** 描线：从无到有画出来。custom = 第几笔（错开 0.1s）。 */
const DRAW: Variants = {
  normal: { pathLength: 1, opacity: 1 },
  animate: (custom: number = 0) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: T(0.4, custom * 0.1)
  })
}

/** 位移后归位。custom = [dx, dy]。 */
const NUDGE: Variants = {
  normal: { x: 0, y: 0 },
  animate: (custom: [number, number] = [0, 0]) => ({
    x: [0, custom[0], 0],
    y: [0, custom[1], 0],
    transition: { ...T(0.5), times: [0, 0.4, 1] }
  })
}

/** 原地放大再收回。custom = 峰值倍数。 */
const PULSE: Variants = {
  normal: { scale: 1 },
  animate: (custom: number = 1.2) => ({
    scale: [1, custom, 1],
    transition: { ...T(0.45), times: [0, 0.45, 1] }
  })
}

/* ══ 文件夹主体（多数图标共用的静止外壳，不参与动画）══════════════════ */

const BODY_FULL =
  'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
const BODY_ROUND =
  'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z'

/* ══ folder-archive · 归档件下沉入库 ═══════════════════════════════════ */

export const FolderArchiveIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1" />
    <motion.path variants={NUDGE} custom={[0, 1.5]} d="M15 11v-1" />
    <motion.path variants={NUDGE} custom={[0, 1.5]} d="M15 17v-2" />
    <motion.circle variants={PULSE} custom={1.15} style={org(15, 19)} cx="15" cy="19" r="2" />
  </IconShell>
)

/* ══ folder-check · 勾描线 ═════════════════════════════════════════════ */

export const FolderCheckIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.path variants={DRAW} d="m9 13 2 2 4-4" />
  </IconShell>
)

/* ══ folder-clock · 分针走一圈 ═════════════════════════════════════════ */

const HAND: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 360, transition: T(0.7) }
}

export const FolderClockIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2" />
    <circle cx="16" cy="16" r="6" />
    <motion.path variants={HAND} style={org(16, 16)} d="M16 14v2.2l1.6 1" />
  </IconShell>
)

/* ══ folder-code · 尖括号左右让开 ══════════════════════════════════════ */

export const FolderCodeIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.path variants={NUDGE} custom={[-1.4, 0]} d="M10 10.5 8 13l2 2.5" />
    <motion.path variants={NUDGE} custom={[1.4, 0]} d="m14 10.5 2 2.5-2 2.5" />
  </IconShell>
)

/* ══ folder-cog · 齿轮转 ═══════════════════════════════════════════════ */

const GEAR: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 90, transition: T(0.55) }
}

export const FolderCogIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3" />
    <motion.g variants={GEAR} style={org(18, 18)}>
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

/* ══ folder-dot · 圆点脉冲 ═════════════════════════════════════════════ */

export const FolderDotIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_ROUND} />
    <motion.circle variants={PULSE} custom={2.1} style={org(12, 13)} cx="12" cy="13" r="1" />
  </IconShell>
)

/* ══ folder-down · 箭头下探 ════════════════════════════════════════════ */

export const FolderDownIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.g variants={NUDGE} custom={[0, 2.2]}>
      <path d="M12 10v6" />
      <path d="m15 13-3 3-3-3" />
    </motion.g>
  </IconShell>
)

/* ══ folder-git · 节点亮起，两侧连线向外画 ═════════════════════════════ */

export const FolderGitIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.circle variants={PULSE} custom={1.3} style={org(12, 13)} cx="12" cy="13" r="2" />
    <motion.path variants={DRAW} custom={1} d="M14 13h3" />
    <motion.path variants={DRAW} custom={1} d="M7 13h3" />
  </IconShell>
)

/* ══ folder-git-2 · 分支画出，末端节点后弹 ═════════════════════════════ */

export const FolderGit2Icon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
    <circle cx="13" cy="12" r="2" />
    <motion.path variants={DRAW} d="M18 19a5 5 0 0 1-5-5v8" />
    <motion.circle variants={PULSE} custom={1.35} style={org(20, 19)} cx="20" cy="19" r="2" />
  </IconShell>
)

/* ══ folder-heart · 心跳 ═══════════════════════════════════════════════ */

const HEARTBEAT: Variants = {
  normal: { scale: 1 },
  animate: {
    scale: [1, 1.18, 0.96, 1.1, 1],
    transition: { ...T(0.6), times: [0, 0.25, 0.45, 0.7, 1] }
  }
}

export const FolderHeartIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M10.638 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.417" />
    <motion.path
      variants={HEARTBEAT}
      style={org(18, 18)}
      d="M14.62 18.8A2.25 2.25 0 1 1 18 15.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z"
    />
  </IconShell>
)

/* ══ folder-input · 箭头滑进来 ═════════════════════════════════════════ */

export const FolderInputIcon24: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
    <motion.g variants={NUDGE} custom={[2.2, 0]}>
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </motion.g>
  </IconShell>
)

/* ══ folder-kanban · 三列依次长起来 ════════════════════════════════════ */

const COLUMN: Variants = {
  normal: { scaleY: 1 },
  animate: (custom: number = 0) => ({
    scaleY: [0.25, 1],
    transition: T(0.35, custom * 0.09)
  })
}

export const FolderKanbanIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_ROUND} />
    {/* 每列的基准点钉在自己的底端，才是「长高」不是「整根平移」。 */}
    <motion.path variants={COLUMN} custom={0} style={org(8, 14)} d="M8 10v4" />
    <motion.path variants={COLUMN} custom={1} style={org(12, 12)} d="M12 10v2" />
    <motion.path variants={COLUMN} custom={2} style={org(16, 16)} d="M16 10v6" />
  </IconShell>
)

/* ══ folder-key · 拧一下钥匙 ═══════════════════════════════════════════ */

const TURN: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: [0, -22, 0], transition: { ...T(0.55), times: [0, 0.45, 1] } }
}

export const FolderKeyIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M13 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v1.36" />
    <motion.g variants={TURN} style={org(19, 20)}>
      <path d="M19 12v6" />
      <path d="M19 14h2" />
      <circle cx="19" cy="20" r="2" />
    </motion.g>
  </IconShell>
)

/* ══ folder-lock · 锁扣抬起再合上 ══════════════════════════════════════ */

export const FolderLockIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5" />
    <motion.path variants={NUDGE} custom={[0, -1.8]} d="M20 17v-2a2 2 0 1 0-4 0v2" />
    <rect width="8" height="5" x="14" y="17" rx="1" />
  </IconShell>
)

/* ══ folder-minus · 横杠描线 ═══════════════════════════════════════════ */

export const FolderMinusIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.path variants={DRAW} d="M9 13h6" />
  </IconShell>
)

/* ══ folder-open · 前盖描线掀开 ════════════════════════════════════════ */

// lucide 的 folder-open 是**一整条** path，盖子拆不出来。硬套一个整体
// rotate/scale 就成了「统一糊一个 transform」——正是 owner 点名不要的。
// 这里改成沿轮廓描线：前盖那一段最后画出来，读起来就是盖子扫开。
const SWEEP: Variants = {
  normal: { pathLength: 1 },
  animate: { pathLength: [0.45, 1], transition: T(0.5) }
}

export const FolderOpenIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <motion.path
      variants={SWEEP}
      d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
    />
  </IconShell>
)

/* ══ folder-output · 箭头往外走 ════════════════════════════════════════ */

export const FolderOutputIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M2 7.5V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-1.5" />
    <motion.g variants={NUDGE} custom={[-2.2, 0]}>
      <path d="M2 13h10" />
      <path d="m5 10-3 3 3 3" />
    </motion.g>
  </IconShell>
)

/* ══ folder-plus · 加号两笔错开描出 ════════════════════════════════════ */

export const FolderPlusIcon24: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.path variants={DRAW} custom={1} d="M12 10v6" />
    <motion.path variants={DRAW} custom={0} d="M9 13h6" />
  </IconShell>
)

/* ══ folder-root · 生根：节点亮起，根须向下长 ══════════════════════════ */

export const FolderRootIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_ROUND} />
    <motion.circle variants={PULSE} custom={1.25} style={org(12, 13)} cx="12" cy="13" r="2" />
    <motion.path variants={DRAW} custom={1} d="M12 15v5" />
  </IconShell>
)

/* ══ folder-sync · 双向环箭头转一圈 ════════════════════════════════════ */

const SYNC: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 180, transition: T(0.6) }
}

export const FolderSyncIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5" />
    <motion.g variants={SYNC} style={org(17, 16)}>
      <path d="M12 10v4h4" />
      <path d="m12 14 1.535-1.605a5 5 0 0 1 8 1.5" />
      <path d="M22 22v-4h-4" />
      <path d="m22 18-1.535 1.605a5 5 0 0 1-8-1.5" />
    </motion.g>
  </IconShell>
)

/* ══ folder-tree · 主干先画，两个子节点依次浮现 ════════════════════════ */

const BRANCH_IN: Variants = {
  normal: { opacity: 1, x: 0 },
  animate: (custom: number = 0) => ({
    opacity: [0, 1],
    x: [-2, 0],
    transition: T(0.35, 0.12 + custom * 0.1)
  })
}

export const FolderTreeIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <motion.path variants={DRAW} d="M3 3v13a2 2 0 0 0 2 2h3" />
    <motion.path variants={DRAW} d="M3 5a2 2 0 0 0 2 2h3" />
    <motion.path
      variants={BRANCH_IN}
      custom={0}
      d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
    />
    <motion.path
      variants={BRANCH_IN}
      custom={1}
      d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"
    />
  </IconShell>
)

/* ══ folder-up · 箭头上抬 ══════════════════════════════════════════════ */

export const FolderUpIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.g variants={NUDGE} custom={[0, -2.2]}>
      <path d="M12 10v6" />
      <path d="m9 13 3-3 3 3" />
    </motion.g>
  </IconShell>
)

/* ══ folder-x · 两笔交叉错开划掉 ═══════════════════════════════════════ */

export const FolderXIcon: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <path d={BODY_FULL} />
    <motion.path variants={DRAW} custom={0} d="m9.5 10.5 5 5" />
    <motion.path variants={DRAW} custom={1} d="m14.5 10.5-5 5" />
  </IconShell>
)

/* ══ folders · 前层错开滑出，后层退让 ══════════════════════════════════ */

const FRONT: Variants = {
  normal: { x: 0, y: 0 },
  animate: { x: -2, y: 2, transition: T(0.4) }
}
const BACK: Variants = {
  normal: { x: 0, y: 0, opacity: 1 },
  animate: { x: 2, y: -2, opacity: 0.35, transition: T(0.4) }
}

export const FoldersIcon24: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <motion.path
      variants={FRONT}
      d="M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"
    />
    <motion.path
      variants={BACK}
      d="M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"
    />
  </IconShell>
)

/* ══ 兜底 · folder（没设过图标 / key 不认识）══════════════════════════ */

const LID: Variants = {
  normal: { y: 0 },
  animate: { y: [0, -1.2, 0], transition: { ...T(0.45), times: [0, 0.4, 1] } }
}

export const FolderIcon24: FolderIconComponent = (props) => (
  <IconShell {...props}>
    <motion.path
      variants={LID}
      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
    />
  </IconShell>
)
