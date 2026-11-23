// Core HTTP transport, DomainError, and DomainHttpCore.
import type { DomainLibraryActor } from './domainTypes'

/** A serve-api domain error surfaced to the caller (tool execute turns it into a
 *  tool-error part). Mirrors the http_client ApiError shape ({code, message, hint?,
 *  httpStatus?}). `code` is the serve-api envelope error code (E_NOT_FOUND /
 *  E_INVALID_ARG / E_KOS_* / E_UPSTREAM / E_INTERNAL / E_NETWORK …). */
export class DomainError extends Error {
  readonly code: string
  readonly hint?: string
  readonly httpStatus?: number
  /** Structured error payload (`error.data`) when the endpoint carries one. Today only the library
   *  CAS 409 does (E_VERSION_CONFLICT → {content_hash, content}, design §4); every other envelope
   *  leaves it undefined. */
  readonly data?: unknown
  constructor(
    code: string,
    message: string,
    opts?: { hint?: string; httpStatus?: number; data?: unknown }
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.hint = opts?.hint
    this.httpStatus = opts?.httpStatus
    this.data = opts?.data
  }
}

type QueryValue = string | number | boolean | undefined | null

export interface DomainClientConfig {
  /** serve-api base URL incl. the /api prefix, e.g. http://127.0.0.1:8200/api. */
  baseUrl: string
  /** X-MailAgent-Local-Token value (main-process ephemeral token). null → header
   *  omitted (dev / pm2 backend where the local-token leg is disabled). */
  localToken: string | null
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

export const LOCAL_TOKEN_HEADER = 'X-MailAgent-Local-Token'

export function buildQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    // String(false) → 'false' / String(10) → '10' — the wire form serve-api expects.
    params.set(k, String(v))
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

export function libraryActorWire(actor: DomainLibraryActor): Record<string, unknown> {
  return {
    kind: actor.kind,
    ...(actor.agentId !== undefined ? { agent_id: actor.agentId } : {})
  }
}

export class DomainHttpCore {
  private readonly baseUrl: string
  private readonly localToken: string | null
  private readonly fetchImpl: typeof fetch

  constructor(config: DomainClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.localToken = config.localToken
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /** Core request: build URL + query, inject the local token, parse the envelope. */
  public async req<T>(
    method: string,
    path: string,
    opts?: {
      query?: Record<string, QueryValue>
      body?: unknown
      /** 二进制请求体，`body` 的互斥替身（`POST /library/files` 的 octet-stream 分支是唯一
       *  用户；它的参数走 query）。响应仍是 envelope JSON，下面的解析路径一个字不变。 */
      rawBody?: Uint8Array
      signal?: AbortSignal
      /** Extra request headers (e.g. S4's X-Claim-Token). Merged after the Accept / local-token /
       *  Content-Type defaults; a caller-supplied key overrides a default. */
      headers?: Record<string, string>
    }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${opts?.query ? buildQuery(opts.query) : ''}`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.localToken) headers[LOCAL_TOKEN_HEADER] = this.localToken
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json'
    else if (opts?.rawBody !== undefined) headers['Content-Type'] = 'application/octet-stream'
    if (opts?.headers) Object.assign(headers, opts.headers)

    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method,
        headers,
        // 二进制体要显式转一次：lib.dom 的 `BufferSource` 把底层 buffer 钉死成 `ArrayBuffer`，
        // 而我们手上的是 `Uint8Array<ArrayBufferLike>`（AI SDK / node:fs 给出来的都是这个）——
        // 运行时是同一件东西，差的只是类型收窄。
        body:
          opts?.body !== undefined
            ? JSON.stringify(opts.body)
            : (opts?.rawBody as BodyInit | undefined),
        signal: opts?.signal
      })
    } catch (e) {
      // Network failure / abort. Re-throw abort as-is (AI SDK / caller distinguishes
      // it); other fetch failures become a typed E_NETWORK DomainError.
      if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) throw e
      throw new DomainError('E_NETWORK', e instanceof Error ? e.message : String(e))
    }

    let parsed: unknown
    try {
      parsed = await resp.json()
    } catch {
      // Non-JSON body. If the status was an error, synthesize one; success non-JSON
      // shouldn't happen for these envelope endpoints.
      if (!resp.ok) {
        throw new DomainError('E_UPSTREAM', `serve-api ${resp.status} (non-JSON body)`, {
          httpStatus: resp.status
        })
      }
      throw new DomainError('E_SCHEMA_MISMATCH', 'serve-api returned a non-JSON success body')
    }

    const envelope = parsed as {
      status?: string
      data?: unknown
      error?: { code?: string; message?: string; hint?: string }
    }
    if (envelope.status === 'success' || envelope.status === 'partial_failure') {
      return envelope.data as T
    }
    // status:error (or missing/unknown status) → typed DomainError. An error envelope's `data` is
    // null everywhere except the library CAS 409 (routers/library.py::_conflict_response puts
    // {content_hash, content} there) — surfaced as DomainError.data, undefined when null.
    const err = envelope.error ?? {}
    throw new DomainError(err.code ?? 'E_UPSTREAM', err.message ?? `serve-api ${resp.status}`, {
      hint: err.hint,
      httpStatus: resp.status,
      data: envelope.data ?? undefined
    })
  }
}
