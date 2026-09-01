// ──── Report Agent (Sprint 20 — /agents 页) ────────────────────────────────
// ReportDoc 块模型契约，与 Python src/reports/models.py + docs/report-agent-
// frontend-handoff.md §5 + agents/CHANGES-vs-PRD.md §2 1:1 对齐。
// **改字段名必须同步改后端 models.py + handoff 文档**。

import type { BotAvatarBotConfig } from '@shared/bot-avatar/types'

export type ReportTone = 'neutral' | 'info' | 'success' | 'warn' | 'critical'
export type ReportCadence = 'daily' | 'weekly' | 'monthly' | 'custom'
export type ReportStatus = 'generating' | 'ready' | 'empty' | 'failed' | 'skipped'

export interface ReportHeaderBlock {
  type: 'header'
  title: string
  subtitle?: string
  date_label?: string
}
export interface ReportOverviewBlock {
  type: 'overview'
  text: string
}
export interface ReportStat {
  key: string
  label: string
  value: number
  tone: ReportTone
}
export interface ReportStatRowBlock {
  type: 'stat_row'
  stats: ReportStat[]
}
export interface ReportSectionBlock {
  type: 'section'
  id: string
  title: string
  icon?: string
  intro?: string
  /** CHANGES-vs-PRD §2 — 本组整体汇总（含 [文本](#email-<id>) 跳转 + **bold**）。 */
  summary?: string
}
export interface ReportEmailSource {
  notion_url: string | null
  app_deeplink: string
}
export interface ReportEmailItemBlock {
  type: 'email_item'
  internal_id: number
  subject: string
  sender_name: string
  time: string
  sender_addr?: string
  category?: string
  priority?: string
  ai_summary?: string
  ai_action?: string
  source: ReportEmailSource
  badges?: string[]
}
export interface ReportKeyPointsBlock {
  type: 'key_points'
  items: string[]
  title?: string
}
export interface ReportCalloutBlock {
  type: 'callout'
  tone: ReportTone
  body: string
  title?: string
}
export interface ReportKosContextBlock {
  type: 'kos_context'
  entity_slug: string
  title: string
  snippet: string
  source: string
}
export interface ReportActionSuggestionBlock {
  type: 'action_suggestion'
  id: string
  title: string
  internal_ids: number[]
  action_type: string
  enabled: boolean
  detail?: string
}
export interface ReportTrendPoint {
  label: string
  value: number
}
export interface ReportTrendBlock {
  type: 'trend'
  metric: string
  points: ReportTrendPoint[]
  compare?: { label: string; delta: number }
  variant?: 'bar' | 'line' | 'area'
}
export interface ReportDividerBlock {
  type: 'divider'
}
export interface ReportMarkdownBlock {
  type: 'markdown'
  title?: string
  text: string
}
export interface ReportTimelineBlock {
  type: 'timeline'
  title?: string
  events: Array<{
    time: string
    title: string
    detail?: string
    tone?: ReportTone
    icon?: string
  }>
}
export interface ReportChecklistBlock {
  type: 'checklist'
  title?: string
  items: Array<{ text: string; done: boolean; tone?: ReportTone }>
}
export interface ReportProgressBlock {
  type: 'progress'
  label: string
  title?: string
  value: number
  max?: number
  tone?: ReportTone
  caption?: string
}
export interface ReportQuoteBlock {
  type: 'quote'
  text: string
  cite?: string
  url?: string
}
export interface ReportMetricDeltaBlock {
  type: 'metric_delta'
  label: string
  title?: string
  value: string
  delta: number
  deltaLabel?: string
  tone?: ReportTone
}
export interface ReportImageBlock {
  type: 'image'
  src: string
  title?: string
  alt?: string
  caption?: string
  width?: number
}
/** S5 事项进展条目。`status` / `health` / `priority` 是 matter 域原始枚举字面量
 *  （`MatterStatus` / `MatterHealth` / `MatterPriority` 的值域，用 string 承接以便后端
 *  加值时优雅降级）；`due_at` 是 epoch **毫秒**；`deeplink` 是稳定标识形
 *  （`mailagent://matter/<public_id>`，报告页内点击走 router 导航）。 */
