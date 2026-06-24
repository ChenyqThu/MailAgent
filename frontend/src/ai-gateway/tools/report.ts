// chat-panel P4 Phase 03a — report read tools (AI SDK Gateway).
//
// Migrated from the legacy harness (shared/chat/tools/builtin/report.ts). report_list
// + report_get are silent reads through the domain client's /reports endpoints. The
// write-class report_run (edit tier, runs the LLM) is NOT migrated here — write tools
// land in phase-03b.

import type { Tool } from 'ai'
import type { z } from 'zod'

import type { MailAgentDomainClient } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import { reportGetSchema, reportListSchema } from './schemas'

/** Build the two report read tools bound to the injected domain client + audit collector. */
export function createReportReadTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = []
): Record<string, Tool> {
  const make = <I>(opts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    run: (input: I, signal: AbortSignal | undefined) => Promise<unknown>
  }): Tool => auditedReadTool(opts, collector)

  const report_list = make({
    name: 'report_list',
    description:
      'List generated email reports (daily / weekly / monthly digests), newest first. ' +
      "Returns each report's id, cadence, report_date, status, headline, and summary counts " +
      '(total / unread / urgent / …) — NOT the full body. Use when the user asks "show my ' +
      'reports" / "what did the daily digest say" / "list this week\'s reports", then call ' +
      'report_get with an id to read one in full.',
    inputSchema: reportListSchema,
    run: async (input, signal) => {
      const items = await domain.listReports(
        { cadence: input.cadence, agentId: input.agent_id, limit: input.limit },
        signal
      )
      return { count: items.length, items }
    }
  })

  const report_get = make({
    name: 'report_get',
    description:
      'Fetch a single report in full by its report_id (from report_list), including the ' +
      'structured block document (headline, sections, per-email items, key points, callouts). ' +
      'Use after report_list when the user wants the details of a specific report. ' +
      'Returns found:false if no report has that id.',
    inputSchema: reportGetSchema,
    run: async (input, signal) => {
      const detail = await domain.getReport(input.report_id, signal)
      if (!detail) return { found: false, report_id: input.report_id }
      // Surface the canonical report id under report_id (the key the input + report_list
      // reference it by), additive to ...detail (which still carries `id`). Mirrors legacy.
      return { found: true, report_id: input.report_id, ...detail }
    }
  })

  return { report_list, report_get }
}
