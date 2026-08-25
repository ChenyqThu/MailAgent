// Sprint 18 §PR C 起是 180px 垂直节 nav；0825 轮 3 起**只剩 <lg 的顶部水平 tab 条**：
// ≥lg 的节导航住进域面板（DomainPanel 设置分支，词表/图标同源），本组件 `lg:hidden`。
// 为什么还要它：<lg(1024) 域面板被 nav-shell 强制收起且开合按钮隐藏，没有这条顶条，
// 窄窗里 12 个设置节就一个都够不着了。版本 footer 随节导航迁去域面板。
//
// tab 词表/顺序单源 = @shared/lib/settingsTabs 的 SETTINGS_TABS；图标表 =
// settingsTabMeta.ts（与域面板共用，防两处漂移）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { TabsList, TabsTrigger } from '@shared/components/ui/tabs'
import { AnimatedIconActiveProvider } from '@shared/components/icons'
import { useMattersEnabled } from '@shared/components/matters/hooks'
import { SETTINGS_TABS, type SettingsTab } from '@shared/lib/settingsTabs'

import { SETTINGS_TAB_ICON, settingsTabLabelKey, type SettingsTabIcon } from './settingsTabMeta'

/** 单个设置 tab —— 整个 TabsTrigger（含文字区）作为 hover/focus 触发面，经
 *  AnimatedIconActiveProvider 把激活态下发给 tab 图标，解决旧版「只有 hover 到
 *  14px 图标本身才触发」的问题。 */
function SettingsTabTrigger({
  value,
  Icon,
  label
}: {
  value: SettingsTab
  Icon: SettingsTabIcon
  label: string
}): React.ReactElement {
  const [iconActive, setIconActive] = React.useState(false)
  return (
    <TabsTrigger
      value={value}
      className="shrink-0"
      onPointerEnter={() => setIconActive(true)}
      onPointerLeave={() => setIconActive(false)}
      onFocus={() => setIconActive(true)}
      onBlur={() => setIconActive(false)}
    >
      <AnimatedIconActiveProvider active={iconActive}>
        <Icon size={14} strokeWidth={2} className="shrink-0" />
      </AnimatedIconActiveProvider>
      <span className="truncate">{label}</span>
    </TabsTrigger>
  )
}

export function SettingsRail(): React.ReactElement {
  const { t } = useTranslation()
  const mattersEnabled = useMattersEnabled()
  const tabs = React.useMemo(
    () => SETTINGS_TABS.filter((tab) => tab !== 'matters' || mattersEnabled),
    [mattersEnabled]
  )

  return (
    <aside
      aria-label="settings sections"
      className="lg:hidden glass-2 shrink-0 w-full border-b border-ink-border/60"
    >
      <div className="overflow-x-auto scrollbar-thin px-3 pt-3 pb-1.5">
        <TabsList className="flex flex-row items-stretch gap-px bg-transparent p-0 w-full">
          {tabs.map((tab) => (
            <SettingsTabTrigger
              key={tab}
              value={tab}
              Icon={SETTINGS_TAB_ICON[tab]}
              label={t(settingsTabLabelKey(tab), { defaultValue: tab })}
            />
          ))}
        </TabsList>
      </div>
    </aside>
  )
}
