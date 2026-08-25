// 设置 tab 的表现层元数据（图标 + label key 约定）。
//
// 词表与顺序的单源 = `@shared/lib/settingsTabs` 的 `SETTINGS_TABS` —— 那是零依赖叶子
// （router-instance / 通知落地都 import 它），不能挂 icon import，所以图标表落在这里。
// 消费方：SettingsRail（<lg 顶部水平 tab 条）+ DomainPanel 设置域行（≥lg，0825 轮 3
// 起设置的节导航住进域面板）。键域 = SettingsTab 全集 —— 少一个 tab 编不过。

import type { ComponentType } from 'react'

import {
  BellIcon,
  BlocksIcon,
  BotMessageSquareIcon,
  BriefcaseBusinessIcon,
  ConnectIcon,
  FlaskConicalIcon,
  RadioIcon,
  RefreshCwIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  UserIcon,
  WifiIcon
} from '@shared/components/icons'
import type { SettingsTab } from '@shared/lib/settingsTabs'

export type SettingsTabIcon = ComponentType<{
  size?: number
  strokeWidth?: number
  className?: string
}>

export const SETTINGS_TAB_ICON: Record<SettingsTab, SettingsTabIcon> = {
  general: BlocksIcon,
  accounts: UserIcon,
  sync: RefreshCwIcon,
  ai: BotMessageSquareIcon,
  connectors: SlidersHorizontalIcon,
  matters: BriefcaseBusinessIcon,
  notifications: BellIcon,
  integrations: ConnectIcon,
  realtime: WifiIcon,
  remote: RouteIcon,
  island: RadioIcon,
  labs: FlaskConicalIcon
}

/** i18n key 约定统一为 `settings.tabs.<tab>`（SettingsRail 既有约定，抽成函数防手拼漂移）。 */
export function settingsTabLabelKey(tab: SettingsTab): string {
  return `settings.tabs.${tab}`
}
