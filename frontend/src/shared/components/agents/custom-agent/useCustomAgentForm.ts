// Extracted from CustomAgentDrawer.tsx — reducer state, prop sync, validation, trigger builders, and CRUD handlers.

import { type Dispatch, type SetStateAction, useMemo, useReducer } from 'react'
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

interface FormSyncTracker {
  open: boolean
  cfg: ReportAgentConfig | null
  create: boolean
  initial: CustomAgentDrawerProps['initial']
  appliedDefaults: readonly string[] | null
}

interface CustomAgentFormFields {
  enabled: boolean
  title: string
  description: string
  avatar: AgentAvatarConfig | null
  avatarDirty: boolean
  prompt: string
  promptDirty: boolean
  model: string
  triggerKind: TriggerKind
  cronMode: 'schedule' | 'legacy'
  cron: string
  triggerTz: string
  schedule: ScheduleValue
  senderPattern: string
  subjectPattern: string
  folders: string
  threadIds: string
  calendarTitlePattern: string
  calendarOrganizerPattern: string
  calendarAttendeePattern: string
  calendarIds: string
  leadAmount: number
  leadUnit: LeadUnit
  triggerEntries: CustomAgentTriggerV2Entry[]
  editingTriggerIndex: number | null
  triggerEnabled: boolean
  selectedTools: string[]
  toolsMode: 'defaults' | 'explicit'
  toolsDirty: boolean
  grantExec: boolean
  grantDirty: boolean
  grantWeb: WebGrant
  webDirty: boolean
  grantSessions: SessionsGrant
  sessionsDirty: boolean
  grantConnectors: ConnectorGrantMap
  grantConnectorTools: ConnectorToolGrantMap
  connectorsDirty: boolean
  grantComputerUse: CustomAgentComputerUseGrant | null
  computerUseDirty: boolean
  mountedSkills: string[]
  skillsMode: 'defaults' | 'explicit'
  skillsDirty: boolean
  maxRunsPerDay: number
  maxRunSeconds: number
  err: string | null
  saveFailed: boolean
  confirming: boolean
  createdId: string | null
}

interface CustomAgentFormState extends CustomAgentFormFields {
  _sync: FormSyncTracker
}

type FormFieldKey = keyof CustomAgentFormFields

type FormAction =
  | {
      type: 'SET_FIELD'
      field: FormFieldKey
      value: SetStateAction<CustomAgentFormFields[FormFieldKey]>
    }
  | {
      type: 'SYNC_FROM_PROPS'
      cfg: ReportAgentConfig | null
      create: boolean
      initial: CustomAgentDrawerProps['initial']
      defaults: readonly string[] | null
    }
  | { type: 'MARK_CLOSED' }
  | { type: 'APPLY_DEFAULT_TOOLS'; defaults: readonly string[] }

function defaultWeeklySchedule(): ScheduleValue {
  return newScheduleValue({ ...DEFAULT_RULE, freq: 'weekly', weekdays: [1, 2, 3, 4, 5] })
}

function createDefaultFormState(): CustomAgentFormState {
  return {
    enabled: false,
    title: '',
    description: '',
    avatar: null,
    avatarDirty: false,
    prompt: '',
    promptDirty: false,
    model: '',
    triggerKind: 'none',
    cronMode: 'schedule',
    cron: '0 9 * * 1-5',
    triggerTz: 'UTC',
    schedule: defaultWeeklySchedule(),
    senderPattern: '',
    subjectPattern: '',
    folders: '',
    threadIds: '',
    calendarTitlePattern: '',
    calendarOrganizerPattern: '',
    calendarAttendeePattern: '',
    calendarIds: '',
    leadAmount: 1,
    leadUnit: 'days',
    triggerEntries: [],
    editingTriggerIndex: null,
    triggerEnabled: false,
    selectedTools: [],
    toolsMode: 'defaults',
    toolsDirty: false,
    grantExec: false,
    grantDirty: false,
    grantWeb: 'off',
    webDirty: false,
    grantSessions: 'own',
    sessionsDirty: false,
    grantConnectors: {},
    grantConnectorTools: {},
    connectorsDirty: false,
    grantComputerUse: null,
    computerUseDirty: false,
    mountedSkills: [],
    skillsMode: 'defaults',
    skillsDirty: false,
    maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
    maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
    err: null,
    saveFailed: false,
    confirming: false,
    createdId: null,
    _sync: {
      open: false,
      cfg: null,
      create: false,
      initial: undefined,
      appliedDefaults: null
    }
  }
}

