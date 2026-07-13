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
//
// Lane C2（07-07 review 拆分）：run 历史 / 自动化策略 / 额外能力三个 section 已机械搬迁到
// ./custom-agent/ 子目录（逻辑逐字节不变）；RunStateBadge 在此 re-export，供 AgentsTab /
// AgentRecordView 沿用 './CustomAgentDrawer' 导入路径不变。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
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
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  useCreateAgent,
  useDeleteAgent,
  useOpennessFlags,
  useSetConfig,
  useToolOptions
} from './hooks'
import { groupToolOptions } from './toolGroups'
import { ModelSelectItems } from './drawers/ModelSelectItems'
import { errText, type WebGrant } from './custom-agent/shared'
import { RunHistorySection } from './custom-agent/RunHistorySection'
import { AutomationPolicySection } from './custom-agent/AutomationPolicySection'
import { ExtraCapabilitiesSection } from './custom-agent/ExtraCapabilitiesSection'

export { RunStateBadge } from './custom-agent/RunHistorySection'

// budget 三门默认 + 上限（与 src/agents/trigger.py DEFAULT_*/CEILING 对齐；浅校验用）。
const DEFAULT_MAX_STEPS = 8
const MAX_STEPS_CEILING = 16
const DEFAULT_MAX_RUNS_PER_DAY = 24
const DEFAULT_MAX_RUN_SECONDS = 300
const MAX_RUN_SECONDS_CEILING = 1800

