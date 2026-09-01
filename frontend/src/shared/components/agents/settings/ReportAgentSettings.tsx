// P4a agent-config lane — 报告 Agent（日/周/月同引擎）配置页。保存语义逐字段：
// prompt 默认态回传 / 空时区写实 / cadence 被 lockFreq 锁死 / 头像未触碰不发。
// 布局是八区，另有两处交互纪律：
//   • 「查看全部历史」入口不再进配置页 —— 运行 / 报告历史归记录列与报告域（r7 §三 判据 6）。
//   • 注入的身份文档：勾选仍可编辑（那是配置），文档内容以只读卡指路（判据 2）。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@shared/components/ui/select'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import { toastError } from '@shared/state/toast'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { CadencePill } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useKosAvailable, useRunNow, useSetConfig } from '../hooks'
import { IS_WEB, PREPROCESS_DOCS, envFlagOn } from '../shared'
import { Field } from '../drawers/Field'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import {
  ScheduleBuilder,
  type ScheduleValue,
  hostTimezone,
  readReportSchedule,
  writeReportSchedule
} from '../schedule'
import { BuiltinToolsNote, ReadonlyCard, SettingsScaffold } from './sections'
import { ChoiceChip, ModelGroup, SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'

// 顺序固定，与 src/llm_agent/schema.py PRIORITY_ENUM 对齐 —— 勾选的优先级邮件带完整正文。
// value 是与后端 body_full_priorities 比较的权威值（一字不改）；显示文案走 i18n key。
const PRIORITY_ENUM = ['🔴 紧急', '🟡 重要', '🟢 一般', '⚪ 低'] as const
const PRIORITY_LABEL_KEYS: Record<string, string> = {
  '🔴 紧急': 'agents.config.priority.critical',
  '🟡 重要': 'agents.config.priority.important',
  '🟢 一般': 'agents.config.priority.normal',
  '⚪ 低': 'agents.config.priority.low'
}

// 报告生成服务总闸（env MAILAGENT_REPORT_AGENT_ENABLED）——同型 PROJECT_PROGRESS_SYNC_ENABLED
// 总闸早有 UI（见 ProjectProgressSettings 的 master 行），报告总闸此前只能改 .env，随旧
// AgentsTab 一起丢了 UI。日/周/月三份配置页共用同一引擎、同一 flag，行落每份配置页的
// 「它自己的设置」区——判据是既有范式「家族总闸进自己的团队页配置页」。
// 🔴 与「总闸未开=不可用」不同，这里是 OR 语义（service.py:737）：worker 在「flag 开
// OR 任一报告行 enabled」时启动，flag 关不等于报告不可用，只差「首次启用是否要重启一
// 次」——hint 文案已把这层说清，不再加会说谎的「未开禁用」徽标。
// 切换即时写 env（不进本页 onSave 的 patch，与页面主保存态解耦），失败原样 toast。
function ReportMasterRow(): React.ReactElement {
  const { t } = useTranslation()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const masterOn = useEnvStore((s) =>
    s.state.status === 'ready'
      ? envFlagOn(s.state.snapshot.values['MAILAGENT_REPORT_AGENT_ENABLED'] ?? '')
      : false
  )
  const handleToggle = async (v: boolean): Promise<void> => {
    const r = await applyEnvPatch({ MAILAGENT_REPORT_AGENT_ENABLED: v ? 'true' : 'false' })
    if (!r.ok) {
      toastError(t('agents.reportsMaster.saveError'), `${r.error.code}: ${r.error.message}`)
      return
    }
    if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
  }
  return (
    <SwitchCard
      label={t('agents.reportsMaster.label')}
      hint={t('agents.reportsMaster.hint')}
      on={masterOn}
      onChange={(v) => void handleToggle(v)}
      disabled={!envReady || IS_WEB}
    />
  )
}

export function ReportAgentSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { run, isRunning } = useRunNow()
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)

  // 整页按 cfg.id key 挂载（AgentSettingsView 传 key）→ 初值直接取 cfg，无需 [open,cfg] effect。
  const cadence = cfg.schedule.cadence
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [prompt, setPrompt] = useState(cfg.prompt)
  const [promptDirty, setPromptDirty] = useState(false)
  // 🔴 空时区写实成宿主机 IANA（排程契约 §4）：报告 agent 空时区的历史语义就是宿主机本地，
  // 留空会让统一后的逻辑退化成 UTC，现有 9:00 报告直接漂到别的时刻。
  const [schedule, setSchedule] = useState<ScheduleValue>(() =>
    readReportSchedule(cfg.schedule, cfg.timezone || hostTimezone())
  )
  const [triggerMode, setTriggerMode] = useState<'rolling_24h' | 'natural_day'>(
    cfg.trigger_mode || 'rolling_24h'
  )
  const [bodyPriorities, setBodyPriorities] = useState<string[]>(
    cfg.body_full_priorities?.length ? cfg.body_full_priorities : ['🔴 紧急', '🟡 重要']
  )
  const [contextDocs, setContextDocs] = useState<string[]>(cfg.context_docs ?? [])
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>(cfg.model || '')
  const [kosEnrich, setKosEnrich] = useState(cfg.kos_enrich)
  const kosAvailable = useKosAvailable()

  const isDaily = cadence === 'daily'

  const saveState: StatefulButtonState = isSaving
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  const onSave = (): void => {
    setSaveFailed(false)
    const patch: ReportConfigPatch = {
      enabled,
      // prompt 未改且仍是默认态 → 传 null 保持「用默认」；改过 → 传文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      kos_enrich: kosEnrich,
      context_docs: contextDocs,
      // 老键先铺（保留后端可能存的未知键），再由 writeReportSchedule 覆盖权威字段。
      // cadence 恒 = rule.freq，而 freq 段被 lockFreq 锁死 → 报告种类不会被排程编辑改掉。
      schedule: { ...cfg.schedule, ...writeReportSchedule(schedule) }
    }
    if (avatarDirty) patch.avatar = avatar
    // 触发模式 / 时区 / 带正文优先级仅 daily 有意义；周月报走层级聚合，不带这些。
    if (isDaily) {
      patch.trigger_mode = triggerMode
      patch.body_full_priorities = bodyPriorities
      // 时区只在 natural_day 有意义（值取自构建器 —— 页面里只有一个时区来源）。
      patch.timezone = triggerMode === 'natural_day' ? schedule.timezone : ''
    }
    void save(cfg.id, patch)
      .then(() => {
        setSaveDone(true)
        window.setTimeout(() => setSaveDone(false), 1600)
      })
      .catch(() => setSaveFailed(true))
  }

  return (
    <SettingsScaffold
      title={cfg.title}
      subtitle={t('agentSettings.role.builtin')}
      enable={{ on: enabled, onChange: setEnabled }}
      tryRun={{ onRun: () => void run(cfg.id), running: isRunning }}
      save={{ state: saveState, onSave }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={cfg.id}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={cfg.title}
            />
          </Field>
        ),
        instructions: (
          <>
            <Field label={t('agents.config.prompt')} hint={t('agents.config.promptHint')}>
              <textarea
                value={prompt}
                placeholder={t('agents.config.promptPlaceholder')}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptDirty(true)
                }}
                rows={11}
                className="scrollbar-thin"
                style={{
                  ...INPUT_STYLE,
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontSize: 13,
                  minHeight: 200
                }}
              />
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 6,
                  lineHeight: 1.5
                }}
              >
                {t('agents.config.promptNote')}
              </div>
            </Field>
            <Field label={t('agents.config.contextDocs')} hint={t('agents.config.contextDocsHint')}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                {PREPROCESS_DOCS.map((doc) => (
                  <ChoiceChip
                    key={doc}
                    on={contextDocs.includes(doc)}
                    onClick={() =>
                      setContextDocs((prev) =>
                        prev.includes(doc) ? prev.filter((x) => x !== doc) : [...prev, doc]
                      )
                    }
                  >
                    {t(`agents.preprocess.doc.${doc}`)}
                  </ChoiceChip>
                ))}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 7,
                  lineHeight: 1.5
                }}
              >
                {t('agents.config.contextDocsNote')}
              </div>
            </Field>
            <ReadonlyCard title={t('agentSettings.docs.injected')}>
              {t('agentSettings.docs.sameSource')}
            </ReadonlyCard>
          </>
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
          <>
            <Field label={t('agents.config.schedule')} hint={t('agents.schedule.hint')}>
              <div className="flex items-center" style={{ gap: 10, marginBottom: 12 }}>
                <CadencePill cadence={cadence} />
              </div>
              <ScheduleBuilder value={schedule} onChange={setSchedule} lockFreq />
            </Field>
            {isDaily && (
              <>
                <Field label={t('agents.config.triggerMode')} hint={t('agents.config.triggerHint')}>
                  <div className="seg" style={{ width: '100%' }}>
                    {(['rolling_24h', 'natural_day'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={triggerMode === mode ? 'on' : ''}
                        style={{ flex: 1, justifyContent: 'center' }}
                        onClick={() => setTriggerMode(mode)}
                      >
                        {t(`agents.config.trigger.${mode}`)}
                      </button>
                    ))}
                  </div>
                </Field>
                {triggerMode === 'natural_day' && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      lineHeight: 1.5,
                      padding: '9px 12px',
                      borderRadius: 9,
                      background: 'rgb(var(--ink-1) / 0.5)',
                      border: '1px solid rgb(var(--ink-border-soft))'
                    }}
                  >
                    {t('agents.config.timezoneFromSchedule', { tz: schedule.timezone })}
                  </div>
                )}
              </>
            )}
          </>
        ),
        capabilities: <BuiltinToolsNote />,
        specific: (
          <>
            <ReportMasterRow />
            {isDaily ? (
              <Field
                label={t('agents.config.bodyPriorities')}
                hint={t('agents.config.bodyPrioritiesHint')}
              >
                <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {PRIORITY_ENUM.map((p) => (
                    <ChoiceChip
                      key={p}
                      on={bodyPriorities.includes(p)}
                      onClick={() =>
                        setBodyPriorities((prev) =>
                          prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                        )
                      }
                    >
                      {p in PRIORITY_LABEL_KEYS ? t(PRIORITY_LABEL_KEYS[p]) : p}
                    </ChoiceChip>
                  ))}
                </div>
              </Field>
            ) : (
              <ReadonlyCard title={t('agents.config.aggregation')}>
                {cadence === 'weekly'
                  ? t('agents.config.aggWeekly')
                  : t('agents.config.aggMonthly')}
              </ReadonlyCard>
            )}
            {kosAvailable && (
              <SwitchCard
                label={t('agents.config.kos')}
                hint={t('agents.config.kosHint')}
                on={kosEnrich}
                onChange={setKosEnrich}
              />
            )}
          </>
        )
      }}
    />
  )
}