export interface ReportMatterItemBlock {
  type: 'matter_item'
  public_id: string
  title: string
  status: string
  health: string
  priority: string
  deeplink: string
  due_at?: number
  summary?: string
  progress?: { done: number; total: number }
  waiting_on?: string[]
  next_action?: string
  signal_count?: number
}
/** 未知 block 优雅降级（BlockRenderer 渲染 UnknownBlock）。 */
export interface ReportUnknownBlock {
  type: string
  [k: string]: unknown
}
export type ReportBlock =
  | ReportHeaderBlock
  | ReportOverviewBlock
  | ReportStatRowBlock
  | ReportSectionBlock
  | ReportEmailItemBlock
  | ReportKeyPointsBlock
  | ReportCalloutBlock
  | ReportKosContextBlock
  | ReportActionSuggestionBlock
  | ReportTrendBlock
  | ReportDividerBlock
  | ReportMarkdownBlock
  | ReportTimelineBlock
  | ReportChecklistBlock
  | ReportProgressBlock
  | ReportQuoteBlock
  | ReportMetricDeltaBlock
  | ReportImageBlock
  | ReportMatterItemBlock
  | ReportUnknownBlock

export interface ReportDoc {
  version: number
  agent_id: string
  cadence: ReportCadence
  report_date: string
  window: { start: string; end: string }
  generated_at: string
  model: string
  blocks: ReportBlock[]
}

export interface ReportCounts {
  total?: number
  unread?: number
  urgent?: number
  ai_handled?: number
  todo?: number
  /** 已回复（同 thread 有更晚发件箱邮件）。 */
  replied?: number
  /** 已发出（本窗口发件箱邮件数）。 */
  sent?: number
  /** 已标旗。 */
  flagged?: number
  by_category?: Record<string, number>
}

/** report:list 行（不含 blocks，热路径直读 sync_store.db）。 */
export interface ReportListItem {
  id: string
  agent_id: string
  cadence: ReportCadence
  report_date: string
  window_start: string
  window_end: string
  status: ReportStatus
  counts: ReportCounts
  headline: string
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  error: string | null
  created_at: number | null
  generated_at: number | null
}

/** report:get — 完整行 + 解析后的 doc。 */
export interface ReportDetail extends ReportListItem {
  doc: ReportDoc | null
}

/** 07-24 排程统一（契约 `research/schedule-contract.md` §1）：结构化 recurrence 规则。
 *  两处共用 —— custom agent 的 `trigger_json`（`kind:'schedule'` 与老 `kind:'cron'` 并存）
 *  与报告 agent 的 `schedule_json`（叠加在 cadence/hours 等 legacy 镜像键之上）。
 *  🔴 weekdays / weekday 是**契约口径 0=周日**，不是 Python `weekday()` 的 0=周一。 */
export interface ScheduleRuleWire {
  freq: 'daily' | 'weekly' | 'monthly'
  interval: number
  weekdays: number[]
  monthMode: 'date' | 'nth'
  monthDay: number
  ordinal: number | 'last'
  weekday: number
  hour: number
  minute: number
  clamp: boolean
}

export interface ReportSchedule {
  /** 🔴 报告侧 cadence 不只是节奏，还是**报告内容种类**（worker 的聚合窗 / 去重主键 /
   *  层级聚合分支都读它）；新形状下恒同步为 `rule.freq`，不可省。 */
  cadence: ReportCadence
  hours: number[]
  /** legacy 镜像，**Python weekday 口径 0=周一**。`kind:'schedule'` 在场时 `rule` 权威。 */
  weekday?: number
  /** legacy 镜像。`kind:'schedule'` 在场时 `rule` 权威。 */
  day_of_month?: number
  v?: 1
  kind?: 'schedule'
  rule?: ScheduleRuleWire
  /** 相位原点，本地日历日期 `YYYY-MM-DD`（在 `timezone` 里解释）。 */
  anchor?: string
  /** IANA 时区；新形状下不允许为空（老行空时区读时写实成宿主机时区）。 */
  timezone?: string
}

/** report:getConfig — 解析后的 agent 配置（prompt 缺省已回填默认）。 */
/** v30 Custom Agent（S4）触发判别式：cron（定时）| email_filter（邮件事件）。
 *  后端 src/agents/trigger.py 是校验权威；前端类型仅供未来 CRUD UI（W1 无 UI 消费）。 */
