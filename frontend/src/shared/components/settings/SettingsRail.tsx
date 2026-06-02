// Sprint 18 §PR C — 180px Settings 节 nav.
// Sprint 18 review — 视觉跟 mockup-settings.html 的 settings rail 完整对齐:
//   - 顶部 SETTINGS eyebrow:   `text-micro font-mono uppercase
//     tracking-wider text-ink-fg-2 px-2.5 mb-1.5` (mockup line 580)
//   - 底部 footer:             `mt-auto px-3 py-3 border-t
//     border-ink-border-soft text-micro font-mono text-ink-fg-2`,
//     内容用 key/value flex justify-between 表格风格 (mockup line 614-617)
//   - active 态由 tabs.tsx 的 vertical variant 接管, 这里只管几何.
//
// 几何变量:
//   width = var(--settings-rail-w, 180px)

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bell,
  Bot,
  Globe,
  Palette,
  Plug,
  Radio,
  RefreshCw,
  User,
  Wifi,
  type LucideIcon
} from 'lucide-react'

import { TabsList, TabsTrigger } from '@shared/components/ui/tabs'
import { useUpdaterStore } from '@shared/state/updater'

interface TabEntry {
  value: string
  Icon: LucideIcon
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
  { value: 'remote', Icon: Globe, labelKey: 'settings.tabs.remote' },
  { value: 'island', Icon: Radio, labelKey: 'settings.tabs.island' }
]

export function SettingsRail(): React.ReactElement {
  const { t } = useTranslation()
  const version = useUpdaterStore((s) => s.status.currentVersion)

  return (
    <aside
      aria-label="settings sections"
      // mockup: `w-[180px] glass-2 border-r border-ink-border/60 shrink-0
      // flex flex-col`. `h-full min-h-0` 保证 flex-col 链拉满高度,
      // footer mt-auto 才贴底.
      // SETTINGS-04 响应式: <md 转顶部水平 tab 条 (flex-row + 全宽 + border-b +
      // 高度自适应, 横向滚动); >=md 恢复 200px 纵向 rail。
      className="glass-2 shrink-0 flex flex-row md:flex-col h-auto md:h-full min-h-0 w-full md:w-[200px] border-b md:border-b-0 md:border-r border-ink-border/60"
    >
      {/* nav — mockup `<div class="px-3 pt-3 pb-1.5">` 包 eyebrow + nav
          rows. flex-1 + overflow-y-auto 让 8 个 tab 在窄高视窗下能滚,
          rail 自身高度不超 viewport. */}
      <div className="flex-1 min-h-0 overflow-x-auto md:overflow-y-auto scrollbar-thin px-3 pt-3 pb-1.5">
        <div className="hidden md:block text-micro font-mono uppercase tracking-wider text-ink-fg-2 px-2.5 mb-1.5">
          {t('settings.title', { defaultValue: 'SETTINGS' })}
        </div>
        {/* w-full 让 TabsList 撑满 rail 宽度 (基础类 `inline-flex` 默认只裹
            到最长 tab 文字, 选中/hover bg 因此窄于 rail). review round 10 —
            修复 rail +20px 后 active bg 仍贴左半边的视觉. */}
        <TabsList className="flex flex-row md:flex-col items-stretch gap-px bg-transparent p-0 w-full">
          {TAB_ORDER.map(({ value, Icon, labelKey }) => (
            <TabsTrigger key={value} value={value} className="shrink-0 md:w-full">
              <Icon className="size-3.5 shrink-0" strokeWidth={2} />
              <span className="truncate">{t(labelKey, { defaultValue: value })}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {/* footer — mockup-settings.html line 614-617 字面对齐:
          `text-micro font-mono text-ink-fg-2` 容器, 两行 key/value
          `flex justify-between`. 不加任何 inline style 也不加 important
          修饰符 — review round 7: 用户确认应保留 mockup text-micro 标准. */}
      <div className="hidden md:block shrink-0 mt-auto px-3 py-3 border-t border-ink-border-soft text-micro font-mono text-ink-fg-2">
        <div className="flex items-center justify-between">
          <span>version</span>
          <span>v{version}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>repo</span>
          <a
            href="https://github.com/chenyqthu/MailAgent"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-coral transition-colors duration-fast"
          >
            GitHub
          </a>
        </div>
      </div>
    </aside>
  )
}
