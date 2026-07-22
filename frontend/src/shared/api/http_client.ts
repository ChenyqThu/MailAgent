// V2 Web SPA HTTP client helper. The single seam between HttpApi's typed
// methods and the local FastAPI service (127.0.0.1:8200 reached via a
// cloudflared tunnel; default baseUrl '/api' for same-origin). See
// REMOTE-ACCESS.md §4 (data layer) + docs/archive/2026-05/v2-backend-sprint12-handoff.md.
//
// Why a dedicated module: every JSON method funnels through `request()` so
// the envelope contract (`{status, schema_version, data, error, meta}`) is
// parsed in exactly one place, mirroring ElectronApi.unwrap() 1:1 — success
// returns `data`, error throws `Error & { code, hint }`, and HTTP 207
// partial_failure returns its `data` block WITHOUT throwing. Call sites keep
// branching on `err.code === 'E_AUTH_FAILED' / 'E_NOT_FOUND'` exactly as they
// do against the Electron build.

/** Server response envelope. FastAPI wraps BOTH reads and writes (unlike the
 *  Electron build where reads were bare and only writes were enveloped), so
 *  the one helper unwraps uniformly. */
export type EnvelopeStatus = 'success' | 'error' | 'partial_failure'

export interface EnvelopeError {
  /** Machine-readable enum, see docs/cli-schema error-codes.md
   *  (E_NOT_FOUND / E_AUTH_FAILED / E_INVALID_ARG / E_PM2_RUNNING / …). */
  code: string
  message: string
  hint?: string
}

export interface ApiEnvelope<T> {
  status: EnvelopeStatus
  schema_version?: number
  data?: T
  error?: EnvelopeError
  meta?: Record<string, unknown>
}

/** Error thrown by `request()` on a non-success envelope or a transport
 *  failure. `code` + `hint` mirror ElectronApi's `unwrap()` so components can
 *  do `err.code === 'E_NOT_FOUND'` regardless of build target. */
export interface ApiError extends Error {
  code: string
  hint?: string
  /** Raw HTTP status when synthesized from a non-enveloped response; absent
   *  when the code came from a parsed envelope error. */
  httpStatus?: number
}

function makeApiError(message: string, code: string, hint?: string, httpStatus?: number): ApiError {
  const err = new Error(message) as ApiError
  err.code = code
  if (hint !== undefined) err.hint = hint
  if (httpStatus !== undefined) err.httpStatus = httpStatus
  return err
}

/**
 * Map a non-2xx HTTP status to a structured error code, used ONLY as a
 * fallback when the response has no parseable envelope (e.g. a 401 HTML page
 * served by Cloudflare Access before the tunnel, a 502 when the tunnel is
 * down, or an opaque 5xx). When an envelope IS present, its `error.code`
 * always wins (server-side ERROR_CODE_TO_HTTP is the source of truth).
 */
function httpStatusToCode(status: number): string {
  if (status === 401 || status === 403) return 'E_AUTH_FAILED'
  if (status === 404) return 'E_NOT_FOUND'
  // 502/503/504 = tunnel/upstream down. Align with the server's
  // ERROR_CODE_TO_HTTP (E_UPSTREAM:502). Fallback only — a parsed
  // envelope error.code always wins over this synthesized mapping.
  if (status === 502 || status === 503 || status === 504) return 'E_UPSTREAM'
  if (status >= 500) return 'E_INTERNAL'
  return 'E_INTERNAL'
}

export type QueryValue = string | number | boolean | null | undefined | (string | number)[]

/** Build a query string from a camelCase param record. Drops undefined/null,
 *  serializes booleans as 'true'/'false', and comma-joins arrays (the wire
 *  shape the FastAPI aliases expect for internalIds etc.). */
export function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      usp.set(key, value.join(','))
    } else if (typeof value === 'boolean') {
      usp.set(key, value ? 'true' : 'false')
    } else {
      usp.set(key, String(value))
    }
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

export interface RequestOptions {
  query?: Record<string, QueryValue>
  body?: unknown
  /** Override the default Accept header (binary endpoints don't use this
   *  helper at all — see HttpApi attachment methods). */
  signal?: AbortSignal
  /** Extra request headers merged on top of Accept (and below the body
   *  Content-Type). D1 — the Electron main process injects
   *  `X-MailAgent-Local-Token` here when forwarding writes to the loopback
   *  serve-api; the remote web build leaves this unset (CF Access cookie). */
  headers?: Record<string, string>
}