export type CustomAgentTrigger =
  | { v: 1; kind: 'cron'; cron: string; timezone?: string }
  /** 07-24 排程统一：结构化 recurrence（与 `kind:'cron'` 并存，老行照旧走 croniter）。 */
  | {
      v: 1
      kind: 'schedule'
      rule: ScheduleRuleWire
      anchor: string
      timezone: string
    }
  | {
      v: 1
      kind: 'email_filter'
      subject_pattern?: string
      sender_pattern?: string
      folders?: string[]
      thread_ids?: string[]
    }
  | {
      v: 1
      kind: 'calendar_event_change'
      title_pattern?: string
      organizer_pattern?: string
      attendee_pattern?: string
      calendar_ids?: string[]
    }
  | {
      v: 1
      kind: 'calendar_before_start'
      lead_seconds: number
      title_pattern?: string
      organizer_pattern?: string
      attendee_pattern?: string
      calendar_ids?: string[]
    }

/** WP6「联系人画像」单例行的 trigger_json —— **不是** `CustomAgentTrigger` 判别式，
 *  是与 project_progress 同类的「拿 trigger_json 当自由配置列」用法：字面存每日批处理
 *  时刻与每轮人数上限，运行时由 `src/contacts/profile_config.py` 行内热读，不进
 *  `parse_trigger`（PUT /report-agents 不深校验 trigger，见 routers/reports.py::set_config）。
 *  🔴 整列覆写不是 merge：写的时候**每个字段都必须一起给**（少给一个就把它抹成缺省）。
 *
 *  只加进 `ReportConfigPatch`（写面）**不加进 `ReportAgentConfig`**（读面）：读面那个
 *  union 有十来处消费方按 `.v` / `.kind` 判别式收窄，把一个没有判别字段的成员塞进去会
 *  让每一处都失去收窄。读侧由 `settings/ContactProfileSettings::readSchedule` 就地做运行时
 *  形状检查 —— 那本来也是唯一知道这行是 contact_profile 的地方。 */
export interface ContactProfileTrigger {
  fire_hour: number
  daily_limit: number
  /** 生成画像前先查此人的 KOS（gbrain）wiki 作背景参考。
   *  🔴 **缺字段默认 true**（读侧回落，与后端同口径）—— 老行没有这个字段，读成 false 会让
   *  一个从没被关过的开关在界面上显示成「关着」。写侧恒给（整列覆写）。 */
  use_kos: boolean
}

/** v2「通讯录治理」单例行的 trigger_json —— 与上面的画像 trigger 同款用法（字面配置列，
 *  不进 `parse_trigger`），但**没有「每轮人数上限」**：治理扫描一次跑完增量、不按人计费。
 *  🔴 同样是整列覆写不是 merge —— 两个字段都要按整列写。
 *  读侧的运行时形状检查在 `settings/ContactGovernanceSettings::readTrigger`（同上，读面
 *  union 不收它，免得毁掉十来处按判别式的收窄）。 */
export interface ContactGovernanceTrigger {
  fire_hour: number
  /** 治理扫描先查此人的 KOS（gbrain）wiki 再提身份建议。缺字段默认 true（同上）。 */
  use_kos: boolean
}

export type CustomAgentTriggerV2Entry = CustomAgentTrigger extends infer Trigger
  ? Trigger extends { v: 1 }
    ? Omit<Trigger, 'v'> & { id?: string; enabled: boolean }
    : never
  : never

export interface TriggerSetV2 {
  v: 2
  triggers: CustomAgentTriggerV2Entry[]
}

/** v30 Custom Agent 工具收窄（矩阵地板之后的 allowed_tools 交集；null/缺失 = 不额外收窄）。 */
export interface CustomAgentToolPolicy {
  v: 1
  allowed_tools?: string[]
  /** S5 ADR-004 D2 — per-agent exec 矩阵例外 opt-in（缺省 = false）。true 时该 agent 的
   *  headless run 注册 exec 工具面；免卡仍需白名单规则命中 + 首跑闸（三重闸）。 */
  grant_exec?: boolean
  /** S6 W3 ADR-004 rev3.1 §3.1 — per-agent web 三档（缺省 = 'off'）：off=web 工具 headless
   *  不注册；gated=注册 + web_fetch 仅域名白名单免卡；open=任意 URL 免卡（高危，UI 红样式）。 */
  grant_web?: 'off' | 'gated' | 'open'
  /** S6 W3 rev3.1 §3.2 — per-agent skill 挂载列表（收窄面）。缺失/null = 默认挂载集
   *  ("email","search")；[] = 显式零挂载。 */
  skills?: string[]
  /** MCP connector 阶段 1 PR3 — per-connector crud 天花板（{connector_id: 'read'|'write'|'update'}）。
   *  缺失/{} = 该 agent 未授权任何 connector（headless 侧整族不注册）。`'delete'` 不在值域内，
   *  服务端 parse_tool_policy 校验拒绝（400）——不是读侧宽容。 */
  grant_connectors?: Record<string, 'read' | 'write' | 'update'>
}

