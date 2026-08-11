import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMattersApi } from '@shared/api/matters'

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

afterEach(() => vi.unstubAllGlobals())

describe('Matters P6 intelligence API client', () => {
  test('uses the create-draft, duplicate, reject-suggestion, and discovery routes', async () => {
    const fetchMock = vi.fn(async () => envelope({ items: [], suppressed: [], local_candidate_count: 0, expanded: true }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createMattersApi('https://mail.example/api')

    await api.createDraft({
      internal_id: 42,
      thread_id: 'thread-abc',
      link_scope: 'thread',
      title: 'Vendor launch'
    })
    await api.duplicateCandidates({
      title: 'Vendor launch',
      resources: [{ provider: 'mailagent', kind: 'thread', external_key: 'thread:abc' }]
    })
    await api.rejectResourceSuggestion('MAT-1', 7, {
      expectedVersion: 4,
      reason: 'user_marked_resource_suggestion_irrelevant'
    })
    await api.discoverResourceSuggestions('MAT-1', {
      query: 'Vendor launch',
      expandReason: 'context_gap',
      limit: 10
    })

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://mail.example/api/matters/create-draft',
      'https://mail.example/api/matters/duplicate-candidates',
      'https://mail.example/api/matters/MAT-1/resources/7/reject-suggestion',
      'https://mail.example/api/matters/MAT-1/resource-suggestions/discover'
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      internal_id: 42,
      thread_id: 'thread-abc',
      link_scope: 'thread',
      title: 'Vendor launch'
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      title: 'Vendor launch',
      resources: [{ provider: 'mailagent', kind: 'thread', external_key: 'thread:abc' }]
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      mutation: { expected_version: 4, reason: 'user_marked_resource_suggestion_irrelevant' }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      query: 'Vendor launch',
      expand_reason: 'context_gap',
      limit: 10
    })
  })
})
