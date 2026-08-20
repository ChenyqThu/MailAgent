// task 08-13 WP6 — /agents 「联系人画像」配置抽屉。后端 DB v63 播种单行
// （id='contact_profile_agent'、type='contact_profile'），只编辑、无新建无删除。
//
// 骨架照 ProjectProgressConfigDrawer 的三段式；控件语义各有出处：
//   • 启用（row.enabled）——保存即生效，走 useSetConfig。
//   • 模型 / fallback ——行级列，「跟随全局」哨兵同 PreprocessConfigDrawer
//     （model 空串 = 跟随全局 LLM_MODEL；fallback null = 跟随全局、[] = 显式不设）。
//   • 提示词追加段（row.prompt）——`prompt_is_default` 语义同 ConfigDrawer：
//     未触碰且后端回填的是默认 → 回传 null（不把默认物化成自定义）。
//   • 每日时刻 / 每轮上限 / 参考 KOS —— 存 trigger_json 的字面字段
//     {fire_hour, daily_limit, use_kos}（运行时由 `src/contacts/profile_config.py` 行内热读）。
//     🔴 trigger_json 是**整列覆写不是 merge** → 三个字段必须一起发，少发一个会把
//     它抹成缺省。所以三者共用同一个 `scheduleDirty`（它是 trigger_json 这一列的脏标记，
//     不只是「排程」的）—— 只改 KOS 开关也会连 fire_hour/daily_limit 一起原样写回。
//
// 🔴 总闸不在这里：`MAILAGENT_CONTACT_PROFILE_ENABLED` 是 Labs 里的灰度 flag（写 .env
// 要重启），与项目周报把总闸收进抽屉的做法有意不同 —— 抽屉里只出总闸**状态说明**，
// 不出一个改了却要用户自己想起去重启的开关。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { ReportIcon } from '../primitives'
import { Switch } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useSetConfig } from '../hooks'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { errorMessage } from '@shared/lib/ipcErrors'
import { CONTACT_PROFILE_AGENT_ID } from '../shared'
import { Field } from './Field'
import { ModelSelectItems } from './ModelSelectItems'

/** 模型下拉「跟随全局默认」哨兵（radix SelectItem 禁空串 value）。 */
const FOLLOW_GLOBAL_MODEL = '__follow_global__'
/** fallback「跟随全局」哨兵（行级列 NULL）。 */
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
/** fallback「不设」哨兵（行级列 '[]'）。 */
const FALLBACK_NONE = '__none__'

/** 排程缺省 —— 与 `profile_config.py::ContactProfileAgentConfig` 的 dataclass 默认同值。
 *  行没配 trigger_json（或字段缺失）时后端就是按这两个值跑，UI 也照这个回落显示。 */
const DEFAULT_FIRE_HOUR = 4
const DEFAULT_DAILY_LIMIT = 50
/** 🔴 「参考 KOS」缺字段默认 **true**（与后端同口径）：老行的 trigger_json 里没有这个键，
 *  读成 false 会让一个从没被关过的开关在界面上显示成「关着」。 */
const DEFAULT_USE_KOS = true

/** 从 trigger_json 读字面排程字段。这行的 trigger **不是** `CustomAgentTrigger` 判别式
 *  （没有 `v`/`kind`），故 `ReportAgentConfig['trigger']` 的静态类型对不上 —— 在这里就地
 *  过一次 `unknown` 并做运行时形状检查，而不是把这个无判别字段的成员塞进那个 union
 *  （会让十来处按 `.v`/`.kind` 收窄的消费方全部失去收窄）。
 *  值域外 / 缺字段一律回落到与 `profile_config.py` dataclass 同值的缺省。 */
function readSchedule(cfg: ReportAgentConfig | null): {
  fireHour: number
  dailyLimit: number
  useKos: boolean
} {
  const raw = cfg?.trigger as unknown as
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
    // 只有明确的 boolean 才算数：缺字段 / null / 野值一律回落 true。
    useKos: typeof kos === 'boolean' ? kos : DEFAULT_USE_KOS
  }
}

