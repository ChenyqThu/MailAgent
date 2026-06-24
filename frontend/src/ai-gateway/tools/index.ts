// chat-panel P4 Phase 03a — AI SDK Gateway tool registry assembly.
//
// buildGatewayTools() composes the read-tool set (email / kos / report) bound to one
// MailAgentDomainClient, ready to hand to streamText({ tools }). The Electron wrapper
// builds this once and injects it as AiGatewayConfig.tools.
//
// 🔴 Phase 03a is READ-ONLY: write tools (email_flag/archive/draft, sync_to_notion,
//    high-risk send) are NOT built here — they land in phase-03b behind
//    MAILAGENT_AI_SDK_WRITE_TOOLS + approval. The `writeToolsEnabled` gate is wired
//    now so 03b only adds the write set; flag-off it stays read-only.

import type { ToolSet } from 'ai'

import type { MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { createEmailReadTools } from './email'
import { createKosReadTools } from './kos'
import { createReportReadTools } from './report'
import { createWriteTools } from './write'
import type { GatewayToolAuditCollector } from './types'

export interface BuildGatewayToolsOpts {
  domain: MailAgentDomainClient
  /** kosConfig().timeDecayEnabled — gates kos_query recency rerank. */
  kosTimeDecayEnabled?: boolean
  /** MAILAGENT_AI_SDK_WRITE_TOOLS (phase-03b). When false (default) the registry is
   *  read-only. When true, the five approval-gated write tools are added — but only
   *  if `approvalGuard` is also supplied (a write tool cannot exist without its guard). */
  writeToolsEnabled?: boolean
  /** The per-gateway ApprovalGuard the write tools bind to (id/hash/expiry domain guard).
   *  Required to build write tools; omitted → read-only even when writeToolsEnabled. */
  approvalGuard?: ApprovalGuard
}

/** Names of the read tools exposed by the gateway (for tests / observability). */
export const GATEWAY_READ_TOOL_NAMES = [
  'email_search',
  'email_search_fulltext',
  'email_get',
  'email_body',
  'email_list_thread',
  'email_search_attachments',
  'kos_query',
  'report_list',
  'report_get'
] as const

/** Compose the gateway tool set. 03a → read tools only. The optional `collector` is
 *  the per-request audit sink each tool's execute pushes into (closure-bound); the
 *  gateway (server.ts) creates one per /api/ai/chat request and drains it in onFinish. */
export function buildGatewayTools(
  opts: BuildGatewayToolsOpts,
  collector: GatewayToolAuditCollector = []
): ToolSet {
  const tools: ToolSet = {
    ...createEmailReadTools(opts.domain, collector),
    ...createKosReadTools(opts.domain, collector, { timeDecayEnabled: opts.kosTimeDecayEnabled }),
    ...createReportReadTools(opts.domain, collector)
  }
  // phase-03b — write tools only when the flag is on AND a guard is supplied. Off (or no
  // guard) → read-only, byte-identical to 03a. Approval is enforced two ways: ai@6's
  // needsApproval/signature (set at streamText) + the guard bound here (id/hash/expiry).
  if (opts.writeToolsEnabled && opts.approvalGuard) {
    Object.assign(tools, createWriteTools(opts.domain, collector, opts.approvalGuard))
  }
  return tools
}
