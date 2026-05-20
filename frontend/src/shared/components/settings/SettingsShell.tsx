// Sprint 18 §PR C — Settings 三列 shell.
//
// Layout 走 mockup-settings.html 同款:
//   PageFrame (TitleBar + AppSidebar 240 + StatusBar)
//     └── SettingsShell
//           ├── SettingsRail (180px Radix Tabs.List vertical)
//           └── content pane (760 max-w, glass-3 surface, overflow-y-auto)
//                 └── one <Tabs.Content> per tab
//
// Active tab 来自 URL search param `?tab=general` (validateSearch 在
// router-instance.tsx 处理 enum + default). 切 tab 用 router.navigate
// 写 search, 这样浏览器返回 / 刷新 / 深链都对得上.
//
// Mount 时调用 useEnvStore.refresh() 拉一次 env:get 缓存; 后续每个
// EnvField 从 store 读, 不再单独 IPC. RestartBanner (PR E) 会挂在 content
// pane 顶部 sticky, 此 PR 留 placeholder 注释.

import * as React from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'

import { Tabs, TabsContent } from '@shared/components/ui/tabs'
import { useEnvStore } from '@shared/state/env'
import { SETTINGS_TABS, type SettingsTab } from '@shared/router-instance'

import { RestartBanner } from './RestartBanner'
import { SettingsRail } from './SettingsRail'
import { AccountsTab } from './tabs/AccountsTab'
import { AiTab } from './tabs/AiTab'
import { GeneralTab } from './tabs/GeneralTab'
import { IntegrationsTab } from './tabs/IntegrationsTab'
import { IslandUpdatesTab } from './tabs/IslandUpdatesTab'
import { NotificationsTab } from './tabs/NotificationsTab'
import { RealtimeStorageTab } from './tabs/RealtimeStorageTab'
import { SyncTab } from './tabs/SyncTab'

export function SettingsShell(): React.ReactElement {
  const search = useSearch({ strict: false }) as { tab?: string }
  const navigate = useNavigate()
  const refresh = useEnvStore((s) => s.refresh)

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const tab: SettingsTab =
    typeof search.tab === 'string' && (SETTINGS_TABS as readonly string[]).includes(search.tab)
      ? (search.tab as SettingsTab)
      : 'general'

  function handleTabChange(value: string): void {
    if (!(SETTINGS_TABS as readonly string[]).includes(value)) return
    void navigate({
      to: '/settings',
      search: { tab: value as SettingsTab }
    })
  }

  return (
    <Tabs
      value={tab}
      onValueChange={handleTabChange}
      orientation="vertical"
      className="flex flex-1 min-h-0 overflow-hidden"
    >
      <SettingsRail />
      <section className="glass-3 flex-1 min-w-0 overflow-y-auto scrollbar-thin">
        <RestartBanner />
        <div
          className="mx-auto"
          style={{
            maxWidth: 'var(--settings-content-max-w, 760px)',
            paddingLeft: 'var(--settings-content-px, 2.5rem)',
            paddingRight: 'var(--settings-content-px, 2.5rem)',
            paddingTop: 'var(--settings-content-py, 2rem)',
            paddingBottom: 'var(--settings-content-pb, 6rem)'
          }}
        >
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="accounts">
            <AccountsTab />
          </TabsContent>
          <TabsContent value="sync">
            <SyncTab />
          </TabsContent>
          <TabsContent value="ai">
            <AiTab />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsTab />
          </TabsContent>
          <TabsContent value="integrations">
            <IntegrationsTab />
          </TabsContent>
          <TabsContent value="realtime">
            <RealtimeStorageTab />
          </TabsContent>
          <TabsContent value="island">
            <IslandUpdatesTab />
          </TabsContent>
        </div>
      </section>
    </Tabs>
  )
}
