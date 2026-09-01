// P4a agent-config lane — 完全自定义 Agent 配置页（+ 新建视图）。保存语义逐字段照
// CustomAgentDrawer（浅校验 / trigger tagged-union 构造 / tool_policy「按需发送 + 整体重建」/
// 两段式 create），只改两处：
//   • 「什么时候动」三档单选（r7 §三 / design §8.3）：不定时 · 你找它才动（默认，
//     `trigger: null`）／按时间／按事件。选第一档时编辑区整段收起、页头「试运行一次」
//     不出现。🔴 `'none'` → null 的存储语义一行不动 —— 这里只是把它提成默认档。
//   • 运行记录不再渲染（r7 §三 判据 6）：归团队页记录列。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AgentAvatarConfig,
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  CustomAgentTriggerV2Entry,
  ReportAgentConfig,
  ReportConfigPatch,
  TriggerSetV2
} from '@shared/api/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { resolveApiBaseUrl, useEnabledModels } from '@shared/hooks/useLlmModels'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { ReportIcon, Switch } from '../primitives'
import {
  DEFAULT_RULE,
  ScheduleBuilder,
  type ScheduleValue,
  cronToRuleSeed,
  hostTimezone,
  newScheduleValue,
  readTriggerSchedule,
  writeTriggerSchedule
} from '../schedule'
import {
  useAgentPluginsEnabled,
  useCalendarTriggerEnabled,
  useConnectorOptions,
  useCreateAgent,
  useDeleteAgent,
  useOpennessFlags,
  useRunNow,
  useSetConfig,
  useToolOptions,
  useTriggerV2Enabled
} from '../hooks'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import { Field } from '../drawers/Field'
import {
  errText,
  formatCalendarLead,
  leadParts,
  type CalendarLeadUnit,
  type ConnectorGrantMap,
  type WebGrant
} from '../custom-agent/shared'
import { AutomationPolicySection } from '../custom-agent/AutomationPolicySection'
import { CapabilityCards } from '../custom-agent/CapabilityCards'
import { AgentIdentityHeader } from '../AgentAvatar'
import { pressHandlers } from '../shared'
import { SettingsScaffold } from './sections'
import { ModelGroup, SettingRow, SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'

// budget 两门默认 + 上限（与 src/agents/trigger.py DEFAULT_*/CEILING 对齐；浅校验用）。
const DEFAULT_MAX_RUNS_PER_DAY = 24
const DEFAULT_MAX_RUN_SECONDS = 1800
const MAX_RUN_SECONDS_CEILING = 1800

// per-agent skill 挂载默认集（与 src/api/routers/agent_runs.py 同源）。
const DEFAULT_MOUNTED_SKILLS = ['email', 'search', 'report']

type TriggerKind =
  | 'none'
  | 'cron'
  | 'email_filter'
  | 'calendar_event_change'
  | 'calendar_before_start'
/** 三档中「按事件」档内的事件种类（design §8.3 第三档）。 */
const EVENT_KINDS = ['email_filter', 'calendar_event_change', 'calendar_before_start'] as const
type LeadUnit = CalendarLeadUnit

/** triggerKind → 三档（纯投影，不进存储）。 */
function whenModeOf(kind: TriggerKind): 'manual' | 'timed' | 'event' {
  if (kind === 'none') return 'manual'
  if (kind === 'cron') return 'timed'
  return 'event'
}

// title → 稳定 slug（新建 agent id），镜像 CustomAgentDrawer.slugifyTitle。
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return slug || `custom_${Date.now().toString(36)}`
}

