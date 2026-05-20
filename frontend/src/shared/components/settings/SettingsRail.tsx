// Sprint 18 §PR C — 180px Settings 节 nav.
//
// Renders the Radix Tabs.List (vertical) — 8 个 Tab trigger 顺序对齐 plan.
// 每个 trigger 一 lucide-react icon + 中文 label (走 i18n; key 在 PR G 加).
// "SETTINGS" micro 标题在顶部,版本 / About link 在底部 (footer 借自老
// SettingsPage AboutSection — 这里用静态版本号 + GitHub link).
//
// 几何变量:
//   width            = var(--settings-rail-w, 180px)
//   nav-row 样式来自 ui/tabs.tsx orientation=vertical (Sprint 18 PR A 内置
//     active 态 .ink-3/85 bg + coral 2px 左 indicator).

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Bot, ExternalLink, Palette, Plug, Radio, RefreshCw, User, Wifi } from 'lucide-react'

import { TabsList, TabsTrigger } from '@shared/components/ui/tabs'
import { useUpdaterStore } from '@shared/state/updater'

interface TabEntry {
  value: string
  Icon: React.ComponentType<{ className?: string }>
  labelKey: string
}

const TAB_ORDER: TabEntry[] = [
  { value: 'general', Icon: Palette, labelKey: 'settings.tabs.general' },
  { value: 'accounts', Icon: User, labelKey: 'settings.tabs.accounts' },
  { value: 'sync', Icon: RefreshCw, labelKey: 'settings.tabs.sync' },
  { value: 'ai', Icon: Bot, labelKey: 'settings.tabs.ai' },
  { value: 'notifications', Icon: Bell, labelKey: 'settings.tabs.notifications' },
  { value: 'integrations', Icon: Plug, labelKey: 'settings.tabs.integrations' },
  { value: 'realtime', Icon: Wifi, labelKey: 'settings.tabs.realtime' },
  { value: 'island', Icon: Radio, labelKey: 'settings.tabs.island' }
]

export function SettingsRail(): React.ReactElement {
  const { t } = useTranslation()
  const version = useUpdaterStore((s) => s.status.currentVersion)

  return (
    <aside
      className="glass-2 border-r border-ink-border-soft shrink-0 flex flex-col"
      style={{ width: 'var(--settings-rail-w, 180px)' }}
    >
      <div className="px-3 pt-3 pb-1.5">
        <div className="text-micro font-mono uppercase tracking-wider text-ink-fg-2 px-2.5 mb-1.5">
          {t('settings.title', { defaultValue: 'SETTINGS' })}
        </div>
        <TabsList className="flex-col items-stretch gap-0.5 bg-transparent p-0">
          {TAB_ORDER.map(({ value, Icon, labelKey }) => (
            <TabsTrigger key={value} value={value} className="w-full">
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{t(labelKey, { defaultValue: value })}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="mt-auto px-3 py-3 border-t border-ink-border-soft">
        <div className="text-meta font-mono text-ink-fg-2 mb-1.5">
          MailAgent <span className="text-ink-fg-3">v{version}</span>
        </div>
        <a
          href="https://github.com/chenyqthu/MailAgent"
          target="_blank"
          rel="noopener noreferrer"
          className="text-meta text-coral hover:underline inline-flex items-center gap-1"
        >
          GitHub
          <ExternalLink className="size-3" />
        </a>
      </div>
    </aside>
  )
}
