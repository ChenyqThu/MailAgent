// 发版终审 HIGH-1 — backfillLegacyDefaultProviderKey 单元测试。
//
// keytar-only 旧 LLM key（未 dual-write 到 .env）在 Python seed（只读 env）后进不了
// default provider 行 → flag on 五入口 503。lifecycle flag-on 启动时先跑本函数再建
// resolver：default 行无 key 且 legacy 链有值 → PATCH 一次性回填；幂等 + 失败仅 warning。

import { beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRequest, mockGetLlmApiKey } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn(),
  mockGetLlmApiKey: vi.fn()
}))

vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRequest: mockDaemonRequest }))
vi.mock('../../src/electron/main/llm_settings', () => ({
  getLlmApiKey: mockGetLlmApiKey,
  getLlmBaseUrl: vi.fn(() => 'https://test.llm')
}))

const { backfillLegacyDefaultProviderKey } =
  await import('../../src/electron/main/llm_provider_resolver')

function snapshotWith(apiKey: string, id = 'default'): unknown {
  return {
    version: 1,
    providers: [
      {
        id,
        protocol: 'anthropic',
        displayName: 'CRS',
        baseUrl: 'https://crs.test/api',
        apiKey,
        headers: {},
        enabled: true,
        models: []
      }
    ]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('backfillLegacyDefaultProviderKey', () => {
  test('keyless default row + keytar key → one PATCH with the legacy key', async () => {
    mockDaemonRequest.mockResolvedValueOnce(snapshotWith('')).mockResolvedValueOnce({})
    mockGetLlmApiKey.mockResolvedValue('keytar-only-key')

    await backfillLegacyDefaultProviderKey()

    expect(mockDaemonRequest).toHaveBeenNthCalledWith(1, 'GET', '/llm/providers/snapshot')
    expect(mockDaemonRequest).toHaveBeenNthCalledWith(2, 'PATCH', '/llm/providers/default', {
      body: { apiKey: 'keytar-only-key' }
    })
  })

  test('idempotent: default row already keyed → no PATCH, keytar never probed', async () => {
    mockDaemonRequest.mockResolvedValueOnce(snapshotWith('already-there'))

    await backfillLegacyDefaultProviderKey()

    expect(mockDaemonRequest).toHaveBeenCalledTimes(1)
    expect(mockGetLlmApiKey).not.toHaveBeenCalled()
  })

  test('no default row in the snapshot → no PATCH', async () => {
    mockDaemonRequest.mockResolvedValueOnce(snapshotWith('', 'dashscope'))

    await backfillLegacyDefaultProviderKey()

    expect(mockDaemonRequest).toHaveBeenCalledTimes(1)
  })

  test('no legacy key anywhere (env + keytar both empty) → no PATCH', async () => {
    mockDaemonRequest.mockResolvedValueOnce(snapshotWith(''))
    mockGetLlmApiKey.mockResolvedValue(null)

    await backfillLegacyDefaultProviderKey()

    expect(mockDaemonRequest).toHaveBeenCalledTimes(1)
  })

  test('snapshot fetch failure → warns, never throws (gateway startup must not block)', async () => {
    mockDaemonRequest.mockRejectedValueOnce(new Error('serve-api not up'))

    await expect(backfillLegacyDefaultProviderKey()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  test('PATCH failure → warns, never throws', async () => {
    mockDaemonRequest
      .mockResolvedValueOnce(snapshotWith(''))
      .mockRejectedValueOnce(new Error('write refused'))
    mockGetLlmApiKey.mockResolvedValue('keytar-only-key')

    await expect(backfillLegacyDefaultProviderKey()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledOnce()
  })
})
