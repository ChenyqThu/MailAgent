// chat-panel P4 Phase 03a — kos_query read tool (AI SDK Gateway).
//
// Migrated from the legacy harness (shared/chat/tools/builtin/kos.ts). Cross-domain
// KOS retrieval through the domain client's POST /chat/kos-call proxy, with the same
// client-side time-decay rerank as the legacy tool (rerankByRecency, gated by the
// kos time-decay flag). KOS-unreachable (E_KOS_*) surfaces as a tool-error so the
// model falls back to email_search_fulltext — identical to the legacy behaviour.

import type { Tool } from 'ai'

// rerankByRecency moved into the gateway in S3 when the legacy engine was deleted.
import { rerankByRecency, type QueryHit } from './kos_rerank'

import type { MailAgentDomainClient } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import { kosQuerySchema } from './schemas'

export interface CreateKosReadToolsOpts {
  /** Mirror of kosConfig().timeDecayEnabled — when true, kos_query reranks hits by
   *  recency (14d half-life) before returning, matching the legacy tool. */
  timeDecayEnabled?: boolean
}

/** Build the kos_query read tool bound to the injected domain client + audit collector. */
export function createKosReadTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  opts: CreateKosReadToolsOpts = {}
): Record<string, Tool> {
  const kos_query = auditedReadTool(
    {
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
        'unreachable returns a tool error (E_KOS_*) → fall back to email_search_fulltext.',
      inputSchema: kosQuerySchema,
      run: async (input, signal) => {
        // Mirror KOSClient.query arg construction: {query, limit, expand} + source_id
        // only when present (kosCall is the low-level tools/call, no convenience defaults).
        const args: Record<string, unknown> = {
          query: input.query,
          limit: input.limit,
          expand: input.expand
        }
        if (input.source_id) args.source_id = input.source_id
        const raw = await domain.kosCall('query', args, signal)
        const rawHits = (Array.isArray(raw) ? raw : []) as QueryHit[]
        // Client-side time-decay rerank (D5 14d half-life) — flag-gated, same as legacy.
        const hits = opts.timeDecayEnabled ? rerankByRecency(rawHits) : rawHits
        return { count: hits.length, hits }
      }
    },
    collector
  )

  return { kos_query }
}
