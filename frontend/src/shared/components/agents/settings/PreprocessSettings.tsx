// P4a agent-config lane — 「AI 邮件预处理」配置页。保存语义逐字段照
// drawers/PreprocessConfigDrawer（双源写：启用 → env LLM_AGENT_ENABLED + 重启横幅；
// 模型 / fallback / 上下文源 / 标已读 / 文档勾选 → report_agent 行 PATCH 保存即生效；
// 分类 prompt → .md 文件热加载；全部 dirty 追踪，未触碰的字段永不写）。
//
// 布局差异（r7 §三）：模型 + Fallback 并成「主力 / 失败时回退」一组（判据 1）；
// 身份文档内容改只读卡指路（判据 2，原内联 StandingDocsSection 移除 —— 单一可写面
// 在 设置 → AI，主 Agent 页也还内联着同一个编辑器）；启用开关上页头（判据 3）。
// 没有「什么时候动」区：它跟着收信自动跑，没有可配的触发（design §8.2）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import type { AgentAvatarConfig, ReportAgentConfig } from '@shared/api/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useMailApi } from '@shared/hooks/useMailApi'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { AgentIdentityHeader } from '../AgentAvatar'
import { useSetConfig } from '../hooks'
import { EMAIL_PREPROCESS_AGENT_ID, IS_WEB, PREPROCESS_DOCS, envFlagOn } from '../shared'
import { Field } from '../drawers/Field'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import { BuiltinToolsNote, ReadonlyCard, SettingsScaffold } from './sections'
import { ChoiceChip, ModelGroup, SwitchCard } from './controls'
import { INPUT_STYLE } from './inputStyle'

/** 模型下拉「跟随全局默认」哨兵（radix SelectItem 禁空串 value）。 */
const FOLLOW_GLOBAL_MODEL = '__follow_global__'
/** fallback 下拉「跟随全局」哨兵（行级列 NULL）。 */
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
/** fallback 下拉「不设」哨兵（行级列 '[]'）。 */
const FALLBACK_NONE = '__none__'

// 参考上下文源二选一（运行时权威 = report_agent.context_source 行值，保存即生效）。
const CONTEXT_SOURCES = ['standing_docs', 'notion_context'] as const
type ContextSource = (typeof CONTEXT_SOURCES)[number]

/** 行值 → 生效源（同后端 _resolve_context_source：显式合法值行权威；NULL/野值按
 *  LLM_CONTEXT_PAGE_ID 有无继承）。 */
function deriveContextSource(rawSource: string | null, rawPageId: string | null): ContextSource {
  const s = (rawSource ?? '').trim().toLowerCase()
  if (s === 'notion_context' || s === 'standing_docs') return s
  return (rawPageId ?? '').trim().length > 0 ? 'notion_context' : 'standing_docs'
}

interface PromptDraft {
  content: string
  path: string
  dirty: boolean
}
type PromptDrafts = Record<'inbox' | 'sent', PromptDraft>

