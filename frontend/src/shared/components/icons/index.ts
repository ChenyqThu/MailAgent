// 动画图标统一出口（lucide-animated 改造，详见 ./AnimatedIcon.tsx + motion-gsap §10）。
//
// 上游 pqoqubbw/icons 的全量（约 460 个）已 vendor 进 ./animated/，出口就是下面这行
// `export *`（具名 export barrel，由 `pnpm icon:vendor` 生成）—— 想换主菜单图标直接
// 按名字 import，不必再逐个拉源码手工套壳。
//   · 上游没有动画版的（Inbox/Star/Mail/Palette/Globe/Plug/BarChart3 等）仍从
//     lucide-react 直接 import 静态版；两者可以并排用，静止态本来就是同一套 path。
//   · 🔴 不要为这批图标建 key → 组件的 eager 查表（理由见 ./animated/index.ts 头注）。
export {
  IconShell,
  AnimatedIconActiveProvider,
  ICON_EASE,
  ICON_DUR,
  type AnimatedIconProps
} from './AnimatedIcon'

export * from './animated'

// 第九批（per-folder 图标）：lucide folder 家族 24 个候选，用户逐个文件夹挑一个。
// 单个图标不逐一 re-export —— 消费方一律经 `folderIcon(key)` 拿组件（key 才是落库值，
// 逐个 import 会把「哪些 key 存在」这件事散到调用点）。
export {
  FOLDER_ICON_KEYS,
  DEFAULT_FOLDER_ICON,
  folderIcon,
  type FolderIconKey,
  type FolderIconComponent
} from './folderIcons'
// 渲染入口：调用方一律用 `<FolderGlyph iconKey={…} />`，不要自己查表再当组件名用。
export { FolderGlyph, type FolderGlyphProps } from './FolderGlyph'

// 内建 5 邮箱（收件箱/发件箱/草稿箱/已标旗/所有邮件）的图标单源 —— 侧边栏与设置页
// 内建邮箱行共读，**不开放自定义**。
export { MAILBOX_ICON_COMPONENT, type MailboxIconComponent } from './mailboxIcons'
