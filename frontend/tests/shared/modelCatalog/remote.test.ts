import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const payload = (publishedAt = '2030-01-01T00:00:00.000Z', name = 'Cloud model'): string =>
  JSON.stringify({
    schemaVersion: 1,
    source: 'https://models.dev/api.json',
    generatedAt: '2030-01-01',
    publishedAt,
    providers: {
      deepseek: {
        name: 'DeepSeek',
        models: {
          'cloud-only-model': {
            name,
            description: 'New model from the cloud',
            context: 123456,
            output: 4096,
            caps: ['tools', 'vision'],
            cost: { input: 0.25, output: 1 }
          }
        }
      }
    }
  })

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-02'))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('remote model catalog', () => {
  test('new models reach lookup, cost/context and subscribers without replacing bundled fallback', async () => {
    const { startModelCatalogUpdates, MODEL_CATALOG_URL } =
      await import('@shared/modelCatalog/remote')
    const { lookupModelMeta, subscribeModelCatalog } = await import('@shared/modelCatalog/lookup')
    const { resolveContextWindow } = await import('@shared/modelCatalog/contextWindow')
    const changed = vi.fn()
    const unsubscribe = subscribeModelCatalog(changed)
    const fetcher = vi.fn().mockResolvedValue(new Response(payload()))
    const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() }
    const updater = startModelCatalogUpdates({ fetcher, storage })
    await updater.refresh()
    expect(fetcher).toHaveBeenCalledWith(
      MODEL_CATALOG_URL,
      expect.objectContaining({ credentials: 'omit' })
    )
    expect(lookupModelMeta('cloud-only-model', 'deepseek')).toMatchObject({
      displayName: 'Cloud model',
      capabilities: { vision: true },
      cost: { input: 0.25 }
    })
    expect(
      resolveContextWindow({ modelId: 'cloud-only-model', providerId: 'x', protocol: 'deepseek' })
    ).toBe(123456)
    expect(lookupModelMeta('deepseek-flash', 'deepseek')).not.toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    await updater.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    updater.stop()
    unsubscribe()
  })

  test('uses cached data synchronously while offline and retains it after failed refresh', async () => {
    const { startModelCatalogUpdates } = await import('@shared/modelCatalog/remote')
    const { lookupModelMeta } = await import('@shared/modelCatalog/lookup')
    const onError = vi.fn()
    const updater = startModelCatalogUpdates({
      storage: {
        getItem: () => JSON.stringify({ checkedAt: 0, payload: payload() }),
        setItem: vi.fn()
      },
      fetcher: vi.fn().mockRejectedValue(new Error('offline')),
      onError
    })
    expect(lookupModelMeta('cloud-only-model', 'deepseek')?.displayName).toBe('Cloud model')
    await updater.refresh()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(lookupModelMeta('cloud-only-model', 'deepseek')?.displayName).toBe('Cloud model')
    updater.stop()
  })

  test.each([
    '{}',
    '<html>login</html>',
    payload().replace('"schemaVersion":1', '"schemaVersion":2'),
    payload().replace('123456', '-1'),
    payload().replace('"tools"', '"executable"')
  ])('rejects invalid payload without losing current data: %s', async (body) => {
    const { startModelCatalogUpdates } = await import('@shared/modelCatalog/remote')
    const { lookupModelMeta } = await import('@shared/modelCatalog/lookup')
    const setItem = vi.fn()
    const updater = startModelCatalogUpdates({
      storage: { getItem: () => null, setItem },
      fetcher: vi.fn().mockResolvedValue(new Response(body)),
      onError: vi.fn()
    })
    await updater.refresh()
    expect(lookupModelMeta('cloud-only-model', 'deepseek')).toBeNull()
    expect(lookupModelMeta('deepseek-flash', 'deepseek')).not.toBeNull()
    expect(setItem).not.toHaveBeenCalled()
    updater.stop()
  })

  test('rejects rollback and preserves user overrides', async () => {
    const { parseRemoteCatalog } = await import('@shared/modelCatalog/remote')
    const { installModelCatalog, lookupModelMeta } = await import('@shared/modelCatalog/lookup')
    const { composeComposerModelOption } = await import('@shared/hooks/useComposerModels')
    expect(installModelCatalog(parseRemoteCatalog(payload()))).toBe(true)
    expect(
      installModelCatalog(parseRemoteCatalog(payload('2029-12-31T00:00:00.000Z', 'Older')))
    ).toBe(false)
    expect(lookupModelMeta('cloud-only-model', 'deepseek')?.displayName).toBe('Cloud model')
    const result = composeComposerModelOption({
      ref: 'x:cloud-only-model',
      providerId: 'x',
      providerLabel: null,
      protocol: 'deepseek',
      modelId: 'cloud-only-model',
      rowDisplayName: 'My name',
      rowCapabilities: { vision: false },
      rowMaxOutput: 12,
      rowContextWindow: 100
    })
    expect(result).toMatchObject({
      displayName: 'My name',
      capabilities: { vision: false },
      maxOutput: 12,
      contextWindow: 100
    })
  })

  test('corrupt/unwritable cache does not prevent installing valid cloud data', async () => {
    const { startModelCatalogUpdates } = await import('@shared/modelCatalog/remote')
    const { lookupModelMeta } = await import('@shared/modelCatalog/lookup')
    const updater = startModelCatalogUpdates({
      storage: {
        getItem: () => 'bad',
        setItem: () => {
          throw new Error('quota')
        }
      },
      fetcher: vi.fn().mockResolvedValue(new Response(payload())),
      onError: vi.fn()
    })
    await updater.refresh()
    expect(lookupModelMeta('cloud-only-model', 'deepseek')?.displayName).toBe('Cloud model')
    updater.stop()
  })

  test('timeout aborts requests and stop removes the refresh timer', async () => {
    const { startModelCatalogUpdates } = await import('@shared/modelCatalog/remote')
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const onError = vi.fn()
    const updater = startModelCatalogUpdates({ fetcher, onError })
    await vi.advanceTimersByTimeAsync(10001)
    expect(onError).toHaveBeenCalledTimes(1)
    updater.stop()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('cloud endpoint is allowed by both shipping CSPs', async () => {
    const { MODEL_CATALOG_URL } = await import('@shared/modelCatalog/remote')
    const origin = new URL(MODEL_CATALOG_URL).origin
    for (const file of ['src/electron/renderer/index.html', 'src/web/index.html']) {
      const html = readFileSync(resolve(file), 'utf8')
      expect(html.match(/content="[^"]*connect-src ([^;"']*(?:'self')?[^;"]*)/)?.[1]).toContain(
        origin
      )
    }
  })
})
