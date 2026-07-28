// @vitest-environment happy-dom
//
// issue #67 item 7 — the LOGIN-failure line must show the count AGAINST its threshold.
//
// The watchdog propagates the threshold it actually applied via sync_state
// `davmail.login_fail_threshold` (F5) precisely so the UI can't drift from the alerting rule,
// and `handlers/admin.ts` puts it on the IPC payload. The SHARED DavMailHealthData type dropped
// it, so the card could only ever print "×2" — the user had no way to tell whether that was one
// away from critical or five.
//
// 🔴 The threshold is DESKTOP-ONLY on the wire: the web producer
// (src/api/routers/admin.py::_build_davmail_health) computes `_login_fail_threshold(state)` for
// its own level decision but does NOT emit it. So the absent case must render the bare count —
// substituting a default 3 would print a confidently wrong number whenever the owner has
// configured DAVMAIL_LOGIN_FAIL_THRESHOLD to something else.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { DavMailHealthData } from '../../src/shared/api/types'

const davmailHealthFn = vi.fn()

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ admin: { davmailHealth: davmailHealthFn } })
}))

import { DavMailHealthCard } from '../../src/shared/components/admin/DavMailHealthCard'

function health(overrides: Partial<DavMailHealthData> = {}): DavMailHealthData {
  return {
    enabled: true,
    level: 'critical',
    last_probe_at: new Date().toISOString(),
    imap_reachable: true,
    smtp_reachable: true,
    consecutive_imap_failures: 0,
    consecutive_smtp_failures: 0,
    imap_login_ok: false,
    consecutive_login_failures: 2,
    token_age_days: 10,
    token_mtime_iso: null,
    throttle_events_5min: 0,
    last_oauth_error: null,
    last_oauth_error_at: null,
    uid_backfill_paused: false,
    ...overrides
  }
}

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(DavMailHealthCard)))
}

afterEach(() => {
  cleanup()
  davmailHealthFn.mockReset()
})

describe('DavMailHealthCard — LOGIN failure count vs threshold', () => {
  test('threshold present (desktop) → renders count/threshold', async () => {
    davmailHealthFn.mockResolvedValue(
      health({ consecutive_login_failures: 2, login_fail_threshold: 3 })
    )
    renderCard()
    await waitFor(() => expect(screen.getByText(/LOGIN 失败/)).toBeTruthy())
    expect(screen.getByText(/×2\/3/)).toBeTruthy()
  })

  test('non-default threshold is shown verbatim, never assumed to be 3', async () => {
    davmailHealthFn.mockResolvedValue(
      health({ consecutive_login_failures: 4, login_fail_threshold: 5 })
    )
    renderCard()
    await waitFor(() => expect(screen.getByText(/×4\/5/)).toBeTruthy())
  })

  test('threshold absent (web半 / older backend) → bare count, no invented denominator', async () => {
    davmailHealthFn.mockResolvedValue(health({ consecutive_login_failures: 2 }))
    renderCard()
    await waitFor(() => expect(screen.getByText(/LOGIN 失败/)).toBeTruthy())
    expect(screen.queryByText(/×2\/3/)).toBeNull()
    expect(screen.getByText(/×2/)).toBeTruthy()
  })

  test('zero failures → no count at all (unchanged)', async () => {
    davmailHealthFn.mockResolvedValue(
      health({ consecutive_login_failures: 0, login_fail_threshold: 3 })
    )
    renderCard()
    await waitFor(() => expect(screen.getByText(/LOGIN 失败/)).toBeTruthy())
    expect(screen.queryByText(/×0/)).toBeNull()
  })
})
