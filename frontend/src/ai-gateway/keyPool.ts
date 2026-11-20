// Multi-key 429 cooldown pool for provider API keys (SDK-free).
//
// Keeps the primary key sticky while healthy (preserving upstream Prompt Cache prefixes),
// and automatically rotates to backup keys inside the same provider when HTTP 429 occurs,
// respecting `Retry-After` cooldown windows.

const DEFAULT_COOLDOWN_MS = 60_000
const MIN_COOLDOWN_MS = 1_000
const MAX_COOLDOWN_MS = 3_600_000

const cooldowns = new Map<string, number>()

function cooldownEntryKey(providerId: string, apiKey: string): string {
  return `${providerId}\0${apiKey}`
}

export function resetKeyCooldowns(): void {
  cooldowns.clear()
}

export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  fallbackMs = DEFAULT_COOLDOWN_MS,
  nowMs = Date.now()
): number {
  if (!headerValue) return fallbackMs
  const trimmed = headerValue.trim()
  if (!trimmed) return fallbackMs
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.round(seconds * 1000)))
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, dateMs - nowMs))
  }
  return fallbackMs
}

export function markKeyRateLimited(
  providerId: string,
  apiKey: string,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  nowMs = Date.now()
): void {
  if (!providerId || !apiKey) return
  const clamped = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, cooldownMs))
  cooldowns.set(cooldownEntryKey(providerId, apiKey), nowMs + clamped)
}

export function isKeyCoolingDown(
  providerId: string,
  apiKey: string,
  nowMs = Date.now()
): boolean {
  const until = cooldowns.get(cooldownEntryKey(providerId, apiKey))
  if (until == null) return false
  if (nowMs >= until) {
    cooldowns.delete(cooldownEntryKey(providerId, apiKey))
    return false
  }
  return true
}

/** Pick the first non-cooling key (sticky primary when healthy). Falls back to the earliest-expiring key if all are cooling. */
export function pickActiveApiKey(
  providerId: string,
  keys: readonly string[],
  nowMs = Date.now()
): string {
  const valid = keys.filter((k) => typeof k === 'string' && k.length > 0)
  if (valid.length === 0) return ''
  let bestFallback = valid[0]
  let earliestUntil = Number.POSITIVE_INFINITY
  for (const key of valid) {
    const entry = cooldownEntryKey(providerId, key)
    const until = cooldowns.get(entry)
    if (until == null || nowMs >= until) {
      if (until != null) cooldowns.delete(entry)
      return key
    }
    if (until < earliestUntil) {
      earliestUntil = until
      bestFallback = key
    }
  }
  return bestFallback
}

export function normalizeProviderKeys(primaryKey: string, apiKeys?: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const candidates = apiKeys && apiKeys.length > 0 ? [primaryKey, ...apiKeys] : [primaryKey]
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function applyApiKeyToRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  apiKey: string
): { url: string | URL | Request; init: RequestInit } {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  )
  if (headers.has('x-api-key')) {
    headers.set('x-api-key', apiKey)
  }
  if (headers.has('x-goog-api-key')) {
    headers.set('x-goog-api-key', apiKey)
  }
  const auth = headers.get('authorization')
  if (auth && /^bearer\s+/i.test(auth)) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }

  let nextUrl = input
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (rawUrl.includes('key=')) {
    try {
      const parsed = new URL(rawUrl)
      if (parsed.searchParams.has('key')) {
        parsed.searchParams.set('key', apiKey)
        nextUrl = input instanceof Request ? new Request(parsed.toString(), input) : parsed.toString()
      }
    } catch {
      /* keep original input when relative or unparseable */
    }
  }

  return {
    url: nextUrl,
    init: { ...init, headers }
  }
}

/** Wrap `fetch` so multi-key providers stay sticky on primary key and fail over on HTTP 429. */
export function createKeyPoolFetch(
  providerId: string,
  keys: readonly string[],
  baseFetch: typeof fetch = globalThis.fetch
): typeof fetch {
  const valid = normalizeProviderKeys('', keys)
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (valid.length <= 1) {
      return baseFetch(input, init)
    }
    const tried = new Set<string>()
    let chosen = pickActiveApiKey(providerId, valid)
    let lastResponse: Response | null = null

    for (let attempt = 0; attempt < valid.length; attempt++) {
      tried.add(chosen)
      const prepared = applyApiKeyToRequest(input, init, chosen)
      const res = await baseFetch(prepared.url, prepared.init)
      if (res.status !== 429) {
        return res
      }
      lastResponse = res
      const cooldownMs = parseRetryAfterMs(res.headers.get('retry-after'))
      markKeyRateLimited(providerId, chosen, cooldownMs)
      const remaining = valid.filter((k) => !tried.has(k))
      if (remaining.length === 0) break
      chosen = pickActiveApiKey(providerId, remaining)
    }

    return lastResponse as Response
  }) as typeof fetch
}
