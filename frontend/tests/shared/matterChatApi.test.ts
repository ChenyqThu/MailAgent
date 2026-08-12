// @vitest-environment happy-dom
//
// Matters MVP P3 (lane ③) — the Matter Chat serve-api face:
//   · resolveMatterUndoRequest: the undo descriptor → REST mapping (pure, one case per tool).
//   · applyUndo: the wire shape a receipt's 撤销 actually sends (fresh idempotency key, the
//     descriptor's expected_version + reverses_event_id, source/reason).
//   （recordChatScope / G5 审计已随 0812 检索范围开关的移除一并删除 —— 见下面那条"只剩两个方法"。）

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  createMatterChatApi,
  resolveMatterUndoRequest,
  type MatterUndoDescriptor
} from '@shared/api/matters'

function descriptor(tool: string, input: Record<string, unknown>): MatterUndoDescriptor {
  return { tool, input: { public_id: 'MAT-0042', ...input }, label: '撤销事项更新' }
}

describe('resolveMatterUndoRequest — tool/operation → REST', () => {
  test('matter_update patch → PATCH /matters/{id} with the reverse patch as the body', () => {
    const resolved = resolveMatterUndoRequest(
      descriptor('matter_update', {
        operation: 'patch',
        patch: { status: 'active' },
        expected_version: 7,
        reverses_event_id: 91
      })
    )
    expect(resolved).toEqual({
      method: 'PATCH',
      path: '/matters/MAT-0042',
      fields: { status: 'active' },
      expectedVersion: 7,
      reversesEventId: 91
    })
  })

  test('matter_update trash (the undo of a create) → POST /matters/{id}/trash', () => {
    const resolved = resolveMatterUndoRequest(
      descriptor('matter_update', { operation: 'trash', expected_version: 2, reverses_event_id: 3 })
    )
    expect(resolved?.method).toBe('POST')
    expect(resolved?.path).toBe('/matters/MAT-0042/trash')
    expect(resolved?.fields).toEqual({})
  })

  test('matter_item_mutate delete/update/restore/create map onto the item routes', () => {
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_item_mutate', { operation: 'delete', item_id: 12 })
      )
    ).toMatchObject({ method: 'DELETE', path: '/matters/MAT-0042/items/12' })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_item_mutate', {
          operation: 'update',
          item_id: 12,
          patch: { title: 'before' }
        })
      )
    ).toMatchObject({
      method: 'PATCH',
      path: '/matters/MAT-0042/items/12',
      fields: { title: 'before' }
    })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_item_mutate', { operation: 'restore', item_id: 12 })
      )
    ).toMatchObject({ method: 'POST', path: '/matters/MAT-0042/items/12/restore' })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_item_mutate', {
          operation: 'create',
          item: { kind: 'note', title: 'x' }
        })
      )
    ).toMatchObject({
      method: 'POST',
      path: '/matters/MAT-0042/items',
      fields: { kind: 'note', title: 'x' }
    })
  })

  test('resource unlink/restore/update + stakeholder + relation all resolve', () => {
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_resource_mutate', { operation: 'unlink', resource_id: 5 })
      )
    ).toMatchObject({ method: 'DELETE', path: '/matters/MAT-0042/resources/5' })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_resource_mutate', {
          operation: 'update',
          resource_id: 5,
          patch: { scope: 'resource', access_policy: 'metadata_only' }
        })
      )
    ).toMatchObject({
      method: 'PATCH',
      path: '/matters/MAT-0042/resources/5',
      fields: { scope: 'resource', access_policy: 'metadata_only' }
    })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_stakeholder_mutate', { operation: 'delete', stakeholder_id: 8 })
      )
    ).toMatchObject({ method: 'DELETE', path: '/matters/MAT-0042/stakeholders/8' })
    expect(
      resolveMatterUndoRequest(
        descriptor('matter_relation_mutate', { operation: 'restore', relation_id: 9 })
      )
    ).toMatchObject({ method: 'POST', path: '/matters/MAT-0042/relations/9/restore' })
  })

  test('a descriptor this client cannot execute resolves to null (never a guessed write)', () => {
    // unknown tool
    expect(resolveMatterUndoRequest(descriptor('matter_create', { operation: 'trash' }))).toBeNull()
    // unknown operation
    expect(resolveMatterUndoRequest(descriptor('matter_update', { operation: 'nuke' }))).toBeNull()
    // child operation with no child id
    expect(
      resolveMatterUndoRequest(descriptor('matter_item_mutate', { operation: 'delete' }))
    ).toBeNull()
    // no matter identity
    expect(
      resolveMatterUndoRequest({ tool: 'matter_update', input: { operation: 'trash' }, label: 'x' })
    ).toBeNull()
  })
})

describe('createMatterChatApi — wire shapes', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
      string,
      RequestInit
    ]
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> }
  }

  test('applyUndo sends a fresh idempotency key + the descriptor version/event id', async () => {
    const api = createMatterChatApi('/api')
    await api.applyUndo(
      descriptor('matter_item_mutate', {
        operation: 'restore',
        item_id: 12,
        expected_version: 4,
        reverses_event_id: 77
      }),
      { reason: '撤销' }
    )
    const { url, init, body } = lastCall()
    expect(url).toBe('/api/matters/MAT-0042/items/12/restore')
    expect(init.method).toBe('POST')
    const mutation = body.mutation as Record<string, unknown>
    expect(mutation.source).toBe('desktop_ui')
    expect(mutation.reason).toBe('撤销')
    expect(mutation.expected_version).toBe(4)
    expect(mutation.reverses_event_id).toBe(77)
    expect(String(mutation.idempotency_key).length).toBeGreaterThan(0)
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      mutation.idempotency_key
    )
  })

  test('applyUndo rejects an unmappable descriptor without touching the network', async () => {
    const api = createMatterChatApi('/api')
    await expect(
      api.applyUndo({ tool: 'matter_create', input: { public_id: 'MAT-1' }, label: 'x' })
    ).rejects.toMatchObject({ code: 'E_INVALID_ARG' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 0812 —— recordChatScope（G5 审计）随「本事项 / 全库」检索范围开关一并删除：没有调用方了，
  // 留着就是一个能往时间线写事件的无主写口。服务端 `POST /{id}/chat-scope` 同批删除。
  test('MatterChatApi 只剩两个方法（没有留下 chat-scope 这个无主写口）', () => {
    const api = createMatterChatApi('/api')
    expect(Object.keys(api).sort()).toEqual(['applyUndo', 'contextSnapshot'])
  })

  test('contextSnapshot is a plain GET on the bounded projection', async () => {
    const api = createMatterChatApi('/api')
    await api.contextSnapshot('MAT-0042')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/matters/MAT-0042/context-snapshot')
    expect(init.method).toBe('GET')
  })
})
