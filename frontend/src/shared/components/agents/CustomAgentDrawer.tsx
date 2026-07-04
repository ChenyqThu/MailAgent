// S5 W2 — 完全自定义 Agent（type='custom'）配置抽屉。复刻 SearchConfigDrawer 三段式
// 脚手架（进/退场动效 + header/body/footer glass 面板），字段扩为 custom agent 所需：
// title / prompt / model / enabled + trigger 判别式（无 | cron | email_filter）+ allowed_tools
// 多选 + budget 三门 + run 历史（8 状态穷举）。
//
// 纪律：
//  • 校验只做浅校验（必填 / 数值范围 / cron 5 段 / email 谓词至少一个）；深校验（croniter /
//    正则可编译 / ReDoS 长度）交后端 validate_agent_config_patch，保存失败展示后端 detail。
//  • trigger 类型「无」用非空 sentinel（seg 控件，避开 radix SelectItem 空串必崩）。
//  • run 历史 state 由后端 derive_agent_run_state 单源投影，前端**只穷举渲染不推导**；
//    paused_* 永不渲染为成功（ADR-003 D4 / ADR-004 P6）。
//  • 新建两段式：createAgent({type:'custom'}) 建草稿 → setConfig 补 trigger/tool_policy/budget。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { requestOpenAgentSession } from '@shared/state/ai-chat-panel'
import { PendingDot } from './AgentPendingBadge'
import type {
  AgentRunHistoryItem,
  AgentRunState,
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  ExecPolicyRule,
  ReportAgentConfig,
  ReportConfigPatch
} from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { ReportIcon, Switch } from './primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  useAgentRuns,
  useCreateAgent,
  useDeleteAgent,
  useRunNow,
  useSetConfig,
  useToolOptions
} from './hooks'

// budget 三门默认 + 上限（与 src/agents/trigger.py DEFAULT_*/CEILING 对齐；浅校验用）。
const DEFAULT_MAX_STEPS = 8
const MAX_STEPS_CEILING = 16
const DEFAULT_MAX_RUNS_PER_DAY = 24
const DEFAULT_MAX_RUN_SECONDS = 300
const MAX_RUN_SECONDS_CEILING = 1800

type TriggerKind = 'none' | 'cron' | 'email_filter'
const TRIGGER_KINDS: TriggerKind[] = ['none', 'cron', 'email_filter']

// title → 稳定 slug（新建 agent id）。保留 CJK + 字母 + 数字，latin 转小写，其余折 `_`；
// 真正为空才时间戳兜底。镜像 SearchConfigDrawer.slugifyTitle（小助手，允许复制）。
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return slug || `custom_${Date.now().toString(36)}`
}

// 结构化 ApiError / Electron err → 用户可读一行（code + message）。保存失败时把后端
// validate_agent_config_patch 的 detail（TriggerValidationError message）渲染出来。
function errText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : null
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

// epoch（秒或毫秒都容错）→ 本地时间串。
function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}

// 免卡 badge 分源投影（S6 W3-2，ADR-004 rev3.1 §4.4 / F#3）：rule-source（白名单规则命中）与
// grant-source（rule_id=null 的 grant 级免卡，按工具分「全开放联网 / 搜索授权 / 授权放行」）
// 分开标注 —— owner 误判授权范围的防线。🔴 不假设 rule_id 非空（grant 桶是一等来源）。
// breakdown 缺席（旧 serve-api 无此字段）→ 回退泛化「自动放行 ×n」；null（账本不可达）→ 不渲染。
function autoWhitelistBadges(
  r: AgentRunHistoryItem,
  t: (key: string, opts?: Record<string, unknown>) => string
): string[] {
  const bd = r.autoWhitelistedBreakdown
  if (bd == null) {
    return typeof r.autoWhitelistedWrites === 'number' && r.autoWhitelistedWrites > 0
      ? [t('agents.custom.runs.autoWhitelisted', { n: r.autoWhitelistedWrites })]
      : []
  }
  const out: string[] = []
  if (bd.rule > 0) out.push(t('agents.custom.runs.autoWhitelistedRule', { n: bd.rule }))
  let otherGrant = 0
  for (const [tool, n] of Object.entries(bd.grant)) {
    if (n <= 0) continue
    if (tool === 'web_fetch') out.push(t('agents.custom.runs.autoWhitelistedWebOpen', { n }))
    else if (tool === 'web_search') out.push(t('agents.custom.runs.autoWhitelistedWebSearch', { n }))
    else otherGrant += n
  }
  if (otherGrant > 0) out.push(t('agents.custom.runs.autoWhitelistedGrant', { n: otherGrant }))
  return out
}

interface RunVisual {
  labelKey: string
  fg: string
  bg: string
  border: string
}

// 8 状态穷举视觉映射。**无 default**：switch 覆盖全部 AgentRunState 后由 assertNever
// 兜底——新增状态时 `state` 不再收窄为 never → tsc 编译红（防漏兜 + 防 paused_* 误渲成功）。
function runStateVisual(state: AgentRunState): RunVisual {
  switch (state) {
    case 'queued':
      return {
        labelKey: 'agents.custom.runs.state.queued',
        fg: 'rgb(var(--ink-fg-3))',
        bg: 'rgb(var(--ink-fg) / 0.05)',
        border: 'rgb(var(--ink-border))'
      }
    case 'running':
      return {
        labelKey: 'agents.custom.runs.state.running',
        fg: 'rgb(var(--c-ai))',
        bg: 'rgb(var(--c-ai) / 0.12)',
        border: 'rgb(var(--c-ai) / 0.28)'
      }
    case 'completed':
      return {
        labelKey: 'agents.custom.runs.state.completed',
        fg: 'rgb(var(--c-ok))',
        bg: 'rgb(var(--c-ok) / 0.12)',
        border: 'rgb(var(--c-ok) / 0.25)'
      }
    case 'paused_pending':
      return {
        labelKey: 'agents.custom.runs.state.pausedPending',
        fg: 'rgb(var(--c-warn))',
        bg: 'rgb(var(--c-warn) / 0.14)',
        border: 'rgb(var(--c-warn) / 0.3)'
      }
    case 'paused_expired':
      return {
        labelKey: 'agents.custom.runs.state.pausedExpired',
        fg: 'rgb(var(--ink-fg-3))',
        bg: 'rgb(var(--ink-fg) / 0.05)',
        border: 'rgb(var(--ink-border))'
      }
    case 'paused_approved':
      return {
        labelKey: 'agents.custom.runs.state.pausedApproved',
        fg: 'rgb(var(--c-ok))',
        bg: 'rgb(var(--c-ok) / 0.12)',
        border: 'rgb(var(--c-ok) / 0.25)'
      }
    case 'paused_rejected':
      return {
        labelKey: 'agents.custom.runs.state.pausedRejected',
        fg: 'rgb(var(--c-fail))',
        bg: 'rgb(var(--c-fail) / 0.10)',
        border: 'rgb(var(--c-fail) / 0.25)'
      }
    case 'failed':
      return {
        labelKey: 'agents.custom.runs.state.failed',
        fg: 'rgb(var(--c-fail))',
        bg: 'rgb(var(--c-fail) / 0.10)',
        border: 'rgb(var(--c-fail) / 0.25)'
      }
  }
  // 穷举兜底：AgentRunState 若新增成员，此处 state 非 never → tsc 报错，逼同步补 case。
  return assertNever(state)
}

