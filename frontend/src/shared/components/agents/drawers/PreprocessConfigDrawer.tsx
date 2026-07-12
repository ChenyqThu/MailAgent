// Sprint 20 — /agents AI 邮件预处理配置抽屉：机械抽自 AgentsTab.tsx（原样搬迁，零行为变化）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'

import type { ReportAgentConfig } from '@shared/api/types'
import { ReportIcon, Switch } from '../primitives'
import { useSetConfig } from '../hooks'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { useMailApi } from '@shared/hooks/useMailApi'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { applyEnvPatch, useEnvStore } from '@shared/state/env'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useRestartStore } from '@shared/state/restart'
import { toastError, toastSuccess } from '@shared/state/toast'
// v27 「AI 邮件预处理」配置抽屉内联复用身份文档正文编辑器（同组件不同入口）。
import { StandingDocsSection } from '@shared/components/settings/CustomAiSection'
import { IS_WEB, PREPROCESS_DOCS, envFlagOn } from '../shared'
import { Field } from './Field'

// v27 「AI 邮件预处理」agent —— 后端 DB v27 播种单行（id 固定、type='preprocess'）。
// 双源绑定：启用/模型走全局 env（LLM_AGENT_ENABLED / LLM_MODEL，pydantic singleton→需重启
// 生效，与 AiTab 现有 toggle 一致）；persona + 文档勾选存 report_agent row（prompt / context_docs）。
const PREPROCESS_AGENT_ID = 'email_preprocess_agent'

// ─── AI 邮件预处理配置抽屉 ────────────────────────────────────────────────────
// 复刻 SearchConfigDrawer 三段式脚手架。双源写：启用 → 全局 env（applyEnvPatch + 重启横幅，
// pydantic singleton 需重启）；模型 / fallback / 文档勾选 → report_agent row（useSetConfig；
// #8-ext 模型走行级 model 列、空 = 跟随全局 LLM_MODEL；R2 #2 fallback 走行级
// fallback_models_json 列、NULL = 跟随全局 LLM_FALLBACK_MODELS —— 均与全局设置拆分，改行级
// 值保存即生效无需重启）；身份文档正文内联复用 StandingDocsSection。
// persona 输入已随 v1.1.0 dogfood 移除（身份/偏好由 Standing Context 文档注入）；分类
// prompt（收件箱/发件箱 .md）v1.3.0 dogfood 起在抽屉内可直接编辑（mailApi.prompts
// read/write：桌面走 prompts IPC、远程 web 走 GET/PUT /api/prompts/{slot}；文件仍是
// SSoT，PromptLoader mtime 热加载 —— 保存即生效无需重启）。

/** 模型下拉「跟随全局默认」哨兵（radix SelectItem 禁空串 value）。 */
const FOLLOW_GLOBAL_MODEL = '__follow_global__'
/** fallback 下拉「跟随全局」哨兵（R2 #2：行级列 NULL；同上 radix 禁空串 value）。 */
const FALLBACK_FOLLOW_GLOBAL = '__follow_global_fb__'
/** fallback 下拉「不设」哨兵（行级列 '[]'；同上，空串 value 会让 radix 直接 throw）。 */
const FALLBACK_NONE = '__none__'

/** 分类 prompt 每 slot 的编辑草稿（content 可编辑；path 用于次要信息展示）。 */
interface PromptDraft {
  content: string
  path: string
  dirty: boolean
}
type PromptDrafts = Record<'inbox' | 'sent', PromptDraft>