function buildPrefilledFields(
  cfg: ReportAgentConfig | null,
  create: boolean,
  initial: CustomAgentDrawerProps['initial'],
  defaults: readonly string[] | null
): CustomAgentFormFields {
  const defaultSchedule = defaultWeeklySchedule()
  if (create || !cfg) {
    const calendarInitial =
      initial?.trigger?.kind === 'calendar_event_change' ||
      initial?.trigger?.kind === 'calendar_before_start'
        ? initial.trigger
        : null
    const initialLead =
      initial?.trigger?.kind === 'calendar_before_start'
        ? leadParts(initial.trigger.lead_seconds)
        : { amount: 1, unit: 'days' as const }
    return {
      enabled: false,
      title: initial?.title ?? '',
      description: '',
      avatar: null,
      avatarDirty: false,
      prompt: '',
      promptDirty: false,
      model: '',
      triggerKind:
        initial?.trigger?.kind === 'schedule' || initial?.trigger?.kind === 'cron'
          ? 'cron'
          : (initial?.trigger?.kind ?? 'none'),
      cronMode: 'schedule',
      cron: '0 9 * * 1-5',
      triggerTz: 'UTC',
      schedule: defaultSchedule,
      senderPattern: '',
      subjectPattern: '',
      folders: '',
      threadIds:
        initial?.trigger?.kind === 'email_filter'
          ? (initial.trigger.thread_ids ?? []).join(', ')
          : '',
      calendarTitlePattern: calendarInitial?.title_pattern ?? '',
      calendarOrganizerPattern: calendarInitial?.organizer_pattern ?? '',
      calendarAttendeePattern: calendarInitial?.attendee_pattern ?? '',
      calendarIds: (calendarInitial?.calendar_ids ?? []).join(', '),
      leadAmount: initialLead.amount,
      leadUnit: initialLead.unit,
      triggerEntries: initial?.trigger ? [initial.trigger] : [],
      editingTriggerIndex: initial?.trigger ? 0 : null,
      triggerEnabled: initial?.trigger?.enabled ?? false,
      selectedTools: defaults ? [...defaults] : [],
      toolsMode: 'defaults',
      toolsDirty: false,
      grantExec: false,
      grantDirty: false,
      grantWeb: 'off',
      webDirty: false,
      grantSessions: 'own',
      sessionsDirty: false,
      grantConnectors: {},
      grantConnectorTools: {},
      connectorsDirty: false,
      grantComputerUse: null,
      computerUseDirty: false,
      mountedSkills: DEFAULT_MOUNTED_SKILLS,
      skillsMode: 'defaults',
      skillsDirty: false,
      maxRunsPerDay: DEFAULT_MAX_RUNS_PER_DAY,
      maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
      err: null,
      saveFailed: false,
      confirming: false,
      createdId: null
    }
  }

  const triggerSet = cfg.trigger?.v === 2 ? cfg.trigger : null
  const trig = triggerSet?.triggers[0] ?? (cfg.trigger?.v === 1 ? cfg.trigger : null)
  let triggerKind: TriggerKind = 'none'
  let cronMode: 'schedule' | 'legacy' = 'schedule'
  let cron = '0 9 * * 1-5'
  let triggerTz = 'UTC'
  let schedule = defaultSchedule
  let senderPattern = ''
  let subjectPattern = ''
  let folders = ''
  let threadIds = ''
  let calendarTitlePattern = ''
  let calendarOrganizerPattern = ''
  let calendarAttendeePattern = ''
  let calendarIds = ''
  let leadAmount = 1
  let leadUnit: LeadUnit = 'days'

  if (trig?.kind === 'schedule') {
    triggerKind = 'cron'
    cronMode = 'schedule'
    schedule = readTriggerSchedule({ ...trig, v: 1 }) ?? defaultSchedule
  } else if (trig?.kind === 'cron') {
    triggerKind = 'cron'
    cronMode = 'legacy'
    cron = trig.cron
    triggerTz = trig.timezone || 'UTC'
  } else if (trig?.kind === 'email_filter') {
    triggerKind = 'email_filter'
    senderPattern = trig.sender_pattern ?? ''
    subjectPattern = trig.subject_pattern ?? ''
    folders = (trig.folders ?? []).join(', ')
    threadIds = (trig.thread_ids ?? []).join(', ')
  } else if (trig?.kind === 'calendar_event_change' || trig?.kind === 'calendar_before_start') {
    triggerKind = trig.kind
    calendarTitlePattern = trig.title_pattern ?? ''
    calendarOrganizerPattern = trig.organizer_pattern ?? ''
    calendarAttendeePattern = trig.attendee_pattern ?? ''
    calendarIds = (trig.calendar_ids ?? []).join(', ')
    const lead = leadParts(trig.kind === 'calendar_before_start' ? trig.lead_seconds : 86400)
    leadAmount = lead.amount
    leadUnit = lead.unit
  }

  const allowed = cfg.tool_policy?.allowed_tools
  const isExplicitTools = Array.isArray(allowed)
  const mounts = cfg.tool_policy?.skills
  const isExplicitSkills = Array.isArray(mounts)

  return {
    enabled: cfg.enabled,
    title: cfg.title,
    description: cfg.description ?? '',
    avatar: cfg.avatar ?? null,
    avatarDirty: false,
    prompt: cfg.prompt_is_default ? '' : cfg.prompt,
    promptDirty: false,
    model: cfg.model || '',
    triggerKind,
    cronMode,
    cron,
    triggerTz,
    schedule,
    senderPattern,
    subjectPattern,
    folders,
    threadIds,
    calendarTitlePattern,
    calendarOrganizerPattern,
    calendarAttendeePattern,
    calendarIds,
    leadAmount,
    leadUnit,
    triggerEntries: triggerSet?.triggers ?? (trig ? [{ ...trig, enabled: true }] : []),
    editingTriggerIndex: triggerSet?.triggers.length ? 0 : trig ? 0 : null,
    triggerEnabled: triggerSet?.triggers[0]?.enabled ?? Boolean(trig),
    selectedTools: isExplicitTools ? allowed : defaults ? [...defaults] : [],
    toolsMode: isExplicitTools ? 'explicit' : 'defaults',
    toolsDirty: false,
    grantExec: cfg.tool_policy?.grant_exec === true,
    grantDirty: false,
    grantWeb: cfg.tool_policy?.grant_web ?? 'off',
    webDirty: false,
    grantSessions: cfg.tool_policy?.grant_sessions ?? 'own',
    sessionsDirty: false,
    grantConnectors: { ...(cfg.tool_policy?.grant_connectors ?? {}) },
    grantConnectorTools: { ...(cfg.tool_policy?.grant_connector_tools ?? {}) },
    connectorsDirty: false,
    grantComputerUse: cfg.tool_policy?.grant_computer_use ?? null,
    computerUseDirty: false,
    mountedSkills: isExplicitSkills ? mounts : DEFAULT_MOUNTED_SKILLS,
    skillsMode: isExplicitSkills ? 'explicit' : 'defaults',
    skillsDirty: false,
    maxRunsPerDay: cfg.budget?.max_runs_per_day ?? DEFAULT_MAX_RUNS_PER_DAY,
    maxRunSeconds: cfg.budget?.max_run_seconds ?? DEFAULT_MAX_RUN_SECONDS,
    err: null,
    saveFailed: false,
    confirming: false,
    createdId: null
  }
}

