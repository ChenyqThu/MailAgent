// Sprint 6 — /settings route shell.
// Sprint 18 §PR C — old single-scroll SettingsPage replaced by SettingsShell
// (Radix vertical Tabs + 180px rail + 760 content pane). Same PageFrame
// chrome around it, so TitleBar / app Sidebar / StatusBar stay shared.

import { PageFrame } from './PageFrame'
import { SettingsShell } from '../settings/SettingsShell'

export function SettingsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="settings">
      <SettingsShell />
    </PageFrame>
  )
}
