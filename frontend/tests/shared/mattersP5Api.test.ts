import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMattersApi } from '@shared/api/matters'

const envelope = (data: unknown): Response => new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), { status: 200, headers: { 'content-type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('Matters P5 API client', () => {
  test('uses frozen attention actions and notify-level routes', async () => {
    const fetchMock = vi.fn(async () => envelope({ items: [], level: 'high', id: 7, kind: 'run_failed', state: 'resolved' }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createMattersApi('https://mail.example/api')

    await api.listAttention('open', 'run_failed')
    await api.listMatterAttention('MAT-1', 'open')
    await api.resolveAttention('MAT-1', 7)
    await api.snoozeAttention('MAT-1', 7, { preset: '3d' })
    await api.dismissAttention('MAT-1', 7)
    await api.getNotifyLevel()
    await api.setNotifyLevel('all')

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain('/matters/attention?state=open&kind=run_failed')
    expect(urls[1]).toContain('/matters/MAT-1/attention?state=open')
    expect(urls.slice(2, 5)).toEqual([
      'https://mail.example/api/matters/MAT-1/attention/7/resolve',
      'https://mail.example/api/matters/MAT-1/attention/7/snooze',
      'https://mail.example/api/matters/MAT-1/attention/7/dismiss'
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).mutation.expected_version).toBeNull()
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({ preset: '3d' })
    expect(JSON.parse(String(fetchMock.mock.calls[6][1]?.body))).toEqual({ level: 'all' })
  })
})