/** Custom Agent 预算两门（null/缺失 = 全默认；旧 max_steps 由后端忽略）。 */
export interface CustomAgentBudget {
  v: 1
  max_runs_per_day?: number
  max_run_seconds?: number
}

export interface ReportAgentConfig {
  id: string
  type: string
  enabled: boolean
  title: string
  description?: string | null
  schedule: ReportSchedule
  window_hours: number | null
  prompt: string
  prompt_is_default: boolean
  model: string
  /** agent 可用工具白名单（wire 把 DB 的 JSON 字符串 parse 成数组）；search agent =
   *  ['email_search_fulltext']，report agent 历史上为空。NULL/非法 → 按 type 回退默认。 */
  tools_json?: string[] | null
  kos_enrich: boolean
  /** daily 触发模式：rolling_24h（往前推 window_hours）| natural_day（指定时区昨天整天）。 */
  trigger_mode: 'rolling_24h' | 'natural_day'
  /** IANA 时区（'' = 本地）；natural_day 边界 + 周/月报自然周/月用。 */
  timezone: string
  /** daily 带完整正文的优先级集合（priority label）；命中的邮件才预载正文，其余只摘要、不带附件。 */
  body_full_priorities: string[]
  /** v27：注入任务 system prompt 的身份文档勾选（profile-doc 名，如 ['soul','user']）。
   *  type='preprocess'（分类）与 'report'（日/周/月报，增量 2）有意义；NULL/未设 →
   *  运行时回退默认 soul+user。search 恒 []。 */
  context_docs?: string[]
  /** v29 preprocess：行级 fallback 模型链。null = 跟随全局 LLM_FALLBACK_MODELS；
   *  [] = 显式不设兜底。仅 type='preprocess' 有意义（其余恒 null）。 */
  fallback_models?: string[] | null
  /** v32 preprocess：AI 预处理完成后自动标已读。缺失/NULL 默认 true。 */
  mark_read_after_processing: boolean
  /** v38 preprocess：参考上下文源 'standing_docs' | 'notion_context'。
   *  null = 行 NULL/野值 → 前端 deriveContextSource 按 LLM_CONTEXT_PAGE_ID 继承派生显示态。
   *  仅 type='preprocess' 有意义（其余恒 null）。行权威、保存即生效（改抽屉无需重启）。 */
  context_source?: string | null
  /** v30 触发/工具/预算。trigger 对 type='custom'（CRUD）与 'project_progress'（S5 W5a 单例行，
   *  复用 email_filter 词汇存 sender/subject）均有意义并投影；tool_policy/budget 仍 custom-only
   *  （其余恒 null，project_progress 执行不进 gateway）。 */
  trigger?: CustomAgentTrigger | TriggerSetV2 | null
  tool_policy?: CustomAgentToolPolicy | null
  budget?: CustomAgentBudget | null
  /** v42 visual identity. null/absent = derive a stable shape/palette from the agent id. */
  avatar?: AgentAvatarConfig | null
  updated_at: number | null
}

/** legacy oreo 生成式身份（shape/palette/variant）。存量行**没有** `type` 键 —— 缺省即生成式，
 *  故判别式在 image/bot 一侧（零迁移）。渲染时由 `mapLegacyGeneratedToBot` 确定性映射为
 *  bot 外观（08-12 living-bot-avatar 起 oreo 渲染链退役，类型仅存量行解析用）。 */
export interface AgentAvatarGenerated {
  type?: 'generated'
  shape: 'bloom' | 'silk' | 'flare' | 'nova' | 'void' | 'jade'
  palette: string
  variant_id?: string
}

/** 08-12 灵动 bot 身份（第三种 kind，prd §5.1）。shape 8 值 / color 11 值词表
 *  单源在 `@shared/bot-avatar`（as const 数组推导），此处仅转出口别名——别手抄第二份。 */
export type AgentAvatarBot = BotAvatarBotConfig

/** 0804 WP7 用户上传身份：客户端已居中方形裁切 + 降采样（≤256×256）+ 编码 webp，
 *  `data` 是 `data:image/webp;base64,…`、**解码后 ≤150KB**（后端 `wire.config_patch_to_db`
 *  复核同一上限，两侧常量各自成文）。 */
export interface AgentAvatarImage {
  type: 'image'
  data: string
}