/**
 * The core JSON request. Builds `${baseUrl}${path}${query}`, sends the CF
 * Access cookie via `credentials:'include'`, parses the envelope, and:
 *   - status==='success'        → returns `env.data as T`
 *   - status==='partial_failure'→ returns `env.data as T` (HTTP 207; batch
 *                                 writes surface {succeeded,failed,summary})
 *   - status==='error'          → throws ApiError(env.error.code/message/hint)
 *   - non-2xx without envelope  → throws ApiError(synthesized code)
 *   - fetch reject / non-JSON   → throws ApiError('E_NETWORK')
 *
 * No Authorization header and no API key ever leave the bundle — Cloudflare
 * Access injects the identity at the edge and the browser auto-sends the
 * CF_Authorization cookie (REMOTE-ACCESS §6.4 G3).
 */
export async function request<T>(
  baseUrl: string,
  method: string,
  path: string,
  opts: RequestOptions = {}
): Promise<T> {
  const { data } = await requestWithMeta<T>(baseUrl, method, path, opts)
  return data
}

/**
 * Same wire contract as `request()`, but also surfaces `meta` (e.g. pagination's
 * `total`/`limit`/`offset` — task 07-21) instead of discarding it. `request()` is a thin
 * wrapper over this so both stay byte-identical on the fetch/parse/unwrap path.
 */
export async function requestWithMeta<T>(
  baseUrl: string,
  method: string,
  path: string,
  opts: RequestOptions = {}
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const url = `${baseUrl}${path}${buildQuery(opts.query)}`

  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) }
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    signal: opts.signal
  }
  if (opts.body !== undefined) {
    // Content-Type set last so a caller-supplied opts.headers can't clobber it.
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }

  return sendAndUnwrapWithMeta<T>(url, init)
}

/**
 * Raw-body variant of `request()` — same envelope contract on the response,
 * but the request body is untouched bytes (attachment staging upload,
 * D1 `PUT /email/compose-attachment`: application/octet-stream, no
 * python-multipart on the server). Kept as a separate function so the JSON
 * path's signature/behaviour stays byte-identical.
 */
export async function requestRaw<T>(
  baseUrl: string,
  method: string,
  path: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string,
  opts: Omit<RequestOptions, 'body'> = {}
): Promise<T> {
  const url = `${baseUrl}${path}${buildQuery(opts.query)}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
    // Set last so caller headers can't clobber it (mirror request()).
    'Content-Type': contentType
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    signal: opts.signal,
    body: body as BodyInit
  }
  const { data } = await sendAndUnwrapWithMeta<T>(url, init)
  return data
}

/** Shared fetch + envelope unwrap for request()/requestWithMeta()/requestRaw(). */
async function sendAndUnwrapWithMeta<T>(
  url: string,
  init: RequestInit
): Promise<{ data: T; meta: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    // Network-level failure (DNS, connection refused, CORS preflight reject,
    // request aborted). No HTTP status to read.
    const msg = e instanceof Error ? e.message : 'network request failed'
    throw makeApiError(msg, 'E_NETWORK')
  }

  // Parse the body as JSON; tolerate empty bodies + non-JSON error pages.
  let parsed: unknown = undefined
  let parseOk = false
  try {
    const text = await res.text()
    if (text.length > 0) {
      parsed = JSON.parse(text)
      parseOk = true
    }
  } catch {
    parseOk = false
  }

  const env =
    parseOk && parsed !== null && typeof parsed === 'object' && 'status' in parsed
      ? (parsed as ApiEnvelope<T>)
      : null

  if (env) {
    if (env.status === 'success') {
      return { data: env.data as T, meta: env.meta ?? {} }
    }
    if (env.status === 'partial_failure') {
      // HTTP 207 — batch write with some failures. The renderer inspects
      // data.summary / data.failed; this is NOT an error.
      return { data: env.data as T, meta: env.meta ?? {} }
    }
    // status === 'error' (or any unknown status) → throw with the envelope's
    // own code, preferred over the HTTP status mapping.
    const code = env.error?.code ?? httpStatusToCode(res.status)
    const message = env.error?.message ?? `request failed (${res.status})`
    throw makeApiError(message, code, env.error?.hint, res.status)
  }

  // No parseable envelope. If the HTTP layer itself failed, synthesize a code
  // from the status (CF 401 HTML, 502 tunnel down, opaque 5xx).
  if (!res.ok) {
    throw makeApiError(
      `request failed (${res.status} ${res.statusText})`,
      httpStatusToCode(res.status),
      undefined,
      res.status
    )
  }

  // 2xx but the body wasn't a recognizable envelope — schema drift.
  throw makeApiError('malformed response envelope', 'E_SCHEMA_MISMATCH', undefined, res.status)
}

/**
 * Fetch a binary endpoint (attachment download/inline) and return it as a
 * `data:<mime>;base64,...` URL. Mirrors ElectronApi.readDataUrl semantics:
 * the sandboxed srcdoc body iframe can't load file:// (or reliably same-origin
 * /inline under its CSP), so cid: images substitute a base64 data URL. Returns
 * null on any non-OK / fetch / read failure. NOT enveloped — raw bytes.
 */
export async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}
