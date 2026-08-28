// Sprint 18 §PR C — Settings 三列 shell.
//
// Layout（0825 轮 3 起）:
//   PageFrame (TitleBar + nav shell + StatusBar)
//     └── SettingsShell
//           ├── SettingsRail（仅 <lg：顶部水平 tab 条；≥lg 节导航在 DomainPanel）
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
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Info } from 'lucide-react'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { Tabs, TabsContent } from '@shared/components/ui/tabs'
import { useEnvStore } from '@shared/state/env'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { SETTINGS_TABS, type SettingsTab } from '@shared/router-instance'

import { RestartBanner } from './RestartBanner'
import { SettingsRail } from './SettingsRail'
import { settingsTabLabelKey } from './settingsTabMeta'
import { SettingsScrollContext } from './settingsScrollContext'
import { AccountsTab } from './tabs/AccountsTab'
import { AiTab } from './tabs/AiTab'
import { ConnectorsTab } from './tabs/ConnectorsTab'
import { GeneralTab } from './tabs/GeneralTab'
import { IntegrationsTab } from './tabs/IntegrationsTab'
import { IslandUpdatesTab } from './tabs/IslandUpdatesTab'
import { LabsTab } from './tabs/LabsTab'
import { MattersTab } from './tabs/MattersTab'
import { NotificationsTab } from './tabs/NotificationsTab'
import { RealtimeStorageTab } from './tabs/RealtimeStorageTab'
import { RemoteAccessTab } from './tabs/RemoteAccessTab'
import { SyncTab } from './tabs/SyncTab'

export function SettingsShell(): React.ReactElement {
  const { t } = useTranslation()
  const search = useSearch({ strict: false }) as { tab?: string }
  const navigate = useNavigate()
  const refresh = useEnvStore((s) => s.refresh)
  // Remote web (HttpApi) is read-only: env.set is notImplemented and every
  // EnvField renders disabled. Surface that ONCE here as a page-level note,
  // instead of repeating it on each of the ~72 fields (which would also
  // clobber each field's own helper). Mirror EnvField.tsx's VITE_BUILD_TARGET
  // probe.
  const isWeb =
    (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env?.VITE_BUILD_TARGET ===
    'web'
  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const tab: SettingsTab =
    typeof search.tab === 'string' && (SETTINGS_TABS as readonly string[]).includes(search.tab)
      ? (search.tab as SettingsTab)
      : 'general'
  const isConnectorsTab = tab === 'connectors'

  // 主标签第二段 = 当前分节（design §三）。label key 走 settingsTabMeta 的同一份约定，
  // 与二级栏的设置分节行、<lg 的水平 tab 条三处同名。
  useMainBreadcrumb('settings', t(settingsTabLabelKey(tab), { defaultValue: tab }))

  // 切 tab 时当前激活 panel 淡入. Radix TabsContent 仅 mount/unmount 无过渡 (硬替换),
  // 这里给 panel 容器做 autoAlpha 0→1 + y:4→0 (DUR.base). reduced-motion 短路.
  const panelScopeRef = React.useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  // 08-01 PR4 — 内容区 `<section>` 是本页**唯一**滚动容器；AiTab 的右侧锚点导航要拿它
  // 做 active 追踪的 root，经 context 递下去（Radix TabsContent 挡着，prop 传不下去）。
  const contentRef = React.useRef<HTMLElement>(null)
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
      // 0825 轮 3 — 节导航 ≥lg 住进域面板（DomainPanel 设置分支），SettingsRail 只剩
      // <lg 的顶部水平 tab 条兜底（<lg 域面板被强制收起，没有它 tab 就够不着了），
      // 所以 orientation 恒 horizontal、根恒 flex-col（rail 上 / content 下；≥lg
      // rail 隐藏，方向无感）。老 SETTINGS-04 的 vertical rail 形态整体退役。
      orientation="horizontal"
      // Sprint 18 review — SettingsLayout passes `mainClassName="flex"`
      // 让 <main> 变成 row flex 容器, 这里 Tabs root 直接 stretch 填高度.
      // `min-w-0` 让长 content 行 (env path / tag-list) 在 flex 子项中
      // 正确 shrink, 不会强行撑爆父级宽度.
      className="flex flex-col flex-1 min-h-0 min-w-0"
    >
      <SettingsRail />
      {/* Sprint 18 review (round 5) — 单滚动条 + sticky banner (EmailDetail
          §line 526-554 同款方案): section 自己是唯一 scroll container,
          RestartBanner 作 sticky top-0 z-10 直接子, 滚动正文时 banner 保
          冻结. content 容器只负责 max-w + padding, 不创建二级 scroll. */}
      <section
        ref={contentRef}
        aria-label="settings content"
        className={`glass-3 flex-1 min-w-0 min-h-0 ${
          isConnectorsTab ? 'flex flex-col overflow-hidden' : 'overflow-y-auto scrollbar-thin'
        }`}
      >
        <RestartBanner />
        {isWeb ? (
          <div
            role="note"
            className="mx-auto w-full max-w-full md:max-w-[760px] px-4 sm:px-6 md:px-10 pt-6 md:pt-4"
          >
            <div className="flex items-center gap-2 rounded-md border border-ink-border-soft bg-ink-3/40 px-3 py-2 text-aux text-ink-fg-2">
              <Info className="size-4 shrink-0 text-ink-fg-3" aria-hidden="true" />
              <span>{t('settings.env.remoteReadonly')}</span>
            </div>
          </div>
        ) : null}
        <SettingsScrollContext.Provider value={contentRef}>
          <div
            ref={panelScopeRef}
            className={
              isConnectorsTab
                ? 'min-h-0 flex-1'
                : 'mx-auto w-full max-w-full md:max-w-[760px] px-4 sm:px-6 md:px-10 pt-6 md:pt-8 pb-24'
            }
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
            <TabsContent value="connectors" className="h-full min-h-0">
              <ConnectorsTab />
            </TabsContent>
            <TabsContent value="matters">
              <MattersTab />
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
            <TabsContent value="labs">
              <LabsTab />
            </TabsContent>
          </div>
        </SettingsScrollContext.Provider>
      </section>
    </Tabs>
  )
}