export type AgentAvatarConfig = AgentAvatarGenerated | AgentAvatarImage | AgentAvatarBot

/** report:setConfig — friendly patch（后端 CLI 映射到 DB 列）。 */
export interface ReportConfigPatch {
  enabled?: boolean
  title?: string
  description?: string | null
  /** null / '' → 重置为内置默认 prompt。 */
  prompt?: string | null
  model?: string
  window_hours?: number
  schedule?: ReportSchedule
  kos_enrich?: boolean
  trigger_mode?: 'rolling_24h' | 'natural_day'
  timezone?: string
  body_full_priorities?: string[]
  /** agent 可用工具白名单（wire.config_patch_to_db 写 tools_json 列）。 */
  tools?: string[]
  /** v27：身份文档勾选，preprocess + report 通用（wire.config_patch_to_db 写 context_docs_json 列）。 */
  context_docs?: string[]
  /** v29 preprocess：行级 fallback 链（wire.config_patch_to_db 写 fallback_models_json 列）。
   *  null = 重置回跟随全局；[] = 显式不设兜底。 */
  fallback_models?: string[] | null
  /** v32 preprocess：处理完成后自动标已读，保存即生效。 */
  mark_read_after_processing?: boolean
  /** v38 preprocess：参考上下文源（wire.config_patch_to_db 写 context_source 列）。
   *  'standing_docs' | 'notion_context' 二选一；null = 重置回继承派生。保存即生效无需重启。 */
  context_source?: 'standing_docs' | 'notion_context' | null
  /** v30 Custom Agent：触发/工具/预算（wire.config_patch_to_db 写对应 *_json 列）。
   *  null = 清空该配置；object = 覆写。仅 type='custom' 有意义
   *  （project_progress 借 email_filter 词汇、contact_profile 借 ContactProfileTrigger
   *  字面字段各存自己的单例配置，两者都不走 parse_trigger）。 */
  trigger?:
    | CustomAgentTrigger
    | TriggerSetV2
    | ContactProfileTrigger
    | ContactGovernanceTrigger
    | null
  tool_policy?: CustomAgentToolPolicy | null
  budget?: CustomAgentBudget | null
  avatar?: AgentAvatarConfig | null
}

/** report:createAgent — 新建一行 agent（type 多态）。 */
export interface ReportAgentCreateInput {
  /** 新 agent id（必填，冲突 → E_INVALID_ARG）。 */
  id: string
  /** 默认 'search'（agentic 搜索）；'preprocess' = AI 邮件预处理（v27）；
   *  'custom' = S5 custom agent（需 MAILAGENT_CUSTOM_AGENTS_ENABLED，创建为草稿，
   *  trigger/tool_policy/budget 经 setConfig 补齐）。 */
  type?: 'search' | 'report' | 'preprocess' | 'custom'
  title?: string
  description?: string | null
  enabled?: boolean
  model?: string | null
  prompt?: string | null
  /** 工具白名单（落库 tools_json）。 */
  tools?: string[]
}

/** custom agent run 读侧状态（后端 derive_agent_run_state 单源判读，9 值域穷举）。
 *  🔴 前端**永不**自行从 outcome/approvalState 推导 state —— 投影即契约，防
 *  paused_handoff 渲染成「成功完成」的第二处解读漂移（ADR-003 D4 / ADR-004 P6）。 */
export type AgentRunState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'paused_pending'
  | 'paused_expired'
  | 'paused_approved'
  | 'paused_rejected'
  | 'failed'

