// Sprint 6 — /admin route shell.

import { useTranslation } from 'react-i18next'

import { navEntry, navLabel } from '@shared/navigation/registry'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'

import { PageFrame } from './PageFrame'
import { AdminPage } from '../admin/AdminPage'

export function AdminLayout(): React.ReactElement {
  const { t } = useTranslation()
  // 主标签第二段 = 当前看板（design §三）。运维域的两块看板各是一条 registry entry，
  // 面包屑直接用那条 entry 的 label —— 不在这里抄第二份看板名。
  useMainBreadcrumb('ops', navLabel(navEntry('kanban'), t))

  return (
    <PageFrame ariaLabel="admin">
      <AdminPage />
    </PageFrame>
  )
}
