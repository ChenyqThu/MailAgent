// Sprint 20 — /agents 项目周报同步配置抽屉 + 执行历史：机械抽自 AgentsTab.tsx（原样搬迁，
// 零行为变化）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AgentAvatarConfig,
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportConfigPatch
} from '@shared/api/types'
import { ReportIcon, Switch } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useProjectProgressRuns, useSetConfig } from '../hooks'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useRestartStore } from '@shared/state/restart'
import { toastError } from '@shared/state/toast'
import { IS_WEB, PROJECT_PROGRESS_AGENT_ID, envFlagOn } from '../shared'
import { Field } from './Field'

// ─── 项目周报同步执行历史（只读，v1.3.0 dogfood R5）──────────────────────────
// 观感参考 CustomAgentDrawer 的 RunHistorySection（状态徽标 + 时间 + 错误行），但用项目
// 周报自己的 status 词表（processing/completed/failed/skipped），不接「立即运行」/「查看
// 记录」——确定性 Python 直调、无 headless session，只回看每次同步结果。
function ppRunTime(ts: number | null | undefined): string {
  if (ts == null) return ''
  // 后端存 Unix 秒；< 1e12 视作秒 → ×1000（与 CustomAgentDrawer fmtTime 同口径）。
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}

function PpStatusBadge({ status }: { status: string }): React.ReactElement {
  const { t } = useTranslation()
  // 四态配色 + i18n 标签：completed=绿 / failed=红 / skipped=中性 / 其它(processing)=info。
  const tone =
    status === 'completed'
      ? { c: 'var(--c-ok)', label: 'agents.projectProgress.runs.statusCompleted' }
      : status === 'failed'
        ? { c: 'var(--c-fail)', label: 'agents.projectProgress.runs.statusFailed' }
        : status === 'skipped'
          ? { c: 'var(--ink-fg-3)', label: 'agents.projectProgress.runs.statusSkipped' }
          : { c: 'var(--c-info)', label: 'agents.projectProgress.runs.statusProcessing' }
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
        color: `rgb(${tone.c})`,
        background: `rgb(${tone.c} / 0.12)`,
        border: `1px solid rgb(${tone.c} / 0.25)`
      }}
    >
      {t(tone.label)}
    </span>
  )
}

function ProjectProgressRunHistory({ open }: { open: boolean }): React.ReactElement {
  const { t } = useTranslation()
  // 仅抽屉打开时拉取（退场期 open=false → 停请求，沿用缓存）。
  const { runs, isLoading } = useProjectProgressRuns(open)
  return (
    <Field
      label={t('agents.projectProgress.runs.section')}
      hint={t('agents.projectProgress.runs.sectionHint')}
    >
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
          {isLoading
            ? t('agents.projectProgress.runs.loading')
            : t('agents.projectProgress.runs.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {runs.map((r) => (
            <div
              key={r.internalId}
              style={{
                padding: '10px 12px',
                borderRadius: 9,
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))'
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <PpStatusBadge status={r.status} />
                <span
                  style={{
                    fontSize: 12,
                    color: 'rgb(var(--ink-fg-2))',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {r.weekTag || r.subject || `#${r.internalId}`}
                </span>
                <span style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', flexShrink: 0 }}>
                  {ppRunTime(r.completedAt ?? r.startedAt)}
                </span>
              </div>
              {r.status === 'completed' && (r.projectsTotal ?? 0) > 0 && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--ink-fg-3))',
                    marginTop: 6,
                    fontFamily: 'ui-monospace, monospace'
                  }}
                >
                  {t('agents.projectProgress.runs.counts', {
                    total: r.projectsTotal ?? 0,
                    created: r.projectsCreated ?? 0,
                    updated: r.projectsUpdated ?? 0
                  })}
                </div>
              )}
              {r.error && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--c-fail))',
                    marginTop: 6,
                    wordBreak: 'break-word',
                    lineHeight: 1.5
                  }}
                >
                  {r.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Field>
  )
}

