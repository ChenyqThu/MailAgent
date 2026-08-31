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
import { daemonRequest, daemonRequestWithMeta } from '../daemon_api'
import { envelopeFromCli, type WriteEnvelope } from '../lib/envelope'
import { clampReportPage } from './reportPage'
import type {
  AgentRunListItem,
  AgentRunPendingCount,
  AgentRunStep,
  AgentRunToolOptions,
  CustomAgentBudget,
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportAgentCreateInput,
  ReportConfigPatch,
  ReportCounts,
  ReportDetail,
  ReportDoc,
  ReportListItem,
  ReportPagedResult,
  ReportRunResult,
  ProjectProgressRunItem
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
  mark_read_after_processing?: number | null
  context_source?: string | null
  // v30 custom agent 三列（仅 type='custom' 解析，对齐 wire.resolve_agent）。
  trigger_json?: string | null
  tool_policy_json?: string | null
  budget_json?: string | null
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
  // v30 custom agent：仅 type='custom' 解析 tool_policy/budget（对齐 wire.resolve_agent 的
  // _is_custom 门控），其余 type 恒 null。NULL/非法 JSON → null（不回填默认）。
  const isCustom = (row.type || 'report') === 'custom'
  // v31 project_progress 单例行也用 trigger_json 存触发配置（email_filter 词汇，运行时走
  // ProjectProgressDetector 子串匹配）→ 投影 trigger 供 Settings 抽屉读 sender/subject
  // （对齐 wire.resolve_agent 的 _projects_trigger）。tool_policy/budget 仍 custom-only。
  const projectsTrigger = isCustom || (row.type || 'report') === 'project_progress'
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
    // v27 文档勾选 JSON 字符串（preprocess + report 增量 2）。NULL/缺列/垃圾兜底运行时默认
    // ['soul','user']（与 wire.resolve_agent / get_preprocess_config 一致，codex MED）；
    // '[]'（用户显式取消全部）保留空；search 一律 []（忽略残留列值，codex 复审）。
    context_docs:
      row.type === 'preprocess' || row.type === 'report'
        ? (_parseJson<string[] | null>(row.context_docs_json, null) ?? ['soul', 'user'])
        : [],
    // v29 preprocess：行级 fallback 链。NULL/缺列/垃圾 → null（跟随全局，与 wire.resolve_agent
    // 一致——不回填默认，"跟随全局"本身就是要显示的态）；'[]' 保留空；非 preprocess 一律 null。
    fallback_models:
      row.type === 'preprocess'
        ? _parseJson<string[] | null>(row.fallback_models_json, null)
        : null,
    // v32 preprocess：NULL/缺列默认 true，保持升级前行为；非 preprocess 也投影 true 保持类型稳定。
    mark_read_after_processing:
      row.type === 'preprocess' ? row.mark_read_after_processing !== 0 : true,
    // v38 preprocess：参考上下文源。合法枚举原样投影；NULL/野值 → null（前端 deriveContextSource
    // 按 LLM_CONTEXT_PAGE_ID 继承派生显示态，与 wire.resolve_agent / 后端 _resolve_context_source
    // 一致）；非 preprocess 恒 null。
    context_source:
      row.type === 'preprocess' &&
      (row.context_source === 'standing_docs' || row.context_source === 'notion_context')
        ? row.context_source
        : null,
    // v30/v31：trigger 对 custom + project_progress 解析（其余恒 null）；tool_policy/budget 仅 custom。
    trigger: projectsTrigger ? _parseJson<CustomAgentTrigger | null>(row.trigger_json, null) : null,
    tool_policy: isCustom
      ? _parseJson<CustomAgentToolPolicy | null>(row.tool_policy_json, null)
      : null,
    budget: isCustom ? _parseJson<CustomAgentBudget | null>(row.budget_json, null) : null,
    updated_at: row.updated_at ?? null
  }
}

