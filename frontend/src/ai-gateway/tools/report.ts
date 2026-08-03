// Report tools (AI SDK Gateway): two reads plus one silent local-artifact write.
//
// Migrated from the legacy harness (shared/chat/tools/builtin/report.ts). report_list
// + report_get are silent reads through the domain client's /reports endpoints. The
// report_write does not run another LLM and never sends data off-device; policy class `artifact`
// keeps it silently available in every context mode.

import type { Tool } from 'ai'
import type { z } from 'zod'

import { MANUAL_CHAT_REPORT_AGENT_ID } from '../../shared/api/reportBlocks'
import type { MailAgentDomainClient } from '../python/domainClient'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import { reportGetSchema, reportListSchema, reportWriteSchema } from './schemas'

export const GATEWAY_ARTIFACT_TOOL_NAMES = ['report_write'] as const

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

/** Build the complete report surface. ``agentId`` comes from the trusted headless run context;
 * manual chat falls back to the built-in assistant identity. */
export function createReportTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  agentId: string = MANUAL_CHAT_REPORT_AGENT_ID
): Record<string, Tool> {
  const report_write = auditedReadTool(
    {
      name: 'report_write',
      description:
        'Persist a structured local report artifact in the Reports tab. mode="new" creates a new ' +
        'sequenced report (use this by default); mode="replace" updates this agent\'s stable ' +
        'destination report. Use concise blocks that improve comprehension, not decoration. ' +
        'Available blocks: header, overview, stat_row, section, email_item, key_points, callout, ' +
        'kos_context, action_suggestion, trend, divider, markdown, timeline, checklist, progress, ' +
        'quote, metric_delta, image. Use trend only for a real trend with at least 4 meaningful ' +
        'points; use markdown for free-form lists/tables/code; use timeline only for an ordered ' +
        'sequence. Images MUST use an internal /api, /assets, mailagent://, app://, or data:image ' +
        'source — arbitrary HTTP(S) images are rejected. The artifact is local, reversible, and ' +
        'written silently without an approval card.',
      inputSchema: reportWriteSchema,
      run: async (input, signal) => {
        const detail = await domain.writeCustomReport(agentId, input, signal)
        return {
          report_id: detail.id,
          title: input.title,
          mode: input.mode,
          status: detail.status,
          cadence: detail.cadence
        }
      }
    },
    collector
  )
  return { ...createReportReadTools(domain, collector), report_write }
}