function assertNever(x: never): never {
  throw new Error(`unhandled AgentRunState: ${String(x)}`)
}

export function RunStateBadge({ state }: { state: AgentRunState }): React.ReactElement {
  const { t } = useTranslation()
  const v = runStateVisual(state)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 5,
        color: v.fg,
        background: v.bg,
        border: `1px solid ${v.border}`,
        whiteSpace: 'nowrap'
      }}
    >
      {t(v.labelKey)}
    </span>
  )
}

// 小 Field（label + hint + children）；复制自 AgentsTab 的私有 Field（避免 AgentsTab ↔
// CustomAgentDrawer 循环 import）。
function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <div className="flex items-baseline" style={{ gap: 8, marginBottom: 7 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>{label}</label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

// run 历史区（编辑既有 custom agent 时展示；新建时 agent 尚未存在 → 不渲染）。
function RunHistorySection({ agentId }: { agentId: string }): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { runs, isLoading } = useAgentRuns(agentId)
  const { run, isRunning } = useRunNow()
  // run-now 失败（预算耗尽 E_BUDGET / flag off / gateway 不可达）→ 展示后端 detail，
  // 不静默吞（否则用户点「立即运行」无任何反馈）。
  const [runErr, setRunErr] = useState<string | null>(null)

  const onRunNow = (): void => {
    if (isRunning) return
    setRunErr(null)
    run(agentId, { type: 'custom' }).catch((e: unknown) => setRunErr(errText(e)))
  }

  // S6 W2 — 打开该次 run 的执行记录 = 打开该 origin='agent' session（复用 AssistantChatModal
  // fullscreen 手法：park sessionId → 导航到 /sessions → AgentViewLayout 消费并 select）。从设置里
  // 触发 → 导航离开设置进入 agent 视图（记录视图 read-mostly，见 AgentConversation）。
  const openRecord = (sessionId: number): void => {
    requestOpenAgentSession(sessionId)
    void navigate({ to: '/sessions' })
  }

  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 9 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.custom.runs.section')}
        </label>
        <button
          type="button"
          onClick={onRunNow}
          disabled={isRunning}
          className="flex items-center"
          style={{
            gap: 5,
            fontFamily: 'inherit',
            fontSize: 12.5,
            padding: '5px 11px',
            borderRadius: 7,
            cursor: isRunning ? 'wait' : 'pointer',
            color: 'rgb(var(--c-accent))',
            background: 'rgb(var(--c-accent) / 0.12)',
            border: '1px solid rgb(var(--c-accent) / 0.28)'
          }}
        >
          <ReportIcon name="zap" size={13} />
          {t('agents.custom.runs.runNow')}
        </button>
      </div>
      {runErr && (
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--c-fail))',
            padding: '9px 12px',
            marginBottom: 8,
            borderRadius: 9,
            background: 'rgb(var(--c-fail) / 0.10)',
            border: '1px solid rgb(var(--c-fail) / 0.25)',
            wordBreak: 'break-word'
          }}
        >
          {runErr}
        </div>
      )}
      {runs.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-3))',
            padding: '11px 13px',
            borderRadius: 9,
            background: 'rgb(var(--ink-1) / 0.5)',
            border: '1px solid rgb(var(--ink-border-soft))'
          }}
        >
          {isLoading ? t('agents.custom.runs.loading') : t('agents.custom.runs.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((r) => (
            <div
              key={r.jobId}
              style={{
                padding: '10px 12px',
                borderRadius: 9,
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))'
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <RunStateBadge state={r.state} />
                {/* 红点链 ①（P5）：paused_pending run 待审批脉冲红点，紧邻状态徽标。 */}
                {r.state === 'paused_pending' && <PendingDot title={t('agents.custom.runs.pendingDot')} />}
                {/* 免卡写 badge（ADR-004 D6；S6 W3-2 rev3.1 §4.4 分源）：虚线边框与人审状态
                    徽标（实线）视觉区分；null（无会话/账本不可达）不渲染 —— 不渲染 ≠「0 次
                    免卡」。分源标签见 autoWhitelistBadges（rule vs grant 两源）。 */}
                {autoWhitelistBadges(r, t).map((label) => (
                  <span
                    key={label}
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      padding: '2px 8px',
                      borderRadius: 5,
                      whiteSpace: 'nowrap',
                      color: 'rgb(var(--c-ai))',
                      background: 'rgb(var(--c-ai) / 0.08)',
                      border: '1px dashed rgb(var(--c-ai) / 0.45)'
                    }}
                  >
                    {label}
                  </span>
                ))}
                <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {fmtTime(r.finishedAt ?? r.createdAt)}
                </span>
                {/* S6 W2 — 「查看执行记录」入口（有 sessionId 即显）→ 打开该次 run 的对话。 */}
                {r.sessionId != null && (
                  <button
                    type="button"
                    onClick={() => openRecord(r.sessionId as number)}
                    className="flex items-center"
                    style={{
                      gap: 4,
                      fontFamily: 'inherit',
                      fontSize: 11.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      color: 'rgb(var(--ink-fg-2))',
                      background: 'rgb(var(--ink-fg) / 0.05)',
                      border: '1px solid rgb(var(--ink-border-soft))'
                    }}
                  >
                    <ReportIcon name="message" size={12} />
                    {t('agents.custom.runs.viewRecord')}
                  </button>
                )}
              </div>
              {r.state === 'paused_pending' && (
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 6, lineHeight: 1.5 }}>
                  {t('agents.custom.runs.pausedPendingHint')}
                </div>
              )}
              {r.state === 'paused_expired' && (
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 6, lineHeight: 1.5 }}>
                  {t('agents.custom.runs.pausedExpiredHint')}
                </div>
              )}
              {r.error && (
                <div
                  style={{
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'rgb(var(--c-fail))',
                    marginTop: 6,
                    wordBreak: 'break-all'
                  }}
                >
                  {r.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── 自动化策略（S5 W5b，ADR-004 D5/D6）──────────────────────────────────────
// per-agent 免卡白名单的**唯一**创建通道（模型零建规则工具、岛卡无「总是允许(此 agent)」）。
// 高危形态 = 红样式警示块 + 影响面声明 + 两步确认（先例 = 身份文档编辑器，无 PIN）。
// context_mode 由后端从 agent trigger.kind 派生（表单结构性不可选）；这里只做读侧 dormant
// 对比提示（规则 contextMode ≠ 当前已保存 trigger 的派生值 → 「休眠」，不迁移不删）。

type PolicyArgKind = 'pin' | 'enum' | 'pattern' | 'path_within'
const POLICY_ARG_KINDS: PolicyArgKind[] = ['pin', 'enum', 'pattern', 'path_within']

interface PolicyArgSlot {
  kind: PolicyArgKind
  /** pin=字面值；enum=逗号分隔允许值；pattern=锚定 regex；path_within=绝对前缀。 */
  value: string
}

/** trigger.kind → headless context_mode（与后端 _derive_rule_context_mode 同表，只读展示用）。 */
function deriveHeadlessMode(kind: string | null): 'cron_headless' | 'untrusted_trigger' | null {
  if (kind === 'cron') return 'cron_headless'
  if (kind === 'email_filter') return 'untrusted_trigger'
  return null
}

/** matcher → 单行摘要（只读展示；放宽 = 删旧建新，无原地编辑）。受约束位显示 `<kind>`。 */
function formatRuleMatcher(rule: ExecPolicyRule): string {
  const m = rule.matcher
  if (rule.capability === 'domain_write') {
    return typeof m.tool === 'string' ? m.tool : '?'
  }
  if (rule.capability === 'exec') {
    const argv0 = typeof m.argv0_realpath === 'string' ? m.argv0_realpath : '?'
    const tmpl = Array.isArray(m.argv_template) ? m.argv_template : []
    const parts = tmpl.map((it) => {
      const o = it as { pin?: unknown; any?: unknown; arg?: { kind?: unknown } }
      if (typeof o?.pin === 'string') return o.pin
      if (o?.any === true) return '<any>'
      return typeof o?.arg?.kind === 'string' ? `<${o.arg.kind}>` : '?'
    })
    return [argv0, ...parts].join(' ')
  }
  return JSON.stringify(m)
}

/** 红样式警示块（创建规则 / grant_exec 共用形态）。 */
function DangerBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.6,
        color: 'rgb(var(--c-fail))',
        padding: '10px 12px',
        borderRadius: 9,
        background: 'rgb(var(--c-fail) / 0.10)',
        border: '1px solid rgb(var(--c-fail) / 0.35)',
        wordBreak: 'break-word'
      }}
    >
      {children}
    </div>
  )
}

