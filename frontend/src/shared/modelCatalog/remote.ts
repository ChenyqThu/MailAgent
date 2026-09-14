import { z } from 'zod'

import { installModelCatalog, type ModelCatalogSnapshot } from './lookup'

export const MODEL_CATALOG_URL =
  'https://raw.githubusercontent.com/ChenyqThu/MailAgent/codex/model-catalog/catalog.json'
export const MODEL_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000
export const MODEL_CATALOG_CACHE_KEY = 'mailagent:model-catalog:v1'
const MAX_BYTES = 2 * 1024 * 1024
const safeKey = z
  .string()
  .min(1)
  .max(300)
  .refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v))
const price = z.number().finite().nonnegative().optional()
const model = z.object({
  name: z.string().max(500).optional(),
  description: z.string().max(10000).optional(),
  context: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
  caps: z
    .array(z.enum(['tools', 'reasoning', 'vision', 'files']))
    .max(4)
    .optional(),
  cost: z.object({ input: price, output: price, cacheRead: price, cacheWrite: price }).optional(),
  released: z.string().max(40).optional(),
  knowledge: z.string().max(40).optional(),
  deprecated: z.boolean().optional()
})
const schema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('https://models.dev/api.json'),
  generatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.iso.datetime(),
  providers: z
    .record(
      safeKey,
      z.object({
        name: z.string().min(1).max(200),
        models: z.record(safeKey, model).refine((v) => Object.keys(v).length > 0)
      })
    )
    .refine((v) => Object.keys(v).length > 0)
})

export function parseRemoteCatalog(text: string): ModelCatalogSnapshot & { publishedAt: string } {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Catalog too large')
  const result = schema.parse(JSON.parse(text))
  if (!Number.isFinite(Date.parse(result.generatedAt))) throw new Error('Invalid catalog date')
  return result
}

export interface CatalogStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** No credentials, API keys, model preferences or user content enter this channel. */
export function startModelCatalogUpdates(
  options: {
    storage?: CatalogStorage
    fetcher?: typeof fetch
    onError?: (error: unknown) => void
  } = {}
): { refresh: () => Promise<void>; stop: () => void } {
  let stopped = false
  let inFlight: Promise<void> | null = null
  let lastSuccess = 0
  let controller: AbortController | null = null
  const report =
    options.onError ??
    ((error: unknown) => console.warn('[model-catalog] update unavailable', error))
  try {
    const cached = options.storage?.getItem(MODEL_CATALOG_CACHE_KEY)
    if (cached) {
      const record: unknown = JSON.parse(cached)
      const envelope = z
        .object({ checkedAt: z.number().finite(), payload: z.string() })
        .parse(record)
      const catalog = parseRemoteCatalog(envelope.payload)
      if (installModelCatalog(catalog)) lastSuccess = Math.min(envelope.checkedAt, Date.now())
    }
  } catch (error) {
    report(error)
  }

  const refresh = (): Promise<void> => {
    if (stopped || Date.now() - lastSuccess < MODEL_CATALOG_REFRESH_MS) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = (async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10000)
      try {
        const response = await (options.fetcher ?? fetch)(MODEL_CATALOG_URL, {
          signal: controller.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-cache'
        })
        if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`)
        if (Number(response.headers.get('content-length')) > MAX_BYTES)
          throw new Error('Catalog too large')
        if (!response.body) throw new Error('Empty catalog response')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let bytes = 0
        let payload = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_BYTES) {
            await reader.cancel()
            throw new Error('Catalog too large')
          }
          payload += decoder.decode(value, { stream: true })
        }
        payload += decoder.decode()
        const catalog = parseRemoteCatalog(payload)
        if (stopped) return
        if (!installModelCatalog(catalog)) throw new Error('Catalog is older than current data')
        lastSuccess = Date.now()
        try {
          options.storage?.setItem(
            MODEL_CATALOG_CACHE_KEY,
            JSON.stringify({ checkedAt: lastSuccess, payload })
          )
        } catch (error) {
          report(error)
        }
      } catch (error) {
        if (!stopped) report(error)
      } finally {
        clearTimeout(timeout)
        controller = null
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }
  // Retry transient failures hourly, while successful requests are limited to once per 6 hours.
  const timer = setInterval(
    () => {
      void refresh()
    },
    60 * 60 * 1000
  )
  void refresh()
  return {
    refresh,
    stop: () => {
      stopped = true
      clearInterval(timer)
      controller?.abort()
    }
  }
}
