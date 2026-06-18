// Report tools — let the LLM fetch generated daily/weekly/monthly reports and
// (with confirmation) trigger a fresh report run.
//
// 后端原语经注入的 ChatToolPlatform（electron loopback + 远程都走 HttpChatPlatform →
// serve-api /api/reports/* 端点，端点已就绪，本批仅前端接线）：
//   - report_list / report_get  → platform.listReports / getReport（silent，纯读）
//   - report_run                → platform.runReport（edit tier，同步跑 LLM 数十秒）
//
// createReportTools(platform) 闭包持 toolPlatform，由 createBuiltinTools 默认装入。

import type { ToolDef, ToolResult, ToolExecCtx } from '../registry'
import type { ChatToolPlatform } from '../../platform'

// ── helpers ────────────────────────────────────────────────────────────

function ok<O>(output: O, start: number): ToolResult<O> {
  return { ok: true, output, durationMs: Date.now() - start }
}

function err(code: string, message: string, start: number): ToolResult {
  return { ok: false, code, message, durationMs: Date.now() - start }
}

function asStr(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined
}

function asInt(x: unknown, def: number, min: number, max: number): number {
  const n = typeof x === 'number' ? Math.floor(x) : NaN
  if (Number.isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

type Cadence = 'daily' | 'weekly' | 'monthly'

function asCadence(x: unknown): Cadence | undefined {
  return x === 'daily' || x === 'weekly' || x === 'monthly' ? x : undefined
}

/** Resolve the effective input for an edit-tier tool (user may have edited the
 *  proposal in the ConfirmToolDialog). Mirrors write.ts::effective. */
function effective(input: unknown, ctx: ToolExecCtx): { resolved: unknown; userEdited: boolean } {
  if (ctx.userEditedInput !== undefined) {
    return { resolved: ctx.userEditedInput, userEdited: true }
  }
  return { resolved: input, userEdited: false }
}

/** Build the 3 report tools bound to the injected platform. */
export function createReportTools(platform: ChatToolPlatform): ToolDef[] {
  // ── 1. report_list — list generated reports ──────────────────────────────
  const reportList: ToolDef = {
    name: 'report_list',
    description:
      'List generated email reports (daily / weekly / monthly digests), newest first. ' +
      "Returns each report's id, cadence, report_date, status, headline, and summary counts " +
      '(total / unread / urgent / …) — NOT the full body. Use when the user asks "show my ' +
      'reports" / "what did the daily digest say" / "list this week\'s reports", then call ' +
      'report_get with an id to read one in full.',
    inputSchema: {
      type: 'object',
      properties: {
        cadence: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly'],
          description: 'Optional — restrict to one cadence. Omit for all.'
        },
        agent_id: {
          type: 'string',
          description: "Optional — restrict to one report agent's output."
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: []
    },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      try {
        const items = await platform.listReports({
          cadence: asCadence(i.cadence),
          agentId: asStr(i.agent_id),
          limit: asInt(i.limit, 20, 1, 100)
        })
        return ok({ count: items.length, items }, start)
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 2. report_get — full report detail (with doc blocks) ─────────────────
  const reportGet: ToolDef = {
    name: 'report_get',
    description:
      'Fetch a single report in full by its report_id (from report_list), including the ' +
      'structured block document (headline, sections, per-email items, key points, callouts). ' +
      'Use after report_list when the user wants the details of a specific report. ' +
      'Returns found:false if no report has that id.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: {
          type: 'string',
          description: 'The report id from a report_list result (e.g. "daily:daily:2026-06-01").'
        }
      },
      required: ['report_id']
    },
    confirmationTier: 'silent',
    category: 'read',
    surface: 'ipc',
    timeoutMs: 6000,
    handler: async (input, _ctx): Promise<ToolResult> => {
      const start = Date.now()
      const i = (input ?? {}) as Record<string, unknown>
      const id = asStr(i.report_id)
      if (!id) return err('E_INVALID_ARG', 'report_id is required (non-empty string)', start)
      try {
        const detail = await platform.getReport(id)
        if (!detail) return ok({ found: false, report_id: id }, start)
        return ok({ found: true, ...detail }, start)
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  // ── 3. report_run — generate a fresh report now (runs the LLM) ───────────
  const reportRun: ToolDef = {
    name: 'report_run',
    description:
      'Generate a fresh report right now for the given report agent (runs the LLM over the ' +
      'agent\'s email window — can take tens of seconds). Use when the user asks to "run the ' +
      'daily report now" / "regenerate this week\'s digest". The user confirms before it runs ' +
      "(edit tier — they can change the agent_id / cadence). Returns the new report's id + " +
      'status + headline; call report_get with that id to read it.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The report agent to run (its id from report_list / the /agents config).'
        },
        cadence: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly'],
          description:
            "Optional — override the agent's default cadence for this one run. Omit to use the " +
            "agent's configured cadence."
        }
      },
      required: ['agent_id']
    },
    confirmationTier: 'edit',
    category: 'write',
    surface: 'ipc',
    // Synchronous LLM run server-side — give it a generous budget (matches the
    // serve-api /run endpoint which awaits run_report_once).
    timeoutMs: 120_000,
    throttlePerMinute: 3,
    handler: async (input, ctx): Promise<ToolResult> => {
      const start = Date.now()
      const { resolved, userEdited } = effective(input, ctx)
      const i = (resolved ?? {}) as Record<string, unknown>
      const agentId = asStr(i.agent_id)
      if (!agentId) return err('E_INVALID_ARG', 'agent_id is required (non-empty string)', start)
      const cadence = asCadence(i.cadence)
      try {
        const result = await platform.runReport(agentId, cadence)
        return ok({ ...result, user_edited: userEdited }, start)
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'E_INTERNAL'
        return err(code, e instanceof Error ? e.message : String(e), start)
      }
    }
  }

  return [reportList, reportGet, reportRun]
}
