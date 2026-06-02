/**
 * KOS MCP client (TypeScript) - OAuth 2.1 client_credentials + JSON-RPC
 * over HTTP with SSE response parsing.
 *
 * Mirrors `src/kos/client.py` 1:1 — keep both in sync if either changes.
 * Wire spec: ~/Projects/jarvis-knowledge-os-v2/docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md
 *
 * Flow:
 *   1. POST /token (form-urlencoded) → 1h access_token (no refresh)
 *   2. POST /mcp Authorization: Bearer <token>, body JSON-RPC tools/call
 *   3. Response Content-Type: text/event-stream — extract 'data: <json>'
 *      lines, JSON.parse. (server-sent events format, NOT raw JSON)
 *   4. JSON-RPC result.content[0].text is JSON-encoded payload, parse
 *      once more → caller-friendly value (array/object).
 *
 * Token cache: in-memory + expiresAt; safety buffer 60s before refresh.
 * Rate limit: 50 req / 15min — client surfaces 429 as E_KOS_RATE_LIMIT,
 * caller (chat agent) decides fallback strategy.
 */

const DEFAULT_SCOPE = 'read write'
const DEFAULT_TIMEOUT_MS = 10_000
const TOKEN_SAFETY_BUFFER_MS = 60_000

export interface KOSConfigInput {
  baseUrl?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  timeoutMs?: number
  /** Injected fetch for tests; defaults to globalThis.fetch */
  fetchImpl?: typeof fetch
}

export interface KOSConfig {
  baseUrl: string
  clientId: string
  clientSecret: string
  scope: string
  timeoutMs: number
  fetchImpl: typeof fetch
}

interface TokenCache {
  token: string
  expiresAt: number
}

export interface QueryHit {
  slug: string
  title?: string
  type?: string
  page_id?: number
  chunk_text?: string
  score?: number
  /** Open shape — KOS server may add fields like updated_at / mtime_ns /
   *  created_at. rerankByRecency() reads these via extractHitTimestampMs. */
  [k: string]: unknown
}

interface PutPageResult {
  slug: string
  status: string
  chunks?: number
  facts_backstop?: { queued: boolean }
  writer_lint?: Record<string, unknown>
  [k: string]: unknown
}

export class KOSError extends Error {
  /**
   * Stable code for caller to branch on:
   *   E_KOS_NOT_CONFIGURED - env vars missing
   *   E_KOS_HEALTH         - /health request failed
   *   E_KOS_NETWORK        - fetch threw / aborted
   *   E_KOS_TOKEN_NETWORK  - /token network error
   *   E_KOS_TOKEN_HTTP     - /token non-200
   *   E_KOS_TOKEN_INVALID  - /token 200 but missing access_token
   *   E_KOS_UNAUTHORIZED   - /mcp 401
   *   E_KOS_RATE_LIMIT     - /mcp 429
   *   E_KOS_HTTP           - /mcp other 4xx/5xx
   *   E_KOS_PARSE          - SSE extract / JSON parse failed
   *   E_KOS_RPC            - JSON-RPC envelope `error` non-empty
   */
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string = 'E_KOS_UNKNOWN', status?: number) {
    super(message)
    this.name = 'KOSError'
    this.code = code
    this.status = status
  }
}

export class KOSClient {
  private readonly config: KOSConfig
  private tokenCache: TokenCache | null = null

  constructor(input?: KOSConfigInput) {
    this.config = {
      baseUrl: stripTrailingSlash(input?.baseUrl ?? process.env.KOS_MCP_BASE ?? ''),
      clientId: input?.clientId ?? process.env.KOS_OAUTH_CLIENT_ID ?? '',
      clientSecret: input?.clientSecret ?? process.env.KOS_OAUTH_CLIENT_SECRET ?? '',
      scope: input?.scope ?? DEFAULT_SCOPE,
      timeoutMs: input?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: input?.fetchImpl ?? globalThis.fetch
    }
  }

