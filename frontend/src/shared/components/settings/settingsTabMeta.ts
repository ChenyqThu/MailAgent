// 设置 tab 的表现层元数据（图标 + label key 约定）。
// 键域 = SettingsTab 全集 —— 少一个 tab 编译期即红。

import type { ComponentType } from 'react'

import {
  BellIcon,
  BlocksIcon,
  BotMessageSquareIcon,
  BriefcaseBusinessIcon,
  ConnectIcon,
  FlaskConicalIcon,
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
  ai: BotMessageSquareIcon,
  connectors: SlidersHorizontalIcon,
  matters: BriefcaseBusinessIcon,
  notifications: BellIcon,
  integrations: ConnectIcon,
  realtime: WifiIcon,
  labs: FlaskConicalIcon
}

/** i18n key 约定统一为 `settings.tabs.<tab>`（抽成函数防三处消费方手拼漂移）。 */
export function settingsTabLabelKey(tab: SettingsTab): string {
  return `settings.tabs.${tab}`
}
