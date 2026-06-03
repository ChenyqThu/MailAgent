// Sprint 20 — 报告 Agent (/agents 页) IPC。
//
// 两类通道，分别走两条路径（与 folder.ts 同款混合策略）：
//   • report:list / report:get — **直读 sync_store.db**（better-sqlite3, readonly,
//     热路径、无 LLM）。表 schema 归 Python SyncStore._init_database (DB v18) owns。
//   • report:getConfig / setConfig / runNow — 经 `mailagent report` CLI fork
//     （需 Python 解析默认 prompt / 跑 LLM / 走 ReportStore 白名单）。
//
// 列名严格对齐 src/reports/store.py 的 report / report_agent 表。
import { ipcMain } from 'electron'

import { getDb } from '../db'
import { callCli } from '../cli_runner'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import type {
  ReportAgentConfig,
  ReportConfigPatch,
  ReportCounts,
  ReportDetail,
  ReportDoc,
  ReportListItem,
  ReportRunResult
} from '../../../shared/api/types'

// runNow 跑一次 LLM 报告，给足超时（claude 限流 fallback gpt 也要时间）。
const RUN_TIMEOUT_MS = 180_000

const _LIST_COLS =
  'id, agent_id, cadence, report_date, window_start, window_end, status, ' +
  'counts_json, headline, model, input_tokens, output_tokens, cost_usd, ' +
  'error, created_at, generated_at'

function _parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

interface ReportRow {
  counts_json?: string | null
  blocks_json?: string | null
  [k: string]: unknown
}

/** DB 行 → ReportListItem（counts_json 解析；剔除重字段）。 */
function _toListItem(row: ReportRow): ReportListItem {
  const { counts_json, ...rest } = row
  return {
    ...(rest as unknown as Omit<ReportListItem, 'counts'>),
    counts: _parseJson<ReportCounts>(counts_json, {})
  }
}

export function registerReportHandlers(): void {
  // ── report:list — 报告列表（不含 blocks_json）。失败返 []。
  ipcMain.handle(
    'report:list',
    async (
      _evt,
      opts?: { cadence?: string; agentId?: string; limit?: number }
    ): Promise<ReportListItem[]> => {
      try {
        const db = getDb()
        const where: string[] = []
        const params: unknown[] = []
        if (opts?.cadence) {
          where.push('cadence = ?')
          params.push(opts.cadence)
        }
        if (opts?.agentId) {
          where.push('agent_id = ?')
          params.push(opts.agentId)
        }
        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''
        const limit = Number.isInteger(opts?.limit) ? (opts!.limit as number) : 50
        const rows = db
          .prepare(
            `SELECT ${_LIST_COLS} FROM report${whereSql} ` +
              `ORDER BY report_date DESC, created_at DESC LIMIT ?`
          )
          .all(...params, limit) as ReportRow[]
        return rows.map(_toListItem)
      } catch (err) {
        console.error('[report:list] read failed:', err)
        return []
      }
    }
  )

  // ── report:get — 单份报告（含 blocks_json → doc）。不存在 / 失败返 null。
  ipcMain.handle('report:get', async (_evt, reportId: unknown): Promise<ReportDetail | null> => {
    if (typeof reportId !== 'string' || reportId.length === 0) return null
    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM report WHERE id = ?').get(reportId) as
        | ReportRow
        | undefined
      if (!row) return null
      const { blocks_json, ...rest } = row
      return {
        ..._toListItem(rest as ReportRow),
        doc: _parseJson<ReportDoc | null>(blocks_json, null)
      }
    } catch (err) {
      console.error('[report:get] read failed:', err)
      return null
    }
  })

  // ── report:getConfig — agent 配置（CLI: 解析默认 prompt + schedule）。失败返 []。
  ipcMain.handle('report:getConfig', async (): Promise<ReportAgentConfig[]> => {
    try {
      const data = await callCli(['report', 'config-get'], { needsAuth: false })
      return Array.isArray(data) ? (data as ReportAgentConfig[]) : []
    } catch (err) {
      console.error('[report:getConfig] CLI failed:', err)
      return []
    }
  })

  // ── report:setConfig — 部分更新（写, needs auth）。
  ipcMain.handle(
    'report:setConfig',
    async (_evt, agentId: unknown, patch: unknown): Promise<WriteEnvelope<ReportAgentConfig>> => {
      if (typeof agentId !== 'string' || !agentId) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'agentId required' }
      }
      const patchJson = JSON.stringify((patch ?? {}) as ReportConfigPatch)
      return envelopeFromCli<ReportAgentConfig>(
        callCli(['report', 'config-set', '--agent', agentId, '--patch', patchJson], {
          needsAuth: true
        })
      )
    }
  )

  // ── report:runNow — 立即生成（写, needs auth, 跑 LLM）。
  ipcMain.handle(
    'report:runNow',
    async (
      _evt,
      agentId: unknown,
      opts?: { cadence?: string }
    ): Promise<WriteEnvelope<ReportRunResult>> => {
      if (typeof agentId !== 'string' || !agentId) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'agentId required' }
      }
      const args = ['report', 'run', '--agent', agentId]
      if (opts?.cadence) args.push('--cadence', opts.cadence)
      return envelopeFromCli<ReportRunResult>(
        callCli(args, { needsAuth: true, timeoutMs: RUN_TIMEOUT_MS })
      )
    }
  )
}
