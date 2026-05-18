// Sprint 6 — /admin route shell.

import { PageFrame } from './PageFrame'
import { AdminPage } from '../admin/AdminPage'

export function AdminLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="admin">
      <AdminPage />
    </PageFrame>
  )
}
