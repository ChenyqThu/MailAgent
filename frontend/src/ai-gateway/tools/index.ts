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
import { createSendTools } from './send'
import { createMemoryTools } from './memory'
import type { GatewayApprovalMode, GatewayToolAuditCollector } from './types'

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
  /** MAILAGENT_A2UI_TOOL_CARDS (phase-04a). When on, write tools stamp the A2UI render payload
   *  into their audit row (ui_payload_json). UI/audit only — does not change the model result
   *  (off → byte-identical to 03b). */
  a2uiEnabled?: boolean
  /** MAILAGENT_AI_SDK_SEND_TOOL (phase-04b). When true, the high-risk email_prepare_send tool is
   *  added — but only if writeToolsEnabled + approvalGuard + sendSigningSecret are also present
   *  (a send tool cannot exist without its guard + token secret). Off (default) → no send tool,
   *  byte-identical to 04a. */
  sendToolEnabled?: boolean
  /** HMAC secret for the send approval token (the per-session local API token, shared with the
   *  Python serve-api). Required to build the send tool; omitted → no send tool even if enabled. */
  sendSigningSecret?: string
  /** MAILAGENT_AI_SDK_MEMORY_TOOLS (M0 — post-cutover parity restore). When true, the four memory
   *  tools are added (memory_list/get silent reads + memory_write/delete preview writes) — but the
   *  two writes need `approvalGuard` too (a write tool cannot exist without its guard), so they are
   *  only registered when the guard is present. Off (default) → no memory tools, byte-identical to
   *  the cutover tool set. Independent of writeToolsEnabled (memory has its own flag/rollback). */
  memoryToolsEnabled?: boolean
  /** Auto-approval mode (body.approvalMode, default 'always'). 'auto-reversible' lets reversible
   *  preview-tier writes (flag/archive/pin/resync + memory write/delete) execute without a card;
   *  edit-tier + the blocking send still ask. Threaded into the write + memory tools' needsApproval.
   *  Absent / 'always' → every write asks (current behaviour, byte-identical). */
  approvalMode?: GatewayApprovalMode
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
  // M0 — memory tools (post-cutover parity restore) when MAILAGENT_AI_SDK_MEMORY_TOOLS is on AND a
  // guard is supplied (memory_write/delete are preview-tier writes that need it, like email writes).
  // Independent of writeToolsEnabled — memory has its own flag/rollback. Off (or no guard) →
  // byte-identical to the cutover tool set.
  if (opts.memoryToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createMemoryTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode
      })
    )
  }
  // phase-03b — write tools only when the flag is on AND a guard is supplied. Off (or no
  // guard) → read-only, byte-identical to 03a. Approval is enforced two ways: ai@6's
  // needsApproval/signature (set at streamText) + the guard bound here (id/hash/expiry).
  if (opts.writeToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createWriteTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode
      })
    )
    // phase-04b — the high-risk send tool layers on top of the write tools (it needs the same
    // approval guard) and only when MAILAGENT_AI_SDK_SEND_TOOL is on AND a signing secret is
    // present. Off → no send tool, byte-identical to 04a.
    if (opts.sendToolEnabled && opts.sendSigningSecret) {
      Object.assign(
        tools,
        createSendTools(opts.domain, collector, opts.approvalGuard, {
          signingSecret: opts.sendSigningSecret,
          a2uiEnabled: opts.a2uiEnabled
        })
      )
    }
  }
  return tools
}
