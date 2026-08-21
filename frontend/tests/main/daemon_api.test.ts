// D1 — daemon_api: 本机 serve-api 写客户端 (baseUrl 解析 + 本地 token header 注入)。
//
// mock http_client.request + local_token, 验证 daemonRequest 把请求打到
// http://127.0.0.1:<port>/api 且带 X-MailAgent-Local-Token header, 并返回
// request 的 resolve 值 (envelope.data 原样, 不再二次处理)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockRequest, mockRequestWithMeta } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockRequestWithMeta: vi.fn()
}))

vi.mock('@shared/api/http_client', () => ({
  request: mockRequest,
  requestWithMeta: mockRequestWithMeta
}))

vi.mock('../../src/electron/main/local_token', () => ({
  getLocalApiToken: () => 'test-token-abc',
  LOCAL_TOKEN_HEADER: 'X-MailAgent-Local-Token'
}))

import { daemonRead, daemonRequest, daemonRequestWithMeta } from '../../src/electron/main/daemon_api'

beforeEach(() => {
  mockRequest.mockReset()
  mockRequest.mockResolvedValue({ ok: 'stub' })
  mockRequestWithMeta.mockReset()
  mockRequestWithMeta.mockResolvedValue({ data: { ok: 'stub' }, meta: {} })
  delete process.env.MAILAGENT_API_PORT
})

afterEach(() => {
  delete process.env.MAILAGENT_API_PORT
  vi.restoreAllMocks()
})

describe('daemonRequest — baseUrl + 本地 token header', () => {
  test('默认端口 8200 + 注入 X-MailAgent-Local-Token header', async () => {
    await daemonRequest('POST', '/email/1/flag', { body: { isRead: true } })
    expect(mockRequest).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api',
      'POST',
      '/email/1/flag',
      expect.objectContaining({
        body: { isRead: true },
        headers: { 'X-MailAgent-Local-Token': 'test-token-abc' }
      })
    )
  })

  test('MAILAGENT_API_PORT 覆盖端口', async () => {
    process.env.MAILAGENT_API_PORT = '9300'
    await daemonRequest('GET', '/email/list')
    expect(mockRequest).toHaveBeenCalledWith(
      'http://127.0.0.1:9300/api',
      'GET',
      '/email/list',
      expect.objectContaining({ headers: { 'X-MailAgent-Local-Token': 'test-token-abc' } })
    )
  })

  test('非法端口 fallback 8200', async () => {
    process.env.MAILAGENT_API_PORT = 'not-a-number'
    await daemonRequest('GET', '/x')
    expect(mockRequest).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api',
      'GET',
      '/x',
      expect.anything()
    )
  })

  test('caller opts.headers 与 token 合并', async () => {
    await daemonRequest('GET', '/x', { headers: { 'X-Other': 'v' } })
    expect(mockRequest).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api',
      'GET',
      '/x',
      expect.objectContaining({
        headers: { 'X-MailAgent-Local-Token': 'test-token-abc', 'X-Other': 'v' }
      })
    )
  })

  test('返回 request 的 resolve 值 (envelope.data 原样)', async () => {
    mockRequest.mockResolvedValueOnce({ internal_id: 1, is_pinned: true })
    const out = await daemonRequest('POST', '/email/1/pin', { body: { pinned: true } })
    expect(out).toEqual({ internal_id: 1, is_pinned: true })
  })

  test('request reject (ApiError) 透传给 caller', async () => {
    const apiErr = Object.assign(new Error('not found'), { code: 'E_NOT_FOUND' })
    mockRequest.mockRejectedValueOnce(apiErr)
    await expect(daemonRequest('POST', '/email/9/pin', { body: { pinned: true } })).rejects.toBe(
      apiErr
    )
  })
})

// task 07-21 — daemonRequestWithMeta：与 daemonRequest 同款 baseUrl/token 注入，
// 但透传 requestWithMeta 的 {data, meta}（不丢 total），供 report:listRuns IPC 用。
describe('daemonRequestWithMeta — baseUrl + 本地 token header + meta 透传', () => {
  test('注入本地 token header，返回 {data, meta} 原样', async () => {
    mockRequestWithMeta.mockResolvedValueOnce({
      data: [{ jobId: 1 }],
      meta: { total: 3, limit: 20, offset: 0 }
    })
    const out = await daemonRequestWithMeta('GET', '/agent-runs', { query: { limit: 20 } })
    expect(mockRequestWithMeta).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api',
      'GET',
      '/agent-runs',
      expect.objectContaining({
        query: { limit: 20 },
        headers: { 'X-MailAgent-Local-Token': 'test-token-abc' }
      })
    )
    expect(out).toEqual({ data: [{ jobId: 1 }], meta: { total: 3, limit: 20, offset: 0 } })
  })

  test('request reject (ApiError) 透传给 caller', async () => {
    const apiErr = Object.assign(new Error('flag off'), { code: 'E_NOT_FOUND' })
    mockRequestWithMeta.mockRejectedValueOnce(apiErr)
    await expect(daemonRequestWithMeta('GET', '/agent-runs')).rejects.toBe(apiErr)
  })
})

// task 08-20-perf-dashboards — daemonRead：仪表盘五个读 IPC 的传输端。
// 唯一新增的失败模式是「serve-api 正在重启」，故传输层失败重试恰一次；业务错误
// 不重试（重一次结果一样，只把看板的错误态往后拖）。
describe('daemonRead — GET + 传输层失败重试恰一次', () => {
  test('成功路径：一次 GET，返回 data 原样', async () => {
    mockRequest.mockResolvedValueOnce({ healthy: true })
    const out = await daemonRead('/admin/health')
    expect(mockRequest).toHaveBeenCalledTimes(1)
    expect(mockRequest).toHaveBeenCalledWith(
      'http://127.0.0.1:8200/api',
      'GET',
      '/admin/health',
      expect.objectContaining({ headers: { 'X-MailAgent-Local-Token': 'test-token-abc' } })
    )
    expect(out).toEqual({ healthy: true })
  })

  test('E_NETWORK → 重试一次；第二次成功就当没发生过', async () => {
    mockRequest.mockRejectedValueOnce(
      Object.assign(new Error('ECONNREFUSED'), { code: 'E_NETWORK' })
    )
    mockRequest.mockResolvedValueOnce({ total: 1 })
    const out = await daemonRead('/admin/stats')
    expect(mockRequest).toHaveBeenCalledTimes(2)
    expect(out).toEqual({ total: 1 })
  })

  test('E_NETWORK 连着两次 → 抛出，不再试第三次（不引 CLI fallback）', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'E_NETWORK' })
    mockRequest.mockRejectedValue(err)
    await expect(daemonRead('/admin/stats')).rejects.toBe(err)
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  test('业务错误 (E_INVALID_ARG) 不重试', async () => {
    const err = Object.assign(new Error('days 0 invalid'), { code: 'E_INVALID_ARG' })
    mockRequest.mockRejectedValueOnce(err)
    await expect(daemonRead('/llm/stats', { query: { days: '0' } })).rejects.toBe(err)
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })
})
