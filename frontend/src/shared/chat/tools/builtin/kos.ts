// V2.1 阶段 3 — 3b-4：KOS consumer chat tools（从 electron `chat/tools/builtin/kos.ts`
// 下沉 shared）。
//
// 9 curated tools 让 LLM 跨域检索 (人/公司/项目/Notion 手记/Slack/会议/邮件 全域知识).
// 后端原语全收敛为 platform.kosCallTool(name, args)（electron: KOSClient.callTool;
// http: serve-api POST /api/chat/kos-call 代理）—— KOS 不可达时实现侧抛带 stable code 的
// 错误 (E_KOS_*)，工具 duck-type 读 code → LLM 自然 fallback 到本地 email_search_fulltext /
// email_search_attachments 路径.
//
// Gate: createBuiltinTools 只在 platform.kosConfig().configured = true 时 push 这 9 个
// tool 进 registry（electron: isKosConsumerEnabled()，零回归注册语义）, 默认关闭.

import type { ToolDef, ToolResult } from '../registry'
import type { ChatToolPlatform } from '../../platform'
import { rerankByRecency, type QueryHit } from './kos_rerank'

// ── 小工具 ────────────────────────────────────────────────────────

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN
  if (Number.isNaN(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

/** KOS 错误 → ToolResult。electron KOSError / http 代理错误都带 stable `code`
 *  字段（E_KOS_*）；duck-type 读 code（不 import main 的 KOSError 类，守不变式 1）。
 *  无 code 的普通异常 → E_INTERNAL（self-correct 给 LLM）。 */
function exceptionToToolResult(e: unknown, start: number): ToolResult {
  const code = (e as { code?: unknown }).code
  if (e instanceof Error && typeof code === 'string') {
    return {
      ok: false,
      code,
      message: e.message,
      durationMs: Date.now() - start
    }
  }
  return {
    ok: false,
    code: 'E_INTERNAL',
    message: e instanceof Error ? e.message : String(e),
    durationMs: Date.now() - start
  }
}

// ── 通用 proxy: kosCallTool(name,args) → ToolResult ──────────────────

async function callKos(
  platform: ChatToolPlatform,
  name: string,
  args: Record<string, unknown>,
  start: number
): Promise<ToolResult> {
  try {
    const out = await platform.kosCallTool(name, args)
    return { ok: true, output: out, durationMs: Date.now() - start }
  } catch (e) {
    return exceptionToToolResult(e, start)
  }
}

/** Build the 9 KOS tools bound to the injected platform. */
export function createKosTools(platform: ChatToolPlatform): ToolDef[] {
  // ── kos_query — 跨域 retrieval ────────────────────────────────────
  const kosQuery: ToolDef = {
    name: 'kos_query',
    description:
      'Hybrid retrieval across the KOS knowledge brain. Reads UNION across 3 ' +
      'sources by default (no source needed): "default" (personal brain: people/' +
      'companies/projects/concepts/Notion notes), "mailagent-emails" (your email ' +
      'corpus), "omada" (Omada product knowledge: user guides / FAQ / synthesized ' +
      'views). Returns ranked hits with [source slug] citations + score. ' +
      'Use when an email mentions a person/company/product/tech point — query ' +
      'first to see what the brain already knows (background, history, product ' +
      'facts), then answer/reply grounded in it. ANSWER ONLY FROM RETRIEVED ' +
      'CONTENT — if nothing relevant, say so; do not fabricate. On KOS ' +
      'unreachable returns ok:false (E_KOS_*) → fall back to email_search_fulltext.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language search query. Examples: "Elkjøp PoC timeline" | ' +
            '"how to add an Omada gateway" | "vendor X contract terms".'
        },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
        expand: {
          type: 'boolean',
          default: false,
          description: 'Include surrounding chunks (longer snippets). Default false.'
        },
        source_id: {
          type: 'string',
          description:
            'Optional — restrict to one source: "default" | "mailagent-emails" | ' +
            '"omada". Omit for cross-source union (recommended).'
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
        // 复刻 KOSClient.query 的 args 构造：{query, limit, expand} + 仅有值加 source_id；
        // kosCallTool 是底层 tools/call（不做便捷方法的 Array.isArray 兜底），故工具自兜。
        const args: Record<string, unknown> = {
          query: q,
          limit: asInt(i.limit, 10, 1, 30),
          expand: typeof i.expand === 'boolean' ? i.expand : false
        }
        const sourceId = asStr(i.source_id)
        if (sourceId) args.source_id = sourceId
        const raw = await platform.kosCallTool('query', args)
        const rawHits = (Array.isArray(raw) ? raw : []) as QueryHit[]
        // Sprint 19 P1-B — client-side time-decay rerank (D5 14d half-life).
        // KOS bm25 无时间维度, 老 hit 跟新 hit 同 score; rerank 让 chat agent
        // 拿到的 hits 偏向 recent. flag-gated 让 user .env 关回纯 bm25.
        const hits = platform.kosConfig().timeDecayEnabled ? rerankByRecency(rawHits) : rawHits
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
  const kosDigest: ToolDef = {
    name: 'kos_digest',
    description:
      'Fetch a profile/digest of a specific entity by KOS slug (e.g. ' +
      'people/bob-acme, companies/acme-inc, projects/q3-okr, concepts/redis). ' +
      'Returns the top matching page including chunk_text summary, type, and ' +
      'score. Use after kos_query to drill into a specific entity, or when ' +
      'the user asks "tell me about <person>/<company>/<project>". ' +
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
        const raw = await platform.kosCallTool('query', { query: slug, limit: 1, expand: true })
        const hits = (Array.isArray(raw) ? raw : []) as QueryHit[]
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

  // ── kos_recall — per-source 热记忆 facts ──────────────────────────
  const kosRecall: ToolDef = {
    name: 'kos_recall',
    description:
      'Recall hot-memory facts the brain holds about an entity (person / company / ' +
      'project — by slug or name). Returns recent facts. Use to quickly check what ' +
      'is known about the email sender or a mentioned entity before replying.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description:
            'Entity slug or name, e.g. "people/bob-acme" or "Bob". Omit for general recent facts.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      }
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 10_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const args: Record<string, unknown> = { limit: asInt(i.limit, 20, 1, 50) }
      const entity = asStr(i.entity)
      if (entity) args.entity = entity
      return callKos(platform, 'recall', args, start)
    }
  }

  // ── kos_find_experts — 谁了解 X ───────────────────────────────────
  const kosFindExperts: ToolDef = {
    name: 'kos_find_experts',
    description:
      'Find who in the brain knows about a topic ("who knows about X"). Returns ' +
      'people ranked by relevance. Use when the user asks who to loop in / who ' +
      'owns an area.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic / area, e.g. "RADIUS portal customization" | "Elkjøp tender".'
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
      },
      required: ['topic']
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 10_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const topic = asStr(i.topic)
      if (!topic) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'topic is required',
          durationMs: Date.now() - start
        }
      }
      return callKos(platform, 'find_experts', { topic, limit: asInt(i.limit, 10, 1, 20) }, start)
    }
  }

  // ── kos_get_page — 按 slug 精确读一页 ─────────────────────────────
  const kosGetPage: ToolDef = {
    name: 'kos_get_page',
    description:
      'Read a single KOS page by exact slug (e.g. people/bob-acme, companies/elkjp, ' +
      'sources/email/51694, faq/3148-...). Use after kos_query to read a hit in full. ' +
      'Set fuzzy:true to tolerate near-miss slugs.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Exact page slug from a query hit.' },
        fuzzy: {
          type: 'boolean',
          default: false,
          description: 'Tolerate near-miss slug. Default false.'
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
          message: 'slug is required',
          durationMs: Date.now() - start
        }
      }
      const args: Record<string, unknown> = { slug }
      if (i.fuzzy === true) args.fuzzy = true
      return callKos(platform, 'get_page', args, start)
    }
  }

  // ── kos_list_skills / kos_get_skill — 发现 KOS 工作流 ──────────────
  const kosListSkills: ToolDef = {
    name: 'kos_list_skills',
    description:
      'List the named workflows (skills) the brain publishes. A skill is a prose ' +
      'instruction set teaching how to do a task with KOS tools. Use to discover ' +
      'workflows like query / idea-ingest / meeting-ingestion / enrich. Then call ' +
      'kos_get_skill to read one. Do NOT invoke whole-corpus / operator skills ' +
      '(corpus-ingest, synthesis-sweep, enrich-sweep, kos-patrol, digest-to-memory) — ' +
      'they are expensive batch jobs, not per-email actions.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Optional section filter.' }
      }
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 10_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const args: Record<string, unknown> = {}
      const section = asStr(i.section)
      if (section) args.section = section
      return callKos(platform, 'list_skills', args, start)
    }
  }

  const kosGetSkill: ToolDef = {
    name: 'kos_get_skill',
    description:
      "Fetch one skill's full instructions by name (returns body + usable_tools + " +
      'client_guidance). Then follow its steps using the KOS read tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name from kos_list_skills, e.g. "query" | "meeting-ingestion".'
        }
      },
      required: ['name']
    },
    confirmationTier: 'silent',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 10_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const name = asStr(i.name)
      if (!name) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'name is required',
          durationMs: Date.now() - start
        }
      }
      return callKos(platform, 'get_skill', { name }, start)
    }
  }

  // ── kos_extract_facts — 从一段文本抽个人知识事实 ──────────────────
  const kosExtractFacts: ToolDef = {
    name: 'kos_extract_facts',
    description:
      'Extract personal-knowledge facts from a chunk of text (e.g. the email body) ' +
      'and PERSIST them into the brain memory (default source). Returns ' +
      '{inserted, duplicate, superseded, fact_ids}. This WRITES to the brain — the ' +
      'user MUST confirm. Use to remember the key facts from an email in one shot ' +
      '(for a single deliberate page, prefer kos_put_page).',
    inputSchema: {
      type: 'object',
      properties: {
        turn_text: {
          type: 'string',
          description:
            'The text to mine facts from (e.g. the email body or a key paragraph). Edit it down to the part worth remembering.'
        }
      },
      required: ['turn_text']
    },
    confirmationTier: 'edit',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 15_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const text = asStr(i.turn_text)
      if (!text) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'turn_text is required',
          durationMs: Date.now() - start
        }
      }
      return callKos(platform, 'extract_facts', { turn_text: text }, start)
    }
  }

  // ── kos_put_page — 写回 default 个人脑 (write, 需确认) ─────────────
  const kosPutPage: ToolDef = {
    name: 'kos_put_page',
    description:
      'Write/update a page in the KOS personal brain (writes to the "default" ' +
      'source). content = markdown with YAML frontmatter. Use to persist a durable ' +
      'fact / decision / commitment learned from the email. MAKE IT TRACEABLE: note ' +
      'the source (email message-id / sender / date) in the content. Requires user ' +
      'confirmation. Does NOT write the email corpus (mailagent-emails is ' +
      'backend-producer-only). Only write when there is something genuinely worth ' +
      'keeping — when unsure, kos_query / kos_get_skill first, do not put_page blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Page slug, e.g. "people/bob-acme" | "notes/2026-q2-vendor-terms".'
        },
        content: {
          type: 'string',
          description:
            'Full markdown page content WITH YAML frontmatter. Note the source email (message-id / sender / date) for traceability.'
        }
      },
      required: ['slug', 'content']
    },
    confirmationTier: 'edit',
    category: 'meta',
    surface: 'webhook',
    timeoutMs: 15_000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const slug = asStr(i.slug)
      const content = asStr(i.content)
      if (!slug || !content) {
        return {
          ok: false,
          code: 'E_INVALID_ARG',
          message: 'slug and content are both required (non-empty strings)',
          durationMs: Date.now() - start
        }
      }
      try {
        // 复刻原 KOSClient.putPage 便捷兜底：非 object 响应包成稳定形（put_page 实际返
        // PutPageResult dict，此兜底是边界防御 —— codex review LOW）。
        const raw = await platform.kosCallTool('put_page', { slug, content })
        const out =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw
            : { slug, status: 'unknown', raw }
        return { ok: true, output: out, durationMs: Date.now() - start }
      } catch (e) {
        return exceptionToToolResult(e, start)
      }
    }
  }

  return [
    kosQuery,
    kosDigest,
    kosRecall,
    kosFindExperts,
    kosGetPage,
    kosListSkills,
    kosGetSkill,
    kosExtractFacts,
    kosPutPage
  ]
}