export function ContactProfileConfigDrawer({
  cfg,
  open,
  masterEnabled,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  /** /chat/config 的 contactProfileEnabled（Labs flag）；off → 只出说明，不禁编辑。 */
  masterEnabled: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { models: enabledModels } = useEnabledModels()

  const [enabled, setEnabled] = useState(false)
  const [model, setModel] = useState('')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(FALLBACK_FOLLOW_GLOBAL)
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [fireHour, setFireHour] = useState(DEFAULT_FIRE_HOUR)
  const [dailyLimit, setDailyLimit] = useState(DEFAULT_DAILY_LIMIT)
  const [useKos, setUseKos] = useState(DEFAULT_USE_KOS)
  // trigger_json 这一列的脏标记（三个字段共用，见文件头注释）。
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setEnabled(cfg.enabled)
    setModel(cfg.model ?? '')
    setModelDirty(false)
    setFallbackModel(
      cfg.fallback_models == null
        ? FALLBACK_FOLLOW_GLOBAL
        : cfg.fallback_models.length === 0
          ? FALLBACK_NONE
          : cfg.fallback_models[0]
    )
    setFallbackModelDirty(false)
    // prompt_is_default 的行后端回填的是**报告默认**（对画像无意义）→ 回显空串，
    // 让 owner 从零写追加段；已自定义则回显自定义。
    setPrompt(cfg.prompt_is_default ? '' : cfg.prompt)
    setPromptDirty(false)
    const schedule = readSchedule(cfg)
    setFireHour(schedule.fireHour)
    setDailyLimit(schedule.dailyLimit)
    setUseKos(schedule.useKos)
    setScheduleDirty(false)
    setAvatar(cfg.avatar ?? null)
    setAvatarDirty(false)
    setErr(null)
    setSaveFailed(false)
  }, [open, cfg])
  /* eslint-enable react-hooks/set-state-in-effect */

  const busy = isSaving

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

  const onSave = async (): Promise<void> => {
    if (!cfg) return
    setSaveFailed(false)
    if (scheduleDirty) {
      if (!Number.isInteger(fireHour) || fireHour < 0 || fireHour > 23) {
        setErr(t('agents.contactProfile.errFireHour'))
        return
      }
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
        setErr(t('agents.contactProfile.errDailyLimit'))
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
    // 未触碰且后端回填的是默认 → 回传 null（不把默认物化成自定义），同 ConfigDrawer。
    if (promptDirty) patch.prompt = prompt
    else if (!cfg.prompt_is_default) patch.prompt = cfg.prompt
    // 🔴 三个字段一起发：trigger_json 整列覆写，少发一个会把它抹回缺省。
    if (scheduleDirty) {
      patch.trigger = { fire_hour: fireHour, daily_limit: dailyLimit, use_kos: useKos }
    }
    if (avatarDirty) patch.avatar = avatar
    try {
      await save(CONTACT_PROFILE_AGENT_ID, patch)
      onClose()
    } catch (e: unknown) {
      setErr(errorMessage(e))
      setSaveFailed(true)
    }
  }

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
        <span style={{ color: 'rgb(var(--c-ai))', display: 'flex' }}>
          <ReportIcon name="sparkles" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.contactProfile.configTitle', { title: cfg?.title ?? '' })}
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
          {/* 总闸状态说明（总闸本体在 Labs，改后需重启，故这里只说明不给开关）。 */}
          <div
            style={{
              fontSize: 12.5,
              color: masterEnabled ? 'rgb(var(--ink-fg-2))' : 'rgb(var(--c-warn, var(--ink-fg-1)))',
              padding: '10px 12px',
              borderRadius: 9,
              background: 'rgb(var(--ink-1) / 0.5)',
              border: '1px solid rgb(var(--ink-border-soft))',
              lineHeight: 1.55
            }}
          >
            {masterEnabled
              ? t('agents.contactProfile.masterOnNote')
              : t('agents.contactProfile.masterOffNote')}
          </div>

          {/* 启用（row.enabled，保存即生效） */}
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
                {t('agents.contactProfile.enable')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.contactProfile.enableHint')}
              </div>
            </div>
            <Switch
              on={enabled}
              ariaLabel={t('agents.contactProfile.enable')}
              onChange={setEnabled}
            />
          </div>

          {/* 头像 + 名称（专型单例行，名称不可编辑，patch 只带 avatar）。 */}
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={CONTACT_PROFILE_AGENT_ID}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={cfg?.title ?? ''}
            />
          </Field>

          {/* 每日批处理时刻 + 每轮人数上限（trigger_json 字面字段）。 */}
          <Field
            label={t('agents.contactProfile.schedule')}
            hint={t('agents.contactProfile.scheduleHint')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))', flex: 1 }}>
                  {t('agents.contactProfile.dailyHour')}
                </span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  aria-label={t('agents.contactProfile.dailyHour')}
                  value={fireHour}
                  onChange={(e) => {
                    setFireHour(Number(e.target.value))
                    setScheduleDirty(true)
                  }}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
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
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              {/* 参考 KOS —— 同住 trigger_json，所以放在这个 Field 里、共用 scheduleDirty。 */}
              <div className="flex items-center" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, color: 'rgb(var(--ink-fg-2))' }}>
                    {t('agents.contactProfile.useKos')}
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      marginTop: 2,
                      lineHeight: 1.5
                    }}
                  >
                    {t('agents.contactProfile.useKosHint')}
                  </div>
                </div>
                <Switch
                  on={useKos}
                  ariaLabel={t('agents.contactProfile.useKos')}
                  onChange={(v) => {
                    setUseKos(v)
                    setScheduleDirty(true)
                  }}
                />
              </div>
            </div>
          </Field>

          {/* 模型（行级 model 列，空串 = 跟随全局 LLM_MODEL）。 */}
          <Field
            label={t('agents.config.model')}
            hint={t('agents.contactProfile.modelHint')}
          >
            <Select
              value={model || FOLLOW_GLOBAL_MODEL}
              onValueChange={(v) => {
                setModel(v === FOLLOW_GLOBAL_MODEL ? '' : v)
                setModelDirty(true)
              }}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[70]">
                <SelectItem value={FOLLOW_GLOBAL_MODEL}>
                  {t('agents.contactProfile.modelFollowGlobal')}
                </SelectItem>
                <ModelSelectItems models={enabledModels} current={model || null} />
              </SelectContent>
            </Select>
          </Field>

          {/* fallback（行级列；null = 跟随全局、[] = 显式不设、[m] = 单模型链）。 */}
          <Field
            label={t('agents.contactProfile.fallback')}
            hint={t('agents.contactProfile.fallbackHint')}
          >
            <Select
              value={fallbackModel}
              onValueChange={(v) => {
                setFallbackModel(v)
                setFallbackModelDirty(true)
              }}
              disabled={busy}
            >
              <SelectTrigger>
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
          </Field>

          {/* 提示词追加段（row.prompt）：接在内置画像 prompt 之后，留空 = 只用内置。 */}
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
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6, fontSize: 13 }}
            />
            <div
              style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 6, lineHeight: 1.5 }}
            >
              {t('agents.contactProfile.promptAppendNote')}
            </div>
          </Field>

          {err && (
            <div style={{ fontSize: 12.5, color: 'rgb(var(--c-danger, var(--ink-fg-1)))' }}>
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
          flexShrink: 0,
          justifyContent: 'flex-end'
        }}
      >
        <button type="button" onClick={onClose} className="btn-ghost" style={{ fontFamily: 'inherit' }}>
          {t('agents.config.cancel')}
        </button>
        <StatefulButton
          type="button"
          onClick={() => void onSave()}
          disabled={busy}
          state={busy ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
