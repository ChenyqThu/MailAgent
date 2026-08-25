import { afterEach, describe, expect, test, vi } from 'vitest'

import { createMattersApi } from '@shared/api/matters'

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

afterEach(() => vi.unstubAllGlobals())

describe('Matters P6 intelligence API client', () => {
  // task 08-25 —— 关键词命中式的 `discoverResourceSuggestions` 已整条退役（端点也没了），
  // 这条用例随之只剩三条路由。资料推荐现在只有 agent 那两条通道，不在本客户端上。
  test('uses the create-draft, duplicate and reject-suggestion routes', async () => {
    const fetchMock = vi.fn(async () => envelope({ ok: true }))
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
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://mail.example/api/matters/create-draft',
      'https://mail.example/api/matters/duplicate-candidates',
      'https://mail.example/api/matters/MAT-1/resources/7/reject-suggestion'
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
  })

  // curated 进展的五个口（task 08-25）。盯的是**路由与信封**：进展的写面与 item 同形
  // （乐观锁 + Idempotency-Key），路径段是单数的 `progress`，写少一段就打到事项本体上。
  test('progress CRUD hits /progress with the mutation envelope', async () => {
    // 形参显式声明 —— 无参的 `vi.fn(async () => …)` 会把 `mock.calls` 推成空元组，
    // 下面每一处 `calls[i][1]` 都成类型错（本文件既有那几条债正是这么来的）。
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      envelope({ items: [] })
    )
    vi.stubGlobal('fetch', fetchMock)
    const api = createMattersApi('https://mail.example/api')

    await api.listProgress('MAT-1', { kind: 'signal', includeDeleted: true, limit: 20 })
    await api.createProgress(
      'MAT-1',
      { kind: 'decision', title: 'Q4 预算已定', body: null },
      { expectedVersion: 4 }
    )
    await api.patchProgress('MAT-1', 9, { title: '改过的主句' }, { expectedVersion: 5 })
    await api.deleteProgress('MAT-1', 9, { expectedVersion: 6 })
    await api.restoreProgress('MAT-1', 9, { expectedVersion: 7 })

    expect(fetchMock.mock.calls.map((call) => `${call[1]?.method} ${String(call[0])}`)).toEqual([
      'GET https://mail.example/api/matters/MAT-1/progress?kind=signal&include_deleted=true&limit=20',
      'POST https://mail.example/api/matters/MAT-1/progress',
      'PATCH https://mail.example/api/matters/MAT-1/progress/9',
      'DELETE https://mail.example/api/matters/MAT-1/progress/9',
      'POST https://mail.example/api/matters/MAT-1/progress/9/restore'
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      kind: 'decision',
      title: 'Q4 预算已定',
      body: null,
      mutation: { expected_version: 4, source: 'desktop_ui' }
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      title: '改过的主句',
      mutation: { expected_version: 5 }
    })
  })
})
