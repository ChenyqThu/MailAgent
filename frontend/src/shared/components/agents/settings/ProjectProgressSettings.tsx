// P4a agent-config lane — 「项目周报同步」配置页。保存语义逐字段照
// drawers/ProjectProgressConfigDrawer（row: enabled + trigger email_filter；env: 总闸 /
// 项目库 ID / BU 过滤，dirty 追踪 + 重启横幅；空触发前端先拒）。
//
// 本页新增的只有交互（r7 §三 判据 4 / 5）：
//   • 标题正则实时校验 + 「拿最近 5 封标题试一下」（标题走现有 email.list IPC，本地跑
//     regex —— 不开新端点）。
//   • 项目进度库 ID 输入带格式识别（32-hex / 带连字符 / 粘贴 Notion 链接可提取）。
//     现有的 Notion 库选择器（NotionDbSelectDialog）绑定在 OAuth 授权流的候选集上，
//     没有「列出工作区全部库」的通用查询面 —— 造一个要开新端点，超出本批范围，
//     故落「输入 + 校验反馈」的折中。
// 执行历史不再渲染（判据 6）：记录列用 useProjectProgressRuns 承担。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AgentAvatarConfig,
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportConfigPatch
} from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { INBOX_LABEL } from '@shared/lib/mailboxSemantics'
import { useRestartStore } from '@shared/state/restart'
import { toastError } from '@shared/state/toast'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { ReportIcon } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useSetConfig } from '../hooks'
import { IS_WEB, PROJECT_PROGRESS_AGENT_ID, envFlagOn } from '../shared'
import { Field } from '../drawers/Field'
import { BuiltinToolsNote, ReadonlyCard, SettingsScaffold } from './sections'
import { SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'
import { compileSubjectRegex, parseNotionDatabaseId, testSubjectsAgainst } from './lib'

type SubjectTrial =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'done'; rows: { subject: string; hit: boolean }[] }