  get configured(): boolean {
    return Boolean(this.config.baseUrl && this.config.clientId && this.config.clientSecret)
  }

  get baseUrl(): string {
    return this.config.baseUrl
  }

  // ============================================================
  // Public API
  // ============================================================

  async health(): Promise<unknown> {
    if (!this.config.baseUrl) {
      throw new KOSError('KOS_MCP_BASE not configured', 'E_KOS_NOT_CONFIGURED')
    }
    const res = await this.fetchWithTimeout(`${this.config.baseUrl}/health`)
    if (!res.ok) {
      throw new KOSError(`health HTTP ${res.status}`, 'E_KOS_HEALTH', res.status)
    }
    return (await res.json()) as unknown
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.configured) {
      throw new KOSError(
        'KOS client not configured (need KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET)',
        'E_KOS_NOT_CONFIGURED'
      )
    }
    const body = this.buildRpcBody(name, args)
    try {
      return await this.postMcp(body)
    } catch (e) {
      if (e instanceof KOSError && e.code === 'E_KOS_UNAUTHORIZED') {
        // Token expired — invalidate + retry once
        this.tokenCache = null
        return await this.postMcp(body)
      }
      throw e
    }
  }

  /** tools/call name='query' — returns retrieval hit array.
   *  默认跨 3 源 union (default + mailagent-emails + omada)；传 sourceId 才限定。 */
  async query(
    query: string,
    opts?: { limit?: number; expand?: boolean; sourceId?: string }
  ): Promise<QueryHit[]> {
    const args: Record<string, unknown> = {
      query,
      limit: opts?.limit ?? 10,
      expand: opts?.expand ?? false
    }
    if (opts?.sourceId) args.source_id = opts.sourceId
    const result = await this.callTool('query', args)
    return Array.isArray(result) ? (result as QueryHit[]) : []
  }

  /** tools/call name='list_pages' — limit capped at 100. */
  async listPages(opts?: {
    limit?: number
    type?: string
    tag?: string
    updatedAfter?: string
    sort?: string
  }): Promise<unknown> {
    const args: Record<string, unknown> = { limit: Math.min(opts?.limit ?? 50, 100) }
    if (opts?.type !== undefined) args.type = opts.type
    if (opts?.tag !== undefined) args.tag = opts.tag
    if (opts?.updatedAfter !== undefined) args.updated_after = opts.updatedAfter
    if (opts?.sort !== undefined) args.sort = opts.sort
    return await this.callTool('list_pages', args)
  }

  /**
   * tools/call name='put_page' — content must include YAML frontmatter.
   * See wire spec §7.1 for the mailagent-specific frontmatter template.
   */
  async putPage(slug: string, content: string): Promise<PutPageResult> {
    const result = await this.callTool('put_page', { slug, content })
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return result as PutPageResult
    }
    return { slug, status: 'unknown', raw: result } as PutPageResult
  }

  // ============================================================
  // Internal
  // ============================================================

  private buildRpcBody(name: string, args: Record<string, unknown>): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id: String(Date.now()),
      method: 'tools/call',
      params: { name, arguments: args }
    }
  }

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - TOKEN_SAFETY_BUFFER_MS) {
      return this.tokenCache.token
    }
    return await this.refreshToken()
  }

  private async refreshToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: this.config.scope
    })
    let res: Response
    try {
      res = await this.fetchWithTimeout(`${this.config.baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      })
    } catch (e) {
      // fetchWithTimeout 已经 wrap 成 E_KOS_NETWORK; re-throw as token network error
      if (e instanceof KOSError && e.code === 'E_KOS_NETWORK') {
        throw new KOSError(e.message, 'E_KOS_TOKEN_NETWORK')
      }
      throw e
    }
    if (!res.ok) {
      const txt = await safeText(res)
      throw new KOSError(
        `/token HTTP ${res.status}: ${txt.slice(0, 200)}`,
        'E_KOS_TOKEN_HTTP',
        res.status
      )
    }
    let payload: { access_token?: string; expires_in?: number }
    try {
      payload = (await res.json()) as { access_token?: string; expires_in?: number }
    } catch (e) {
      throw new KOSError(
        `/token response not JSON: ${(e as Error).message}`,
        'E_KOS_TOKEN_INVALID'
      )
    }
    if (!payload.access_token) {
      throw new KOSError('/token response missing access_token', 'E_KOS_TOKEN_INVALID')
    }
    const expiresInMs = (payload.expires_in ?? 3600) * 1000
    this.tokenCache = {
      token: payload.access_token,
      expiresAt: Date.now() + expiresInMs
    }
    return payload.access_token
  }

  private async postMcp(body: Record<string, unknown>): Promise<unknown> {
    const token = await this.getToken()
    const res = await this.fetchWithTimeout(`${this.config.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(body)
    })
    if (res.status === 401) {
      throw new KOSError(
        'MCP 401 unauthorized (token expired or scope mismatch)',
        'E_KOS_UNAUTHORIZED',
        401
      )
    }
    if (res.status === 429) {
      throw new KOSError('MCP rate limited (50 req / 15min)', 'E_KOS_RATE_LIMIT', 429)
    }
    if (!res.ok) {
      const txt = await safeText(res)
      throw new KOSError(`MCP HTTP ${res.status}: ${txt.slice(0, 200)}`, 'E_KOS_HTTP', res.status)
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    let envelope: Record<string, unknown>
    if (contentType.includes('text/event-stream')) {
      const text = await res.text()
      envelope = KOSClient.extractSseEnvelope(text)
    } else {
      try {
        envelope = (await res.json()) as Record<string, unknown>
      } catch (e) {
        throw new KOSError(
          `MCP response not JSON: ${(e as Error).message}`,
          'E_KOS_PARSE'
        )
      }
    }

    const error = (envelope as { error?: { code?: number; message?: string } }).error
    if (error) {
      throw new KOSError(
        `MCP JSON-RPC error: ${error.message ?? JSON.stringify(error)}`,
        'E_KOS_RPC',
        error.code
      )
    }

    const result = (envelope as { result?: unknown }).result ?? envelope
    return KOSClient.unwrapToolResult(result)
  }

  /**
   * SSE 'data: <json>\n\n' parsing — extract first non-[DONE] data: line.
   *
   * Exposed as static so tests don't need a KOSClient instance.
   */
  static extractSseEnvelope(body: string): Record<string, unknown> {
    const lines = body.split(/\r?\n/)
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice('data: '.length).trim()
        if (raw && raw !== '[DONE]') {
          try {
            return JSON.parse(raw) as Record<string, unknown>
          } catch (e) {
            throw new KOSError(
              `SSE data: line not JSON: ${(e as Error).message}`,
              'E_KOS_PARSE'
            )
          }
        }
      }
    }
    throw new KOSError("SSE response missing 'data:' line", 'E_KOS_PARSE')
  }

  /**
   * MCP tools/call result usually looks like
   *   {content: [{type: 'text', text: '<JSON-encoded payload>'}]}
   * Parse the inner text once → caller-friendly value. Not-JSON → return
   * string. No content → return result as-is.
   */
  static unwrapToolResult(result: unknown): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return result
    }
    const content = (result as { content?: unknown }).content
    if (!Array.isArray(content) || content.length === 0) {
      return result
    }
    const first = content[0]
    if (!first || typeof first !== 'object') {
      return result
    }
    const typed = first as { type?: string; text?: string }
    if (typed.type !== 'text' || typeof typed.text !== 'string') {
      return result
    }
    try {
      return JSON.parse(typed.text)
    } catch {
      return typed.text
    }
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      return await this.config.fetchImpl(url, { ...init, signal: controller.signal })
    } catch (e) {
      throw new KOSError(
        `fetch failed: ${(e as Error).message}`,
        controller.signal.aborted ? 'E_KOS_NETWORK' : 'E_KOS_NETWORK'
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Sprint 19 P1-B — client-side time-decay rerank ───────────────────────
//
// KOS bm25 排序无时间维度, 老 hit 跟新 hit 同权重命中. 给 chat agent 的
// kos_query / kos_digest tool, 拿到 hits 后乘 exponential decay factor
// 让新 hit 优先. 实施在 client-side 因为 KOS server 没现成 time decay
// param (Lucien sync 后可上 server-side, P2 design doc §3.3 B).
//
// 公式: factor = 0.5 ^ (Δt_days / halfLifeDays)
//   - halfLifeDays=14 (D5 user-approved): score 在 14d 时降一半, 28d 1/4,
//     56d 1/16. 适合邮件回复节奏 (周/月级).
//   - hit 无 timestamp → factor=1.0 不调整 (保持 bm25 原序)
//
// 注意: 跟 src/kos/client.py 1:1 镜像不对齐 — Python 端 KOS 消费者只
// 有 producer 路径 (推 email 不 query), chat agent 仅 TS 路径需 rerank.
// 若 Python 端将来加 retrieval consumer 再补 Python parity.

const DEFAULT_HALF_LIFE_DAYS = 14

/**
 * Extract a timestamp (ms since epoch) from a KOS hit's open metadata.
 * KOS server 字段名不固定 (gbrain wiki_pages 用 updated_at 或 mtime_ns),
 * 这里按 priority 取第一个找到的有效值. null = 不能 rerank.
 */
export function extractHitTimestampMs(hit: QueryHit): number | null {
  // updated_at: ms epoch (gbrain wiki_pages convention).
  if (typeof hit.updated_at === 'number' && hit.updated_at > 0) {
    return hit.updated_at
  }
  // mtime_ns: ns epoch (gbrain internal). Convert to ms.
  if (typeof hit.mtime_ns === 'number' && hit.mtime_ns > 0) {
    return Math.floor(hit.mtime_ns / 1_000_000)
  }
  // created_at fallback.
  if (typeof hit.created_at === 'number' && hit.created_at > 0) {
    return hit.created_at
  }
  return null
}

export interface RerankOptions {
  /** Half-life in days. Default 14 (D5). */
  halfLifeDays?: number
  /** Override now() for deterministic tests. Default Date.now(). */
  nowMs?: number
}

/**
 * Rerank KOS query hits by exponential time decay. Returns a NEW array
 * sorted by adjusted score (DESC). Original hits NOT mutated.
 *
 * Behaviour:
 *   - hit with extractable timestamp → score *= 0.5^(Δt_days / halfLife)
 *   - hit without timestamp → factor=1.0 (rank by original bm25 score)
 *   - hit without score → treated as 0 (sorts to bottom)
 *   - 添加 `_recency_factor` + `_original_score` 字段在新 hit 上方便 caller
 *     debug / 渲染 explanation
 */
export function rerankByRecency(
  hits: ReadonlyArray<QueryHit>,
  opts?: RerankOptions
): QueryHit[] {
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const now = opts?.nowMs ?? Date.now()
  const dayMs = 86_400_000

  const adjusted: QueryHit[] = hits.map((hit) => {
    const tsMs = extractHitTimestampMs(hit)
    const originalScore = typeof hit.score === 'number' ? hit.score : 0
    let factor = 1.0
    if (tsMs !== null) {
      const deltaDays = Math.max(0, (now - tsMs) / dayMs)
      factor = Math.pow(0.5, deltaDays / halfLifeDays)
    }
    const newScore = originalScore * factor
    return {
      ...hit,
      score: newScore,
      _recency_factor: factor,
      _original_score: originalScore
    }
  })

  // Stable sort by adjusted score DESC. Array.prototype.sort is stable in
  // modern V8/JavaScriptCore.
  adjusted.sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score : 0
    const sb = typeof b.score === 'number' ? b.score : 0
    return sb - sa
  })
  return adjusted
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