function formReducer(state: CustomAgentFormState, action: FormAction): CustomAgentFormState {
  switch (action.type) {
    case 'SET_FIELD': {
      const current = state[action.field]
      const next =
        typeof action.value === 'function'
          ? (action.value as (prev: typeof current) => typeof current)(current)
          : action.value
      if (Object.is(current, next)) return state
      return { ...state, [action.field]: next }
    }
    case 'MARK_CLOSED':
      if (!state._sync.open) return state
      return { ...state, _sync: { ...state._sync, open: false, appliedDefaults: null } }
    case 'SYNC_FROM_PROPS':
      return {
        ...buildPrefilledFields(action.cfg, action.create, action.initial, action.defaults),
        _sync: {
          open: true,
          cfg: action.cfg,
          create: action.create,
          initial: action.initial,
          appliedDefaults: action.defaults
        }
      }
    case 'APPLY_DEFAULT_TOOLS':
      if (state.toolsMode !== 'defaults' || state.toolsDirty) return state
      return {
        ...state,
        selectedTools: [...action.defaults],
        _sync: { ...state._sync, appliedDefaults: action.defaults }
      }
  }
}

function createFieldSetters(dispatch: Dispatch<FormAction>): {
  [K in FormFieldKey as `set${Capitalize<K>}`]: Dispatch<SetStateAction<CustomAgentFormFields[K]>>
} {
  const bind = <K extends FormFieldKey>(
    field: K
  ): Dispatch<SetStateAction<CustomAgentFormFields[K]>> => {
    return (value) =>
      dispatch({
        type: 'SET_FIELD',
        field,
        value: value as SetStateAction<CustomAgentFormFields[FormFieldKey]>
      })
  }
  return {
    setEnabled: bind('enabled'),
    setTitle: bind('title'),
    setDescription: bind('description'),
    setAvatar: bind('avatar'),
    setAvatarDirty: bind('avatarDirty'),
    setPrompt: bind('prompt'),
    setPromptDirty: bind('promptDirty'),
    setModel: bind('model'),
    setTriggerKind: bind('triggerKind'),
    setCronMode: bind('cronMode'),
    setCron: bind('cron'),
    setTriggerTz: bind('triggerTz'),
    setSchedule: bind('schedule'),
    setSenderPattern: bind('senderPattern'),
    setSubjectPattern: bind('subjectPattern'),
    setFolders: bind('folders'),
    setThreadIds: bind('threadIds'),
    setCalendarTitlePattern: bind('calendarTitlePattern'),
    setCalendarOrganizerPattern: bind('calendarOrganizerPattern'),
    setCalendarAttendeePattern: bind('calendarAttendeePattern'),
    setCalendarIds: bind('calendarIds'),
    setLeadAmount: bind('leadAmount'),
    setLeadUnit: bind('leadUnit'),
    setTriggerEntries: bind('triggerEntries'),
    setEditingTriggerIndex: bind('editingTriggerIndex'),
    setTriggerEnabled: bind('triggerEnabled'),
    setSelectedTools: bind('selectedTools'),
    setToolsMode: bind('toolsMode'),
    setToolsDirty: bind('toolsDirty'),
    setGrantExec: bind('grantExec'),
    setGrantDirty: bind('grantDirty'),
    setGrantWeb: bind('grantWeb'),
    setWebDirty: bind('webDirty'),
    setGrantSessions: bind('grantSessions'),
    setSessionsDirty: bind('sessionsDirty'),
    setGrantConnectors: bind('grantConnectors'),
    setGrantConnectorTools: bind('grantConnectorTools'),
    setConnectorsDirty: bind('connectorsDirty'),
    setGrantComputerUse: bind('grantComputerUse'),
    setComputerUseDirty: bind('computerUseDirty'),
    setMountedSkills: bind('mountedSkills'),
    setSkillsMode: bind('skillsMode'),
    setSkillsDirty: bind('skillsDirty'),
    setMaxRunsPerDay: bind('maxRunsPerDay'),
    setMaxRunSeconds: bind('maxRunSeconds'),
    setErr: bind('err'),
    setSaveFailed: bind('saveFailed'),
    setConfirming: bind('confirming'),
    setCreatedId: bind('createdId')
  }
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
  const { options: toolOptions } = useToolOptions(open)
  const opennessFlags = useOpennessFlags(open)
  const connectorSummaries = useConnectorOptions(
    open && opennessFlags.connectorToolsEnabled === true
  )

  const [state, dispatch] = useReducer(formReducer, undefined, createDefaultFormState)
  const setters = useMemo(() => createFieldSetters(dispatch), [])

  // Sync form state directly on prop/open transitions without cascading effect re-renders.
  const defaultsEligible =
    open && (create || !Array.isArray(cfg?.tool_policy?.allowed_tools))
  if (!open && state._sync.open) {
    dispatch({ type: 'MARK_CLOSED' })
  } else if (
    open &&
    (!state._sync.open ||
      state._sync.cfg !== cfg ||
      state._sync.create !== create ||
      state._sync.initial !== initial)
  ) {
    dispatch({
      type: 'SYNC_FROM_PROPS',
      cfg,
      create,
      initial,
      defaults: defaultsEligible ? toolOptions.defaults : null
    })
  } else if (
    defaultsEligible &&
    state.toolsMode === 'defaults' &&
    !state.toolsDirty &&
    state._sync.appliedDefaults !== toolOptions.defaults
  ) {
    dispatch({ type: 'APPLY_DEFAULT_TOOLS', defaults: toolOptions.defaults })
  }

  const {
    enabled,
    title,
    description,
    avatar,
    avatarDirty,
    prompt,
    promptDirty,
    model,
    triggerKind,
    cronMode,
    cron,
    triggerTz,
    schedule,
    senderPattern,
    subjectPattern,
    folders,
    threadIds,
    calendarTitlePattern,
    calendarOrganizerPattern,
    calendarAttendeePattern,
    calendarIds,
    leadAmount,
    leadUnit,
    triggerEntries,
    editingTriggerIndex,
    triggerEnabled,
    selectedTools,
    toolsMode,
    toolsDirty,
    grantExec,
    grantDirty,
    grantWeb,
    webDirty,
    grantSessions,
    sessionsDirty,
    grantConnectors,
    grantConnectorTools,
    connectorsDirty,
    grantComputerUse,
    computerUseDirty,
    mountedSkills,
    skillsMode,
    skillsDirty,
    maxRunsPerDay,
    maxRunSeconds,
    err,
    saveFailed,
    confirming,
    createdId
  } = state

  const {
    setEnabled,
    setTitle,
    setDescription,
    setAvatar,
    setAvatarDirty,
    setPrompt,
    setPromptDirty,
    setModel,
    setTriggerKind,
    setCronMode,
    setCron,
    setTriggerTz,
    setSchedule,
    setSenderPattern,
    setSubjectPattern,
    setFolders,
    setThreadIds,
    setCalendarTitlePattern,
    setCalendarOrganizerPattern,
    setCalendarAttendeePattern,
    setCalendarIds,
    setLeadAmount,
    setLeadUnit,
    setTriggerEntries,
    setEditingTriggerIndex,
    setTriggerEnabled,
    setSelectedTools,
    setToolsDirty,
    setGrantExec,
    setGrantDirty,
    setGrantWeb,
    setWebDirty,
    setGrantSessions,
    setSessionsDirty,
    setGrantConnectors,
    setGrantConnectorTools,
    setConnectorsDirty,
    setGrantComputerUse,
    setComputerUseDirty,
    setMountedSkills,
    setSkillsMode,
    setSkillsDirty,
    setMaxRunsPerDay,
    setMaxRunSeconds,
    setErr,
    setSaveFailed,
    setConfirming,
    setCreatedId
  } = setters

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
    if (grantExec) toolPolicy.grant_exec = true
    if (grantWeb !== 'off') toolPolicy.grant_web = grantWeb
    toolPolicy.grant_sessions = grantSessions
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