function AutomationPolicySection({
  agentId,
  agentTitle,
  triggerKind,
  writeToolChoices,
  grantExec,
  onGrantChange
}: {
  agentId: string
  agentTitle: string
  /** 已保存 trigger 的 kind（dormant 对比基准 + 影响面文案；null = 无触发）。 */
  triggerKind: string | null
  /** domain_write 规则可选工具 = 5 个 domain_write 工具 ∩ 该 agent allowed_tools。 */
  writeToolChoices: string[]
  grantExec: boolean
  /** 翻转 grant_exec（已过确认对话）；父层置 grantDirty，保存时并入 tool_policy。 */
  onGrantChange: (next: boolean) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()
  const derivedMode = deriveHeadlessMode(triggerKind)

  const rulesQ = useQuery({
    queryKey: ['policy', 'rules', agentId],
    queryFn: () => api.chat.listPolicyRules({ agentId })
  })
  const rules = rulesQ.data ?? []
  const refetchRules = (): void => {
    void qc.invalidateQueries({ queryKey: ['policy', 'rules', agentId] })
  }

  const [formOpen, setFormOpen] = useState(false)
  // entrypoint 候选仅建 exec 规则需要；graceful []（flag off / 无安装面 → 空态提示）。
  const entryQ = useQuery({
    queryKey: ['policy', 'skill-entrypoints'],
    queryFn: () => api.chat.listSkillEntrypoints(),
    enabled: formOpen,
    staleTime: 60_000
  })
  const skills = entryQ.data ?? []

  const [capability, setCapability] = useState<'domain_write' | 'exec'>('domain_write')
  const [tool, setTool] = useState('')
  const [skillName, setSkillName] = useState('')
  const [entryFile, setEntryFile] = useState('')
  const [interpreter, setInterpreter] = useState('')
  const [args, setArgs] = useState<PolicyArgSlot[]>([])
  const [pinCwd, setPinCwd] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)
  const [grantConfirming, setGrantConfirming] = useState(false)

  const skill = skills.find((s) => s.name === skillName) ?? null
  const entryAbs = skill && entryFile ? `${skill.dir}/${entryFile}` : ''
  const actionSummary =
    capability === 'domain_write' ? tool : `${interpreter.trim()} ${entryAbs}`.trim()
  const modeLabel = derivedMode
    ? t(`agents.custom.policy.mode.${derivedMode}`)
    : t('agents.custom.policy.mode.none')

  const resetForm = (): void => {
    setCapability('domain_write')
    setTool('')
    setSkillName('')
    setEntryFile('')
    setInterpreter('')
    setArgs([])
    setPinCwd(true)
    setConfirming(false)
    setFormErr(null)
  }

  // 浅校验（必选项 / 绝对路径 / 位值非空）；形状闸深校验在后端，400 detail 原样展示。
  const shallowFormError = (): string | null => {
    if (capability === 'domain_write') {
      return tool ? null : t('agents.custom.policy.errToolRequired')
    }
    if (!skill || !entryFile) return t('agents.custom.policy.errEntryRequired')
    if (!interpreter.trim().startsWith('/')) return t('agents.custom.policy.errInterpreterAbs')
    if (args.some((a) => !a.value.trim())) return t('agents.custom.policy.errArgEmpty')
    return null
  }

  // 无 raw {any} 选项：尾位词汇 = pin | enum | pattern | path_within（ADR-004 §4.3）。
  const buildMatcher = (): Record<string, unknown> => {
    if (capability === 'domain_write') return { v: 1, tool }
    const tmpl: Record<string, unknown>[] = [{ pin: entryAbs }]
    for (const a of args) {
      const v = a.value.trim()
      if (a.kind === 'pin') tmpl.push({ pin: v })
      else if (a.kind === 'enum') {
        tmpl.push({
          arg: { kind: 'enum', values: v.split(',').map((s) => s.trim()).filter(Boolean) }
        })
      } else if (a.kind === 'pattern') tmpl.push({ arg: { kind: 'pattern', regex: v } })
      else tmpl.push({ arg: { kind: 'path_within', prefix: v } })
    }
    const m: Record<string, unknown> = {
      v: 1,
      argv0_realpath: interpreter.trim(),
      argv_template: tmpl
    }
    if (pinCwd && skill) m.cwd_scope = skill.dir
    return m
  }

  const onCreateClick = (): void => {
    const v = shallowFormError()
    if (v) {
      setFormErr(v)
      return
    }
    setFormErr(null)
    setConfirming(true)
  }

  const onConfirmCreate = (): void => {
    setCreating(true)
    api.chat
      .createPolicyRule({ capability, matcher: buildMatcher(), agentId })
      .then(() => {
        setFormOpen(false)
        resetForm()
        refetchRules()
      })
      .catch((e: unknown) => {
        setConfirming(false)
        setFormErr(errText(e))
      })
      .finally(() => setCreating(false))
  }

  const onToggleRule = (id: number, next: boolean): void => {
    api.chat
      .setPolicyRuleEnabled(id, next)
      .then(refetchRules)
      .catch((e: unknown) => setFormErr(errText(e)))
  }
  const onDeleteRule = (id: number): void => {
    api.chat
      .deletePolicyRule(id)
      .then(refetchRules)
      .catch((e: unknown) => setFormErr(errText(e)))
  }

  const smallBtn: React.CSSProperties = {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '4px 10px',
    borderRadius: 7,
    cursor: 'pointer',
    color: 'rgb(var(--ink-fg-2))',
    background: 'transparent',
    border: '1px solid rgb(var(--ink-border))'
  }
  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 12.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '7px 10px'
  }

  return (
    <div>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 4 }}>
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.custom.policy.section')}
        </label>
        {!formOpen && (
          <button
            type="button"
            style={smallBtn}
            onClick={() => {
              // 唯一可选写工具 → 预选（省一次下拉；多选项时留空强制显式选择）。
              setTool(writeToolChoices.length === 1 ? writeToolChoices[0] : '')
              setFormOpen(true)
            }}
          >
            {t('agents.custom.policy.add')}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginBottom: 9, lineHeight: 1.5 }}>
        {t('agents.custom.policy.hint')}
      </div>

      {/* 规则列表 */}
      {rules.length === 0 ? (
        <div
          style={{
            fontSize: 12.5,
            color: 'rgb(var(--ink-fg-3))',
            padding: '11px 13px',
            borderRadius: 9,
            background: 'rgb(var(--ink-1) / 0.5)',
            border: '1px solid rgb(var(--ink-border-soft))'
          }}
        >
          {rulesQ.isLoading ? t('agents.custom.policy.loading') : t('agents.custom.policy.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((rule) => {
            const dormant = rule.contextMode !== derivedMode
            return (
              <div
                key={rule.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--ink-1) / 0.5)',
                  border: '1px solid rgb(var(--ink-border-soft))'
                }}
              >
                <div className="flex items-center" style={{ gap: 8 }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 5,
                      whiteSpace: 'nowrap',
                      color: 'rgb(var(--c-warn))',
                      background: 'rgb(var(--c-warn) / 0.12)',
                      border: '1px solid rgb(var(--c-warn) / 0.28)'
                    }}
                  >
                    {t(`agents.custom.policy.capability.${rule.capability}`, {
                      defaultValue: rule.capability
                    })}
                  </span>
                  <span style={{ flex: 1 }} />
                  <Switch on={rule.enabled} onChange={(v) => onToggleRule(rule.id, v)} />
                  <button
                    type="button"
                    aria-label={t('agents.custom.policy.delete')}
                    onClick={() => onDeleteRule(rule.id)}
                    style={{ ...smallBtn, color: 'rgb(var(--c-fail))', borderColor: 'rgb(var(--c-fail) / 0.3)' }}
                  >
                    {t('agents.custom.policy.delete')}
                  </button>
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 12,
                    color: 'rgb(var(--ink-fg))',
                    wordBreak: 'break-all'
                  }}
                >
                  {formatRuleMatcher(rule)}
                </div>
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 3 }}>
                  {t('agents.custom.policy.hits', { n: rule.useCount })}
                  {rule.lastUsedAt ? ` · ${rule.lastUsedAt}` : ''}
                </div>
                {dormant && (
                  <div style={{ fontSize: 11.5, color: 'rgb(var(--c-warn))', marginTop: 5, lineHeight: 1.5 }}>
                    {t('agents.custom.policy.dormant')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 创建表单 */}
      {formOpen && (
        <div
          style={{
            marginTop: 10,
            padding: '12px 13px',
            borderRadius: 10,
            background: 'rgb(var(--ink-2) / 0.55)',
            border: '1px solid rgb(var(--ink-border))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10
          }}
        >
          <div className="seg" style={{ width: '100%' }}>
            {(['domain_write', 'exec'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={capability === c ? 'on' : ''}
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => {
                  setCapability(c)
                  setConfirming(false)
                }}
              >
                {t(`agents.custom.policy.capability.${c}`)}
              </button>
            ))}
          </div>

          {/* context_mode 只读展示（自动派生，表单不可选） */}
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.custom.policy.modeDerived', { mode: modeLabel })}
          </div>

          {capability === 'domain_write' &&
            (writeToolChoices.length === 0 ? (
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                {t('agents.custom.policy.toolNone')}
              </div>
            ) : (
              <Select value={tool || undefined} onValueChange={setTool}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.custom.policy.toolLabel')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {writeToolChoices.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ))}

          {capability === 'exec' &&
            (skills.length === 0 ? (
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                {t('agents.custom.policy.skillNone')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Select
                  value={skillName || undefined}
                  onValueChange={(v) => {
                    setSkillName(v)
                    setEntryFile('')
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('agents.custom.policy.skillLabel')} />
                  </SelectTrigger>
                  <SelectContent className="z-[70]">
                    {skills.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {skill && (
                  <Select value={entryFile || undefined} onValueChange={setEntryFile}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('agents.custom.policy.entryLabel')} />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      {skill.files.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <input
                  type="text"
                  value={interpreter}
                  placeholder={t('agents.custom.policy.interpreterPlaceholder')}
                  onChange={(e) => setInterpreter(e.target.value)}
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <div>
                  <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                      {t('agents.custom.policy.argsLabel')}
                    </span>
                    <button
                      type="button"
                      style={smallBtn}
                      onClick={() => setArgs((prev) => [...prev, { kind: 'pattern', value: '' }])}
                    >
                      {t('agents.custom.policy.argAdd')}
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginBottom: 6, lineHeight: 1.5 }}>
                    {t('agents.custom.policy.argsHint')}
                  </div>
                  {args.map((a, i) => (
                    <div key={i} className="flex items-center" style={{ gap: 6, marginBottom: 6 }}>
                      <select
                        value={a.kind}
                        aria-label={t('agents.custom.policy.argsLabel')}
                        onChange={(e) =>
                          setArgs((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, kind: e.target.value as PolicyArgKind } : x
                            )
                          )
                        }
                        style={{ ...inputStyle, width: 110, flexShrink: 0 }}
                      >
                        {POLICY_ARG_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`agents.custom.policy.argKind.${k}`)}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={a.value}
                        placeholder={t(`agents.custom.policy.argPlaceholder.${a.kind}`)}
                        onChange={(e) =>
                          setArgs((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                          )
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                      />
                      <button
                        type="button"
                        style={smallBtn}
                        onClick={() => setArgs((prev) => prev.filter((_, j) => j !== i))}
                      >
                        {t('agents.custom.policy.argRemove')}
                      </button>
                    </div>
                  ))}
                </div>
                <label
                  className="flex items-center"
                  style={{ gap: 8, fontSize: 12, color: 'rgb(var(--ink-fg-2))', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={pinCwd}
                    onChange={(e) => setPinCwd(e.target.checked)}
                  />
                  {t('agents.custom.policy.cwdPin')}
                </label>
              </div>
            ))}

          {formErr && (
            <div
              style={{
                fontSize: 12,
                color: 'rgb(var(--c-fail))',
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgb(var(--c-fail) / 0.10)',
                border: '1px solid rgb(var(--c-fail) / 0.25)',
                wordBreak: 'break-word'
              }}
            >
              {formErr}
            </div>
          )}

          {/* 影响面确认（红样式，两步）：先例 = 身份文档编辑器高危形态，无 PIN。 */}
          {confirming && (
            <DangerBlock>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t('agents.custom.policy.warnTitle')}
              </div>
              {t('agents.custom.policy.warnBody', {
                agent: agentTitle,
                action: actionSummary,
                mode: modeLabel
              })}
            </DangerBlock>
          )}

          <div className="flex items-center" style={{ gap: 8 }}>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={smallBtn}
              onClick={() => {
                setFormOpen(false)
                resetForm()
              }}
            >
              {t('agents.custom.policy.cancel')}
            </button>
            {confirming ? (
              <button
                type="button"
                disabled={creating}
                onClick={onConfirmCreate}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: creating ? 'wait' : 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'rgb(var(--c-fail) / 0.12)',
                  border: '1px solid rgb(var(--c-fail) / 0.4)'
                }}
              >
                {t('agents.custom.policy.confirmCreate')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onCreateClick}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-cta-fg))',
                  background: 'rgb(var(--c-cta-bg))',
                  border: 0
                }}
              >
                {t('agents.custom.policy.create')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* grant_exec 开关（红样式 + 同一确认形态；保存时并入 tool_policy —— 触碰即触碰 tool_policy） */}
      <div
        style={{
          marginTop: 10,
          padding: '12px 13px',
          borderRadius: 10,
          background: 'rgb(var(--c-fail) / 0.05)',
          border: '1px solid rgb(var(--c-fail) / 0.25)'
        }}
      >
        <div className="flex items-center" style={{ gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--c-fail))' }}>
              {t('agents.custom.policy.grant.label')}
            </div>
            <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 2, lineHeight: 1.5 }}>
              {t('agents.custom.policy.grant.hint')}
            </div>
          </div>
          <Switch
            on={grantExec}
            onChange={(next) => {
              if (next) {
                setGrantConfirming(true)
              } else {
                // 关方向 = 收窄，直改（保存后该 agent 回恒 HITL）。
                setGrantConfirming(false)
                onGrantChange(false)
              }
            }}
          />
        </div>
        {grantConfirming && !grantExec && (
          <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <DangerBlock>{t('agents.custom.policy.grant.warn', { agent: agentTitle })}</DangerBlock>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span style={{ flex: 1 }} />
              <button type="button" style={smallBtn} onClick={() => setGrantConfirming(false)}>
                {t('agents.custom.policy.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setGrantConfirming(false)
                  onGrantChange(true)
                }}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  fontWeight: 500,
                  padding: '6px 13px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'rgb(var(--c-fail) / 0.12)',
                  border: '1px solid rgb(var(--c-fail) / 0.4)'
                }}
              >
                {t('agents.custom.policy.grant.confirm')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function CustomAgentDrawer({
  cfg,
  open,
  create = false,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  /** true = 新建空态（cfg 为 null）；false = 编辑既有 cfg。 */
  create?: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { create: createAgent, isCreating } = useCreateAgent()
  const { remove, isDeleting } = useDeleteAgent()
  const { models: enabledModels } = useEnabledModels()
  // 工具清单只在抽屉打开时拉（后端权威 defaults；端点未就绪 → 空 → 提示）。
  const { options: toolOptions } = useToolOptions(open)

  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  const [enabled, setEnabled] = useState(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [model, setModel] = useState<string>('')
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('none')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [triggerTz, setTriggerTz] = useState('UTC')
  const [senderPattern, setSenderPattern] = useState('')
  const [subjectPattern, setSubjectPattern] = useState('')
  const [folders, setFolders] = useState('') // 逗号分隔
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  // toolsMode='defaults'（新建 / 编辑 tool_policy=NULL 行）→ 工具区展示后端默认安全集，且未
  // 触碰不写库；'explicit'（编辑显式 allowed_tools 行）→ 展示行内集合。toolsDirty=用户本次
  // 会话是否改过工具勾选（决定编辑保存是否发 tool_policy，见 onSave）。
  const [toolsMode, setToolsMode] = useState<'defaults' | 'explicit'>('defaults')
  const [toolsDirty, setToolsDirty] = useState(false)
  // grant_exec（S5 ADR-004 D2）：触碰开关 = 触碰 tool_policy（grantDirty 驱动保存时按需发送，
  // 与 toolsDirty 同一「按需发送」纪律 —— 未触碰的 NULL 行保存后仍是 NULL）。
  const [grantExec, setGrantExec] = useState(false)
  const [grantDirty, setGrantDirty] = useState(false)
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(DEFAULT_MAX_RUNS_PER_DAY)
  const [maxRunSeconds, setMaxRunSeconds] = useState(DEFAULT_MAX_RUN_SECONDS)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // 两段式 create 的第一段成果（codex S5 复核 P2）：createAgent 成功即记 id——第二段
  // setConfig 失败后原地重试直接走 setConfig，不再重复 create（同 id 撞 409）。打开抽屉重置。
  const [createdId, setCreatedId] = useState<string | null>(null)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。同 SearchConfigDrawer 既有豁免理由：模态打开按
  // cfg/空态预填多字段表单，React Compiler 迁移债，effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErr(null)
    setConfirming(false)
    setCreatedId(null)
    if (create || !cfg) {
      setEnabled(false)
      setTitle('')
      setPrompt('')
      setPromptDirty(false)
      setModel('')
      setTriggerKind('none')
      setCron('0 9 * * 1-5')
      setTriggerTz('UTC')
      setSenderPattern('')
      setSubjectPattern('')
      setFolders('')
      // 新建默认勾选由下方独立 effect 从后端 defaults 初始化（toolOptions 可能尚未就位）。
      setSelectedTools([])
      setToolsMode('defaults')
      setToolsDirty(false)
      setGrantExec(false)
      setGrantDirty(false)
      setMaxSteps(DEFAULT_MAX_STEPS)
      setMaxRunsPerDay(DEFAULT_MAX_RUNS_PER_DAY)
      setMaxRunSeconds(DEFAULT_MAX_RUN_SECONDS)
      return
    }
    setEnabled(cfg.enabled)
    setTitle(cfg.title)
    setPrompt(cfg.prompt_is_default ? '' : cfg.prompt)
    setPromptDirty(false)
    setModel(cfg.model || '')
    const trig = cfg.trigger
    if (trig?.kind === 'cron') {
      setTriggerKind('cron')
      setCron(trig.cron)
      setTriggerTz(trig.timezone || 'UTC')
      setSenderPattern('')
      setSubjectPattern('')
      setFolders('')
    } else if (trig?.kind === 'email_filter') {
      setTriggerKind('email_filter')
      setSenderPattern(trig.sender_pattern ?? '')
      setSubjectPattern(trig.subject_pattern ?? '')
      setFolders((trig.folders ?? []).join(', '))
      setCron('0 9 * * 1-5')
      setTriggerTz('UTC')
    } else {
      setTriggerKind('none')
    }
    // tool_policy=NULL 行（W5 的 DMS/周报模板等 Settings 外建行常见）→ 'defaults' 模式：工具区
    // 展示后端默认安全集（下方 effect 填），保存时未触碰则不写 tool_policy，NULL 保持 NULL。
    // 显式 allowed_tools 行 → 'explicit'：展示行内集合。
    const allowed = cfg.tool_policy?.allowed_tools
    if (Array.isArray(allowed)) {
      setSelectedTools(allowed)
      setToolsMode('explicit')
    } else {
      setSelectedTools([])
      setToolsMode('defaults')
    }
    setToolsDirty(false)
    setGrantExec(cfg.tool_policy?.grant_exec === true)
    setGrantDirty(false)
    setMaxSteps(cfg.budget?.max_steps ?? DEFAULT_MAX_STEPS)
    setMaxRunsPerDay(cfg.budget?.max_runs_per_day ?? DEFAULT_MAX_RUNS_PER_DAY)
    setMaxRunSeconds(cfg.budget?.max_run_seconds ?? DEFAULT_MAX_RUN_SECONDS)
  }, [open, cfg, create])

  // 'defaults' 模式（新建 / 编辑 NULL-policy 行）：toolOptions 就位后用后端 defaults 初始化
  // 默认勾选（展示与 NULL 投影的真实默认安全集一致）。用户触碰工具区（toolsDirty）后不再
  // 覆盖；defaults 稳定引用（EMPTY 单例），就位后仅触发一次。
  // 🔴 显式行双保险（W5b 修 W2 潜伏 bug）：mount/打开时本 effect 与上方 prefill effect 同批
  // 执行，闭包里 toolsMode 还是旧值 'defaults' —— 仅靠 state 守卫会把显式行刚填好的勾选
  // clobber 成 defaults。改从 props 直判：编辑显式 allowed_tools 行永不套 defaults。
  useEffect(() => {
    if (!open || toolsMode !== 'defaults' || toolsDirty) return
    if (!create && Array.isArray(cfg?.tool_policy?.allowed_tools)) return
    setSelectedTools([...toolOptions.defaults])
  }, [open, toolsMode, toolsDirty, toolOptions.defaults, create, cfg])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!shouldRender) return null

  const busy = isSaving || isCreating || isDeleting

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontFamily: 'inherit',
    fontSize: 13.5,
    color: 'rgb(var(--ink-fg))',
    background: 'rgb(var(--ink-1) / 0.55)',
    border: '1px solid rgb(var(--ink-border))',
    borderRadius: 8,
    padding: '9px 11px'
  }

  const toggleTool = (name: string): void => {
    setToolsDirty(true)
    setSelectedTools((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    )
  }

  // trigger tagged-union 构造（none → null = 草稿/禁用触发）。
  const buildTrigger = (): CustomAgentTrigger | null => {
    if (triggerKind === 'cron') {
      return { v: 1, kind: 'cron', cron: cron.trim(), timezone: triggerTz }
    }
    if (triggerKind === 'email_filter') {
      const trig: CustomAgentTrigger = { v: 1, kind: 'email_filter' }
      if (senderPattern.trim()) trig.sender_pattern = senderPattern.trim()
      if (subjectPattern.trim()) trig.subject_pattern = subjectPattern.trim()
      const fl = folders
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (fl.length) trig.folders = fl
      return trig
    }
    return null
  }

  // 浅校验（必填 / 数值范围 / cron 5 段 / email 谓词至少一个）。深校验交后端。
  const shallowValidate = (): string | null => {
    if (!title.trim()) return t('agents.custom.errTitleRequired')
    if (triggerKind === 'cron' && cron.trim().split(/\s+/).length !== 5) {
      return t('agents.custom.errCron5')
    }
    if (
      triggerKind === 'email_filter' &&
      !senderPattern.trim() &&
      !subjectPattern.trim() &&
      !folders.trim()
    ) {
      return t('agents.custom.errEmailPredicate')
    }
    if (maxSteps < 1 || maxSteps > MAX_STEPS_CEILING) {
      return t('agents.custom.errMaxSteps', { max: MAX_STEPS_CEILING })
    }
    if (maxRunSeconds < 1 || maxRunSeconds > MAX_RUN_SECONDS_CEILING) {
      return t('agents.custom.errMaxRunSeconds', { max: MAX_RUN_SECONDS_CEILING })
    }
    if (maxRunsPerDay < 0) return t('agents.custom.errMaxRunsPerDay')
    return null
  }

  const onSave = (): void => {
    const v = shallowValidate()
    if (v) {
      setErr(v)
      return
    }
    setErr(null)
    const trigger = buildTrigger()
    const budget = {
      v: 1 as const,
      max_steps: maxSteps,
      max_runs_per_day: maxRunsPerDay,
      max_run_seconds: maxRunSeconds
    }
    const toolPolicy: CustomAgentToolPolicy = { v: 1, allowed_tools: selectedTools }
    if (create) {
      const id = createdId ?? slugifyTitle(title)
      // 两段式：先建草稿行（type='custom'，无 trigger），再 setConfig 补 trigger/tool_policy/budget。
      // 新建恒发显式集合（默认勾 defaults），维持安全方向。
      // 第二段失败后的重试（createdId 已记）跳过 create 直接 setConfig，patch 带上
      // title/enabled/model/prompt 覆盖重试间隙的编辑（首次成功路径 = 同值幂等覆写）。
      const ensureCreated: Promise<unknown> =
        createdId !== null
          ? Promise.resolve()
          : createAgent({
              id,
              type: 'custom',
              title: title.trim() || id,
              enabled,
              model: model || null,
              prompt: prompt.trim() || null
            }).then(() => setCreatedId(id))
      void ensureCreated
        .then(() =>
          save(id, {
            title: title.trim() || id,
            enabled,
            model,
            prompt: prompt.trim() || null,
            trigger,
            tool_policy: toolPolicy,
            budget
          })
        )
        .then(onClose)
        .catch((e: unknown) => setErr(errText(e)))
      return
    }
    if (!cfg) return
    const editPatch: ReportConfigPatch = {
      enabled,
      title: title.trim() || cfg.title,
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      trigger,
      budget
    }
    // 编辑「按需发送」tool_policy：仅当用户本次会话触碰过工具区（toolsDirty）或 grant 开关
    // （grantDirty，S5 W5b —— 触碰 grant 即触碰 tool_policy）才发。未触碰 → 省略字段（PATCH
    // 语义：字段缺席=不动）——NULL 行仅改 prompt 保存后仍是 NULL（投影层默认安全集继续生效），
    // 显式行同理原封不动。这修复了「编辑 NULL-policy 行会被静默清成空工具集」的 P2。
    // 组装规则：allowed_tools 仅在「工具被触碰或行本就显式」时携带 —— 只翻 grant 的 NULL 行
    // 保持 allowed_tools 缺省（投影层默认安全集语义不被物化）；grant_exec 仅 true 时携带
    // （缺省 = False，parse_tool_policy 语义）。
    if (toolsDirty || grantDirty) {
      const tp: CustomAgentToolPolicy = { v: 1 }
      if (toolsDirty || toolsMode === 'explicit') tp.allowed_tools = selectedTools
      if (grantExec) tp.grant_exec = true
      editPatch.tool_policy = tp
    }
    void save(cfg.id, editPatch)
      .then(onClose)
      .catch((e: unknown) => setErr(errText(e)))
  }

  const onDelete = (): void => {
    if (!cfg) return
    setErr(null)
    void remove(cfg.id)
      .then(onClose)
      .catch((e: unknown) => setErr(errText(e)))
  }

  // UTC 置顶 + 全 IANA 时区（去重 UTC，防 SelectItem key 撞）。
  const tzOptions = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')]

  return (
    <div
      ref={scopeRef}
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.4)' }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '92%',
          zIndex: 61,
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
          boxShadow: 'var(--shadow-raised)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <header
          className="flex items-center"
          style={{
            gap: 10,
            padding: '15px 18px',
            borderBottom: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0
          }}
        >
          <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
            <ReportIcon name="cog" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {create ? t('agents.custom.newTitle') : t('agents.custom.configTitle', { title })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agents.source.close')}
            style={{
              display: 'grid',
              placeItems: 'center',
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
              color: 'rgb(var(--ink-fg-2))'
            }}
          >
            <ReportIcon name="x" size={16} />
          </button>
        </header>

        <div className="scrollbar-thin" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* enable */}
            <div
              className="flex items-center"
              style={{
                gap: 12,
                padding: '13px 14px',
                borderRadius: 10,
                background: 'rgb(var(--ink-2) / 0.55)',
                border: '1px solid rgb(var(--ink-border))'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
                  {t('agents.config.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.custom.enableHint')}
                </div>
              </div>
              <Switch on={enabled} onChange={setEnabled} />
            </div>

            {/* title */}
            <Field label={t('agents.custom.titleLabel')}>
              <input
                type="text"
                value={title}
                placeholder={t('agents.custom.titlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
                style={inputStyle}
              />
            </Field>

            {/* prompt (task) */}
            <Field label={t('agents.custom.promptLabel')} hint={t('agents.custom.promptHint')}>
              <textarea
                value={prompt}
                placeholder={t('agents.custom.promptPlaceholder')}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptDirty(true)
                }}
                rows={8}
                className="scrollbar-thin"
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6, fontSize: 13, minHeight: 150 }}
              />
            </Field>

            {/* model */}
            <Field label={t('agents.config.model')}>
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  {(model && !enabledModels.includes(model)
                    ? [...enabledModels, model]
                    : enabledModels
                  ).map((id) => {
                    const isOrphan = !enabledModels.includes(id)
                    return (
                      <SelectItem key={id} value={id}>
                        {id}
                        {isOrphan && (
                          <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
                            {t('settings.ai.enabledModels.notEnabled', { defaultValue: '（未启用）' })}
                          </span>
                        )}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </Field>

            {/* trigger 判别式 —— seg 控件（非空 sentinel，避 radix SelectItem 空串崩） */}
            <Field label={t('agents.custom.trigger.label')} hint={t('agents.custom.trigger.hint')}>
              <div className="seg" style={{ width: '100%' }}>
                {TRIGGER_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={triggerKind === k ? 'on' : ''}
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => setTriggerKind(k)}
                  >
                    {t(`agents.custom.trigger.kind.${k}`)}
                  </button>
                ))}
              </div>

              {triggerKind === 'none' && (
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 8, lineHeight: 1.5 }}>
                  {t('agents.custom.trigger.noneHint')}
                </div>
              )}

              {triggerKind === 'cron' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <div>
                    <input
                      type="text"
                      value={cron}
                      placeholder="0 9 * * 1-5"
                      onChange={(e) => setCron(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                    />
                    <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 6, lineHeight: 1.5 }}>
                      {t('agents.custom.trigger.cronHint')}
                    </div>
                  </div>
                  <Select value={triggerTz} onValueChange={setTriggerTz}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('agents.custom.trigger.tz')} />
                    </SelectTrigger>
                    <SelectContent className="z-[70]">
                      {tzOptions.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {triggerKind === 'email_filter' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  <input
                    type="text"
                    value={senderPattern}
                    placeholder={t('agents.custom.trigger.senderPlaceholder')}
                    onChange={(e) => setSenderPattern(e.target.value)}
                    style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                  />
                  <input
                    type="text"
                    value={subjectPattern}
                    placeholder={t('agents.custom.trigger.subjectPlaceholder')}
                    onChange={(e) => setSubjectPattern(e.target.value)}
                    style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
                  />
                  <input
                    type="text"
                    value={folders}
                    placeholder={t('agents.custom.trigger.foldersPlaceholder')}
                    onChange={(e) => setFolders(e.target.value)}
                    style={inputStyle}
                  />
                  <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                    {t('agents.custom.trigger.emailHint')}
                  </div>
                </div>
              )}
            </Field>

            {/* allowed_tools 多选 */}
            <Field label={t('agents.custom.tools.label')} hint={t('agents.custom.tools.hint')}>
              {toolOptions.tools.length === 0 ? (
                // 工具清单无法加载（端点未就绪 / flag off）→ 禁用该区编辑（无可点 chip →
                // toolsDirty 永不置真 → 编辑保存省略 tool_policy，绝不在信息缺失下写错集合）。
                // 已有显式集合只读展示，让用户看清当前配置。
                <div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'rgb(var(--ink-fg-3))',
                      padding: '11px 13px',
                      borderRadius: 9,
                      background: 'rgb(var(--ink-1) / 0.5)',
                      border: '1px solid rgb(var(--ink-border-soft))'
                    }}
                  >
                    {t('agents.custom.tools.unavailable')}
                  </div>
                  {selectedTools.length > 0 && (
                    <div
                      className="flex items-center"
                      style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}
                    >
                      {selectedTools.map((name) => (
                        <span
                          key={name}
                          style={{
                            padding: '5px 10px',
                            borderRadius: 8,
                            fontFamily: 'var(--font-mono, monospace)',
                            fontSize: 12,
                            color: 'rgb(var(--ink-fg-2))',
                            background: 'rgb(var(--ink-1) / 0.5)',
                            border: '1px solid rgb(var(--ink-border))'
                          }}
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {toolOptions.tools.map((tool) => {
                    const on = selectedTools.includes(tool.name)
                    const isWrite = tool.class === 'domain_write'
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleTool(tool.name)}
                        title={isWrite ? t('agents.custom.tools.writeTag') : undefined}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '6px 11px',
                          borderRadius: 8,
                          fontFamily: 'var(--font-mono, monospace)',
                          fontSize: 12.5,
                          cursor: 'pointer',
                          color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                          background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                          border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`
                        }}
                      >
                        {tool.name}
                        {isWrite && (
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: 'inherit',
                              color: 'rgb(var(--c-warn))'
                            }}
                          >
                            {t('agents.custom.tools.writeBadge')}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </Field>

            {/* budget 三门 */}
            <Field label={t('agents.custom.budget.label')} hint={t('agents.custom.budget.hint')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="flex items-center" style={{ gap: 10 }}>
                  <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                    {t('agents.custom.budget.maxSteps', { max: MAX_STEPS_CEILING })}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_STEPS_CEILING}
                    value={maxSteps}
                    onChange={(e) => setMaxSteps(Number(e.target.value))}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </div>
                <div className="flex items-center" style={{ gap: 10 }}>
                  <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                    {t('agents.custom.budget.maxRunsPerDay')}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={maxRunsPerDay}
                    onChange={(e) => setMaxRunsPerDay(Number(e.target.value))}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </div>
                <div className="flex items-center" style={{ gap: 10 }}>
                  <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                    {t('agents.custom.budget.maxRunSeconds', { max: MAX_RUN_SECONDS_CEILING })}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_RUN_SECONDS_CEILING}
                    value={maxRunSeconds}
                    onChange={(e) => setMaxRunSeconds(Number(e.target.value))}
                    style={{ ...inputStyle, width: 110 }}
                  />
                </div>
              </div>
            </Field>

            {/* 自动化策略（S5 W5b；仅编辑既有时 —— 建规归属校验要求 agent 行已存在） */}
            {!create && cfg && (
              <AutomationPolicySection
                agentId={cfg.id}
                agentTitle={title.trim() || cfg.title}
                triggerKind={cfg.trigger?.kind ?? null}
                writeToolChoices={toolOptions.tools
                  .filter((tl) => tl.class === 'domain_write' && selectedTools.includes(tl.name))
                  .map((tl) => tl.name)}
                grantExec={grantExec}
                onGrantChange={(next) => {
                  setGrantExec(next)
                  setGrantDirty(true)
                }}
              />
            )}

            {/* run 历史（仅编辑既有时；新建时 agent 尚未存在） */}
            {!create && cfg && <RunHistorySection agentId={cfg.id} />}

            {err && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'rgb(var(--c-fail))',
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--c-fail) / 0.10)',
                  border: '1px solid rgb(var(--c-fail) / 0.25)',
                  wordBreak: 'break-word'
                }}
              >
                {err}
              </div>
            )}
          </div>
        </div>

        <footer
          className="flex items-center"
          style={{
            gap: 10,
            padding: '13px 18px',
            borderTop: '1px solid rgb(var(--ink-border-soft))',
            flexShrink: 0
          }}
        >
          {/* 删除：仅编辑既有时；两步确认（同 SearchConfigDrawer 风格）。 */}
          {!create &&
            cfg &&
            (confirming ? (
              <span className="flex items-center" style={{ gap: 6 }}>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={busy}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 13,
                    padding: '7px 12px',
                    borderRadius: 8,
                    cursor: busy ? 'wait' : 'pointer',
                    color: 'rgb(var(--c-fail))',
                    background: 'rgb(var(--c-fail) / 0.12)',
                    border: '1px solid rgb(var(--c-fail) / 0.3)'
                  }}
                >
                  {t('agents.search.deleteConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="btn-ghost"
                  style={{ fontFamily: 'inherit' }}
                >
                  {t('agents.search.deleteCancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex items-center"
                style={{
                  gap: 6,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'transparent',
                  border: '1px solid rgb(var(--c-fail) / 0.3)'
                }}
              >
                <ReportIcon name="x" size={14} />
                {t('agents.search.delete')}
              </button>
            ))}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost"
            style={{ fontFamily: 'inherit' }}
          >
            {t('agents.config.cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: busy ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0
            }}
          >
            {create ? t('agents.custom.create') : t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
