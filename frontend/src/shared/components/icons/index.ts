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