/** S5 run 历史行（GET /api/agent-runs 投影）。 */
export interface AgentRunHistoryItem {
  /** 台账来源判别。缺省 / `'job'` = async_jobs 行（本接口）；`'run_log'` = agent_run_log 行
   *  （AgentRunLogItem）。同一个聚合端点返两种形状，判别字段是它。 */
  kind?: 'job'
  jobId: number
  agentId: string
  /** 后端单源读态（derive_agent_run_state）；前端只按此穷举渲染，不自行推导。 */
  state: AgentRunState
  /** gateway 终态 outcome（completed | paused_handoff | error），可空。 */
  outcome?: string | null
  /** Gateway one-line progress/final summary when result_json carries one. */
  summary?: string | null
  /** 审批终态（pending | approved | rejected），仅 paused_handoff 有意义。 */
  approvalState?: string | null
  /** 该 run 的 ai_chat.db session（可打开查看 headless 对话历史）。 */
  sessionId?: number | null
  createdAt: number
  finishedAt?: number | null
  /** 失败错误码（E_GATEWAY_DOWN / E_ORPHANED / …）。 */
  error?: string | null
  /** gateway 实际完成的 tool-loop step 数。 */
  steps?: number | null
  /** LLM usage（token 计数 map），result_json 有则带。 */
  tokens?: Record<string, unknown> | null
  /** 从 async_jobs started/finished 时间戳投影的 wall-clock 秒数。 */
  durationSeconds?: number | null
  /** S5 ADR-004 D6 — 该 run 的免卡写次数（chat_tool_call approval_status='auto_whitelist'
   *  经 sessionId 归账）。null = 无 sessionId 或审计账本不可达（badge 不渲染，非「0 次」）。 */
  autoWhitelistedWrites?: number | null
  /** S6 W3-2 ADR-004 rev3.1 §4.4 / F#3 — 免卡分源明细：rule = 白名单规则命中（whitelist_rule_id
   *  非空）计数；grant = grant 级免卡（rule_id=null，如 open 档 web_fetch / web_search 授权），
   *  按 tool_name 分桶。null 语义同 autoWhitelistedWrites（账本不可达 ≠ 0）。 */
  autoWhitelistedBreakdown?: { rule: number; grant: Record<string, number> } | null
  /** L4 批次2 §2.1 — 触发方式（manual | schedule | email_filter | cron | …），与后端
   *  `_run_history_item` 同源投影（job.params.trigger_kind）。缺失（老行 / 非常规入队）恒 null。 */
  triggerKind?: string | null
  /** 同上批次，触发时刻 ISO 字符串（cron 用 occurrence 时刻，否则用入队时刻）；
   *  triggerKind 为 null 时本字段恒 null。 */
  triggerFiredAtIso?: string | null
}

/** 08-31 执行台账 — `agent_run_log` 行（`GET /api/agent-runs` 聚合里 `kind: 'run_log'` 的 item）。
 *  报告 / 联系人画像 / 项目周报三位不走 gateway headless（LLM 直连 provider 或干脆零 LLM，
 *  r10 §0.3），没有 session 可读；它们把过程结构化落进 agent_run_log + agent_run_step，
 *  前端合成 transcript（runStepsToUIMessages）后与会话共用同一个渲染器。
 *
 *  形状对齐 `_run_history_item`（后端 `_run_log_item` 的注释明写「字段名不许改」），差别只有
 *  三处，都在这里标死：
 *  🔴 `createdAt` / `finishedAt` 是 **ISO 字符串**（async_jobs run 行是 epoch 数字）——
 *     换算只在读侧 `isoMs` 一处。
 *  🔴 `sessionId` / `approvalState` **恒 null 是契约不是没写完**：run_log 的三位写入方不开
 *     会话、不走审批。transcript 走 `runLogSteps` 合成。
 *  🔴 `state` 直接是 run_state 9 值域（建表 CHECK 钉死）——RunStateBadge 零映射，前端不建
 *     第二张 status 词表（`_profile_run_item` 的既有纪律：复用 9 值域，不加第 10 个值）。 */
export interface AgentRunLogItem {
  kind: 'run_log'
  runLogId: number
  /** = runLogId（后端为形状对齐也带了它）。列表 key 一律用 runLogId —— 两套台账的自增
   *  id 各自从 1 起，拿 jobId 当键必与 async_jobs 行撞号。 */
  jobId: number
  agentId: string
  state: AgentRunState
  outcome?: string | null
  /** 记录列直接显示的一行。 */
  summary?: string | null
  sessionId?: null
  approvalState?: null
  createdAt: string | null
  finishedAt?: string | null
  error?: string | null
  /** 步骤**计数**（明细走 `runLogSteps`）。 */
  steps?: number | null
  tokens?: { inputTokens: number; outputTokens: number } | null
  durationSeconds?: number | null
  triggerKind?: string | null
  triggerFiredAtIso?: string | null
  /** 触发条件的一句话补充（「收到邮件《W35 项目周报》」），喂 AgentRunTriggerBubble。 */
  triggerDetail?: string | null
  model?: string | null
  /** 这次执行产出的报告 id（后端从 out 步骤 `payload.report_id` 抽出）。报告类才有，
   *  画像 / 项目周报恒 null。empty（这段时间没有新邮件）那一档也带——它同样建了
   *  `status='empty'` 的 report 行。
   *  🔴 记录列靠它把「产物行 `report:xxx`」与「过程行 `runlog:N`」收敛成一条 ——
   *  真实引用，**不是**时间窗启发式。去重后产物的入口改由 runlog 详情头的「去报告」提供。 */
  reportId?: string | null
  /** 这次执行的触发邮件 internal_id（后端从首条 trig 步骤 `payload.internal_id` 抽出，
   *  并在 API 边界加了成员语义门：只对项目周报投影）。其余成员恒 null。
   *  🔴 与 reportId 同模式：记录列靠它把 `project_progress_sync` 台账行
   *  （`progress:{internalId}`）与过程行 `runlog:N` 收敛成一条。 */
  progressEmailId?: number | null
}

