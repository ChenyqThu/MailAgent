// Sprint 19 PR-2e — KOS consumer chat tools (kos_query / kos_digest).
//
// Wrap PR-2c 的 KOSClient (OAuth 2.1 + MCP JSON-RPC over HTTP with SSE)
// 给 LLM 当 silent-tier read tool 用. 跨域检索 (人/公司/项目/Notion 手记/
// Slack/会议/邮件 全域知识), KOS 不可达时返 E_KOS_* code → LLM 自然
// fallback 到本地 email_search_fulltext (PR-2a) 或 email_search_attachments
// (PR-2b) 路径.
//
// Lazy singleton KOSClient — 复用 token cache 跨 chat session. 测试用
// __setKosClientForTests 注入 mock.
//
// Gate: registerBuiltinTools 只在 isKosConsumerEnabled() = true 时 wire
// 这俩 tool 进 default registry, 默认关闭. 启用前确认 PR-2c 的
// KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET 都已配齐.

import type { ToolDef, ToolResult } from '../registry'
import { KOSClient, KOSError, rerankByRecency } from '../../../kos/client'
import { isKosTimeDecayEnabled } from '../../config'

// ── Lazy singleton + 测试注入点 ───────────────────────────────────

let _client: KOSClient | null = null

function getClient(): KOSClient {
  if (_client === null) {
    _client = new KOSClient()
  }
  return _client
}

/** Tests: inject mock; pass null to reset to default lazy ctor. */
export function __setKosClientForTests(c: KOSClient | null): void {
  _client = c
}

// ── 小工具 ────────────────────────────────────────────────────────

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN
  if (Number.isNaN(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

function kosErrorToToolResult(e: KOSError, start: number): ToolResult {
  return {
    ok: false,
    code: e.code,
    message: e.message,
    durationMs: Date.now() - start
  }
}

function exceptionToToolResult(e: unknown, start: number): ToolResult {
  if (e instanceof KOSError) return kosErrorToToolResult(e, start)
  return {
    ok: false,
    code: 'E_INTERNAL',
    message: e instanceof Error ? e.message : String(e),
    durationMs: Date.now() - start
  }
}

// ── kos_query — 跨域 retrieval ────────────────────────────────────

export const kosQuery: ToolDef = {
  name: 'kos_query',
  description:
    'Hybrid retrieval across the entire personal knowledge graph (people, ' +
    'companies, projects, Notion notes, Slack threads, meeting notes, mail ' +
    'history). Returns ranked page hits with slug + title + snippet + score. ' +
    "Use when the user asks cross-context questions like \"what did Bob say " +
    'last week about X\" or \"Acme contract terms history\" — covers sources ' +
    'beyond just synced email bodies. On KOS unreachable / auth failure ' +
    'returns ok:false with E_KOS_* code so caller can fall back to ' +
    'email_search_fulltext (local FTS5).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language search query. Examples: "Bob Acme integration plan" | ' +
          '"redis migration timeline" | "Q3 OKR review feedback".'
      },
      limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
      expand: {
        type: 'boolean',
        default: false,
        description: 'Include surrounding chunks (longer snippets). Default false.'
      }
    },
    required: ['query']
  },
  confirmationTier: 'silent',
  category: 'meta',
  surface: 'webhook',
  timeoutMs: 10_000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    const q = asStr(i.query)
    if (!q) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'query is required (non-empty string)',
        durationMs: Date.now() - start
      }
    }
    try {
      const rawHits = await getClient().query(q, {
        limit: asInt(i.limit, 10, 1, 30),
        expand: typeof i.expand === 'boolean' ? i.expand : false
      })
      // Sprint 19 P1-B — client-side time-decay rerank (D5 14d half-life).
      // KOS bm25 无时间维度, 老 hit 跟新 hit 同 score; rerank 让 chat agent
      // 拿到的 hits 偏向 recent. flag-gated 让 user .env 关回纯 bm25.
      const hits = isKosTimeDecayEnabled() ? rerankByRecency(rawHits) : rawHits
      return {
        ok: true,
        output: { count: hits.length, hits },
        durationMs: Date.now() - start
      }
    } catch (e) {
      return exceptionToToolResult(e, start)
    }
  }
}

// ── kos_digest — 取 entity 档案 ───────────────────────────────────

export const kosDigest: ToolDef = {
  name: 'kos_digest',
  description:
    'Fetch a profile/digest of a specific entity by KOS slug (e.g. ' +
    'people/bob-acme, companies/acme-inc, projects/q3-okr, concepts/redis). ' +
    'Returns the top matching page including chunk_text summary, type, and ' +
    'score. Use after kos_query to drill into a specific entity, or when ' +
    "the user asks \"tell me about <person>/<company>/<project>\". " +
    'Internally runs a targeted query against the slug; returns found:false ' +
    'if KOS has no page for the slug.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'KOS page slug. Format: <namespace>/<id>. Examples: people/bob-acme | ' +
          'companies/acme-inc | projects/q3-okr | concepts/redis.'
      }
    },
    required: ['slug']
  },
  confirmationTier: 'silent',
  category: 'meta',
  surface: 'webhook',
  timeoutMs: 10_000,
  handler: async (input, _ctx): Promise<ToolResult> => {
    const start = Date.now()
    const i = (input ?? {}) as Record<string, unknown>
    const slug = asStr(i.slug)
    if (!slug) {
      return {
        ok: false,
        code: 'E_INVALID_ARG',
        message: 'slug is required (non-empty string)',
        durationMs: Date.now() - start
      }
    }
    try {
      // KOS MCP 没 dedicated /digest endpoint (2026-05-17 §6.28 cutover 后退役).
      // 用 query(slug, limit=1, expand=true) 取 slug 在 retrieval 中 top-1 hit.
      const hits = await getClient().query(slug, { limit: 1, expand: true })
      const top = hits[0]
      if (!top) {
        return {
          ok: true,
          output: { found: false, slug },
          durationMs: Date.now() - start
        }
      }
      return {
        ok: true,
        output: {
          found: true,
          slug: top.slug ?? slug,
          title: top.title,
          type: top.type,
          chunk_text: top.chunk_text,
          score: top.score
        },
        durationMs: Date.now() - start
      }
    } catch (e) {
      return exceptionToToolResult(e, start)
    }
  }
}

export const allKosTools: ToolDef[] = [kosQuery, kosDigest]