export function ProjectProgressSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const api = useMailApi()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  const initialTrig = cfg.trigger?.v === 1 ? cfg.trigger : null
  const [enabled, setEnabled] = useState(cfg.enabled)
  const [sender, setSender] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.sender_pattern ?? '') : ''
  )
  const [subject, setSubject] = useState(
    initialTrig?.kind === 'email_filter' ? (initialTrig.subject_pattern ?? '') : ''
  )
  const [triggerDirty, setTriggerDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)
  const [master, setMaster] = useState(false)
  const [masterDirty, setMasterDirty] = useState(false)
  const [dbId, setDbId] = useState('')
  const [dbIdDirty, setDbIdDirty] = useState(false)
  const [filterBu, setFilterBu] = useState('')
  const [filterBuDirty, setFilterBuDirty] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)
  const [trial, setTrial] = useState<SubjectTrial>({ phase: 'idle' })

  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const envMasterRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')
      : null
  )
  const envDbIdRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_DATABASE_ID'] ?? '')
      : null
  )
  const envFilterBuRaw = useEnvStore((s) =>
    s.state.status === 'ready'
      ? (s.state.snapshot.values['PROJECT_PROGRESS_FILTER_BU'] ?? '')
      : null
  )
  const masterEnabled = envMasterRaw !== null && envFlagOn(envMasterRaw)

  // env 迟到回填（仅未 dirty 字段，同 ProjectProgressConfigDrawer：env idle→ready 的
  // 迟到加载能纠正显示，但绝不覆盖用户在页面里的编辑）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (envMasterRaw !== null && !masterDirty) setMaster(envFlagOn(envMasterRaw))
  }, [envMasterRaw, masterDirty])
  useEffect(() => {
    if (envDbIdRaw !== null && !dbIdDirty) setDbId(envDbIdRaw)
  }, [envDbIdRaw, dbIdDirty])
  useEffect(() => {
    if (envFilterBuRaw !== null && !filterBuDirty) setFilterBu(envFilterBuRaw)
  }, [envFilterBuRaw, filterBuDirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 标题正则的实时校验（判据 4）。空串 = 没写，不报错（sender/subject 至少一个即可）。
  const regexCheck = useMemo(
    () => (subject.trim() ? compileSubjectRegex(subject.trim()) : null),
    [subject]
  )
  // 库 ID 的格式识别（判据 5 的折中形态）。
  const dbIdParse = useMemo(() => parseNotionDatabaseId(dbId), [dbId])

  const runTrial = (): void => {
    const pattern = subject.trim()
    if (!pattern || (regexCheck && !regexCheck.ok)) return
    setTrial({ phase: 'loading' })
    void api.email
      .list({ mailbox: INBOX_LABEL, limit: 5 })
      .then((rows) => {
        const subjects = rows.map((r) => r.subject ?? '')
        const hits = testSubjectsAgainst(pattern, subjects)
        setTrial(
          hits === null
            ? { phase: 'error' }
            : { phase: 'done', rows: subjects.map((s, i) => ({ subject: s, hit: hits[i] })) }
        )
      })
      .catch(() => setTrial({ phase: 'error' }))
  }

  const busy = isSaving || envSaving
  const saveState: StatefulButtonState = busy
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  const onSave = async (): Promise<void> => {
    setSaveFailed(false)
    const patch: ReportConfigPatch = { enabled }
    if (triggerDirty) {
      // 空触发（sender+subject 全空）= 永不匹配的死配置，后端 parse_trigger 会拒 ——
      // 前端先给友好错误（要停用请用启用开关）。
      if (!sender.trim() && !subject.trim()) {
        setErr(t('agents.projectProgress.errEmptyTrigger'))
        setSaveFailed(true)
        return
      }
      if (regexCheck && !regexCheck.ok) {
        setErr(t('agentSettings.regex.invalid', { message: regexCheck.error }))
        setSaveFailed(true)
        return
      }
      const trig: CustomAgentTrigger = { v: 1, kind: 'email_filter' }
      if (sender.trim()) trig.sender_pattern = sender.trim()
      if (subject.trim()) trig.subject_pattern = subject.trim()
      patch.trigger = trig
    }
    if (avatarDirty) patch.avatar = avatar
    setErr(null)
    // 1) env 写（总闸 / 项目库 ID / BU 过滤）：dirty 且值变化才写，变更键挂重启横幅。
    if (envReady && !IS_WEB) {
      const st = useEnvStore.getState().state
      const vals = st.status === 'ready' ? st.snapshot.values : {}
      const envPatch: Record<string, string> = {}
      const nextMaster = master ? 'true' : 'false'
      if (masterDirty && nextMaster !== (vals['PROJECT_PROGRESS_SYNC_ENABLED'] ?? '')) {
        envPatch['PROJECT_PROGRESS_SYNC_ENABLED'] = nextMaster
      }
      if (dbIdDirty && dbId.trim() !== (vals['PROJECT_PROGRESS_DATABASE_ID'] ?? '')) {
        envPatch['PROJECT_PROGRESS_DATABASE_ID'] = dbId.trim()
      }
      if (filterBuDirty && filterBu.trim() !== (vals['PROJECT_PROGRESS_FILTER_BU'] ?? '')) {
        envPatch['PROJECT_PROGRESS_FILTER_BU'] = filterBu.trim()
      }
      if (Object.keys(envPatch).length > 0) {
        setEnvSaving(true)
        try {
          const r = await applyEnvPatch(envPatch)
          if (!r.ok) {
            toastError(
              t('agents.projectProgress.envSaveError'),
              `${r.error.code}: ${r.error.message}`
            )
            setSaveFailed(true)
            return
          }
          if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
        } finally {
          setEnvSaving(false)
        }
      }
    }
    // 2) row 保存（enabled + trigger，保存即生效无需重启）。
    try {
      await save(PROJECT_PROGRESS_AGENT_ID, patch)
      setSaveDone(true)
      window.setTimeout(() => setSaveDone(false), 1600)
    } catch (e: unknown) {
      setErr(errorMessage(e))
      setSaveFailed(true)
    }
  }

  const envDisabled = !envReady || IS_WEB

  return (
    <SettingsScaffold
      title={cfg.title}
      subtitle={t('agentSettings.role.builtin')}
      banner={
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
            ? t('agents.projectProgress.masterOnNote')
            : t('agents.projectProgress.masterOffNote')}
          {IS_WEB ? ` ${t('agents.projectProgress.webReadOnly')}` : null}
        </div>
      }
      enable={{ on: enabled, onChange: setEnabled }}
      save={{ state: saveState, onSave: () => void onSave(), disabled: busy }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={PROJECT_PROGRESS_AGENT_ID}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={cfg.title}
            />
          </Field>
        ),
        when: (
          <>
            <Field
              label={t('agents.projectProgress.subjectPattern')}
              hint={t('agents.projectProgress.subjectPatternHint')}
            >
              <input
                type="text"
                value={subject}
                placeholder={t('agents.projectProgress.subjectPlaceholder')}
                onChange={(e) => {
                  setSubject(e.target.value)
                  setTriggerDirty(true)
                  setTrial({ phase: 'idle' })
                }}
                style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
              />
              {/* 实时校验（判据 4）：能不能编译当场说，不用等下一封周报邮件。 */}
              {regexCheck && (
                <div
                  data-testid="subject-regex-feedback"
                  style={{
                    fontSize: 11.5,
                    marginTop: 6,
                    lineHeight: 1.5,
                    color: regexCheck.ok ? 'rgb(var(--c-ok))' : 'rgb(var(--c-fail))'
                  }}
                >
                  {regexCheck.ok
                    ? t('agentSettings.regex.ok')
                    : t('agentSettings.regex.invalid', { message: regexCheck.error })}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontFamily: 'inherit' }}
                  disabled={!subject.trim() || (regexCheck !== null && !regexCheck.ok)}
                  onClick={runTrial}
                >
                  {t('agentSettings.regex.tryLabel')}
                </button>
                {trial.phase === 'loading' && (
                  <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', marginTop: 6 }}>
                    …
                  </div>
                )}
                {trial.phase === 'error' && (
                  <div style={{ fontSize: 11.5, color: 'rgb(var(--c-fail))', marginTop: 6 }}>
                    {t('agentSettings.regex.loadFailed')}
                  </div>
                )}
                {trial.phase === 'done' && (
                  <div
                    data-testid="subject-regex-trial"
                    style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}
                  >
                    {trial.rows.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))' }}>
                        {t('agentSettings.regex.empty')}
                      </div>
                    ) : (
                      trial.rows.map((row, i) => (
                        <div
                          key={i}
                          className="flex items-center"
                          style={{
                            gap: 8,
                            fontSize: 12,
                            padding: '5px 9px',
                            borderRadius: 7,
                            background: 'rgb(var(--ink-1) / 0.4)',
                            border: '1px solid rgb(var(--ink-border-soft))'
                          }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 11,
                              fontWeight: 600,
                              color: row.hit ? 'rgb(var(--c-ok))' : 'rgb(var(--ink-fg-3))'
                            }}
                          >
                            {row.hit
                              ? t('agentSettings.regex.matched')
                              : t('agentSettings.regex.missed')}
                          </span>
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              color: 'rgb(var(--ink-fg-2))'
                            }}
                          >
                            {row.subject}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 6,
                  lineHeight: 1.5
                }}
              >
                {t('agentSettings.regex.jsNote')}
              </div>
            </Field>
            <Field
              label={t('agents.projectProgress.senderPattern')}
              hint={t('agents.projectProgress.senderPatternHint')}
            >
              <input
                type="text"
                value={sender}
                placeholder={t('agents.projectProgress.senderPlaceholder')}
                onChange={(e) => {
                  setSender(e.target.value)
                  setTriggerDirty(true)
                }}
                style={{ ...INPUT_STYLE, fontFamily: 'var(--font-mono, monospace)' }}
              />
            </Field>
          </>
        ),
        capabilities: (
          <>
            <ReadonlyCard title={t('agents.projectProgress.capability')}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: 'rgb(var(--c-accent))',
                  background: 'rgb(var(--c-accent) / 0.14)',
                  border: '1px solid rgb(var(--c-accent) / 0.5)'
                }}
              >
                <ReportIcon name="check" size={13} />
                {t('agents.projectProgress.capabilityChip')}
              </span>
              <div style={{ marginTop: 7 }}>{t('agents.projectProgress.capabilityNote')}</div>
            </ReadonlyCard>
            <BuiltinToolsNote />
          </>
        ),
        specific: (
          <>
            <SwitchCard
              label={t('agents.projectProgress.master')}
              hint={t('agents.projectProgress.masterHint')}
              on={master}
              onChange={(v) => {
                setMaster(v)
                setMasterDirty(true)
              }}
              disabled={envDisabled}
            />
            <Field
              label={t('agents.projectProgress.database')}
              hint={t('agents.projectProgress.databaseHint')}
            >
              <input
                type="text"
                value={dbId}
                disabled={envDisabled}
                placeholder={t('agents.projectProgress.databaseUnset')}
                onChange={(e) => {
                  setDbId(e.target.value)
                  setDbIdDirty(true)
                }}
                style={{
                  ...INPUT_STYLE,
                  fontFamily: 'var(--font-mono, monospace)',
                  ...(envDisabled ? { opacity: 0.5 } : {})
                }}
              />
              {dbIdParse.kind === 'id' && (
                <div style={{ fontSize: 11.5, color: 'rgb(var(--c-ok))', marginTop: 6 }}>
                  {t('agentSettings.notionDb.ok')}
                </div>
              )}
              {dbIdParse.kind === 'url' && (
                <div
                  className="flex items-center"
                  style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}
                >
                  <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-2))' }}>
                    {t('agentSettings.notionDb.parsed', { id: dbIdParse.id })}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    style={{ fontFamily: 'inherit' }}
                    disabled={envDisabled}
                    onClick={() => {
                      setDbId(dbIdParse.id)
                      setDbIdDirty(true)
                    }}
                  >
                    {t('agentSettings.notionDb.useParsed')}
                  </button>
                </div>
              )}
              {dbIdParse.kind === 'invalid' && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--c-warn))',
                    marginTop: 6,
                    lineHeight: 1.5
                  }}
                >
                  {t('agentSettings.notionDb.invalid')}
                </div>
              )}
            </Field>
            <Field
              label={t('agents.projectProgress.filterBu')}
              hint={t('agents.projectProgress.filterBuHint')}
            >
              <input
                type="text"
                value={filterBu}
                disabled={envDisabled}
                placeholder={t('agents.projectProgress.filterBuPlaceholder')}
                onChange={(e) => {
                  setFilterBu(e.target.value)
                  setFilterBuDirty(true)
                }}
                style={{
                  ...INPUT_STYLE,
                  fontFamily: 'var(--font-mono, monospace)',
                  ...(envDisabled ? { opacity: 0.5 } : {})
                }}
              />
            </Field>
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