/** transcript 节点词表（design §8.1 定死四类，跨四位共用）。 */
export type AgentRunStepKind = 'trig' | 'think' | 'tool' | 'out'

/** `agent_run_step` 行（GET /api/agent-runs/run-log/{id}/steps）。
 *  `payload` 的内部形状不在接缝契约里（只约定「对象或 null」），渲染侧按约定俗成的
 *  `{input, output}` 分开，缺则整块当请求（runStepsToUIMessages）。 */
export interface AgentRunStep {
  seq: number
  kind: AgentRunStepKind
  /** tool: 工具名 / out: 产物类型。 */
  name?: string | null
  /** 人话（失败时写「为什么这么处置」）。 */
  detail?: string | null
  payload?: Record<string, unknown> | null
  /** 1|0|null；false → 前端标 ✗ + fail 色。 */
  ok?: boolean | null
  ms?: number | null
}

/** `GET /api/agent-runs` 聚合列表的行（两种台账并列）。 */
export type AgentRunListItem = AgentRunHistoryItem | AgentRunLogItem

export interface ReportRunResult {
  report_id: string
  status: ReportStatus
  headline: string
  cadence?: string
  report_date?: string
  error?: string | null
}

/** v1.3.0 dogfood R5 — 项目周报同步的一次执行记录（GET /api/project-progress/runs）。
 *  自有 status 词表（processing | completed | failed | skipped，非 custom agent 的 9 值域）；
 *  时间戳为 Unix 秒（前端 fmtTime 自适应秒/毫秒）。确定性 Python 同步脚本产物，不进 async_jobs。 */
export interface ProjectProgressRunItem {
  internalId: number
  subject?: string | null
  weekTag?: string | null
  filename?: string | null
  status: string
  error?: string | null
  startedAt?: number | null
  completedAt?: number | null
  projectsTotal?: number | null
  projectsCreated?: number | null
  projectsUpdated?: number | null
  projectsFailed?: number | null
}

/** S6 W1 — 待审批（paused_pending）计数（GET /api/agent-runs/pending-count，P5 红点链数据源）。
 *  只计 live 可批的 paused_pending（paused_expired 不计）；byAgent 只含 count>0 的 agent。 */
export interface AgentRunPendingCount {
  total: number
  byAgent: Record<string, number>
}

/** S5 — custom agent allowed_tools 单项（GET /api/agent-runs/tool-options）。
 *  class 决定默认勾选与危险度标注：read = 默认安全集；domain_write = 需显式勾选。 */
export interface AgentRunToolOption {
  name: string
  class: 'read' | 'domain_write' | 'artifact'
}

/** S5 — custom agent 可选工具清单（GET /api/agent-runs/tool-options）。
 *  tools = 全部可选工具（按 class 标注）；defaults = 新建时默认勾选（后端权威，
 *  前端不硬编码工具名清单）。端点 404 / 失败 → { tools: [], defaults: [] }。 */
export interface AgentRunToolOptions {
  tools: AgentRunToolOption[]
  defaults: string[]
}

/** R3 (task 07-05) — GET /chat/config 开放性 flag 分面（S1 openness main-env-only flag 的
 *  前端投影：sessionToolsEnabled / configToolsEnabled / webToolsEnabled + 既有
 *  execPolicyEnabled 映射为 execToolsEnabled）。三值语义：true = flag on；false = flag off
 *  （授权控件禁用 + 提示，消除「UI 授权但 gateway 未注册工具」的静默 no-op）；
 *  undefined = 旧后端无此字段或 /chat/config 不可达（按现状渲染，不禁用）。 */
export interface ChatOpennessFlags {
  sessionToolsEnabled?: boolean
  configToolsEnabled?: boolean
  webToolsEnabled?: boolean
  /** /chat/config.execPolicyEnabled（MAILAGENT_OPENNESS_EXEC_TOOLS）的投影。 */
  execToolsEnabled?: boolean
  /** MCP connector PR4 — /chat/config.connectorToolsEnabled（MAILAGENT_MCP_CONNECTORS）。
   *  false → 第七「外部服务」能力卡禁用 + 提示（同 web/exec 的三值语义）。 */
  connectorToolsEnabled?: boolean
}