export function PreprocessConfigDrawer({
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
  // 分类 prompt 读写走 mailApi.prompts（桌面 IPC / web PUT /api/prompts/{slot}）。
  const api = useMailApi()
  const markRestartRequired = useRestartStore((s) => s.markRestartRequired)
  // R5 — 跳 LLM 处理统计仪表盘（预处理执行情况看 per-email llm_processing 聚合，不走
  // custom agent run 历史）。切路由会卸载 agents tab，无需先播退场动画。
  const navigate = useNavigate()

  // 启用 = env 值本地镜像（**dirty 追踪**：仅用户显式改过的字段在保存时写回 env →
  // 未触碰的字段永不写，即使预填时 env 未就绪 idle 也不会把真实 .env 覆写掉，codex HIGH）；
  // 模型 / fallback / 文档勾选 = row 值（#8-ext 模型空串 = 跟随全局 LLM_MODEL；R2 #2
  // fallback 存哨兵或模型 id，对应行级列 NULL / '[]' / '[m]'，PATCH 保存无需重启）。
  const [enabled, setEnabled] = useState(false)
  const [enabledDirty, setEnabledDirty] = useState(false)
  const [model, setModel] = useState<string>('')
  const [modelDirty, setModelDirty] = useState(false)
  const [fallbackModel, setFallbackModel] = useState<string>(FALLBACK_FOLLOW_GLOBAL)
  const [fallbackModelDirty, setFallbackModelDirty] = useState(false)
  const [contextDocs, setContextDocs] = useState<string[]>([])
  const [envSaving, setEnvSaving] = useState(false)
  // 分类 prompt 编辑草稿（收件箱/发件箱 tab，textarea 可编辑，保存写回 .md 文件）——
  // 打开抽屉时经 mailApi.prompts.read 拉两份。
  const [promptDrafts, setPromptDrafts] = useState<PromptDrafts | 'loading' | 'error'>('loading')
  const [saveFailed, setSaveFailed] = useState(false)
  const [promptTab, setPromptTab] = useState<'inbox' | 'sent'>('inbox')
  const { models: enabledModels } = useEnabledModels()
  // env store 状态（idle/loading 时 enable 不可编辑、保存不写 env）+ 响应式 env 值
  // （就绪后回填，仅在用户未触碰该字段时）。envModelRaw / envFallbackRaw 仅用于
  // 「跟随全局」选项的当前值展示（R2 #2：fallback 已改行级列，env 值不再回填进编辑态）。
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

  // 打开时预填 row 字段 + 复位所有 dirty。同 ConfigDrawer / SearchConfigDrawer 既有豁免理由：
  // 模态打开按 cfg 预填多字段表单，React Compiler 迁移债（真重构需父组件 key 重置 remount +
  // 预填搬 useState initializer，等价性风险高于收益），effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !cfg) return
    setSaveFailed(false)
    setModel(cfg.model ?? '')
    // R2 #2 行级 fallback：null → 跟随全局哨兵、[] → 不设哨兵、[m,...] → 首个 m
    // （UI 单选，保存也只存单模型链 [m]）。
    setFallbackModel(
      cfg.fallback_models == null
        ? FALLBACK_FOLLOW_GLOBAL
        : cfg.fallback_models.length === 0
          ? FALLBACK_NONE
          : cfg.fallback_models[0]
    )
    setContextDocs(cfg.context_docs ?? [])
    setEnabledDirty(false)
    setModelDirty(false)
    setFallbackModelDirty(false)
    setPromptTab('inbox')
  }, [open, cfg])
  // 启用从 env 就绪快照回填：仅在打开且用户未 dirty 该字段时同步 —— env idle→ready 的
  // 迟到加载能纠正显示，但绝不覆盖用户在抽屉里的编辑（dirty 后停止同步）。
  useEffect(() => {
    if (!open) return
    if (envEnabledRaw !== null && !enabledDirty) setEnabled(envFlagOn(envEnabledRaw))
  }, [open, envEnabledRaw, enabledDirty])
  // 分类 prompt：打开时经 mailApi.prompts.read 拉两份（best-effort，失败显示占位；
  // 关闭时丢弃避免 setState-after-close）。与运行时 PromptLoader 同两份文件（mtime 热加载）。
  useEffect(() => {
    if (!open) return
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
  }, [open, api.prompts])
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
    // 1) env 写：仅在 env 已就绪、非 web、且用户显式改过该字段（dirty）时写 —— 未触碰的
    //    enable 永不写，即使预填 stale（env idle）也不会把真实 .env 覆写掉（codex HIGH）。
    //    只写变更键，避免无谓触发重启横幅。（#8-ext 模型 / R2 #2 fallback 均不再写 env ——
    //    走 row PATCH。）
    if (envReady && !IS_WEB) {
      const st = useEnvStore.getState().state
      const vals = st.status === 'ready' ? st.snapshot.values : {}
      const envPatch: Record<string, string> = {}
      const nextEnabled = enabled ? 'true' : 'false'
      if (enabledDirty && nextEnabled !== (vals['LLM_AGENT_ENABLED'] ?? '')) {
        envPatch['LLM_AGENT_ENABLED'] = nextEnabled
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
          // 与 EnvField 一致：变更键挂重启横幅（LLM_AGENT_ENABLED 是 pydantic singleton）。
          if (r.changedKeys.length > 0) markRestartRequired(r.changedKeys)
        } finally {
          setEnvSaving(false)
        }
      }
    }
    // 2) 分类 prompt 写：仅 dirty 的 slot 写回 .md 文件（桌面走 prompts IPC、web 走
    //    PUT /api/prompts/{slot}）。PromptLoader 按 mtime 热加载 —— 保存即生效无需重启。
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
    // 3) row 保存：模型（#8-ext 行级 model 列；空串 = 跟随全局 LLM_MODEL，config_patch_to_db
    //    原样落列、resolve_agent 非 report 不回填默认）+ fallback（R2 #2 行级列；null =
    //    重置回跟随全局、[] = 显式不设、[m] = 单模型链）+ 文档勾选。改行级值立即生效
    //    （分类每封邮件重读 preprocess 行），无需重启。
    try {
      await save(PREPROCESS_AGENT_ID, {
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
        context_docs: contextDocs
      })
      onClose()
    } catch (e: unknown) {
      toastError(t('agents.preprocess.rowSaveError'), errorMessage(e))
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
            <ReportIcon name="zap" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {t('agents.preprocess.configTitle', { title: cfg?.title ?? '' })}
          </h2>
          {/* R5 — 「查看处理统计」→ 跳 LLM 仪表盘（预处理执行情况 = per-email 分类聚合）。 */}
          <button
            type="button"
            onClick={() => void navigate({ to: '/admin/llm' })}
            className="flex items-center"
            style={{
              gap: 5,
              fontFamily: 'inherit',
              fontSize: 12,
              padding: '5px 10px',
              borderRadius: 7,
              cursor: 'pointer',
              color: 'rgb(var(--ink-fg-2))',
              background: 'rgb(var(--ink-fg) / 0.05)',
              border: '1px solid rgb(var(--ink-border-soft))'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'rgb(var(--c-accent))')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgb(var(--ink-fg-2))')}
          >
            <ReportIcon name="barchart" size={13} />
            {t('agents.preprocess.viewStats')}
          </button>
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
            {/* 远程 web 只读提示（env 写不可用；persona / 文档仍可改） */}
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
                {t('agents.preprocess.webReadOnly')}
              </div>
            )}

            {/* 启用（env LLM_AGENT_ENABLED）—— 需重启生效 */}
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
                  {t('agents.preprocess.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.preprocess.enableHint')}
                </div>
              </div>
              <span
                style={!envReady || IS_WEB ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
              >
                <Switch
                  on={enabled}
                  onChange={(v) => {
                    setEnabled(v)
                    setEnabledDirty(true)
                  }}
                />
              </span>
            </div>

            {/* 模型（row.model，PATCH 保存立即生效）—— #8-ext：与 chat 的全局默认（LLM_MODEL）
                拆分；「跟随全局」哨兵 = 行级空串。enabledModels + orphan 兜底同 ConfigDrawer。 */}
            <Field label={t('agents.config.model')} hint={t('agents.preprocess.modelHint')}>
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
                    {t('agents.preprocess.modelFollowGlobal', {
                      model: envModelRaw || 'claude-sonnet-4-6'
                    })}
                  </SelectItem>
                  {(model && !enabledModels.includes(model)
                    ? [...enabledModels, model]
                    : enabledModels
                  ).map((id) => {
                    const isOrphan = !enabledModels.includes(id)
                    return (
                      <SelectItem key={id} value={id}>
                        {id}
                        {isOrphan && (
                          <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
                            {t('settings.ai.enabledModels.notEnabled', {
                              defaultValue: '（未启用）'
                            })}
                          </span>
                        )}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </Field>

            {/* fallback 模型（row.fallback_models_json，R2 #2 行级，PATCH 保存立即生效）——
                主模型失败时兜底。「跟随全局」哨兵 = 行 NULL（用全局 LLM_FALLBACK_MODELS）、
                「不设」哨兵 = 行 '[]'（显式无兜底）。 */}
            <Field
              label={t('agents.preprocess.fallback')}
              hint={t('agents.preprocess.fallbackHint')}
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
                    {t('agents.preprocess.fallbackFollowGlobal', {
                      model: envFallbackRaw || t('agents.preprocess.fallbackGlobalUnset')
                    })}
                  </SelectItem>
                  <SelectItem value={FALLBACK_NONE}>
                    {t('agents.preprocess.fallbackNone')}
                  </SelectItem>
                  {(fallbackModel !== FALLBACK_FOLLOW_GLOBAL &&
                  fallbackModel !== FALLBACK_NONE &&
                  !enabledModels.includes(fallbackModel)
                    ? [...enabledModels, fallbackModel]
                    : enabledModels
                  ).map((id) => {
                    const isOrphan = !enabledModels.includes(id)
                    return (
                      <SelectItem key={id} value={id}>
                        {id}
                        {isOrphan && (
                          <span style={{ color: 'rgb(var(--ink-fg-3))', marginLeft: 6 }}>
                            {t('settings.ai.enabledModels.notEnabled', {
                              defaultValue: '（未启用）'
                            })}
                          </span>
                        )}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </Field>

            {/* 分类 prompt 编辑（v1.3.0 dogfood：只读 → 可编辑）—— 收件箱/发件箱 .md 与
                运行时同源（PromptLoader mtime 热加载同两份文件），保存即生效无需重启。
                persona 输入已移除：身份/偏好由上方勾选的 Standing Context 文档注入。 */}
            <Field
              label={t('agents.preprocess.promptView')}
              hint={t('agents.preprocess.promptViewHint')}
            >
              <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
                {(['inbox', 'sent'] as const).map((tab) => {
                  const on = promptTab === tab
                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPromptTab(tab)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 8,
                        fontFamily: 'inherit',
                        fontSize: 12.5,
                        cursor: 'pointer',
                        color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                        background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                        border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                        transition:
                          'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
                      }}
                    >
                      {t(`agents.preprocess.promptTab.${tab}`)}
                    </button>
                  )
                })}
              </div>
              {promptDrafts === 'loading' ? (
                <div style={{ ...inputStyle, color: 'rgb(var(--ink-fg-3))' }}>…</div>
              ) : promptDrafts === 'error' ? (
                <div style={{ ...inputStyle, color: 'rgb(var(--ink-fg-3))' }}>
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
                      ...inputStyle,
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

            {/* 文档勾选（cfg.context_docs）—— 注入分类 system prompt 的身份文档 */}
            <Field
              label={t('agents.preprocess.contextDocs')}
              hint={t('agents.preprocess.contextDocsHint')}
            >
              <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                {PREPROCESS_DOCS.map((doc) => {
                  const on = contextDocs.includes(doc)
                  return (
                    <button
                      key={doc}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setContextDocs((prev) =>
                          prev.includes(doc) ? prev.filter((x) => x !== doc) : [...prev, doc]
                        )
                      }
                      style={{
                        padding: '6px 12px',
                        borderRadius: 8,
                        fontFamily: 'inherit',
                        fontSize: 13,
                        cursor: 'pointer',
                        color: on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-fg-2))',
                        background: on ? 'rgb(var(--c-accent) / 0.14)' : 'rgb(var(--ink-1) / 0.5)',
                        border: `1px solid ${on ? 'rgb(var(--c-accent))' : 'rgb(var(--ink-border))'}`,
                        transition:
                          'color 120ms cubic-bezier(0.4,0,0.2,1), background-color 120ms cubic-bezier(0.4,0,0.2,1), border-color 120ms cubic-bezier(0.4,0,0.2,1)'
                      }}
                    >
                      {t(`agents.preprocess.doc.${doc}`)}
                    </button>
                  )
                })}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'rgb(var(--ink-fg-3))',
                  marginTop: 7,
                  lineHeight: 1.5
                }}
              >
                {t('agents.preprocess.contextDocsNote')}
              </div>
            </Field>

            {/* 身份文档正文编辑：内联复用 Settings 的 StandingDocsSection（自渲染标题 + 自 flag 门控，
                flag-off / 未加载时返回 null，不留空占位）。 */}
            <StandingDocsSection />
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
