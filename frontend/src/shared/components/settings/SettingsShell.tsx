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

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
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
import { RemoteAccessTab } from './tabs/RemoteAccessTab'
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

  // 切 tab 时当前激活 panel 淡入. Radix TabsContent 仅 mount/unmount 无过渡 (硬替换),
  // 这里给 panel 容器做 autoAlpha 0→1 + y:4→0 (DUR.base). reduced-motion 短路.
  const panelScopeRef = React.useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      if (reduceMotion) return
      const el = panelScopeRef.current
      if (!el) return
      gsap.from(el, { autoAlpha: 0, y: 4, duration: DUR.base, overwrite: 'auto' })
    },
    { dependencies: [tab, reduceMotion], scope: panelScopeRef }
  )

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
      // Sprint 18 review — SettingsLayout passes `mainClassName="flex"`
      // 让 <main> 变成 row flex 容器, 这里 Tabs root 直接 stretch 填高度.
      // `min-w-0` 让长 content 行 (env path / tag-list) 在 flex 子项中
      // 正确 shrink, 不会强行撑爆父级宽度.
      className="flex flex-1 min-h-0 min-w-0"
    >
      <SettingsRail />
      {/* Sprint 18 review (round 5) — 单滚动条 + sticky banner (EmailDetail
          §line 526-554 同款方案): section 自己是唯一 scroll container,
          RestartBanner 作 sticky top-0 z-10 直接子, 滚动正文时 banner 保
          冻结. content 容器只负责 max-w + padding, 不创建二级 scroll. */}
      <section
        aria-label="settings content"
        className="glass-3 flex-1 min-w-0 min-h-0 overflow-y-auto scrollbar-thin"
      >
        <RestartBanner />
        <div
          ref={panelScopeRef}
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
          <TabsContent value="remote">
            <RemoteAccessTab />
          </TabsContent>
          <TabsContent value="island">
            <IslandUpdatesTab />
          </TabsContent>
        </div>
      </section>
    </Tabs>
  )
}
