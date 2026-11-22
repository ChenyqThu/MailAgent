// Extracted from CustomAgentDrawer.tsx — state, prefill effects, validation, trigger builders, and save/delete/export handlers.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AgentAvatarConfig,
  CustomAgentComputerUseGrant,
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  CustomAgentTriggerV2Entry,
  ReportAgentConfig,
  ReportConfigPatch,
  TriggerSetV2
} from '@shared/api/types'
import { resolveApiBaseUrl, useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  useAgentPluginsEnabled,
  useCalendarTriggerEnabled,
  useConnectorOptions,
  useCreateAgent,
  useDeleteAgent,
  useOpennessFlags,
  useSetConfig,
  useToolOptions,
  useTriggerV2Enabled
} from '../hooks'
import {
  DEFAULT_RULE,
  newScheduleValue,
  readTriggerSchedule,
  type ScheduleValue,
  writeTriggerSchedule
} from '../schedule'
import {
  type CalendarLeadUnit,
  type ConnectorGrantMap,
  type ConnectorToolGrantMap,
  errText,
  formatCalendarLead,
  leadParts,
  type SessionsGrant,
  type WebGrant
} from './shared'

// budget 两门默认 + 上限（与 src/agents/trigger.py DEFAULT_*/CEILING 对齐；浅校验用）。
const DEFAULT_MAX_RUNS_PER_DAY = 24
const DEFAULT_MAX_RUN_SECONDS = 1800
export const MAX_RUN_SECONDS_CEILING = 1800

// per-agent skill 挂载默认集（S6 W3-3；与 src/api/routers/agent_runs.py 的
// DEFAULT_CUSTOM_AGENT_MOUNTED_SKILLS 同源，NULL 挂载 → 默认集，工具面与现存 agent 逐字节一致）。
const DEFAULT_MOUNTED_SKILLS = ['email', 'search', 'report']

export type TriggerKind =
  | 'none'
  | 'cron'
  | 'email_filter'
  | 'calendar_event_change'
  | 'calendar_before_start'
export const TRIGGER_KINDS: TriggerKind[] = [
  'none',
  'cron',
  'email_filter',
  'calendar_event_change',
  'calendar_before_start'
]
export type LeadUnit = CalendarLeadUnit

// title → 稳定 slug（新建 agent id）。保留 CJK + 字母 + 数字，latin 转小写，其余折 `_`；
// 真正为空才时间戳兜底。
export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return slug || `custom_${Date.now().toString(36)}`
}

