// 动画图标统一出口（lucide-animated 改造，详见 ./AnimatedIcon.tsx + motion-gsap §10）。
// 仅收录有 pqoqubbw 动画版的 lucide 图标；无动画版的（Inbox/Star/Mail/Palette/User/
// Globe/Plug/BarChart3 等）继续从 lucide-react 直接 import 静态版。
export {
  IconShell,
  AnimatedIconActiveProvider,
  ICON_EASE,
  ICON_DUR,
  type AnimatedIconProps
} from './AnimatedIcon'

export { SettingsIcon } from './animated/settings'
export { SparklesIcon } from './animated/sparkles'

// 第二批（用户点名替换）：发件箱→feather · 所有邮件→folders · 自定义文件夹→folder-plus
// · Custom Agents→grip。均 pqoqubbw 动画版，已套 IconShell。
export { FeatherIcon } from './animated/feather'
export { FoldersIcon } from './animated/folders'
export { FolderPlusIcon } from './animated/folder-plus'
export { GripIcon } from './animated/grip'

// 第三批（主菜单/设置/搜索/邮件工具栏全量动态化）。均 pqoqubbw 动画版，已套 IconShell。
export { MailboxIcon } from './animated/mailbox'
export { ZapIcon } from './animated/zap'
export { ZapOffIcon } from './animated/zap-off'
export { ChartPieIcon } from './animated/chart-pie'
export { ChartLineIcon } from './animated/chart-line'
export { CalendarCheckIcon } from './animated/calendar-check'
export { BlocksIcon } from './animated/blocks'
export { UserRoundCogIcon } from './animated/user-round-cog'
export { ConnectIcon } from './animated/connect'
export { RouteIcon } from './animated/route'
export { SearchIcon } from './animated/search'
export { RocketIcon } from './animated/rocket'
export { LanguagesIcon } from './animated/languages'
export { CheckCheckIcon } from './animated/check-check'
export { MapPinIcon } from './animated/map-pin'
export { MapPinCheckIcon } from './animated/map-pin-check'
export { ArchiveIcon } from './animated/archive'
export { RefreshCcwIcon } from './animated/refresh-ccw'
export { AtomIcon } from './animated/atom'
export { ChevronUpIcon } from './animated/chevron-up'
export { ChevronDownIcon } from './animated/chevron-down'
export { DeleteIcon } from './animated/delete'

// 第四批（dogfood 微调）：收件箱 folder-input、设置账户 user、设置 AI tab bot-message-square。
export { FolderInputIcon } from './animated/folder-input'
export { UserIcon } from './animated/user'
export { BotMessageSquareIcon } from './animated/bot-message-square'

export { SendIcon } from './animated/send'
export { SquarePenIcon } from './animated/square-pen'
export { HistoryIcon } from './animated/history'
export { ActivityIcon } from './animated/activity'
export { CalendarDaysIcon } from './animated/calendar-days'
export { CircleHelpIcon } from './animated/circle-help'
export { SlidersHorizontalIcon } from './animated/sliders-horizontal'
export { RefreshCwIcon } from './animated/refresh-cw'
export { BellIcon } from './animated/bell'
export { BotIcon } from './animated/bot'
export { WifiIcon } from './animated/wifi'
export { RadioIcon } from './animated/radio'

// 第五批（Settings Labs）：lucide FlaskConical 静止态 + IconShell tween 微动效。
export { FlaskConicalIcon } from './animated/flask-conical'

// 第六批（用户点名）：邮件工具栏「在 Notion 打开」从 AtomIcon（与"跟进 Agent"撞图）
// 换成 box —— 描边绘制型动画。
export { BoxIcon } from './animated/box'

// 第七批（用户点名）：主菜单「事项」→ briefcase-business，接上动画体系。
export { BriefcaseBusinessIcon } from './animated/briefcase-business'
