// Sprint 20 — 报告 Agent (/agents 页) IPC。
//
// 三类通道，分别走不同路径（与 folder.ts 同款混合策略）：
//   • report:list / report:get — **直读 sync_store.db**（better-sqlite3, readonly,
//     热路径、无 LLM）—— 前端热路径不该 fork CLI（CLI 是给 agent 用的）。
//   • report:getConfig — 走 daemonRequest(serve-api in-process wire.resolve_agent，~ms)；
//     serve-api 不可达兜底直读 SQLite（TS 复刻 _resolve_agent：schedule 解析 / bool 还原 /
//     model 默认 / prompt is_default flag）。避开 CLI fork 的 ~秒级 Python 冷启。
//   • report:setConfig / runNow / delete / createAgent / deleteAgent — 经
//     `mailagent report` CLI fork（写需 ReportStore 白名单 + auth；runNow 跑 LLM）。
//     低频，fork 开销可接受。
// 表 schema 归 Python SyncStore._init_database (DB v19) owns。
//
// 列名严格对齐 src/reports/store.py 的 report / report_agent 表。
import { ipcMain } from 'electron'

import { getDb } from '../db'
import { callCli } from '../cli_runner'
import { daemonRequest } from '../daemon_api'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import type {
  ReportAgentConfig,
  ReportAgentCreateInput,
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

// 与 src/cli/commands/report.py:DEFAULT_REPORT_MODEL 对齐。
const _DEFAULT_REPORT_MODEL = 'claude-opus-4-8'

interface AgentRow {
  id: string
  type?: string | null
  enabled?: number | null
  title?: string | null
  schedule_json?: string | null
  window_hours?: number | null
  prompt?: string | null
  model?: string | null
  kos_enrich?: number | null
  trigger_mode?: string | null
  timezone?: string | null
  body_full_priorities?: string | null
  context_docs_json?: string | null
  fallback_models_json?: string | null
  updated_at?: number | null
}

/** report_agent 行 → ReportAgentConfig（TS 复刻 _resolve_agent）。prompt 直读原始：
 *  空 → prompt_is_default=true（前端 textarea 留空 + 提示"用内置默认 persona"），不回填
 *  默认全文（默认 persona 的 SSoT 在 src/reports/prompts.py，避免复制进 TS 漂移）。 */
function _toAgentConfig(row: AgentRow): ReportAgentConfig {
  const schedule = _parseJson<ReportAgentConfig['schedule']>(row.schedule_json, {
    cadence: 'daily',
    hours: [9]
  })
  const prompt = (row.prompt ?? '').trim()
  return {
    id: row.id,
    type: row.type || 'report',
    enabled: !!row.enabled,
    title: row.title || '',
    schedule,
    window_hours: row.window_hours ?? null,
    prompt,
    prompt_is_default: !prompt,
    model: (row.model || '').trim() || _DEFAULT_REPORT_MODEL,
    kos_enrich: !!row.kos_enrich,
    trigger_mode: row.trigger_mode === 'natural_day' ? 'natural_day' : 'rolling_24h',
    timezone: row.timezone || '',
    // body_full_priorities 落库是 JSON 字符串（priority label 数组）；解析失败 / 缺列兜底 []。
    body_full_priorities: _parseJson<string[]>(row.body_full_priorities, []),
    // v27 preprocess：文档勾选 JSON 字符串。NULL/缺列/垃圾对 preprocess 兜底运行时默认
    // ['soul','user']（与 wire.resolve_agent / get_preprocess_config 一致，codex MED）；
    // '[]'（用户显式取消全部）保留空；非 preprocess 一律 []（忽略残留列值，codex 复审）。
    context_docs:
      row.type === 'preprocess'
        ? (_parseJson<string[] | null>(row.context_docs_json, null) ?? ['soul', 'user'])
        : [],
    // v29 preprocess：行级 fallback 链。NULL/缺列/垃圾 → null（跟随全局，与 wire.resolve_agent
    // 一致——不回填默认，"跟随全局"本身就是要显示的态）；'[]' 保留空；非 preprocess 一律 null。
    fallback_models:
      row.type === 'preprocess'
        ? _parseJson<string[] | null>(row.fallback_models_json, null)
        : null,
    updated_at: row.updated_at ?? null
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

  // ── report:getConfig — agent 配置（**直读 report_agent**，TS 复刻 _resolve_agent，列表不再
  //    每次 fork CLI（旧版全 CLI 要刷 ~5s）。仅对「未自定义 prompt」的 agent 首次 fork 一次
  //    config-get 取默认全文（缓存），供配置 drawer 预填显示。失败返 []。
  ipcMain.handle('report:getConfig', async (): Promise<ReportAgentConfig[]> => {
    // V2.1 修慢: 走本机 serve-api in-process resolve（wire.resolve_agent 经
    // get_default_prompt 回填默认 prompt，~ms），取代旧 fork CLI config-get
    // （冷启 ~759ms+ 拖慢 /agents 列表）。serve-api 不可达兜底直读 SQLite
    // （prompt_is_default 的 agent prompt 留空，drawer 按需；不再 fork）。
    try {
      return await daemonRequest<ReportAgentConfig[]>('GET', '/report-agents')
    } catch (err) {
      console.warn('[report:getConfig] serve-api unreachable, fallback to direct SQLite:', err)
      try {
        const db = getDb()
        const rows = db.prepare('SELECT * FROM report_agent ORDER BY id').all() as AgentRow[]
        return rows.map(_toAgentConfig)
      } catch (e) {
        console.error('[report:getConfig] fallback read failed:', e)
        return []
      }
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

  // ── report:delete — 删一份报告（写, needs auth）。
  ipcMain.handle(
    'report:delete',
    async (_evt, reportId: unknown): Promise<WriteEnvelope<{ deleted: string }>> => {
      if (typeof reportId !== 'string' || !reportId) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'reportId required' }
      }
      return envelopeFromCli<{ deleted: string }>(
        callCli(['report', 'delete', reportId], { needsAuth: true })
      )
    }
  )

  // ── report:createAgent — 新建一行 agent 配置（写, needs auth；type='report'|'search'）。
  ipcMain.handle(
    'report:createAgent',
    async (_evt, input: unknown): Promise<WriteEnvelope<ReportAgentConfig>> => {
      const raw = (input ?? {}) as ReportAgentCreateInput
      const id = typeof raw.id === 'string' ? raw.id : ''
      if (!id) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'id required' }
      }
      const args = ['report', 'agent-create', '--id', id]
      // 默认 search（本 IPC 主用例=Custom Agent 搜索；store/serve-api 默认 report，
      // 刻意按传输端区分，勿对齐）。
      args.push('--type', raw.type ?? 'search')
      if (typeof raw.title === 'string') args.push('--title', raw.title)
      args.push(raw.enabled === false ? '--no-enabled' : '--enabled')
      if (raw.model != null) args.push('--model', raw.model)
      if (raw.prompt != null) args.push('--prompt', raw.prompt)
      if (Array.isArray(raw.tools)) args.push('--tools-json', JSON.stringify(raw.tools))
      return envelopeFromCli<ReportAgentConfig>(callCli(args, { needsAuth: true }))
    }
  )

  // ── report:deleteAgent — 删一行 agent 配置（写, needs auth）。
  ipcMain.handle(
    'report:deleteAgent',
    async (_evt, agentId: unknown): Promise<WriteEnvelope<{ deleted: string }>> => {
      if (typeof agentId !== 'string' || !agentId) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'agentId required' }
      }
      return envelopeFromCli<{ deleted: string }>(
        callCli(['report', 'agent-delete', '--agent', agentId], { needsAuth: true })
      )
    }
  )
}