export interface CustomAgentDrawerProps {
  cfg: ReportAgentConfig | null
  open: boolean
  /** true = 新建空态（cfg 为 null）；false = 编辑既有 cfg。 */
  create?: boolean
  initial?: { title?: string; trigger?: CustomAgentTriggerV2Entry }
  onClose: () => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- controller inferred across split subcomponents
export function useCustomAgentForm({
  cfg,
  open,
  create = false,
  initial,
  onClose
}: CustomAgentDrawerProps) {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { create: createAgent, isCreating } = useCreateAgent()
  const { remove, isDeleting } = useDeleteAgent()
  const { models: enabledModels } = useEnabledModels()
  const triggerV2Enabled = useTriggerV2Enabled()
  const calendarTriggerEnabled = useCalendarTriggerEnabled()
  const agentPluginsEnabled = useAgentPluginsEnabled()
  // 工具清单只在抽屉打开时拉（后端权威 defaults；端点未就绪 → 空 → 提示）。
  const { options: toolOptions } = useToolOptions(open)
  // R3 — openness flag 分面（webToolsEnabled/execToolsEnabled），驱动「额外能力」区禁用提示。
  const opennessFlags = useOpennessFlags(open)
  // PR4 T3 — 第七「外部服务」卡的 connector 行集合（失败降级空数组，不触碰 grant state）。
  // 🔴 PR5 — 必须**同时**看 flag：flag off 时 `/api/connector` 全 409，且这个 query 与设置页
  // 的 ConnectorsSection 共用 `qk.connectors()` 缓存键 —— 只看抽屉开合会把一个 error 结果写进
  // 共享缓存。flags 还在加载（undefined）时按 off 处理，加载完 enabled 自然翻真。
  const connectorSummaries = useConnectorOptions(
    open && opennessFlags.connectorToolsEnabled === true
  )

  const [enabled, setEnabled] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [model, setModel] = useState<string>('')
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('none')
  // 定时触发两态（07-24 排程统一）：
  //  • 'schedule' —— 共享 ScheduleBuilder（新建默认，与报告 Agent 同一个组件）
  //  • 'legacy'   —— 老 `kind:'cron'` 行的裸 cron 文本框。**绝不自动转换**（契约 §4：老 cron 行
  //    原样走 croniter、不改行为）—— `*/5 * * * *` 这类表达式落在构建器值模型之外，静默映射
  //    会改掉用户的触发时刻。用户显式点「改用排程构建器」才切过去。
  const [cronMode, setCronMode] = useState<'schedule' | 'legacy'>('schedule')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [triggerTz, setTriggerTz] = useState('UTC')
  const [schedule, setSchedule] = useState<ScheduleValue>(() =>
    newScheduleValue({ ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] })
  )
  const [senderPattern, setSenderPattern] = useState('')
  const [subjectPattern, setSubjectPattern] = useState('')
  const [folders, setFolders] = useState('') // 逗号分隔
  const [threadIds, setThreadIds] = useState('')
  const [calendarTitlePattern, setCalendarTitlePattern] = useState('')
  const [calendarOrganizerPattern, setCalendarOrganizerPattern] = useState('')
  const [calendarAttendeePattern, setCalendarAttendeePattern] = useState('')
  const [calendarIds, setCalendarIds] = useState('')
  const [leadAmount, setLeadAmount] = useState(1)
  const [leadUnit, setLeadUnit] = useState<LeadUnit>('days')
  const [triggerEntries, setTriggerEntries] = useState<CustomAgentTriggerV2Entry[]>([])
  const [editingTriggerIndex, setEditingTriggerIndex] = useState<number | null>(null)
  const [triggerEnabled, setTriggerEnabled] = useState(false)
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
  // grant_sessions（task 09-02）：会话读取半径两档。读到的恒是投影层物化过的有效值（存量行
  // 按迁移规则代入），保存时**恒显式写回**（见 onSave）—— 不循「仅非默认携带」：键缺席时服务端
  // 会重新套迁移规则，存量 all 行就关不回 own。
  const [grantSessions, setGrantSessions] = useState<SessionsGrant>('own')
  const [sessionsDirty, setSessionsDirty] = useState(false)
  // grant_connectors（MCP connector PR4 T3）：第七「外部服务」卡的 state。🔴 永远存服务端
  // **原始值**（含 UI 没有对应档的 'write'）——展示折叠在 CapabilityCards，这里必须无损往返；
  // 服务端语义 = whole-map replace（显式 {} = 清空），物化规则见 onSave。
  const [grantConnectors, setGrantConnectors] = useState<ConnectorGrantMap>({})
  const [grantConnectorTools, setGrantConnectorTools] = useState<ConnectorToolGrantMap>({})
  const [connectorsDirty, setConnectorsDirty] = useState(false)
  const [grantComputerUse, setGrantComputerUse] = useState<CustomAgentComputerUseGrant | null>(null)
  const [computerUseDirty, setComputerUseDirty] = useState(false)
  const [mountedSkills, setMountedSkills] = useState<string[]>([])
  const [skillsMode, setSkillsMode] = useState<'defaults' | 'explicit'>('defaults')
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(DEFAULT_MAX_RUNS_PER_DAY)
  const [maxRunSeconds, setMaxRunSeconds] = useState(DEFAULT_MAX_RUN_SECONDS)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 两段式 create 的第一段成果（codex S5 复核 P2）：createAgent 成功即记 id——第二段
  // setConfig 失败后原地重试直接走 setConfig，不再重复 create（同 id 撞 409）。打开抽屉重置。
  const [createdId, setCreatedId] = useState<string | null>(null)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。既有豁免理由：模态打开按 cfg/空态预填多字段
  // 表单，React Compiler 迁移债，effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErr(null)
    setSaveFailed(false)
    setConfirming(false)
    setCreatedId(null)
    if (create || !cfg) {
      setEnabled(false)
      setTitle(initial?.title ?? '')
      setDescription('')
      setAvatar(null)
      setAvatarDirty(false)
      setPrompt('')
      setPromptDirty(false)
      setModel('')
      setTriggerKind(
        initial?.trigger?.kind === 'schedule' || initial?.trigger?.kind === 'cron'
          ? 'cron'
          : (initial?.trigger?.kind ?? 'none')
      )
      setCronMode('schedule')
      setCron('0 9 * * 1-5')
      setTriggerTz('UTC')
      // 新建默认「每周 周一~周五 09:00」——与旧 cron 占位 `0 9 * * 1-5` 同义，
      // 老用户看到的默认排程不变。
      setSchedule(newScheduleValue({ ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] }))
      setSenderPattern('')
      setSubjectPattern('')
      setFolders('')
      setThreadIds(
        initial?.trigger?.kind === 'email_filter'
          ? (initial.trigger.thread_ids ?? []).join(', ')
          : ''
      )
      const calendarInitial =
        initial?.trigger?.kind === 'calendar_event_change' ||
        initial?.trigger?.kind === 'calendar_before_start'
          ? initial.trigger
          : null
      setCalendarTitlePattern(calendarInitial?.title_pattern ?? '')
      setCalendarOrganizerPattern(calendarInitial?.organizer_pattern ?? '')
      setCalendarAttendeePattern(calendarInitial?.attendee_pattern ?? '')
      setCalendarIds((calendarInitial?.calendar_ids ?? []).join(', '))
      const initialLead =
        initial?.trigger?.kind === 'calendar_before_start'
          ? leadParts(initial.trigger.lead_seconds)
          : { amount: 1, unit: 'days' as const }
      setLeadAmount(initialLead.amount)
      setLeadUnit(initialLead.unit)
      setTriggerEntries(initial?.trigger ? [initial.trigger] : [])
      setEditingTriggerIndex(initial?.trigger ? 0 : null)
      setTriggerEnabled(initial?.trigger?.enabled ?? false)
      // 新建默认勾选由下方独立 effect 从后端 defaults 初始化（toolOptions 可能尚未就位）。
      setSelectedTools([])
      setToolsMode('defaults')
      setToolsDirty(false)
      setGrantExec(false)
      setGrantDirty(false)
      setGrantWeb('off')
      setWebDirty(false)
      setGrantConnectors({})
      setGrantConnectorTools({})
      setConnectorsDirty(false)
      setGrantComputerUse(null)
      setComputerUseDirty(false)
      setMountedSkills(DEFAULT_MOUNTED_SKILLS)
      setSkillsMode('defaults')
      setSkillsDirty(false)
      setMaxRunsPerDay(DEFAULT_MAX_RUNS_PER_DAY)
      setMaxRunSeconds(DEFAULT_MAX_RUN_SECONDS)
      return
    }
    setEnabled(cfg.enabled)
    setTitle(cfg.title)
    setDescription(cfg.description ?? '')
    setAvatar(cfg.avatar ?? null)
    setAvatarDirty(false)
    setPrompt(cfg.prompt_is_default ? '' : cfg.prompt)
    setPromptDirty(false)
    setModel(cfg.model || '')
    const triggerSet = cfg.trigger?.v === 2 ? cfg.trigger : null
    const trig = triggerSet?.triggers[0] ?? (cfg.trigger?.v === 1 ? cfg.trigger : null)
    setTriggerEntries(triggerSet?.triggers ?? (trig ? [{ ...trig, enabled: true }] : []))
    setEditingTriggerIndex(triggerSet?.triggers.length ? 0 : trig ? 0 : null)
    setTriggerEnabled(triggerSet?.triggers[0]?.enabled ?? Boolean(trig))
    const defaultSchedule = newScheduleValue({
      ...DEFAULT_RULE,
      freq: 'weekly',
      weekdays: [1, 2, 3, 4, 5]
    })
    if (trig?.kind === 'schedule') {
      setTriggerKind('cron')
      setCronMode('schedule')
      setSchedule(readTriggerSchedule({ ...trig, v: 1 }) ?? defaultSchedule)
      setCron('0 9 * * 1-5')
      setTriggerTz('UTC')
      setSenderPattern('')
      setSubjectPattern('')
      setFolders('')
      setThreadIds('')
    } else if (trig?.kind === 'cron') {
      // 老 cron 行：停在 legacy 态原样展示/编辑，**不自动映射**（契约 §4）。
      setTriggerKind('cron')
      setCronMode('legacy')
      setCron(trig.cron)
      setTriggerTz(trig.timezone || 'UTC')
      setSchedule(defaultSchedule)
      setSenderPattern('')
      setSubjectPattern('')
      setFolders('')
      setThreadIds('')
    } else if (trig?.kind === 'email_filter') {
      setTriggerKind('email_filter')
      setSenderPattern(trig.sender_pattern ?? '')
      setSubjectPattern(trig.subject_pattern ?? '')
      setFolders((trig.folders ?? []).join(', '))
      setThreadIds((trig.thread_ids ?? []).join(', '))
      setCronMode('schedule')
      setCron('0 9 * * 1-5')
      setTriggerTz('UTC')
      setSchedule(defaultSchedule)
    } else if (trig?.kind === 'calendar_event_change' || trig?.kind === 'calendar_before_start') {
      setTriggerKind(trig.kind)
      setCalendarTitlePattern(trig.title_pattern ?? '')
      setCalendarOrganizerPattern(trig.organizer_pattern ?? '')
      setCalendarAttendeePattern(trig.attendee_pattern ?? '')
      setCalendarIds((trig.calendar_ids ?? []).join(', '))
      const lead = leadParts(trig.kind === 'calendar_before_start' ? trig.lead_seconds : 86400)
      setLeadAmount(lead.amount)
      setLeadUnit(lead.unit)
    } else {
      setTriggerKind('none')
      setCronMode('schedule')
      setSchedule(defaultSchedule)
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
    setGrantSessions(cfg.tool_policy?.grant_sessions ?? 'own')
    setSessionsDirty(false)
    // 服务端原始 grant 原样进 state（含 'write'）；浅拷贝防 setConnectorTier 的展开写触碰 cfg。
    setGrantConnectors({ ...(cfg.tool_policy?.grant_connectors ?? {}) })
    setGrantConnectorTools({ ...(cfg.tool_policy?.grant_connector_tools ?? {}) })
    setConnectorsDirty(false)
    setGrantComputerUse(cfg.tool_policy?.grant_computer_use ?? null)
    setComputerUseDirty(false)
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
    setMaxRunsPerDay(cfg.budget?.max_runs_per_day ?? DEFAULT_MAX_RUNS_PER_DAY)
    setMaxRunSeconds(cfg.budget?.max_run_seconds ?? DEFAULT_MAX_RUN_SECONDS)
  }, [open, cfg, create, initial])

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

  const editTrigger = (index: number): void => {
    const entry = triggerEntries[index]
    if (!entry) return
    setEditingTriggerIndex(index)
    setTriggerEnabled(entry.enabled)
    if (entry.kind === 'schedule') {
      setTriggerKind('cron')
      setCronMode('schedule')
      setSchedule(readTriggerSchedule({ ...entry, v: 1 }) ?? schedule)
    } else if (entry.kind === 'cron') {
      setTriggerKind('cron')
      setCronMode('legacy')
      setCron(entry.cron)
      setTriggerTz(entry.timezone || 'UTC')
    } else if (entry.kind === 'email_filter') {
      setTriggerKind('email_filter')
      setSenderPattern(entry.sender_pattern ?? '')
      setSubjectPattern(entry.subject_pattern ?? '')
      setFolders((entry.folders ?? []).join(', '))
      setThreadIds((entry.thread_ids ?? []).join(', '))
    } else {
      setTriggerKind(entry.kind)
      setCalendarTitlePattern(entry.title_pattern ?? '')
      setCalendarOrganizerPattern(entry.organizer_pattern ?? '')
      setCalendarAttendeePattern(entry.attendee_pattern ?? '')
      setCalendarIds((entry.calendar_ids ?? []).join(', '))
      const lead = leadParts(entry.kind === 'calendar_before_start' ? entry.lead_seconds : 86400)
      setLeadAmount(lead.amount)
      setLeadUnit(lead.unit)
    }
  }

  const addTrigger = (): void => {
    setEditingTriggerIndex(triggerEntries.length)
    setTriggerEnabled(false)
    setTriggerKind('email_filter')
    setSenderPattern('')
    setSubjectPattern('')
    setFolders('')
    setThreadIds('')
    setCalendarTitlePattern('')
    setCalendarOrganizerPattern('')
    setCalendarAttendeePattern('')
    setCalendarIds('')
    setLeadAmount(1)
    setLeadUnit('days')
  }

  const triggerEntrySummary = (entry: CustomAgentTriggerV2Entry): string => {
    if (entry.kind === 'cron') return `${entry.cron} · ${entry.timezone || 'UTC'}`
    if (entry.kind === 'schedule') return `${entry.rule.freq} · ${entry.timezone}`
    if (entry.kind === 'calendar_event_change') {
      return t('agents.custom.trigger.triggerCalendarChange')
    }
    if (entry.kind === 'calendar_before_start') {
      return t('agents.custom.trigger.triggerCalendarBefore', {
        lead: formatCalendarLead(t, entry.lead_seconds)
      })
    }
    const predicates = [
      entry.sender_pattern,
      entry.subject_pattern,
      entry.folders?.join(', '),
      entry.thread_ids?.join(', ')
    ].filter((value): value is string => Boolean(value))
    return predicates.join(' · ')
  }

  const policyTriggerKind = triggerV2Enabled
    ? triggerEntries.some((entry) => entry.kind === 'email_filter') ||
      (editingTriggerIndex !== null && triggerKind === 'email_filter')
      ? 'email_filter'
      : (triggerEntries[0]?.kind ?? (triggerKind === 'none' ? null : triggerKind))
    : triggerKind === 'none'
      ? null
      : triggerKind

  // trigger tagged-union 构造（none → null = 草稿/禁用触发）。
  const buildTrigger = (): CustomAgentTrigger | null => {
    if (triggerKind === 'cron') {
      return cronMode === 'legacy'
        ? { v: 1, kind: 'cron', cron: cron.trim(), timezone: triggerTz }
        : writeTriggerSchedule(schedule)
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
      const tids = threadIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (tids.length) trig.thread_ids = tids
      return trig
    }
    if (triggerKind === 'calendar_event_change' || triggerKind === 'calendar_before_start') {
      const trig: CustomAgentTrigger =
        triggerKind === 'calendar_before_start'
          ? {
              v: 1,
              kind: 'calendar_before_start',
              lead_seconds:
                leadAmount * (leadUnit === 'days' ? 86400 : leadUnit === 'hours' ? 3600 : 60)
            }
          : { v: 1, kind: 'calendar_event_change' }
      if (calendarTitlePattern.trim()) trig.title_pattern = calendarTitlePattern.trim()
      if (calendarOrganizerPattern.trim()) trig.organizer_pattern = calendarOrganizerPattern.trim()
      if (calendarAttendeePattern.trim()) trig.attendee_pattern = calendarAttendeePattern.trim()
      const ids = calendarIds
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (ids.length) trig.calendar_ids = ids
      return trig
    }
    return null
  }

  // 浅校验（必填 / 数值范围 / cron 5 段 / email 谓词至少一个）。深校验交后端。
  const shallowValidate = (): string | null => {
    if (!title.trim()) return t('agents.custom.errTitleRequired')
    // 构建器出来的规则形状恒合法（值模型受控），只有 legacy 裸 cron 需要段数浅校验。
    if (triggerKind === 'cron' && cronMode === 'legacy' && cron.trim().split(/\s+/).length !== 5) {
      return t('agents.custom.errCron5')
    }
    if (
      triggerKind === 'email_filter' &&
      !senderPattern.trim() &&
      !subjectPattern.trim() &&
      !folders.trim() &&
      !threadIds.trim()
    ) {
      return t('agents.custom.errEmailPredicate')
    }
    if (triggerKind === 'calendar_before_start') {
      const seconds = leadAmount * (leadUnit === 'days' ? 86400 : leadUnit === 'hours' ? 3600 : 60)
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 2592000) {
        return t('agents.custom.errCalendarLead')
      }
    }
    if (grantComputerUse?.enabled) {
      const doms = grantComputerUse.allowed_domains ?? []
      const apps = grantComputerUse.allowed_apps ?? []
      const hasWildcard = [...doms, ...apps].some((s) => {
        const l = s.trim().toLowerCase()
        return !l || l.includes('*') || l === 'all' || l === 'any'
      })
      if ((doms.length === 0 && apps.length === 0) || hasWildcard) {
        return t('agents.custom.errComputerUseScope')
      }
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
    const builtTrigger = buildTrigger()
    const nextEntries = [...triggerEntries]
    if (triggerV2Enabled && editingTriggerIndex !== null && builtTrigger) {
      const { v: _v, ...entryTrigger } = builtTrigger
      const previous = nextEntries[editingTriggerIndex]
      nextEntries[editingTriggerIndex] = {
        ...(previous?.id ? { id: previous.id } : {}),
        enabled: triggerEnabled,
        ...entryTrigger
      }
    }
    const trigger: CustomAgentTrigger | TriggerSetV2 | null = triggerV2Enabled
      ? { v: 2, triggers: nextEntries }
      : builtTrigger
    const budget = {
      v: 1 as const,
      max_runs_per_day: maxRunsPerDay,
      max_run_seconds: maxRunSeconds
    }
    const toolPolicy: CustomAgentToolPolicy = { v: 1, allowed_tools: selectedTools }
    // R3 — 新建也可授 grants（额外能力区新建时渲染）：两段式第二段 setConfig（PUT）本就接受
    // grant 键；按需物化（false/'off' 缺省 = parse_tool_policy 默认），镜像编辑路径纪律。
    if (grantExec) toolPolicy.grant_exec = true
    if (grantWeb !== 'off') toolPolicy.grant_web = grantWeb
    toolPolicy.grant_sessions = grantSessions
    // grant_connectors 仅非空携带（镜像 grant_web 仅非 off 携带）——新建行缺省 = 未授权任何
    // connector（parse_tool_policy 默认），键不物化。
    if (Object.keys(grantConnectors).length > 0) {
      toolPolicy.grant_connectors = grantConnectors
      const prunedTools = Object.fromEntries(
        Object.entries(grantConnectorTools).filter(([cid]) => grantConnectors[cid] !== undefined)
      )
      if (Object.keys(prunedTools).length > 0) toolPolicy.grant_connector_tools = prunedTools
    }
    if (grantComputerUse?.enabled) {
      toolPolicy.grant_computer_use = grantComputerUse
    }
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
              description: description.trim() || null,
              enabled,
              model: model || null,
              prompt: prompt.trim() || null
            }).then(() => setCreatedId(id))
      void ensureCreated
        .then(() =>
          save(id, {
            title: title.trim() || id,
            description: description.trim() || null,
            enabled,
            model,
            prompt: prompt.trim() || null,
            trigger,
            tool_policy: toolPolicy,
            budget,
            ...(avatarDirty ? { avatar } : {})
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
      description: description.trim() || null,
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      trigger,
      budget
    }
    if (avatarDirty) editPatch.avatar = avatar
    // 编辑「按需发送」tool_policy：仅当用户本次会话触碰过工具区（toolsDirty）或 grant 开关
    // （grantDirty，S5 W5b —— 触碰 grant 即触碰 tool_policy）才发。未触碰 → 省略字段（PATCH
    // 语义：字段缺席=不动）——NULL 行仅改 prompt 保存后仍是 NULL（投影层默认安全集继续生效），
    // 显式行同理原封不动。这修复了「编辑 NULL-policy 行会被静默清成空工具集」的 P2。
    // 组装规则：tool_policy 从**当前 state**（全部由 cfg 预填）整体重建，所以任何一个子面 dirty
    // 都不会抹掉其它键（W3-2 教训）。各键的「按需物化」纪律：allowed_tools / skills 仅在「被触碰
    // 或行本就显式」时携带 —— 只翻 grant 的 NULL 行保持二者缺省（投影层默认集/默认挂载集不被物化）；
    // grant_exec 仅 true 携带、grant_web 仅非 'off' 携带（缺省语义 = parse_tool_policy 的 false/'off'）。
    if (
      toolsDirty ||
      grantDirty ||
      webDirty ||
      sessionsDirty ||
      skillsDirty ||
      connectorsDirty ||
      computerUseDirty
    ) {
      const tp: CustomAgentToolPolicy = { v: 1 }
      if (toolsDirty || toolsMode === 'explicit') tp.allowed_tools = selectedTools
      if (grantExec) tp.grant_exec = true
      if (grantWeb !== 'off') tp.grant_web = grantWeb
      tp.grant_sessions = grantSessions
      if (skillsDirty || skillsMode === 'explicit') tp.skills = mountedSkills
      // grant_connectors 从**当前 state**物化（PR4 起它进了「整体重建」不变量的覆盖范围，
      // PR3 的「照抄服务端行」临时块已删）：state 打开时从 cfg 预填、未触碰即原始值无损往返
      // （含 UI 折叠掉的 'write'）。state 空但行原本非空 → 显式 {}（服务端 whole-map replace
      // 语义下的「清空」）；两边都空 → 键不物化（与 PR3 前逐字节相同）。
      if (Object.keys(grantConnectors).length > 0) {
        tp.grant_connectors = grantConnectors
        const prunedTools = Object.fromEntries(
          Object.entries(grantConnectorTools).filter(([cid]) => grantConnectors[cid] !== undefined)
        )
        if (Object.keys(prunedTools).length > 0) tp.grant_connector_tools = prunedTools
      } else if (
        cfg.tool_policy?.grant_connectors &&
        Object.keys(cfg.tool_policy.grant_connectors).length > 0
      ) {
        tp.grant_connectors = {}
      }
      if (grantComputerUse?.enabled) {
        tp.grant_computer_use = grantComputerUse
      }
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

  const onExport = (): void => {
    if (!cfg) return
    setErr(null)
    void fetch(`${resolveApiBaseUrl()}/report-agents/${encodeURIComponent(cfg.id)}/export`, {
      credentials: 'include'
    })
      .then(async (response) => {
        const envelope = (await response.json()) as { data?: unknown; error?: { message?: string } }
        if (!response.ok || !envelope.data)
          throw new Error(envelope.error?.message ?? response.statusText)
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(envelope.data, null, 2)], { type: 'application/json' })
        )
        const anchor = document.createElement('a')
        const slug =
          (cfg.title || cfg.id)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || cfg.id
        anchor.href = url
        anchor.download = `agent-${slug}.json`
        anchor.click()
        URL.revokeObjectURL(url)
      })
      .catch((error: unknown) => setErr(errText(error)))
  }

  // UTC 置顶 + 全 IANA 时区（去重 UTC，防 SelectItem key 撞）。
  const tzOptions = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')]

  return {
    t,
    enabledModels,
    triggerV2Enabled,
    calendarTriggerEnabled,
    agentPluginsEnabled,
    toolOptions,
    opennessFlags,
    connectorSummaries,
    enabled,
    setEnabled,
    title,
    setTitle,
    description,
    setDescription,
    avatar,
    setAvatar,
    setAvatarDirty,
    prompt,
    setPrompt,
    setPromptDirty,
    model,
    setModel,
    triggerKind,
    setTriggerKind,
    cronMode,
    setCronMode,
    cron,
    setCron,
    triggerTz,
    setTriggerTz,
    schedule,
    setSchedule,
    senderPattern,
    setSenderPattern,
    subjectPattern,
    setSubjectPattern,
    folders,
    setFolders,
    threadIds,
    setThreadIds,
    calendarTitlePattern,
    setCalendarTitlePattern,
    calendarOrganizerPattern,
    setCalendarOrganizerPattern,
    calendarAttendeePattern,
    setCalendarAttendeePattern,
    calendarIds,
    setCalendarIds,
    leadAmount,
    setLeadAmount,
    leadUnit,
    setLeadUnit,
    triggerEntries,
    setTriggerEntries,
    editingTriggerIndex,
    setEditingTriggerIndex,
    triggerEnabled,
    setTriggerEnabled,
    selectedTools,
    setSelectedTools,
    setToolsDirty,
    grantExec,
    setGrantExec,
    setGrantDirty,
    grantWeb,
    setGrantWeb,
    setWebDirty,
    grantSessions,
    setGrantSessions,
    setSessionsDirty,
    grantConnectors,
    setGrantConnectors,
    grantConnectorTools,
    setGrantConnectorTools,
    setConnectorsDirty,
    grantComputerUse,
    setGrantComputerUse,
    setComputerUseDirty,
    mountedSkills,
    setMountedSkills,
    skillsMode,
    setSkillsMode,
    setSkillsDirty,
    maxRunsPerDay,
    setMaxRunsPerDay,
    maxRunSeconds,
    setMaxRunSeconds,
    err,
    saveFailed,
    confirming,
    setConfirming,
    busy,
    tzOptions,
    editTrigger,
    addTrigger,
    triggerEntrySummary,
    policyTriggerKind,
    onSave,
    onDelete,
    onExport
  }
}

export type CustomAgentFormController = ReturnType<typeof useCustomAgentForm>