// ─── 项目周报同步配置抽屉（S5 W5a）────────────────────────────────────────────
// 镜像 PreprocessConfigDrawer 单例编辑脚手架，双源写：
//   • row（enabled + trigger_json，保存即生效无需重启，走 useSetConfig）—— sender 是子串、
//     subject 是正则（后端 ProjectProgressDetector 语义；trigger_json 复用 email_filter
//     字段名）；保存时后端 parse_trigger 校验（空触发拒）。
//   • env（v1.3.0 dogfood 收编自 Settings→集成：总闸 PROJECT_PROGRESS_SYNC_ENABLED /
//     PROJECT_PROGRESS_DATABASE_ID / PROJECT_PROGRESS_FILTER_BU，applyEnvPatch + 重启横幅
//     —— 三者均为启动时一次性读取，改后需重启后端生效；dirty 追踪同 PreprocessConfigDrawer，
//     codex HIGH：未触碰的字段永不写回 .env）。
export function ProjectProgressConfigDrawer({
  cfg,
  open,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)

  const [enabled, setEnabled] = useState(false)
  const [sender, setSender] = useState('')
  const [subject, setSubject] = useState('')
  const [triggerDirty, setTriggerDirty] = useState(false)
  // 头像身份（0804 dogfood 3d）：行级 avatar_json，dirty 才写 patch。
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  // env 三字段本地镜像（dirty 追踪；保存时只写显式改过且值变化的键）。
  const [master, setMaster] = useState(false)
  const [masterDirty, setMasterDirty] = useState(false)
  const [dbId, setDbId] = useState('')
  const [dbIdDirty, setDbIdDirty] = useState(false)
  const [filterBu, setFilterBu] = useState('')
  const [filterBuDirty, setFilterBuDirty] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)

  // env store 状态 + 响应式 env 原值（就绪后回填，仅在用户未触碰该字段时）。
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

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setEnabled(cfg.enabled)
    const trig = cfg.trigger
    setSender(trig?.kind === 'email_filter' ? (trig.sender_pattern ?? '') : '')
    setSubject(trig?.kind === 'email_filter' ? (trig.subject_pattern ?? '') : '')
    setTriggerDirty(false)
    setAvatar(cfg.avatar ?? null)
    setAvatarDirty(false)
    setMasterDirty(false)
    setDbIdDirty(false)
    setFilterBuDirty(false)
    setErr(null)
    setSaveFailed(false)
  }, [open, cfg])
  // env 字段从就绪快照回填：仅在打开且用户未 dirty 该字段时同步（镜像 PreprocessConfigDrawer
  // —— env idle→ready 的迟到加载能纠正显示，但绝不覆盖用户在抽屉里的编辑）。
  useEffect(() => {
    if (!open) return
    if (envMasterRaw !== null && !masterDirty) setMaster(envFlagOn(envMasterRaw))
  }, [open, envMasterRaw, masterDirty])
  useEffect(() => {
    if (!open) return
    if (envDbIdRaw !== null && !dbIdDirty) setDbId(envDbIdRaw)
  }, [open, envDbIdRaw, dbIdDirty])
  useEffect(() => {
    if (!open) return
    if (envFilterBuRaw !== null && !filterBuDirty) setFilterBu(envFilterBuRaw)
  }, [open, envFilterBuRaw, filterBuDirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  const busy = isSaving || envSaving

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
    // 触发若被改过则一并提交；改成空触发（sender+subject 全空）= 永不匹配的死配置，
    // 后端 parse_trigger 会拒 —— 前端先给友好错误（要停用请用启用开关）。
    const patch: ReportConfigPatch = { enabled }
    if (triggerDirty) {
      if (!sender.trim() && !subject.trim()) {
        setErr(t('agents.projectProgress.errEmptyTrigger'))
        return
      }
      const trig: CustomAgentTrigger = { v: 1, kind: 'email_filter' }
      if (sender.trim()) trig.sender_pattern = sender.trim()
      if (subject.trim()) trig.subject_pattern = subject.trim()
      patch.trigger = trig
    }
    // 头像：未触碰不发（PATCH 缺席 = 不动列）。
    if (avatarDirty) patch.avatar = avatar
    setErr(null)
    // 1) env 写（总闸 / 项目库 ID / BU 过滤）：仅在 env 已就绪、非 web、且用户显式改过
    //    该字段（dirty）时写 —— 镜像 PreprocessConfigDrawer（codex HIGH：未触碰的字段
    //    永不写回 .env）。只写值变化的键，变更键挂重启横幅（三者均启动时一次性读取）。
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
        <span style={{ color: 'rgb(var(--c-accent))', display: 'flex' }}>
          <ReportIcon name="barchart" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.projectProgress.configTitle', { title: cfg?.title ?? '' })}
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
          {/* 远程 web 只读提示（env 写不可用；启用开关与触发规则仍可改） */}
          {IS_WEB && (
            <div
              style={{
                fontSize: 12.5,
                color: 'rgb(var(--ink-fg-2))',
                padding: '10px 12px',
                borderRadius: 9,
                background: 'rgb(var(--ink-1) / 0.5)',
                border: '1px solid rgb(var(--ink-border-soft))'
              }}
            >
              {t('agents.projectProgress.webReadOnly')}
            </div>
          )}

          {/* 总闸状态说明。总闸未开时高亮提示。 */}
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
          </div>

          {/* 总开关（env PROJECT_PROGRESS_SYNC_ENABLED，v1.3.0 收编自 Settings→集成）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
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
                {t('agents.projectProgress.master')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.projectProgress.masterHint')}
              </div>
            </div>
            <span style={!envReady || IS_WEB ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
              <Switch
                on={master}
                onChange={(v) => {
                  setMaster(v)
                  setMasterDirty(true)
                }}
              />
            </span>
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
                {t('agents.projectProgress.enable')}
              </div>
              <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                {t('agents.projectProgress.enableHint')}
              </div>
            </div>
            <Switch on={enabled} onChange={setEnabled} />
          </div>

          {/* 头像 + 名称（0804 dogfood 3d/3e）—— 项目周报是 DB v31 播种的专型单例行，
              名称不可编辑，故只并排展示，保存 patch 只带 avatar。 */}
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={PROJECT_PROGRESS_AGENT_ID}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={cfg?.title ?? ''}
            />
          </Field>

          {/* 触发：标题正则（必填）+ 发件人子串（可选，留空 = 任意发件人） */}
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
              }}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
            />
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
              style={{ ...inputStyle, fontFamily: 'var(--font-mono, monospace)' }}
            />
          </Field>

          {/* 项目进度库 ID（env PROJECT_PROGRESS_DATABASE_ID，v1.3.0 只读 → 可编辑）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
          <Field
            label={t('agents.projectProgress.database')}
            hint={t('agents.projectProgress.databaseHint')}
          >
            <input
              type="text"
              value={dbId}
              disabled={!envReady || IS_WEB}
              placeholder={t('agents.projectProgress.databaseUnset')}
              onChange={(e) => {
                setDbId(e.target.value)
                setDbIdDirty(true)
              }}
              style={{
                ...inputStyle,
                fontFamily: 'var(--font-mono, monospace)',
                ...(!envReady || IS_WEB ? { opacity: 0.5 } : {})
              }}
            />
          </Field>

          {/* BU 过滤（env PROJECT_PROGRESS_FILTER_BU，v1.3.0 收编自 Settings→集成）
                —— 需重启生效。env 未就绪 / web 时禁用。 */}
          <Field
            label={t('agents.projectProgress.filterBu')}
            hint={t('agents.projectProgress.filterBuHint')}
          >
            <input
              type="text"
              value={filterBu}
              disabled={!envReady || IS_WEB}
              placeholder={t('agents.projectProgress.filterBuPlaceholder')}
              onChange={(e) => {
                setFilterBu(e.target.value)
                setFilterBuDirty(true)
              }}
              style={{
                ...inputStyle,
                fontFamily: 'var(--font-mono, monospace)',
                ...(!envReady || IS_WEB ? { opacity: 0.5 } : {})
              }}
            />
          </Field>

          {/* 内置能力（R2(c)）：同步脚本 = 确定性 Python 直调、恒启用 —— 锁定态徽标，
                不可交互（不是 skill 体系，不能挂载/卸载）；唯一开关 = 上方启用开关。 */}
          <Field
            label={t('agents.projectProgress.capability')}
            hint={t('agents.projectProgress.capabilityHint')}
          >
            <span
              aria-disabled="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'default',
                opacity: 0.7,
                color: 'rgb(var(--c-accent))',
                background: 'rgb(var(--c-accent) / 0.14)',
                border: '1px solid rgb(var(--c-accent) / 0.5)'
              }}
            >
              <ReportIcon name="check" size={13} />
              {t('agents.projectProgress.capabilityChip')}
            </span>
            <div
              style={{
                fontSize: 11.5,
                color: 'rgb(var(--ink-fg-3))',
                marginTop: 7,
                lineHeight: 1.5
              }}
            >
              {t('agents.projectProgress.capabilityNote')}
            </div>
          </Field>

          {/* 执行历史（R5）：只读近期同步记录（状态/时间/错误/项目计数）。 */}
          <ProjectProgressRunHistory open={open} />

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