export function CustomAgentSettings({
  cfg,
  create = false,
  onCreated
}: {
  cfg: ReportAgentConfig | null
  /** true = 新建空态（cfg 为 null）。 */
  create?: boolean
  /** 新建保存成功后回调（team-shell 拿它切到新成员）。 */
  onCreated?: (agentId: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { create: createAgent, isCreating } = useCreateAgent()
  const { remove, isDeleting } = useDeleteAgent()
  const { run, isRunning } = useRunNow()
  const { models: enabledModels } = useEnabledModels()
  const triggerV2Enabled = useTriggerV2Enabled()
  const calendarTriggerEnabled = useCalendarTriggerEnabled()
  const agentPluginsEnabled = useAgentPluginsEnabled()
  const { options: toolOptions } = useToolOptions(true)
  const opennessFlags = useOpennessFlags(true)
  // 🔴 必须同时看 flag：flag off 时 /api/connector 全 409，且与设置页共用 qk.connectors() 缓存。
  const connectorSummaries = useConnectorOptions(opennessFlags.connectorToolsEnabled === true)

  const [enabled, setEnabled] = useState(create || !cfg ? false : cfg.enabled)
  const [title, setTitle] = useState(create || !cfg ? '' : cfg.title)
  const [description, setDescription] = useState(create || !cfg ? '' : (cfg.description ?? ''))
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(
    create || !cfg ? null : (cfg.avatar ?? null)
  )
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [prompt, setPrompt] = useState(create || !cfg || cfg.prompt_is_default ? '' : cfg.prompt)
  const [promptDirty, setPromptDirty] = useState(false)
  const [model, setModel] = useState<string>(create || !cfg ? '' : cfg.model || '')

  // ── trigger 编辑态（初值派生沿 CustomAgentDrawer 的 prefill 分支，key=cfg.id 重挂载）──
  const triggerSet = !create && cfg?.trigger?.v === 2 ? cfg.trigger : null
  const initialTrig =
    triggerSet?.triggers[0] ?? (!create && cfg?.trigger?.v === 1 ? cfg.trigger : null)
  const defaultSchedule = (): ScheduleValue =>
    newScheduleValue({ ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] })
  // 🔴 'none' 是默认档（design §8.3）：新建 / 无触发行落在这里，构造成 null 的语义不变。
  const [triggerKind, setTriggerKind] = useState<TriggerKind>(() => {
    if (!initialTrig) return 'none'
    if (initialTrig.kind === 'schedule' || initialTrig.kind === 'cron') return 'cron'
    return initialTrig.kind
  })
  // 老 `kind:'cron'` 行停在 legacy 态原样编辑，**不自动映射**（排程契约 §4）。
  const [cronMode, setCronMode] = useState<'schedule' | 'legacy'>(
    initialTrig?.kind === 'cron' ? 'legacy' : 'schedule'
  )
  const [cron, setCron] = useState(initialTrig?.kind === 'cron' ? initialTrig.cron : '0 9 * * 1-5')
  const [triggerTz, setTriggerTz] = useState(
    initialTrig?.kind === 'cron' ? initialTrig.timezone || 'UTC' : 'UTC'
  )
  const [schedule, setSchedule] = useState<ScheduleValue>(() =>
    initialTrig?.kind === 'schedule'
      ? (readTriggerSchedule({ ...initialTrig, v: 1 }) ?? defaultSchedule())
      : defaultSchedule()
  )
  const [senderPattern, setSenderPattern] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.sender_pattern ?? '') : ''
  )
  const [subjectPattern, setSubjectPattern] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.subject_pattern ?? '') : ''
  )
  const [folders, setFolders] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.folders ?? []).join(', ') : ''
  )
  const [threadIds, setThreadIds] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.thread_ids ?? []).join(', ') : ''
  )
  const initialCalendar =
    initialTrig?.kind === 'calendar_event_change' || initialTrig?.kind === 'calendar_before_start'
      ? initialTrig
      : null
  const [calendarTitlePattern, setCalendarTitlePattern] = useState(
    initialCalendar?.title_pattern ?? ''
  )
  const [calendarOrganizerPattern, setCalendarOrganizerPattern] = useState(
    initialCalendar?.organizer_pattern ?? ''
  )
  const [calendarAttendeePattern, setCalendarAttendeePattern] = useState(
    initialCalendar?.attendee_pattern ?? ''
  )
  const [calendarIds, setCalendarIds] = useState((initialCalendar?.calendar_ids ?? []).join(', '))
  const initialLead = leadParts(
    initialTrig?.kind === 'calendar_before_start' ? initialTrig.lead_seconds : 86400
  )
  const [leadAmount, setLeadAmount] = useState(initialLead.amount)
  const [leadUnit, setLeadUnit] = useState<LeadUnit>(initialLead.unit)
  const [triggerEntries, setTriggerEntries] = useState<CustomAgentTriggerV2Entry[]>(
    triggerSet?.triggers ?? (initialTrig ? [{ ...initialTrig, enabled: true }] : [])
  )
  const [editingTriggerIndex, setEditingTriggerIndex] = useState<number | null>(
    triggerSet?.triggers.length ? 0 : initialTrig ? 0 : null
  )
  const [triggerEnabled, setTriggerEnabled] = useState(
    triggerSet?.triggers[0]?.enabled ?? Boolean(initialTrig)
  )

  // ── 工具 / grant / skills（defaults vs explicit 两态 + dirty，沿 CustomAgentDrawer）──
  const explicitTools = !create && Array.isArray(cfg?.tool_policy?.allowed_tools)
  const [selectedTools, setSelectedTools] = useState<string[]>(
    explicitTools && cfg?.tool_policy?.allowed_tools ? cfg.tool_policy.allowed_tools : []
  )
  // 整页按 cfg.id key 重挂载 → toolsMode 是 props 的纯派生（抽屉里它也只在 prefill 时定一次）。
  const toolsMode: 'defaults' | 'explicit' = explicitTools ? 'explicit' : 'defaults'
  const [toolsDirty, setToolsDirty] = useState(false)
  const [grantExec, setGrantExec] = useState(!create && cfg?.tool_policy?.grant_exec === true)
  const [grantDirty, setGrantDirty] = useState(false)
  const [grantWeb, setGrantWeb] = useState<WebGrant>(
    !create && cfg ? (cfg.tool_policy?.grant_web ?? 'off') : 'off'
  )
  const [webDirty, setWebDirty] = useState(false)
  const [grantConnectors, setGrantConnectors] = useState<ConnectorGrantMap>(
    !create && cfg ? { ...(cfg.tool_policy?.grant_connectors ?? {}) } : {}
  )
  const [connectorsDirty, setConnectorsDirty] = useState(false)
  const explicitSkills = !create && Array.isArray(cfg?.tool_policy?.skills)
  const [mountedSkills, setMountedSkills] = useState<string[]>(
    explicitSkills && cfg?.tool_policy?.skills ? cfg.tool_policy.skills : DEFAULT_MOUNTED_SKILLS
  )
  const [skillsMode, setSkillsMode] = useState<'defaults' | 'explicit'>(
    explicitSkills ? 'explicit' : 'defaults'
  )
  const [skillsDirty, setSkillsDirty] = useState(false)
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(
    (!create && cfg?.budget?.max_runs_per_day) || DEFAULT_MAX_RUNS_PER_DAY
  )
  const [maxRunSeconds, setMaxRunSeconds] = useState(
    (!create && cfg?.budget?.max_run_seconds) || DEFAULT_MAX_RUN_SECONDS
  )
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 两段式 create 的第一段成果：成功即记 id，第二段失败重试跳过 create（防同 id 409）。
  const [createdId, setCreatedId] = useState<string | null>(null)

  // 'defaults' 模式：toolOptions 就位后用后端 defaults 初始化默认勾选；用户触碰后不再覆盖。
  // 🔴 显式行双保险（W5b）：编辑显式 allowed_tools 行永不套 defaults（从 props 直判）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (toolsMode !== 'defaults' || toolsDirty) return
    if (!create && Array.isArray(cfg?.tool_policy?.allowed_tools)) return
    setSelectedTools([...toolOptions.defaults])
  }, [toolsMode, toolsDirty, toolOptions.defaults, create, cfg])
  /* eslint-enable react-hooks/set-state-in-effect */

  const busy = isSaving || isCreating || isDeleting
  const whenMode = whenModeOf(triggerKind)
  const saveState: StatefulButtonState = busy
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

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

  // trigger tagged-union 构造（🔴 none → null = 草稿/禁用触发，存储语义一行不动）。
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
    if (grantExec) toolPolicy.grant_exec = true
    if (grantWeb !== 'off') toolPolicy.grant_web = grantWeb
    if (Object.keys(grantConnectors).length > 0) toolPolicy.grant_connectors = grantConnectors
    if (create) {
      const id = createdId ?? slugifyTitle(title)
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
        .then(() => onCreated?.(id))
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
    // 编辑「按需发送」tool_policy（沿 CustomAgentDrawer：任一子面 dirty → 从当前 state 整体
    // 重建；allowed_tools / skills 仅「被触碰或行本就显式」时携带；grant_exec 仅 true、
    // grant_web 仅非 'off' 携带；grant_connectors 空但行原非空 → 显式 {} 清空）。
    if (toolsDirty || grantDirty || webDirty || skillsDirty || connectorsDirty) {
      const tp: CustomAgentToolPolicy = { v: 1 }
      if (toolsDirty || toolsMode === 'explicit') tp.allowed_tools = selectedTools
      if (grantExec) tp.grant_exec = true
      if (grantWeb !== 'off') tp.grant_web = grantWeb
      if (skillsDirty || skillsMode === 'explicit') tp.skills = mountedSkills
      if (Object.keys(grantConnectors).length > 0) {
        tp.grant_connectors = grantConnectors
      } else if (
        cfg.tool_policy?.grant_connectors &&
        Object.keys(cfg.tool_policy.grant_connectors).length > 0
      ) {
        tp.grant_connectors = {}
      }
      editPatch.tool_policy = tp
    }
    void save(cfg.id, editPatch)
      .then(() => {
        setSaveDone(true)
        window.setTimeout(() => setSaveDone(false), 1600)
      })
      .catch((e: unknown) => {
        setErr(errText(e))
        setSaveFailed(true)
      })
  }

  const onDelete = (): void => {
    if (!cfg) return
    setErr(null)
    void remove(cfg.id).catch((e: unknown) => setErr(errText(e)))
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

  const errBlock = err && (
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
  )

  return (
    <SettingsScaffold
      title={create ? t('agents.custom.newTitle') : title || (cfg?.title ?? '')}
      subtitle={create ? undefined : t('agentSettings.role.custom')}
      banner={
        create ? (
          <div
            style={{
              fontSize: 12.5,
              color: 'rgb(var(--ink-fg-2))',
              padding: '10px 12px',
              borderRadius: 9,
              background: 'rgb(var(--c-accent) / 0.08)',
              border: '1px solid rgb(var(--c-accent) / 0.25)',
              lineHeight: 1.55
            }}
          >
            {t('agentSettings.create.hint')}
          </div>
        ) : (
          errBlock || undefined
        )
      }
      enable={{ on: enabled, onChange: setEnabled }}
      // 「不定时」档没有可试的定时行为 → 页头不出现「试运行一次」；新建时 agent 尚不存在。
      tryRun={
        !create && cfg && whenMode !== 'manual'
          ? { onRun: () => void run(cfg.id), running: isRunning }
          : undefined
      }
      save={{
        state: saveState,
        onSave,
        disabled: busy,
        label: create ? t('agents.custom.create') : undefined
      }}
      sections={{
        identity: (
          <>
            <Field label={t('agents.avatar.identityLabel')} hint={t('agents.avatar.hint')}>
              <AgentIdentityHeader
                agentId={cfg?.id ?? slugifyTitle(title)}
                value={avatar}
                onChange={(next) => {
                  setAvatar(next)
                  setAvatarDirty(true)
                }}
                name={title}
                onNameChange={setTitle}
                namePlaceholder={t('agents.custom.titlePlaceholder')}
                // 名字下的一行现成事实：选了哪个模型、按哪种方式起跑。model 为空
                // （新建、还没选）就只剩起跑方式，不占位也不编造。
                meta={[model, t(`agentSettings.when.${whenMode}`)].filter(Boolean).join(' · ')}
              />
            </Field>
            <Field
              label={t('agents.custom.descriptionLabel')}
              hint={t('agents.custom.descriptionHint')}
            >
              <textarea
                value={description}
                maxLength={1000}
                rows={3}
                placeholder={t('agents.custom.descriptionPlaceholder')}
                onChange={(event) => setDescription(event.target.value)}
                className="scrollbar-thin"
                style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.5, minHeight: 72 }}
              />
            </Field>
          </>
        ),
        instructions: (
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
                ...INPUT_STYLE,
                resize: 'vertical',
                lineHeight: 1.6,
                fontSize: 13,
                minHeight: 150
              }}
            />
          </Field>
        ),
        model: (
          <ModelGroup
            primary={
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger aria-label={t('agents.config.model')}>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <ModelSelectItems models={enabledModels} current={model || null} />
                </SelectContent>
              </Select>
            }
          />
        ),
        when: (
          <Field label={t('agents.custom.trigger.label')} hint={t('agents.custom.trigger.hint')}>
            {triggerV2Enabled && triggerEntries.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {triggerEntries.map((entry, index) => (
                  <div
                    key={entry.id ?? `new-${index}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: 8,
                      border: '1px solid rgb(var(--ink-border))',
                      borderRadius: 8
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5 }}>
                        {t(`agents.custom.trigger.kind.${entry.kind}`)}
                      </div>
                      <div
                        style={{
                          marginTop: 2,
                          color: 'rgb(var(--ink-fg-3))',
                          fontSize: 11.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {triggerEntrySummary(entry)}
                      </div>
                    </div>
                    <Switch
                      on={entry.enabled}
                      onChange={(checked) => {
                        setTriggerEntries((items) =>
                          items.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, enabled: checked } : item
                          )
                        )
                        if (editingTriggerIndex === index) setTriggerEnabled(checked)
                      }}
                    />
                    <button type="button" className="btn-ghost" onClick={() => editTrigger(index)}>
                      {t('agents.custom.trigger.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        setTriggerEntries((items) =>
                          items.filter((_, itemIndex) => itemIndex !== index)
                        )
                        setEditingTriggerIndex(null)
                      }}
                    >
                      {t('agents.custom.trigger.delete')}
                    </button>
                  </div>
                ))}
                <button type="button" className="btn-ghost" onClick={addTrigger}>
                  {t('agents.custom.trigger.add')}
                </button>
              </div>
            )}

            {/* 三档单选（design §8.3）：第一档是默认。档位只驱动编辑面板，
                triggerKind 状态机与 buildTrigger 的构造原样保留。 */}
            <div
              className="seg"
              style={{ width: '100%' }}
              role="group"
              aria-label={t('agents.custom.trigger.label')}
            >
              {(['manual', 'timed', 'event'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={whenMode === mode ? 'on' : ''}
                  aria-pressed={whenMode === mode}
                  style={{ flex: 1, justifyContent: 'center' }}
                  onClick={() => {
                    if (mode === 'manual') {
                      setTriggerKind('none')
                      return
                    }
                    const nextKind: TriggerKind = mode === 'timed' ? 'cron' : 'email_filter'
                    setTriggerKind(nextKind)
                    if (triggerV2Enabled && editingTriggerIndex === null) {
                      setEditingTriggerIndex(triggerEntries.length)
                      setTriggerEnabled(false)
                    }
                  }}
                >
                  {t(`agentSettings.when.${mode}`)}
                </button>
              ))}
            </div>

            {/* 第一档：时刻选择整段收起，只留一句说明（页头的「试运行一次」也随之隐藏）。 */}
            {whenMode === 'manual' && (
              <div
                data-testid="when-manual-hint"
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

            {/* 第三档：事件种类子选（邮件命中 / 日程变动 / 会前提前量）。 */}
            {whenMode === 'event' && (
              <div
                className="seg"
                style={{ width: '100%', marginTop: 8 }}
                role="group"
                aria-label={t('agentSettings.when.eventKindLabel')}
              >
                {EVENT_KINDS.filter(
                  (kind) => calendarTriggerEnabled || !kind.startsWith('calendar_')
                ).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={triggerKind === k ? 'on' : ''}
                    aria-pressed={triggerKind === k}
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => setTriggerKind(k)}
                  >
                    {t(`agents.custom.trigger.kind.${k}`)}
                  </button>
                ))}
              </div>
            )}

            {triggerKind === 'cron' && cronMode === 'schedule' && (
              <div style={{ marginTop: 12 }}>
                <ScheduleBuilder value={schedule} onChange={setSchedule} />
              </div>
            )}

            {triggerKind === 'cron' && cronMode === 'legacy' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <div>
                  <input
                    type="text"
                    value={cron}
                    placeholder="0 9 * * 1-5"
                    onChange={(e) => setCron(e.target.value)}
                    style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
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
                {/* 升级入口：**单向** —— 构建器的值模型不覆盖任意 cron，回不去才是诚实的。 */}
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontFamily: 'inherit', alignSelf: 'flex-start' }}
                  onClick={() => {
                    const seed = cronToRuleSeed(cron)
                    setSchedule(
                      newScheduleValue(
                        seed ?? { ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] },
                        triggerTz || hostTimezone()
                      )
                    )
                    setCronMode('schedule')
                  }}
                >
                  {t('agents.custom.trigger.upgradeToBuilder')}
                </button>
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                  {t('agents.custom.trigger.legacyCronHint')}
                </div>
              </div>
            )}

            {triggerKind === 'email_filter' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input
                  type="text"
                  value={senderPattern}
                  placeholder={t('agents.custom.trigger.senderPlaceholder')}
                  onChange={(e) => setSenderPattern(e.target.value)}
                  style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <input
                  type="text"
                  value={subjectPattern}
                  placeholder={t('agents.custom.trigger.subjectPlaceholder')}
                  onChange={(e) => setSubjectPattern(e.target.value)}
                  style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <input
                  type="text"
                  value={folders}
                  placeholder={t('agents.custom.trigger.foldersPlaceholder')}
                  onChange={(e) => setFolders(e.target.value)}
                  style={INPUT_STYLE}
                />
                {triggerV2Enabled && (
                  <input
                    type="text"
                    value={threadIds}
                    placeholder={t('agents.custom.trigger.threadIdsPlaceholder')}
                    onChange={(e) => setThreadIds(e.target.value)}
                    style={INPUT_STYLE}
                  />
                )}
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                  {t('agents.custom.trigger.emailHint')}
                </div>
              </div>
            )}

            {(triggerKind === 'calendar_event_change' ||
              triggerKind === 'calendar_before_start') && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                <input
                  type="text"
                  value={calendarTitlePattern}
                  placeholder={t('agents.custom.trigger.titlePatternPlaceholder')}
                  onChange={(e) => setCalendarTitlePattern(e.target.value)}
                  style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <input
                  type="text"
                  value={calendarOrganizerPattern}
                  placeholder={t('agents.custom.trigger.organizerPatternPlaceholder')}
                  onChange={(e) => setCalendarOrganizerPattern(e.target.value)}
                  style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <input
                  type="text"
                  value={calendarAttendeePattern}
                  placeholder={t('agents.custom.trigger.attendeePatternPlaceholder')}
                  onChange={(e) => setCalendarAttendeePattern(e.target.value)}
                  style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
                />
                <input
                  type="text"
                  value={calendarIds}
                  placeholder={t('agents.custom.trigger.calendarIdsPlaceholder')}
                  onChange={(e) => setCalendarIds(e.target.value)}
                  style={INPUT_STYLE}
                />
                {triggerKind === 'calendar_before_start' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10 }}>
                    <input
                      type="number"
                      min={1}
                      value={leadAmount}
                      aria-label={t('agents.custom.trigger.leadLabel')}
                      onChange={(e) => setLeadAmount(Number(e.target.value))}
                      style={INPUT_STYLE}
                    />
                    <Select
                      value={leadUnit}
                      onValueChange={(value) => setLeadUnit(value as LeadUnit)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[70]">
                        <SelectItem value="minutes">
                          {t('agents.custom.trigger.leadUnitMinutes')}
                        </SelectItem>
                        <SelectItem value="hours">
                          {t('agents.custom.trigger.leadUnitHours')}
                        </SelectItem>
                        <SelectItem value="days">
                          {t('agents.custom.trigger.leadUnitDays')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
                  {t('agents.custom.trigger.calendarHint')}
                </div>
              </div>
            )}

            {triggerV2Enabled && editingTriggerIndex !== null && whenMode !== 'manual' && (
              <div style={{ marginTop: 10 }}>
                <SwitchCard
                  label={t('agents.custom.trigger.enabled')}
                  on={triggerEnabled}
                  onChange={setTriggerEnabled}
                />
              </div>
            )}
          </Field>
        ),
        capabilities: (
          <>
            <CapabilityCards
              selectedTools={selectedTools}
              onSelectedToolsChange={(next) => {
                setSelectedTools(next)
                setToolsDirty(true)
              }}
              agentTitle={title.trim() || (cfg ? cfg.title : t('agents.custom.newTitle'))}
              triggerKind={policyTriggerKind}
              grantExec={grantExec}
              onGrantExecChange={(next) => {
                setGrantExec(next)
                setGrantDirty(true)
              }}
              grantWeb={grantWeb}
              onGrantWebChange={(next) => {
                setGrantWeb(next)
                setWebDirty(true)
              }}
              flags={opennessFlags}
              toolOptions={toolOptions}
              connectorOptions={connectorSummaries.map((c) => ({
                id: c.connector_id,
                label: c.display_name,
                status: c.status
              }))}
              grantConnectors={grantConnectors}
              onGrantConnectorsChange={(next) => {
                setGrantConnectors(next)
                setConnectorsDirty(true)
              }}
            />
            {/* 自动化策略（仅编辑既有 —— 建规归属校验要求 agent 行已存在）。 */}
            {!create && cfg && (
              <AutomationPolicySection
                agentId={cfg.id}
                agentTitle={title.trim() || cfg.title}
                triggerKind={policyTriggerKind}
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
          </>
        ),
        specific: (
          <>
            <Field label={t('agents.custom.budget.label')} hint={t('agents.custom.budget.hint')}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <SettingRow label={t('agents.custom.budget.maxRunsPerDay')}>
                  <input
                    type="number"
                    min={0}
                    value={maxRunsPerDay}
                    onChange={(e) => setMaxRunsPerDay(Number(e.target.value))}
                    style={{ ...INPUT_STYLE, width: 110 }}
                  />
                </SettingRow>
                <SettingRow
                  label={t('agents.custom.budget.maxRunSeconds', { max: MAX_RUN_SECONDS_CEILING })}
                >
                  <input
                    type="number"
                    min={1}
                    max={MAX_RUN_SECONDS_CEILING}
                    value={maxRunSeconds}
                    onChange={(e) => setMaxRunSeconds(Number(e.target.value))}
                    style={{ ...INPUT_STYLE, width: 110 }}
                  />
                </SettingRow>
              </div>
            </Field>
            {create && errBlock}
          </>
        ),
        danger:
          !create && cfg ? (
            <div className="flex items-center" style={{ gap: 10, flexWrap: 'wrap' }}>
              {cfg.type === 'custom' && agentPluginsEnabled ? (
                <button
                  type="button"
                  onClick={onExport}
                  className="btn-ghost"
                  style={{ fontFamily: 'inherit' }}
                >
                  {t('agents.custom.export')}
                </button>
              ) : null}
              <span style={{ flex: 1 }} />
              {confirming ? (
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
                  // 静息态只留红字：删除入口不该在页面底部拉一道红框喊人。红色留给
                  // 下一步的确认按钮 —— 那一下才是不可逆的。
                  style={{
                    gap: 6,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    padding: '8px 14px',
                    borderRadius: 'var(--r-ctl)',
                    cursor: 'pointer',
                    color: 'rgb(var(--c-fail))',
                    background: 'transparent',
                    border: '1px solid rgb(var(--ink-border))',
                    transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
                  }}
                  {...pressHandlers()}
                >
                  <ReportIcon name="x" size={14} />
                  {t('agents.search.delete')}
                </button>
              )}
            </div>
          ) : undefined
      }}
    />
  )
}

/** 新建自定义 Agent（team-shell 挂在「+ 新成员」入口；保存成功后才有其他档）。 */
export function CustomAgentCreateView({
  onCreated
}: {
  onCreated?: (agentId: string) => void
}): React.ReactElement {
  return <CustomAgentSettings cfg={null} create onCreated={onCreated} />
}