// per-agent skill 挂载默认集（S6 W3-3；与 src/api/routers/agent_runs.py 的
// DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS 同源，NULL 挂载 → 默认集，工具面与现存 agent 逐字节一致）。
const DEFAULT_MOUNTED_SKILLS = ['email', 'search']

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
        <label style={{ fontSize: 13, fontWeight: 500, color: 'rgb(var(--ink-fg))' }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>{hint}</span>}
      </div>
      {children}
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
  // R3 — openness flag 分面（webToolsEnabled/execToolsEnabled），驱动「额外能力」区禁用提示。
  const opennessFlags = useOpennessFlags(open)

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
  // grant_web（S6 W3-3 ADR-004 rev3.1 §3.1）三档 + skill 挂载：均循 grantExec 的「按需发送」纪律
  // （触碰 → dirty → 保存时并入 tool_policy）。skillsMode 区分「默认挂载集（NULL）」与「显式列表
  // （含 []）」两态（镜像 toolsMode）—— 未触碰的 NULL 行保存后仍是 NULL，投影层默认集继续生效。
  const [grantWeb, setGrantWeb] = useState<WebGrant>('off')
  const [webDirty, setWebDirty] = useState(false)
  const [mountedSkills, setMountedSkills] = useState<string[]>([])
  const [skillsMode, setSkillsMode] = useState<'defaults' | 'explicit'>('defaults')
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [maxSteps, setMaxSteps] = useState(DEFAULT_MAX_STEPS)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(DEFAULT_MAX_RUNS_PER_DAY)
  const [maxRunSeconds, setMaxRunSeconds] = useState(DEFAULT_MAX_RUN_SECONDS)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
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
    setSaveFailed(false)
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
      setGrantWeb('off')
      setWebDirty(false)
      setMountedSkills(DEFAULT_MOUNTED_SKILLS)
      setSkillsMode('defaults')
      setSkillsDirty(false)
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
    setGrantWeb(cfg.tool_policy?.grant_web ?? 'off')
    setWebDirty(false)
    // skills=NULL（未配置）→ 展示默认挂载集（defaults 模式，保存时未触碰不写 skills 键）；
    // 显式列表（含 []）→ 展示行内集合（explicit）。镜像 allowed_tools 的 defaults/explicit 两态。
    const mounts = cfg.tool_policy?.skills
    if (Array.isArray(mounts)) {
      setMountedSkills(mounts)
      setSkillsMode('explicit')
    } else {
      setMountedSkills(DEFAULT_MOUNTED_SKILLS)
      setSkillsMode('defaults')
    }
    setSkillsDirty(false)
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

  // R3 — 组级批量（全选/清空一个家族）。与 toggleTool 同一 toolsDirty 纪律（触碰即显式）。
  const setGroupTools = (names: string[], on: boolean): void => {
    setToolsDirty(true)
    setSelectedTools((prev) =>
      on
        ? [...prev, ...names.filter((n) => !prev.includes(n))]
        : prev.filter((x) => !names.includes(x))
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
      setSaveFailed(true)
      return
    }
    setErr(null)
    setSaveFailed(false)
    const trigger = buildTrigger()
    const budget = {
      v: 1 as const,
      max_steps: maxSteps,
      max_runs_per_day: maxRunsPerDay,
      max_run_seconds: maxRunSeconds
    }
    const toolPolicy: CustomAgentToolPolicy = { v: 1, allowed_tools: selectedTools }
    // R3 — 新建也可授 grants（额外能力区新建时渲染）：两段式第二段 setConfig（PUT）本就接受
    // grant 键；按需物化（false/'off' 缺省 = parse_tool_policy 默认），镜像编辑路径纪律。
    if (grantExec) toolPolicy.grant_exec = true
    if (grantWeb !== 'off') toolPolicy.grant_web = grantWeb
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
        .catch((e: unknown) => {
          setErr(errText(e))
          setSaveFailed(true)
        })
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
    // 组装规则：tool_policy 从**当前 state**（全部由 cfg 预填）整体重建，所以任何一个子面 dirty
    // 都不会抹掉其它键（W3-2 教训）。各键的「按需物化」纪律：allowed_tools / skills 仅在「被触碰
    // 或行本就显式」时携带 —— 只翻 grant 的 NULL 行保持二者缺省（投影层默认集/默认挂载集不被物化）；
    // grant_exec 仅 true 携带、grant_web 仅非 'off' 携带（缺省语义 = parse_tool_policy 的 false/'off'）。
    if (toolsDirty || grantDirty || webDirty || skillsDirty) {
      const tp: CustomAgentToolPolicy = { v: 1 }
      if (toolsDirty || toolsMode === 'explicit') tp.allowed_tools = selectedTools
      if (grantExec) tp.grant_exec = true
      if (grantWeb !== 'off') tp.grant_web = grantWeb
      if (skillsDirty || skillsMode === 'explicit') tp.skills = mountedSkills
      editPatch.tool_policy = tp
    }
    void save(cfg.id, editPatch)
      .then(onClose)
      .catch((e: unknown) => {
        setErr(errText(e))
        setSaveFailed(true)
      })
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
    <Drawer open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
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
              style={{
                ...inputStyle,
                resize: 'vertical',
                lineHeight: 1.6,
                fontSize: 13,
                minHeight: 150
              }}
            />
          </Field>

          {/* model */}
          <Field label={t('agents.config.model')}>
            <Select value={model || undefined} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder={t('agents.config.model')} />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <ModelSelectItems models={enabledModels} current={model || null} />
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
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 8,
                  lineHeight: 1.5
                }}
              >
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
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      marginTop: 6,
                      lineHeight: 1.5
                    }}
                  >
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
              // R3 — 按家族分组渲染（toolGroups.ts 常量；未映射工具落「其他」组不静默丢）。
              // 组级批量 = 全选/清空（走 setGroupTools，同 toolsDirty 纪律）；组内 chip 单控不变。
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {groupToolOptions(toolOptions.tools).map((group) => {
                  const names = group.tools.map((tl) => tl.name)
                  const selectedCount = names.filter((n) => selectedTools.includes(n)).length
                  return (
                    <div key={group.id}>
                      <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
                        <span
                          style={{ fontSize: 12, fontWeight: 500, color: 'rgb(var(--ink-fg-2))' }}
                        >
                          {t(`agents.custom.tools.group.${group.id}`)}
                        </span>
                        <span style={{ fontSize: 11, color: 'rgb(var(--ink-fg-3))' }}>
                          {selectedCount}/{names.length}
                        </span>
                        <span style={{ flex: 1 }} />
                        <button
                          type="button"
                          onClick={() => setGroupTools(names, true)}
                          style={{
                            fontFamily: 'inherit',
                            fontSize: 11.5,
                            padding: '2px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            color: 'rgb(var(--ink-fg-2))',
                            background: 'transparent',
                            border: '1px solid rgb(var(--ink-border))'
                          }}
                        >
                          {t('agents.custom.tools.groupSelectAll')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setGroupTools(names, false)}
                          style={{
                            fontFamily: 'inherit',
                            fontSize: 11.5,
                            padding: '2px 8px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            color: 'rgb(var(--ink-fg-2))',
                            background: 'transparent',
                            border: '1px solid rgb(var(--ink-border))'
                          }}
                        >
                          {t('agents.custom.tools.groupClearAll')}
                        </button>
                      </div>
                      <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {group.tools.map((tool) => {
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
                                background: on
                                  ? 'rgb(var(--c-accent) / 0.14)'
                                  : 'rgb(var(--ink-1) / 0.5)',
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
                    </div>
                  )
                })}
              </div>
            )}
          </Field>

          {/* 额外能力（R3）：grant_web / grant_exec 授权 —— 工具白名单之外的能力面，
                紧邻工具区提升可发现性；新建模式也渲染（create 二段 setConfig 接受 grant 键）。 */}
          <ExtraCapabilitiesSection
            agentTitle={title.trim() || (cfg ? cfg.title : t('agents.custom.newTitle'))}
            triggerKind={create ? triggerKind : (cfg?.trigger?.kind ?? null)}
            grantExec={grantExec}
            onGrantChange={(next) => {
              setGrantExec(next)
              setGrantDirty(true)
            }}
            grantWeb={grantWeb}
            onWebChange={(next) => {
              setGrantWeb(next)
              setWebDirty(true)
            }}
            flags={opennessFlags}
          />

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
              mountedSkills={mountedSkills}
              skillsMode={skillsMode}
              onSkillsChange={(next) => {
                setMountedSkills(next)
                setSkillsDirty(true)
                setSkillsMode('explicit')
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
        <StatefulButton
          type="button"
          onClick={onSave}
          disabled={busy}
          state={busy ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {create ? t('agents.custom.create') : t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
