// Sprint 6 — /settings route shell.

import { PageFrame } from './PageFrame'
import { SettingsPage } from '../settings/SettingsPage'

export function SettingsLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="settings">
      <SettingsPage />
    </PageFrame>
  )
}
