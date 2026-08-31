// P4a agent-config lane — 「通讯录治理」配置页。保存语义逐字段照
// drawers/ContactGovernanceConfigDrawer：
//   🔴 保存是两次串行调用（agent 行 + profile doc），任一失败如实报错不吞；
//   🔴 追加段 / 组织框架读失败时不回写（空草稿覆盖 owner 已有内容的代价太大）；
//   🔴 trigger_json 整列覆写：{fire_hour, use_kos} 两个字段一起发，仍是字面字段不是
//      schedule envelope（每日时刻并进排程编辑器的只是 UI，见 controls.DailyHourSchedule）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, FileText } from 'lucide-react'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { ContactPip } from '@shared/components/contacts/parts'
import {
  useContactAgentPrompt,
  useContactOrgFrame,
  useSaveContactAgentPrompt,
  useSaveContactOrgFrame
} from '@shared/components/contacts/hooks'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { cn } from '@shared/lib/cn'
import { CONTACT_TOOL_FACE_GROUPS, type ContactToolGroup } from '@shared/lib/contactToolFace'
import { errorMessage } from '@shared/lib/ipcErrors'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { AgentIdentityHeader } from '../AgentAvatar'
import { useSetConfig } from '../hooks'
import { CONTACT_GOVERNANCE_AGENT_ID } from '../shared'
import { Field } from '../drawers/Field'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import { BuiltinToolsNote, ReadonlyCard, SettingsScaffold } from './sections'
import { DailyHourSchedule, ModelGroup, SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'

const FOLLOW_GLOBAL_MODEL = '__follow_global__'
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
const FALLBACK_NONE = '__none__'

const DEFAULT_FIRE_HOUR = 4
const DEFAULT_USE_KOS = true

const PERMISSION_TONE: Record<ContactToolGroup['permission'], 'neutral' | 'info' | 'warn'> = {
  read: 'neutral',
  propose: 'info',
  write: 'warn'
}

const TOOL_FACE_COUNT = CONTACT_TOOL_FACE_GROUPS.reduce((n, group) => n + group.tools.length, 0)

function readTrigger(cfg: ReportAgentConfig): { fireHour: number; useKos: boolean } {
  const raw = cfg.trigger as unknown as
    | { fire_hour?: unknown; use_kos?: unknown }
    | null
    | undefined
  const hour = raw?.fire_hour
  const kos = raw?.use_kos
  return {
    fireHour:
      typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
        ? hour
        : DEFAULT_FIRE_HOUR,
    useKos: typeof kos === 'boolean' ? kos : DEFAULT_USE_KOS
  }
}

/** 只读工具清单 —— 与治理抽屉同源（读零依赖叶子 @shared/lib/contactToolFace），行样式一致。 */
function ToolFaceList(): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      {CONTACT_TOOL_FACE_GROUPS.map((group) =>
        group.tools.map((name) => (
          <div
            key={name}
            className="flex items-baseline gap-2 rounded-[var(--r-ctl)] bg-ink-fg/[0.025] px-[9px] py-1.5"
          >
            <code className="shrink-0 font-mono text-micro text-ink-fg">{name}</code>
            <ContactPip tone={PERMISSION_TONE[group.permission]}>
              {t(`contacts.agent.perm.${group.permission}`)}
            </ContactPip>
            <span className="min-w-0 flex-1 text-micro leading-[1.5] text-ink-fg-2 [text-wrap:pretty]">
              {t(`contacts.agent.desc.${name}`)}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export function ContactGovernanceSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { models: enabledModels } = useEnabledModels()
  const promptDoc = useContactAgentPrompt(true)
  const savePrompt = useSaveContactAgentPrompt()
  const orgFrameDoc = useContactOrgFrame(true)
  const saveOrgFrame = useSaveContactOrgFrame()
  const initial = readTrigger(cfg)

  const [enabled, setEnabled] = useState(cfg.enabled)
  const [model, setModel] = useState(cfg.model ?? '')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(
    cfg.fallback_models == null
      ? FALLBACK_FOLLOW_GLOBAL
      : cfg.fallback_models.length === 0
        ? FALLBACK_NONE
        : cfg.fallback_models[0]
  )
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [fireHour, setFireHour] = useState(initial.fireHour)
  const [useKos, setUseKos] = useState(initial.useKos)
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [append, setAppend] = useState('')
  const [appendDirty, setAppendDirty] = useState(false)
  const [orgFrame, setOrgFrame] = useState('')
  const [orgFrameDirty, setOrgFrameDirty] = useState(false)
  const [defaultOpen, setDefaultOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)

  // 追加段 / 框架来自另两条查询，各自落定后回填（未 dirty 才覆盖）。
  // 🔴 回显 content 原样，不 || defaultContent —— 灌默认全文会在下次保存把它物化成自定义。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (promptDoc.data === undefined || appendDirty) return
    setAppend(promptDoc.data.content)
  }, [promptDoc.data, appendDirty])
  useEffect(() => {
    if (orgFrameDoc.data === undefined || orgFrameDirty) return
    setOrgFrame(orgFrameDoc.data)
  }, [orgFrameDoc.data, orgFrameDirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  const busy = isSaving || savePrompt.isPending || saveOrgFrame.isPending
  const defaultContent = promptDoc.data?.defaultContent ?? ''
  const usingDefault = append.trim() === ''
  const saveState: StatefulButtonState = busy
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  const onSave = async (): Promise<void> => {
    setSaveFailed(false)
    if (scheduleDirty && (!Number.isInteger(fireHour) || fireHour < 0 || fireHour > 23)) {
      setErr(t('agents.contactGovernance.errFireHour'))
      setSaveFailed(true)
      return
    }
    setErr(null)
    const patch: ReportConfigPatch = { enabled }
    if (modelDirty) patch.model = model
    if (fallbackModelDirty) {
      patch.fallback_models =
        fallbackModel === FALLBACK_FOLLOW_GLOBAL
          ? null
          : fallbackModel === FALLBACK_NONE
            ? []
            : [fallbackModel]
    }
    // 🔴 trigger_json 整列覆写：两个字段一起发（字面字段，不是 envelope）。
    if (scheduleDirty) patch.trigger = { fire_hour: fireHour, use_kos: useKos }
    if (avatarDirty) patch.avatar = avatar
    try {
      await save(CONTACT_GOVERNANCE_AGENT_ID, patch)
      // 🔴 读失败时那个框是空草稿 —— 不许拿它覆盖 owner 可能已有的内容。
      if (appendDirty && !promptDoc.isError) await savePrompt.mutateAsync(append)
      if (orgFrameDirty && !orgFrameDoc.isError) await saveOrgFrame.mutateAsync(orgFrame)
      setSaveDone(true)
      window.setTimeout(() => setSaveDone(false), 1600)
    } catch (e: unknown) {
      setErr(errorMessage(e))
      setSaveFailed(true)
    }
  }

  return (
    <SettingsScaffold
      title={cfg.title}
      subtitle={t('agentSettings.role.builtin')}
      enable={{ on: enabled, onChange: setEnabled }}
      save={{ state: saveState, onSave: () => void onSave(), disabled: busy }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={CONTACT_GOVERNANCE_AGENT_ID}
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
            <Field
              label={t('agents.contactGovernance.prompt')}
              hint={t('agents.contactGovernance.promptHint')}
            >
              <div className="mb-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDefaultOpen((prev) => !prev)}
                  aria-expanded={defaultOpen}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
                >
                  <ChevronDown
                    size={12}
                    aria-hidden
                    className={cn(
                      'transition-transform duration-fast ease-standard',
                      defaultOpen && 'rotate-180'
                    )}
                  />
                  {t('agents.contactGovernance.promptDefaultToggle')}
                </button>
                <span aria-hidden className="flex-1" />
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-micro',
                    usingDefault ? 'bg-ok/[0.12] text-ok' : 'bg-ai/[0.12] text-ai'
                  )}
                >
                  {t(
                    usingDefault
                      ? 'contacts.agent.prompt.usingDefault'
                      : 'contacts.agent.prompt.customized'
                  )}
                </span>
              </div>
              {/* 系统提示词默认段：只读弱化展示（判据 2），可折叠看全文。 */}
              {defaultOpen ? (
                <ReadonlyCard title={t('agents.contactGovernance.promptDefaultToggle')}>
                  <pre className="scrollbar-thin m-0 max-h-[260px] overflow-auto whitespace-pre-wrap font-mono text-micro leading-[1.7] text-ink-fg-2">
                    {defaultContent}
                  </pre>
                </ReadonlyCard>
              ) : null}
              {promptDoc.isError ? (
                <p className="mb-1.5 text-meta leading-[1.6] text-warn">
                  {t('contacts.agent.prompt.loadFailed')}
                </p>
              ) : null}
              <textarea
                value={append}
                disabled={promptDoc.isPending || promptDoc.isError}
                placeholder={t('agents.contactGovernance.promptAppendPlaceholder')}
                aria-label={t('agents.contactGovernance.promptAppend')}
                onChange={(e) => {
                  setAppend(e.target.value)
                  setAppendDirty(true)
                }}
                rows={7}
                className="scrollbar-thin"
                style={{
                  ...INPUT_STYLE,
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontSize: 13,
                  marginTop: 8
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
                {t('agents.contactGovernance.promptAppendNote')}
              </div>
            </Field>
            <Field
              label={t('agents.contactGovernance.orgFrame')}
              hint={t('agents.contactGovernance.orgFrameHint')}
            >
              {orgFrameDoc.isError ? (
                <p className="mb-1.5 text-meta leading-[1.6] text-warn">
                  {t('contacts.agent.prompt.loadFailed')}
                </p>
              ) : null}
              <textarea
                value={orgFrame}
                disabled={orgFrameDoc.isPending || orgFrameDoc.isError}
                placeholder={t('agents.contactGovernance.orgFramePlaceholder')}
                aria-label={t('agents.contactGovernance.orgFrame')}
                onChange={(e) => {
                  setOrgFrame(e.target.value)
                  setOrgFrameDirty(true)
                }}
                rows={8}
                className="scrollbar-thin"
                style={{
                  ...INPUT_STYLE,
                  resize: 'vertical',
                  lineHeight: 1.7,
                  // 层级靠 ` / ` 对齐着读，等宽字体下才不会歪。
                  fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
                  fontSize: 12.5
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
                {t('agents.contactGovernance.orgFrameNote')}
              </div>
            </Field>
          </>
        ),
        model: (
          <ModelGroup
            primary={
              <Select
                value={model || FOLLOW_GLOBAL_MODEL}
                onValueChange={(v) => {
                  setModel(v === FOLLOW_GLOBAL_MODEL ? '' : v)
                  setModelDirty(true)
                }}
                disabled={busy}
              >
                <SelectTrigger aria-label={t('agentSettings.model.primary')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value={FOLLOW_GLOBAL_MODEL}>
                    {t('agents.contactProfile.modelFollowGlobal')}
                  </SelectItem>
                  <ModelSelectItems models={enabledModels} current={model || null} />
                </SelectContent>
              </Select>
            }
            fallback={
              <Select
                value={fallbackModel}
                onValueChange={(v) => {
                  setFallbackModel(v)
                  setFallbackModelDirty(true)
                }}
                disabled={busy}
              >
                <SelectTrigger aria-label={t('agentSettings.model.fallback')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[70]">
                  <SelectItem value={FALLBACK_FOLLOW_GLOBAL}>
                    {t('agents.contactProfile.fallbackFollowGlobal')}
                  </SelectItem>
                  <SelectItem value={FALLBACK_NONE}>
                    {t('agents.contactProfile.fallbackNone')}
                  </SelectItem>
                  <ModelSelectItems
                    models={enabledModels}
                    current={
                      fallbackModel !== FALLBACK_FOLLOW_GLOBAL && fallbackModel !== FALLBACK_NONE
                        ? fallbackModel
                        : null
                    }
                  />
                </SelectContent>
              </Select>
            }
          />
        ),
        when: (
          <Field
            label={t('agents.contactGovernance.schedule')}
            hint={t('agents.contactGovernance.scheduleHint')}
          >
            <DailyHourSchedule
              hour={fireHour}
              onHourChange={(h) => {
                setFireHour(h)
                setScheduleDirty(true)
              }}
            />
          </Field>
        ),
        capabilities: (
          <>
            <ReadonlyCard title={t('agents.contactGovernance.tools', { count: TOOL_FACE_COUNT })}>
              <ToolFaceList />
              <p className="mt-[7px] text-micro leading-[1.6] text-ink-fg-3">
                {t('contacts.agent.tools.footnote')}
              </p>
              {/* 🔴 面上列着写工具但治理场地 deny 掉 domain_write —— 不说清就是撒谎。 */}
              <p className="mt-1 text-micro leading-[1.6] text-ink-fg-3">
                {t('contacts.agent.tools.governanceOff')}
              </p>
            </ReadonlyCard>
            <BuiltinToolsNote />
          </>
        ),
        specific: (
          <>
            <SwitchCard
              label={t('agents.contactGovernance.useKos')}
              hint={t('agents.contactGovernance.useKosHint')}
              on={useKos}
              onChange={(v) => {
                setUseKos(v)
                setScheduleDirty(true)
              }}
            />
            <div className="flex items-start gap-2 rounded-[var(--r-ctl)] border border-ink-border-soft bg-ink-1/40 px-3 py-2.5">
              <FileText size={13} aria-hidden className="mt-0.5 shrink-0 text-ink-fg-3" />
              <p className="text-micro leading-[1.6] text-ink-fg-3">
                {t('agents.contactGovernance.queueNote')}
              </p>
            </div>
            {err && (
              <div style={{ fontSize: 12.5, color: 'rgb(var(--c-danger, var(--ink-fg-1)))' }}>
                {err}
              </div>
            )}
          </>
        )
      }}
    />
  )
}
