import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMattersApi } from '@shared/api/matters'

const envelope = (data: unknown): Response => new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Matters P4 API client', () => {
  test('uses authenticated run and update routes with mutation envelopes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/runs/7')) return envelope({ run: { id: 7 } })
      if (url.endsWith('/updates/9')) return envelope({ update: { id: 9 } })
      if (url.endsWith('/runs')) return envelope({ items: [], next_cursor: null })
      if (url.includes('/updates?')) return envelope({ items: [], next_cursor: null })
      return envelope({ run: { id: 7 }, coalesced: false })
    })
    vi.stubGlobal('fetch', fetchMock)
    const api = createMattersApi('https://mail.example/api')

    await api.listRuns('MAT-1')
    await api.getRun('MAT-1', 7)
    await api.startRun('MAT-1', { expectedVersion: 3 })
    await api.cancelRun('MAT-1', 7)
    await api.listUpdates('MAT-1', 'pending')
    await api.getUpdate('MAT-1', 9)
    await api.acceptUpdate('MAT-1', 9, { selected_change_ids: ['c1'] }, { expectedVersion: 3 })
    await api.rejectUpdate('MAT-1', 9, 'No', { expectedVersion: 3 })

    expect(fetchMock).toHaveBeenCalledTimes(8)
    for (const call of fetchMock.mock.calls) expect(call[1]).toMatchObject({ credentials: 'include' })
    const startBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(startBody.mutation).toMatchObject({ source: 'desktop_ui', expected_version: 3 })
    expect(typeof startBody.mutation.idempotency_key).toBe('string')
    const acceptBody = JSON.parse(String(fetchMock.mock.calls[6][1]?.body))
    expect(acceptBody).toMatchObject({ selected_change_ids: ['c1'] })
  })
})
