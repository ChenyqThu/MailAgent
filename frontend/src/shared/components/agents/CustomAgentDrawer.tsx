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

import type {
  AgentRunState,
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportConfigPatch
} from '@shared/api/types'
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
                <span style={{ fontSize: 12, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {fmtTime(r.finishedAt ?? r.createdAt)}
                </span>
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
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(DEFAULT_MAX_RUNS_PER_DAY)
  const [maxRunSeconds, setMaxRunSeconds] = useState(DEFAULT_MAX_RUN_SECONDS)
  const [err, setErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。同 SearchConfigDrawer 既有豁免理由：模态打开按
  // cfg/空态预填多字段表单，React Compiler 迁移债，effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErr(null)
    setConfirming(false)
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
    setMaxSteps(cfg.budget?.max_steps ?? DEFAULT_MAX_STEPS)
    setMaxRunsPerDay(cfg.budget?.max_runs_per_day ?? DEFAULT_MAX_RUNS_PER_DAY)
    setMaxRunSeconds(cfg.budget?.max_run_seconds ?? DEFAULT_MAX_RUN_SECONDS)
  }, [open, cfg, create])

  // 'defaults' 模式（新建 / 编辑 NULL-policy 行）：toolOptions 就位后用后端 defaults 初始化
  // 默认勾选（展示与 NULL 投影的真实默认安全集一致）。用户触碰工具区（toolsDirty）后不再
  // 覆盖；defaults 稳定引用（EMPTY 单例），就位后仅触发一次。
  useEffect(() => {
    if (!open || toolsMode !== 'defaults' || toolsDirty) return
    setSelectedTools([...toolOptions.defaults])
  }, [open, toolsMode, toolsDirty, toolOptions.defaults])
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
      const id = slugifyTitle(title)
      // 两段式：先建草稿行（type='custom'，无 trigger），再 setConfig 补 trigger/tool_policy/budget。
      // 新建恒发显式集合（默认勾 defaults），维持安全方向。
      void createAgent({
        id,
        type: 'custom',
        title: title.trim() || id,
        enabled,
        model: model || null,
        prompt: prompt.trim() || null
      })
        .then(() => save(id, { trigger, tool_policy: toolPolicy, budget }))
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
    // 编辑「按需发送」tool_policy：仅当用户本次会话触碰过工具区（toolsDirty）才发（含空数组=
    // 显式零工具，安全方向）。未触碰 → 省略字段（PATCH 语义：字段缺席=不动）——NULL 行仅改
    // prompt 保存后仍是 NULL（投影层默认安全集继续生效），显式行同理原封不动。这修复了「编辑
    // NULL-policy 行会被静默清成空工具集」的 P2（W5 的 DMS/周报模板正是此类 NULL 行）。
    if (toolsDirty) editPatch.tool_policy = toolPolicy
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