/** task 07-21 — 分页读结果（items + 同 filter 条件下的 total）。列表页滚动预取/「加载
 *  更多」与总数展示都靠 total 判断 hasMore（items.length < total）。 */
export interface ReportPagedResult<T> {
  items: T[]
  total: number
}

export interface ReportApi {
  /** 报告列表（不含 blocks，按 report_date 倒序）。失败返 { items: [], total: 0 }。
   *  offset 分页（task 07-21）：不传 = 首页。 */
  list(opts?: {
    cadence?: ReportCadence
    agentId?: string
    limit?: number
    offset?: number
  }): Promise<ReportPagedResult<ReportListItem>>
  /** 单份报告详情（含解析后的 doc）。不存在返 null。 */
  get(reportId: string): Promise<ReportDetail | null>
  /** task 08-27 P5 —— 「在新窗口打开」这份报告（Electron 轻窗）。放法同
   *  `chat.openPopout` / `email.openDetached`：shared/web 载体是 no-op，
   *  Electron 由 ElectronApi 注入真实的 `window:openDetached` IPC。 */
  openDetached(reportId: string): void
  /** agent 配置列表（v1 一个 daily agent）。失败返 []。 */
  getConfig(): Promise<ReportAgentConfig[]>
  /** 部分更新 agent 配置（写, needs auth）。返回更新后的解析配置。 */
  setConfig(agentId: string, patch: ReportConfigPatch): Promise<ReportAgentConfig>
  /** 立即生成一份报告（runNow, 写, needs auth, 跑 LLM）。
   *  S5：type='custom' 时改为 enqueue 一次 headless run（async job，返回 jobId 映射进
   *  report_id；report/search 仍走同步生成路径）。 */
  runNow(
    agentId: string,
    opts?: { cadence?: ReportCadence; type?: string }
  ): Promise<ReportRunResult>
  /** 删除一份报告（写, needs auth）。 */
  delete(reportId: string): Promise<void>
  /** 新建一行 agent 配置（写, needs auth；type='search'|'report'|'preprocess'|'custom'）。返回解析后的配置。 */
  createAgent(input: ReportAgentCreateInput): Promise<ReportAgentConfig>
  /** 删除一行 agent 配置（写, needs auth）。 */
  deleteAgent(agentId: string): Promise<{ deleted: string }>
  /** S5 — custom agent run 历史（读）。GET /api/agent-runs；flag off / 失败返
   *  { items: [], total: 0 }（守读优雅降级）。state 由后端 derive_agent_run_state 单源投影，
   *  前端不自行推导。S6 W1：可选 state 过滤（9 值域，后端服务端派生后过滤）。offset 分页
   *  （task 07-21）：不传 = 首页；total 不叠加 state 过滤（详见后端 count_agent_runs 口径）。 */
  listRuns(opts?: {
    agentId?: string
    limit?: number
    offset?: number
    state?: AgentRunState
  }): Promise<ReportPagedResult<AgentRunListItem>>
  /** 08-31 — 一次 run_log 执行的过程节点（读）。GET /api/agent-runs/run-log/{id}/steps；
   *  端点未就绪 / 失败返 []（守读优雅降级 —— 步骤取不到时详情退回「没有输出」而不是崩）。 */
  runLogSteps(runLogId: number): Promise<AgentRunStep[]>
  /** S6 W1 — 待审批（paused_pending）计数（读）。GET /api/agent-runs/pending-count；
   *  flag off / 失败返 { total: 0, byAgent: {} }（守读优雅降级）。 */
  pendingCount(): Promise<AgentRunPendingCount>
  /** S5 — custom agent allowed_tools 可选清单（读）。GET /api/agent-runs/tool-options；
   *  flag off / 失败返 { tools: [], defaults: [] }（守读优雅降级，不硬编码工具名）。 */
  toolOptions(): Promise<AgentRunToolOptions>
  /** R5 (task 07-05) — 项目周报同步近期执行记录（读）。GET /api/project-progress/runs；
   *  失败返 []（守读优雅降级）。custom agent run 历史（listRuns）之外的独立读面。 */
  projectProgressRuns(limit?: number): Promise<ProjectProgressRunItem[]>
}
