// P4a agent-config lane — 「联系人画像」配置页。
//
// 🔴 「每日运行时刻 0–23」并进排程编辑器的 **UI**（DailyHourSchedule，r7 §三 判据 1），
// 但写回格式一字不动：trigger_json 仍存 {fire_hour, daily_limit, use_kos} 字面字段
// （profile_config.py 行内热读这个形状），绝不写成 schedule envelope —— 那是改排程语义。
// 🔴 trigger_json 整列覆写不是 merge：三个字段共用同一个 scheduleDirty，任一被触碰
// 保存时三个一起原样写回，少发一个会把它抹成缺省。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { errorMessage } from '@shared/lib/ipcErrors'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { AgentIdentityHeader } from '../AgentAvatar'
import { useSetConfig } from '../hooks'
import { CONTACT_PROFILE_AGENT_ID } from '../shared'
import { Field } from '../drawers/Field'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import { BuiltinToolsNote, SettingsScaffold } from './sections'
import { DailyHourSchedule, ModelGroup, SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'

const FOLLOW_GLOBAL_MODEL = '__follow_global__'
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
const FALLBACK_NONE = '__none__'

/** 排程缺省 —— 与 `profile_config.py::ContactProfileAgentConfig` 的 dataclass 默认同值。 */
const DEFAULT_FIRE_HOUR = 4
const DEFAULT_DAILY_LIMIT = 50
/** 🔴 缺字段默认 true（与后端同口径）：老行没这个键，读成 false 会把一个从没被关过的
 *  开关显示成「关着」。 */
const DEFAULT_USE_KOS = true

/** 从 trigger_json 读字面排程字段（读面是 union，就地做运行时形状检查）。 */
function readSchedule(cfg: ReportAgentConfig): {
  fireHour: number
  dailyLimit: number
  useKos: boolean
} {
  const raw = cfg.trigger as unknown as
    | { fire_hour?: unknown; daily_limit?: unknown; use_kos?: unknown }
    | null
    | undefined
  const hour = raw?.fire_hour
  const limit = raw?.daily_limit
  const kos = raw?.use_kos
  return {
    fireHour:
      typeof hour === 'number' && Number.isInteger(hour) && hour >= 0 && hour <= 23
        ? hour
        : DEFAULT_FIRE_HOUR,
    dailyLimit:
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0
        ? limit
        : DEFAULT_DAILY_LIMIT,
    useKos: typeof kos === 'boolean' ? kos : DEFAULT_USE_KOS
  }
}

export function ContactProfileSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { models: enabledModels } = useEnabledModels()
  const initial = readSchedule(cfg)

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
  // prompt_is_default 的行后端回填的是报告默认（对画像无意义）→ 回显空串。
  const [prompt, setPrompt] = useState(cfg.prompt_is_default ? '' : cfg.prompt)
  const [promptDirty, setPromptDirty] = useState(false)
  const [fireHour, setFireHour] = useState(initial.fireHour)
  const [dailyLimit, setDailyLimit] = useState(initial.dailyLimit)
  const [useKos, setUseKos] = useState(initial.useKos)
  // trigger_json 这一列的脏标记（三个字段共用，见文件头注释）。
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)

  const busy = isSaving
  const saveState: StatefulButtonState = busy
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  const onSave = async (): Promise<void> => {
    setSaveFailed(false)
    if (scheduleDirty) {
      if (!Number.isInteger(fireHour) || fireHour < 0 || fireHour > 23) {
        setErr(t('agents.contactProfile.errFireHour'))
        setSaveFailed(true)
        return
      }
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
        setErr(t('agents.contactProfile.errDailyLimit'))
        setSaveFailed(true)
        return
      }
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
    // 未触碰且后端回填的是默认 → 回传 null（不把默认物化成自定义）。
    if (promptDirty) patch.prompt = prompt
    else if (!cfg.prompt_is_default) patch.prompt = cfg.prompt
    // 🔴 三个字段一起发：trigger_json 整列覆写，写回仍是字面 {fire_hour,…}，不是 envelope。
    if (scheduleDirty) {
      patch.trigger = { fire_hour: fireHour, daily_limit: dailyLimit, use_kos: useKos }
    }
    if (avatarDirty) patch.avatar = avatar
    try {
      await save(CONTACT_PROFILE_AGENT_ID, patch)
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
              agentId={CONTACT_PROFILE_AGENT_ID}
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
          <Field
            label={t('agents.contactProfile.promptAppend')}
            hint={t('agents.contactProfile.promptAppendHint')}
          >
            <textarea
              value={prompt}
              placeholder={t('agents.contactProfile.promptAppendPlaceholder')}
              onChange={(e) => {
                setPrompt(e.target.value)
                setPromptDirty(true)
              }}
              rows={7}
              className="scrollbar-thin"
              style={{ ...INPUT_STYLE, resize: 'vertical', lineHeight: 1.6, fontSize: 13 }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 6,
                lineHeight: 1.5
              }}
            >
              {t('agents.contactProfile.promptAppendNote')}
            </div>
          </Field>
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
            label={t('agents.contactProfile.schedule')}
            hint={t('agents.contactProfile.scheduleHint')}
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
        capabilities: <BuiltinToolsNote />,
        specific: (
          <>
            <div className="flex items-center" style={{ gap: 10 }}>
              <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                {t('agents.contactProfile.dailyCap')}
              </span>
              <input
                type="number"
                min={1}
                aria-label={t('agents.contactProfile.dailyCap')}
                value={dailyLimit}
                onChange={(e) => {
                  setDailyLimit(Number(e.target.value))
                  setScheduleDirty(true)
                }}
                style={{ ...INPUT_STYLE, width: 110 }}
              />
            </div>
            <SwitchCard
              label={t('agents.contactProfile.useKos')}
              hint={t('agents.contactProfile.useKosHint')}
              on={useKos}
              onChange={(v) => {
                setUseKos(v)
                setScheduleDirty(true)
              }}
            />
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
