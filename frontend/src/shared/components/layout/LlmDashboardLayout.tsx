// Sprint 6 — /llm route shell.

import { useTranslation } from 'react-i18next'

import { navEntry, navLabel } from '@shared/navigation/registry'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'

import { PageFrame } from './PageFrame'
import { LlmDashboardPage } from '../llm/LlmDashboardPage'

export function LlmDashboardLayout(): React.ReactElement {
  const { t } = useTranslation()
  // 运维域的第二块看板（另一块在 AdminLayout）；面包屑第二段同样取 registry 的 entry label。
  useMainBreadcrumb('ops', navLabel(navEntry('llm'), t))

  return (
    <PageFrame ariaLabel="llm-dashboard">
      <LlmDashboardPage />
    </PageFrame>
  )
}
