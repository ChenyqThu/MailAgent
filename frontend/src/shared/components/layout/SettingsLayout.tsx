// Sprint 6 — /settings route shell.
// Sprint 18 §PR C — old single-scroll SettingsPage replaced by SettingsShell
// (Radix vertical Tabs + 180px rail + 760 content pane). Same PageFrame
// chrome around it, so TitleBar / app Sidebar / StatusBar stay shared.
// Sprint 18 review — pass `mainClassName` 让 <main> 不再 overflow-y-auto,
// 由 SettingsShell 内部决定哪一列滚动 (rail 不滚, content 列单独滚).

import { PageFrame } from './PageFrame'
import { SettingsShell } from '../settings/SettingsShell'

export function SettingsLayout(): React.ReactElement {
  return (
    <PageFrame
      ariaLabel="settings"
      mainClassName="flex flex-1 min-w-0 min-h-0 overflow-hidden"
    >
      <SettingsShell />
    </PageFrame>
  )
}