export function registerReportHandlers(): void {
  // ── report:list — 报告列表（不含 blocks_json）。失败返 { items: [], total: 0 }。
  //    task 07-21：加 offset 分页 + total（同 cadence/agentId filter 的 COUNT(*)），
  //    与 serve-api GET /api/reports（meta.total）parity。
  ipcMain.handle(
    'report:list',
    async (
      _evt,
      opts?: { cadence?: string; agentId?: string; limit?: number; offset?: number }
    ): Promise<ReportPagedResult<ReportListItem>> => {
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
        // codex LOW-1 — clamp to the SAME bounds serve-api enforces (GET /api/reports:
        // limit Query(50, ge=1, le=200), offset Query(0, ge=0)) via the pure clampReportPage
        // helper, so the two transports agree on page shape and a bogus IPC arg can't run an
        // unbounded / negative-offset query.
        const { limit, offset } = clampReportPage({ limit: opts?.limit, offset: opts?.offset })
        const rows = db
          .prepare(
            `SELECT ${_LIST_COLS} FROM report${whereSql} ` +
              `ORDER BY report_date DESC, created_at DESC LIMIT ? OFFSET ?`
          )
          .all(...params, limit, offset) as ReportRow[]
        const totalRow = db
          .prepare(`SELECT COUNT(*) AS n FROM report${whereSql}`)
          .get(...params) as { n: number }
        return { items: rows.map(_toListItem), total: totalRow.n }
      } catch (err) {
        console.error('[report:list] read failed:', err)
        return { items: [], total: 0 }
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
      opts?: { cadence?: string; type?: string }
    ): Promise<WriteEnvelope<ReportRunResult>> => {
      if (typeof agentId !== 'string' || !agentId) {
        return { ok: false, code: 'E_INVALID_ARG', message: 'agentId required' }
      }
      // S5：custom agent 的 run-now 是 enqueue 一次 headless run（async job → AgentRunWorker
      // 消费），走 serve-api POST /report-agents/{id}/run 返 { jobId }，**不**走 report-only 的
      // CLI 同步生成 fork。flag off → serve-api 404 → 转 error envelope（不静默成功）。
      if (opts?.type === 'custom') {
        try {
          const res = await daemonRequest<{ jobId?: number }>(
            'POST',
            `/report-agents/${encodeURIComponent(agentId)}/run`,
            { body: {} }
          )
          return {
            ok: true,
            data: { report_id: String(res.jobId ?? ''), status: 'generating', headline: '' }
          }
        } catch (err) {
          const code = (err as { code?: string })?.code
          const message = (err as { message?: string })?.message
          return {
            ok: false,
            code: code ?? 'E_RUN_FAILED',
            message: message ?? 'run enqueue failed'
          }
        }
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
      // 缺省 = 关。桌面此前是 `!== false ⇒ --enabled`（缺省开），与 web
      // （HttpApi 丢键 → serve-api `bool(raw.get("enabled", False))` ⇒ 关）相反 ——
      // 同一个「新建 agent」动作在两个传输端默认值相反是潜伏雷（审计 P2#4）。
      // 取「关」是因为另外两层都这么定：store.create_agent 的 `enabled=False`
      // 默认 + 本仓惯例（种子 daily 默认关）。现有两个调用方
      // （CustomAgentDrawer / SearchConfigDrawer）都显式传值，行为不变。
      args.push(raw.enabled === true ? '--enabled' : '--no-enabled')
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

  // ── report:listRuns — S5 custom agent run 历史（读，走 serve-api GET /agent-runs）。
  //    state 由后端 derive_agent_run_state 单源投影（前端不推导）。flag off → serve-api 404 →
  //    catch 返 { items: [], total: 0 }（守 ReportApi「读失败返空」契约；不 fallback 直读
  //    SQLite——读态推导只有 Python 一处权威，绝不在 TS 重造第二套 status 映射）。
  //    task 07-21：加 offset 分页透传 + total（来自 serve-api meta.total，经 daemonRequestWithMeta
  //    不丢弃 meta），与 serve-api parity。
  ipcMain.handle(
    'report:listRuns',
    async (
      _evt,
      opts?: { agentId?: string; limit?: number; offset?: number; state?: string }
    ): Promise<ReportPagedResult<AgentRunListItem>> => {
      try {
        const { data, meta } = await daemonRequestWithMeta<AgentRunListItem[]>(
          'GET',
          '/agent-runs',
          {
            query: {
              agentId: opts?.agentId,
              limit: opts?.limit,
              offset: opts?.offset,
              state: opts?.state
            }
          }
        )
        return { items: data, total: typeof meta.total === 'number' ? meta.total : data.length }
      } catch (err) {
        console.warn('[report:listRuns] serve-api unreachable / flag off:', err)
        return { items: [], total: 0 }
      }
    }
  )

  // ── report:pendingCount — S6 W1 待审批（paused_pending）计数（读，走 serve-api
  //    GET /agent-runs/pending-count）。P5 红点链轮询数据源；只计 live 可批的 paused_pending。
  //    flag off → serve-api 404 → catch 返零计数（守读优雅降级，红点不渲染；读态推导权威仍在
  //    Python 一处，TS 绝不重造 status 映射）。
  ipcMain.handle('report:pendingCount', async (): Promise<AgentRunPendingCount> => {
    try {
      return await daemonRequest<AgentRunPendingCount>('GET', '/agent-runs/pending-count')
    } catch (err) {
      console.warn('[report:pendingCount] serve-api unreachable / flag off:', err)
      return { total: 0, byAgent: {} }
    }
  })

  // ── report:toolOptions — S5 custom agent allowed_tools 可选清单（读，走 serve-api
  //    GET /agent-runs/tool-options）。工具集 + 默认勾选由后端权威投影（前端不硬编码工具名）。
  //    flag off / 端点未就绪 → catch 返空清单（守读优雅降级）。
  ipcMain.handle('report:toolOptions', async (): Promise<AgentRunToolOptions> => {
    try {
      return await daemonRequest<AgentRunToolOptions>('GET', '/agent-runs/tool-options')
    } catch (err) {
      console.warn('[report:toolOptions] serve-api unreachable / flag off:', err)
      return { tools: [], defaults: [] }
    }
  })

  // ── report:projectProgressRuns — R5 项目周报同步执行历史（读，走 serve-api
  //    GET /project-progress/runs）。确定性 Python 同步脚本产物（自有 status 词表），不属
  //    custom agent 的 async_jobs run 体系。serve-api 不可达 → catch 返 []（守读优雅降级）。
  ipcMain.handle(
    'report:projectProgressRuns',
    async (_evt, limit?: number): Promise<ProjectProgressRunItem[]> => {
      try {
        return await daemonRequest<ProjectProgressRunItem[]>('GET', '/project-progress/runs', {
          query: { limit }
        })
      } catch (err) {
        console.warn('[report:projectProgressRuns] serve-api unreachable:', err)
        return []
      }
    }
  )

  // ── report:runLogSteps — 08-31 执行台账过程节点（读，走 serve-api
  //    GET /agent-runs/run-log/{id}/steps）。报告 / 画像 / 项目周报三位不走 gateway headless
  //    （无 session 可读），过程记在 agent_run_step；前端合成 transcript 后与会话共用渲染器。
  //    端点未就绪 / 不可达 → catch 返 []（详情退回「这次运行没有产生任何输出」，不崩）。
  ipcMain.handle('report:runLogSteps', async (_evt, runLogId: unknown): Promise<AgentRunStep[]> => {
    if (typeof runLogId !== 'number' || !Number.isFinite(runLogId)) return []
    try {
      const res = await daemonRequest<{ steps?: AgentRunStep[] }>(
        'GET',
        `/agent-runs/run-log/${runLogId}/steps`
      )
      return res.steps ?? []
    } catch (err) {
      console.warn('[report:runLogSteps] serve-api unreachable / 端点未就绪:', err)
      return []
    }
  })
}
