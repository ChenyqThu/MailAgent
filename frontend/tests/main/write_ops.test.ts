// D1 — 写操作 IPC handler 收编到本机 daemon (serve-api) 后的契约。
//
// 旧契约 (Sprint 5/15/16) 测 callCli argv 形状 + writeFlagDirect 直写 outbox; D1 起这些
// 写经 daemonRequest 转发本机 serve-api, 故改测:
//   - flagBody 构造 (mirror HttpApi.email.flag wire: 只非 undefined 字段, 无 allowConcurrent)
//   - 各 forwarder 的 method/path/body/query (mirror serve-api 端点, 与 HttpApi 零漂移)
//   - envelope 形状: daemon resolve → {ok:true,data}; ApiError → {ok:false,code,hint}
//   - ensureInternalId guard

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRequest } = vi.hoisted(() => ({ mockDaemonRequest: vi.fn() }))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRequest: mockDaemonRequest
}))

import {
  __testing,
  runArchive,
  runEmailFlag,
  runLlmRun,
  runPin,
  runResync,
  type WriteEnvelope
} from '../../src/electron/main/handlers/write_ops'

beforeEach(() => {
  mockDaemonRequest.mockReset()
  mockDaemonRequest.mockResolvedValue({ ok: 'stub' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('write_ops — flagBody (mirror HttpApi.email.flag wire)', () => {
  test('isRead=true → { isRead: true }', () => {
    expect(__testing.flagBody({ isRead: true })).toEqual({ isRead: true })
  })

  test('isRead=false preserved (not dropped — tri-bool)', () => {
    expect(__testing.flagBody({ isRead: false })).toEqual({ isRead: false })
  })

  test('processingStatus → { processingStatus }', () => {
    expect(__testing.flagBody({ processingStatus: '已完成' })).toEqual({
      processingStatus: '已完成'
    })
  })

  test('combines isRead + isFlagged + processingStatus', () => {
    expect(
      __testing.flagBody({ isRead: true, isFlagged: false, processingStatus: '已完成' })
    ).toEqual({ isRead: true, isFlagged: false, processingStatus: '已完成' })
  })

  test('batch ids included', () => {
    expect(__testing.flagBody({ ids: [1, 2, 3], isRead: true })).toEqual({
      ids: [1, 2, 3],
      isRead: true
    })
  })

  test('empty ids array dropped (no batch)', () => {
    expect(__testing.flagBody({ ids: [], isFlagged: true })).toEqual({ isFlagged: true })
  })

  test('empty processingStatus dropped', () => {
    expect(__testing.flagBody({ processingStatus: '' })).toEqual({})
  })
})

describe('write_ops — daemon forwarders (mock daemonRequest)', () => {
  test('resync → POST /email/{id}/resync, camelCase body', async () => {
    await runResync(53675, { replaceExisting: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/resync', {
      body: { replaceExisting: true, skipParentLookup: undefined, dryRun: undefined }
    })
  })

  test('resync dry-run forwards dryRun: true', async () => {
    await runResync(53675, { dryRun: true, replaceExisting: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/resync', {
      body: { replaceExisting: true, skipParentLookup: undefined, dryRun: true }
    })
  })

  test('pin → POST /email/{id}/pin { pinned }', async () => {
    await runPin(53675, true)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/pin', {
      body: { pinned: true }
    })
  })

  test('unpin → POST /email/{id}/pin { pinned: false }', async () => {
    await runPin(53675, false)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/pin', {
      body: { pinned: false }
    })
  })

  test('archive → POST /email/{id}/archive {}', async () => {
    await runArchive(53675)
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/archive', { body: {} })
  })

  test('llm → POST /llm/run/{id} with QUERY params (not body)', async () => {
    await runLlmRun(53675, { force: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/llm/run/53675', {
      query: { dry_run: undefined, force: true, no_overwrite: undefined }
    })
  })

  test('flag single → POST /email/{id}/flag', async () => {
    await runEmailFlag(53675, { isFlagged: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/53675/flag', {
      body: { isFlagged: true }
    })
  })

  test('flag batch → POST /email/0/flag with body.ids (server ignores path id)', async () => {
    await runEmailFlag(null, { ids: [1, 2, 3], isRead: true })
    expect(mockDaemonRequest).toHaveBeenCalledWith('POST', '/email/0/flag', {
      body: { ids: [1, 2, 3], isRead: true }
    })
    // One request — not three. This is the whole point of --ids batching.
    expect(mockDaemonRequest).toHaveBeenCalledTimes(1)
  })
})

describe('write_ops — envelopeFromCli (daemon ApiError path)', () => {
  test('resolved daemon value → { ok: true, data }', async () => {
    const env = (await __testing.envelopeFromCli<{ x: 1 }>(
      Promise.resolve({ x: 1 })
    )) as WriteEnvelope<{ x: 1 }>
    expect(env.ok).toBe(true)
    if (env.ok) expect(env.data).toEqual({ x: 1 })
  })

  test('ApiError (daemon) → envelope preserves code + hint (renderer branches on code)', async () => {
    const apiErr = Object.assign(new Error('email not found'), {
      code: 'E_NOT_FOUND',
      hint: 'check internal_id'
    })
    const env = await __testing.envelopeFromCli<unknown>(Promise.reject(apiErr))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_NOT_FOUND')
      expect(env.hint).toBe('check internal_id')
    }
  })

  test('unknown rejection (no code) → E_DISPATCH', async () => {
    const env = await __testing.envelopeFromCli<unknown>(Promise.reject(new Error('boom')))
    expect(env.ok).toBe(false)
    if (!env.ok) {
      expect(env.code).toBe('E_DISPATCH')
      expect(env.message).toBe('boom')
    }
  })
})

describe('write_ops — ensureInternalId guard', () => {
  test('rejects non-numbers + negatives', () => {
    const cases: unknown[] = ['x', null, undefined, -1, 1.5, NaN]
    for (const c of cases) {
      const r = __testing.ensureInternalId(c, 'email:resync')
      expect(typeof r === 'object' && r !== null && r.ok === false).toBe(true)
      if (typeof r === 'object' && r !== null && r.ok === false)
        expect(r.code).toBe('E_INVALID_ARG')
    }
  })

  test('accepts valid non-negative integers', () => {
    expect(__testing.ensureInternalId(0, 'email:resync')).toBe(0)
    expect(__testing.ensureInternalId(53675, 'email:resync')).toBe(53675)
  })
})
