// @vitest-environment happy-dom
//
// issue #67 item 5 — the admin health "notes" must actually reach the screen.
//
// BOTH producers have emitted them all along:
//   - CLI  `mailagent admin health` → src/cli/commands/admin.py::_compose_health_notes
//   - web  GET /api/admin/health    → src/api/routers/admin.py::_compose_dynamic_health_notes
// and admin-health.schema.json declares `notes`. But the hand-written AdminHealthData dropped the
// field, so E4's crashloop / token-aging diagnostics were recomputed on every poll and discarded
// — the one place that tells an operator "this worker is stopped until you restart the service".
//
// Also pinned here: `db_path` is optional now (the web half redacts it by design, C9), so its
// absence must not print "undefined" into the db-accessible card's hint.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { AdminHealthData } from '../../src/shared/api/types'

const healthFn = vi.fn()
const statsFn = vi.fn()
const deadLetterListFn = vi.fn()

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: {
      health: healthFn,
      stats: statsFn,
      deadLetterList: deadLetterListFn,
      deadLetterRetry: vi.fn(),
      deadLetterDelete: vi.fn(),
      davmailHealth: vi.fn().mockResolvedValue({ enabled: false })
    }
  })
}))

import i18n from '@shared/i18n'
import { AdminPage } from '../../src/shared/components/admin/AdminPage'

await i18n.changeLanguage('zh-CN')

function health(overrides: Partial<AdminHealthData> = {}): AdminHealthData {
  return {
    db_path: '/Users/someone/Library/Application Support/mailagent-frontend/data/sync_store.db',
    db_accessible: true,
    db_version: 41,
    db_version_expected: 41,
    schema_ok: true,
    tables_present: ['email_metadata'],
    tables_missing: [],
    healthy: true,
    ...overrides
  }
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(AdminPage)))
}

afterEach(() => {
  cleanup()
  healthFn.mockReset()
  statsFn.mockReset()
  deadLetterListFn.mockReset()
})

describe('AdminPage — E4 health notes', () => {
  test('notes present → each diagnostic line is rendered', async () => {
    healthFn.mockResolvedValue(
      health({
        notes: [
          "worker 'fanout' 已 crash-loop 停摆 (supervise 停止重启), 该功能不可用直到服务重启 — last_error: boom",
          'DavMail OAuth token 已 87.0 天未刷新 (≥80d)；refresh_token 90 天有效期，接近时需重走 OAuth flow。'
        ]
      })
    )
    statsFn.mockResolvedValue({})
    deadLetterListFn.mockResolvedValue([])
    renderPage()

    await waitFor(() => expect(screen.getByText(/crash-loop 停摆/)).toBeTruthy())
    expect(screen.getByText(/token 已 87.0 天未刷新/)).toBeTruthy()
  })

  test('notes absent / empty → no diagnostics block (healthy install stays quiet)', async () => {
    healthFn.mockResolvedValue(health({ notes: [] }))
    statsFn.mockResolvedValue({})
    deadLetterListFn.mockResolvedValue([])
    renderPage()

    await waitFor(() => expect(screen.getByText('v41')).toBeTruthy())
    expect(screen.queryByText(i18n.t('admin.healthNotes'))).toBeNull()
  })

  test('web half omits db_path (C9 redaction) → hint is empty, never the string "undefined"', async () => {
    healthFn.mockResolvedValue({ ...health(), db_path: undefined })
    statsFn.mockResolvedValue({})
    deadLetterListFn.mockResolvedValue([])
    renderPage()

    await waitFor(() => expect(screen.getByText('v41')).toBeTruthy())
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  test('db_version null (unreadable DB) renders a dash, not "vnull"', async () => {
    // admin-health.schema.json types db_version as `integer | null`; the old hand-written type
    // pinned it non-null, so an unreadable DB rendered the literal "vnull".
    healthFn.mockResolvedValue(health({ db_version: null, db_accessible: false, healthy: false }))
    statsFn.mockResolvedValue({})
    deadLetterListFn.mockResolvedValue([])
    renderPage()

    // Anchor on a value that only exists once the health strip has rendered — asserting a
    // queryByText(...)===null straight away would pass against the loading skeleton.
    await waitFor(() => expect(screen.getByText('expected v41')).toBeTruthy())
    expect(screen.queryByText('vnull')).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
  })
})