export function PreprocessSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const api = useMailApi()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  const navigate = useNavigate()

  const [enabled, setEnabled] = useState(false)
  const [enabledDirty, setEnabledDirty] = useState(false)
  const [model, setModel] = useState<string>(cfg.model ?? '')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(
    cfg.fallback_models == null
      ? FALLBACK_FOLLOW_GLOBAL
      : cfg.fallback_models.length === 0
        ? FALLBACK_NONE
        : cfg.fallback_models[0]
  )
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [markReadAfterProcessing, setMarkReadAfterProcessing] = useState(
    cfg.mark_read_after_processing ?? true
  )
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [contextDocs, setContextDocs] = useState<string[]>(cfg.context_docs ?? [])
  const [contextSource, setContextSource] = useState<ContextSource>('standing_docs')
  const [contextSourceDirty, setContextSourceDirty] = useState(false)
  const [contextPageId, setContextPageId] = useState('')
  const [contextPageIdDirty, setContextPageIdDirty] = useState(false)
  const [envSaving, setEnvSaving] = useState(false)
  const [promptDrafts, setPromptDrafts] = useState<PromptDrafts | 'loading' | 'error'>('loading')
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)
  const [promptTab, setPromptTab] = useState<'inbox' | 'sent'>('inbox')
  const { models: enabledModels } = useEnabledModels()

  const envReady = useEnvStore((s) => s.state.status === 'ready')
  const envEnabledRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_AGENT_ENABLED'] ?? '') : null
  )
  const envModelRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_MODEL'] ?? '') : null
  )
  const envFallbackRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_FALLBACK_MODELS'] ?? '') : null
  )
  const envContextPageIdRaw = useEnvStore((s) =>
    s.state.status === 'ready' ? (s.state.snapshot.values['LLM_CONTEXT_PAGE_ID'] ?? '') : null
  )

  // env / 异步查询的迟到回填 —— 仅在用户未 dirty 该字段时同步（同 PreprocessConfigDrawer，
  // codex HIGH：迟到加载纠正显示，但绝不覆盖用户在页面里的编辑）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (envEnabledRaw !== null && !enabledDirty) setEnabled(envFlagOn(envEnabledRaw))
  }, [envEnabledRaw, enabledDirty])
  useEffect(() => {
    if (!contextSourceDirty) {
      setContextSource(deriveContextSource(cfg.context_source ?? null, envContextPageIdRaw))
    }
  }, [cfg, envContextPageIdRaw, contextSourceDirty])
  useEffect(() => {
    if (envContextPageIdRaw !== null && !contextPageIdDirty) setContextPageId(envContextPageIdRaw)
  }, [envContextPageIdRaw, contextPageIdDirty])
  // 分类 prompt：挂载时经 mailApi.prompts.read 拉两份（与运行时 PromptLoader 同两份文件）。
  useEffect(() => {
    let cancelled = false
    setPromptDrafts('loading')
    void Promise.all([api.prompts.read('inbox'), api.prompts.read('sent')])
      .then(([inbox, sent]) => {
        if (cancelled) return
        setPromptDrafts({
          inbox: { content: inbox.content, path: inbox.path, dirty: false },
          sent: { content: sent.content, path: sent.path, dirty: false }
        })
      })
      .catch(() => {
        if (!cancelled) setPromptDrafts('error')
      })
    return () => {
      cancelled = true
    }
  }, [api.prompts])
  /* eslint-enable react-hooks/set-state-in-effect */

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
    // 1) env 写：仅 env 已就绪、非 web、且字段 dirty 时写（未触碰的字段永不写回 .env）。
    if (envReady && !IS_WEB) {
      const st = useEnvStore.getState().state
      const vals = st.status === 'ready' ? st.snapshot.values : {}
      const envPatch: Record<string, string> = {}
      const nextEnabled = enabled ? 'true' : 'false'
      if (enabledDirty && nextEnabled !== (vals['LLM_AGENT_ENABLED'] ?? '')) {
        envPatch['LLM_AGENT_ENABLED'] = nextEnabled
      }
      if (contextPageIdDirty && contextPageId !== (vals['LLM_CONTEXT_PAGE_ID'] ?? '')) {
        envPatch['LLM_CONTEXT_PAGE_ID'] = contextPageId
      }
      if (Object.keys(envPatch).length > 0) {
        setEnvSaving(true)
        try {
          const r = await applyEnvPatch(envPatch)
          if (!r.ok) {
            toastError(t('agents.preprocess.envSaveError'), `${r.error.code}: ${r.error.message}`)
            setSaveFailed(true)
            return
          }
          if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
        } finally {
          setEnvSaving(false)
        }
      }
    }
    // 2) 分类 prompt 写：仅 dirty 的 slot 写回 .md（PromptLoader mtime 热加载，保存即生效）。
    if (promptDrafts !== 'loading' && promptDrafts !== 'error') {
      let wrotePrompt = false
      for (const slot of ['inbox', 'sent'] as const) {
        const draft = promptDrafts[slot]
        if (!draft.dirty) continue
        const r = await api.prompts.write(slot, draft.content)
        if (!r.ok) {
          toastError(t('agents.preprocess.promptSaveError'), `${r.code}: ${r.message}`)
          setSaveFailed(true)
          return
        }
        wrotePrompt = true
      }
      if (wrotePrompt) toastSuccess(t('agents.preprocess.promptSaved'))
    }
    // 3) row 保存（模型 / fallback / 上下文源 / 头像按 dirty；文档勾选 + 标已读恒发）。
    try {
      await save(EMAIL_PREPROCESS_AGENT_ID, {
        ...(modelDirty ? { model } : {}),
        ...(fallbackModelDirty
          ? {
              fallback_models:
                fallbackModel === FALLBACK_FOLLOW_GLOBAL
                  ? null
                  : fallbackModel === FALLBACK_NONE
                    ? []
                    : [fallbackModel]
            }
          : {}),
        ...(contextSourceDirty ? { context_source: contextSource } : {}),
        ...(avatarDirty ? { avatar } : {}),
        context_docs: contextDocs,
        mark_read_after_processing: markReadAfterProcessing
      })
      setSaveDone(true)
      window.setTimeout(() => setSaveDone(false), 1600)
    } catch (e: unknown) {
      toastError(t('agents.preprocess.rowSaveError'), errorMessage(e))
      setSaveFailed(true)
    }
  }

  return (
    <SettingsScaffold
      title={cfg.title}
      subtitle={t('agentSettings.role.builtin')}
      banner={
        IS_WEB ? (
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
            {t('agents.preprocess.webReadOnly')}
          </div>
        ) : undefined
      }
      enable={{
        on: enabled,
        onChange: (v) => {
          setEnabled(v)
          setEnabledDirty(true)
        },
        disabled: !envReady || IS_WEB
      }}
      save={{ state: saveState, onSave: () => void onSave(), disabled: busy }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.label')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={EMAIL_PREPROCESS_AGENT_ID}
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
              label={t('agents.preprocess.promptView')}
              hint={t('agents.preprocess.promptViewHint')}
            >
              <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
                {(['inbox', 'sent'] as const).map((tab) => (
                  <ChoiceChip key={tab} on={promptTab === tab} onClick={() => setPromptTab(tab)}>
                    {t(`agents.preprocess.promptTab.${tab}`)}
                  </ChoiceChip>
                ))}
              </div>
              {promptDrafts === 'loading' ? (
                <div style={{ ...INPUT_STYLE, color: 'rgb(var(--ink-fg-3))' }}>…</div>
              ) : promptDrafts === 'error' ? (
                <div style={{ ...INPUT_STYLE, color: 'rgb(var(--ink-fg-3))' }}>
                  {t('agents.preprocess.promptLoadError')}
                </div>
              ) : (
                <>
                  <textarea
                    value={promptDrafts[promptTab].content}
                    onChange={(e) => {
                      const next = e.target.value
                      setPromptDrafts((prev) =>
                        prev === 'loading' || prev === 'error'
                          ? prev
                          : {
                              ...prev,
                              [promptTab]: { ...prev[promptTab], content: next, dirty: true }
                            }
                      )
                    }}
                    spellCheck={false}
                    placeholder={t('agents.preprocess.promptEmpty')}
                    className="scrollbar-thin"
                    style={{
                      ...INPUT_STYLE,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      minHeight: 220,
                      resize: 'vertical'
                    }}
                  />
                  {promptDrafts[promptTab].path && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'rgb(var(--ink-fg-3))',
                        marginTop: 6,
                        wordBreak: 'break-all'
                      }}
                    >
                      {promptDrafts[promptTab].path}
                    </div>
                  )}
                </>
              )}
            </Field>
            <Field
              label={t('agents.preprocess.contextSource')}
              hint={t('agents.preprocess.contextSourceHint')}
            >
              <div
                className="flex items-center"
                style={{
                  gap: 8,
                  flexWrap: 'wrap',
                  ...(busy ? { opacity: 0.5, pointerEvents: 'none' as const } : null)
                }}
              >
                {CONTEXT_SOURCES.map((src) => (
                  <ChoiceChip
                    key={src}
                    on={contextSource === src}
                    onClick={() => {
                      setContextSource(src)
                      setContextSourceDirty(true)
                    }}
                  >
                    {t(`agents.preprocess.contextSourceOption.${src}`)}
                  </ChoiceChip>
                ))}
              </div>
              {contextSource === 'notion_context' && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: 'rgb(var(--ink-fg-2))',
                      marginBottom: 6
                    }}
                  >
                    {t('agents.preprocess.contextPageId')}
                  </div>
                  <input
                    type="text"
                    value={contextPageId}
                    onChange={(e) => {
                      setContextPageId(e.target.value)
                      setContextPageIdDirty(true)
                    }}
                    disabled={!envReady || IS_WEB}
                    placeholder={t('agents.preprocess.contextPageIdPlaceholder')}
                    spellCheck={false}
                    style={{ ...INPUT_STYLE, ...(!envReady || IS_WEB ? { opacity: 0.5 } : null) }}
                  />
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'rgb(var(--ink-fg-3))',
                      marginTop: 6,
                      lineHeight: 1.5
                    }}
                  >
                    {t('agents.preprocess.contextPageIdHint')}
                  </div>
                </div>
              )}
            </Field>
            <Field
              label={t('agents.preprocess.contextDocs')}
              hint={t('agents.preprocess.contextDocsHint')}
            >
              <div
                className="flex items-center"
                style={{
                  gap: 8,
                  flexWrap: 'wrap',
                  ...(contextSource === 'notion_context'
                    ? { opacity: 0.45, pointerEvents: 'none' as const }
                    : null)
                }}
              >
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
                {contextSource === 'notion_context'
                  ? t('agents.preprocess.contextDocsInactiveNote')
                  : t('agents.preprocess.contextDocsNote')}
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
                    {t('agents.preprocess.modelFollowGlobal', {
                      model: envModelRaw || 'claude-sonnet-4-6'
                    })}
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
                    {t('agents.preprocess.fallbackFollowGlobal', {
                      model: envFallbackRaw || t('agents.preprocess.fallbackGlobalUnset')
                    })}
                  </SelectItem>
                  <SelectItem value={FALLBACK_NONE}>
                    {t('agents.preprocess.fallbackNone')}
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
        capabilities: <BuiltinToolsNote />,
        specific: (
          <>
            <SwitchCard
              label={t('agents.preprocess.markReadAfterProcessing')}
              hint={t('agents.preprocess.markReadAfterProcessingHint')}
              on={markReadAfterProcessing}
              onChange={setMarkReadAfterProcessing}
            />
            {/* 预处理没有 per-run 记录（per-邮件的 llm_processing 聚合在 LLM 仪表盘），
                这条入口不属于「运行记录」搬迁范围，保留。 */}
            <button
              type="button"
              className="btn-ghost"
              style={{ fontFamily: 'inherit', alignSelf: 'flex-start' }}
              onClick={() => void navigate({ to: '/admin/llm' })}
            >
              {t('agents.preprocess.viewStats')}
            </button>
          </>
        )
      }}
    />
  )
}
