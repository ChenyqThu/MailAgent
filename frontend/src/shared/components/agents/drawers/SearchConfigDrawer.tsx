// Sprint 20 — /agents 搜索 agent 配置抽屉：机械抽自 AgentsTab.tsx（原样搬迁，零行为变化）。
// export 供 component tests 直接渲染（tests/components/AgentsSearchTab.test.tsx）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { DEFAULT_SEARCH_AGENT_PROMPT } from '@shared/assistant/searchAgentClient'
import { ReportIcon, Switch } from '../primitives'
import { useCreateAgent, useDeleteAgent, useSetConfig } from '../hooks'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@shared/components/ui/select'
import { PRESS_SCALE, pressHandlers } from '../shared'
import { Field } from './Field'

// ─── Search Agent 配置抽屉 ───────────────────────────────────────────────────
// F4b — 复刻 ConfigDrawer 三段式脚手架，但字段精简为 search agent 所需：
// enabled / title / model / prompt / tools。编辑既有走 useSetConfig；新建（cfg=null
// + create=true）走 useCreateAgent；footer 删除走 useDeleteAgent（两步确认）。
// 不改 report 的 ConfigDrawer。
const SEARCH_TOOLS = ['email_search_fulltext'] as const

// title → 稳定 slug，用于新建 agent id。保留 CJK + 字母 + 数字（中文产品常见全中文标题），
// latin 转小写，其余分隔符折成 `_`。仅真正为空时才时间戳兜底。
function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
  return slug || `search_${Date.now().toString(36)}`
}

export function SearchConfigDrawer({
  cfg,
  open,
  create = false,
  onClose
}: {
  cfg: ReportAgentConfig | null
  open: boolean
  /** true = 新建空态（cfg 为 null）；false = 编辑既有 cfg。 */
  create?: boolean
  onClose: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { create: createAgent, isCreating } = useCreateAgent()
  const { remove, isDeleting } = useDeleteAgent()

  // 进/退场动效：与 ConfigDrawer 同款（遮罩淡入 + 抽屉右滑同步）。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: 'aside',
    from: { autoAlpha: 0, xPercent: 100 },
    syncBackdrop: true
  })

  const [enabled, setEnabled] = useState(true)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>('')
  // 选中的工具集合（MVP 只有 email_search_fulltext）。
  const [tools, setTools] = useState<string[]>([...SEARCH_TOOLS])
  const [errKey, setErrKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。依赖 [open, cfg, create]。同 ConfigDrawer 既有
  // 豁免理由：模态打开按 cfg/空态预填多字段表单，React Compiler 迁移债（真重构需父组件 key
  // 重置 remount + 预填搬 useState initializer，等价性风险高于收益），effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErrKey(null)
    setConfirming(false)
    if (create || !cfg) {
      setEnabled(true)
      setTitle('')
      // 回显内置默认搜索 prompt 供查看/覆写；promptDirty 仍 false → 未改时 onSave 存
      // null 走默认，不把默认快照写死进库（将来内置默认改了，此 agent 仍跟随）。
      setPrompt(DEFAULT_SEARCH_AGENT_PROMPT)
      setPromptDirty(false)
      setModel('')
      setTools([...SEARCH_TOOLS])
      return
    }
    setEnabled(cfg.enabled)
    setTitle(cfg.title)
    // prompt_is_default 的行后端返回空串 → 回显内置默认供查看/覆写；已自定义则回显自定义。
    setPrompt(cfg.prompt_is_default ? DEFAULT_SEARCH_AGENT_PROMPT : cfg.prompt)
    setPromptDirty(false)
    setModel(cfg.model || '')
    setTools(cfg.tools_json?.length ? cfg.tools_json : [...SEARCH_TOOLS])
  }, [open, cfg, create])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!shouldRender) return null

  const busy = isSaving || isCreating || isDeleting

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

  const toggleTool = (tool: string): void => {
    setTools((prev) => (prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]))
  }

  const onSave = (): void => {
    setErrKey(null)
    if (create) {
      const id = slugifyTitle(title)
      void createAgent({
        id,
        type: 'search',
        title: title.trim() || id,
        enabled,
        model: model || null,
        // prompt 已回显内置默认；未改（promptDirty=false）→ null 走默认不写死快照，改过 → 存文本。
        prompt: promptDirty ? prompt : null,
        tools
      })
        .then(onClose)
        .catch((e: unknown) => {
          // 真实 Electron 路径错误码挂在 err.code（message 是人话不含码串）。
          const code = (e as { code?: string })?.code
          setErrKey(code === 'E_INVALID_ARG' ? 'errConflict' : 'errGeneric')
        })
      return
    }
    if (!cfg) return
    const patch: ReportConfigPatch = {
      enabled,
      title: title.trim() || cfg.title,
      // prompt 未改且仍是默认态 → null 保持「用默认」；改过 → 文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      tools
    }
    void save(cfg.id, patch)
      .then(onClose)
      .catch((e: unknown) => {
        console.warn('search agent save failed', e)
        setErrKey('errGeneric')
      })
  }

  const onDelete = (): void => {
    if (!cfg) return
    setErrKey(null)
    void remove(cfg.id)
      .then(onClose)
      .catch((e: unknown) => {
        console.warn('search agent delete failed', e)
        setErrKey('errGeneric')
      })
  }

  return (
    <div
      ref={scopeRef}
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgb(0 0 0 / 0.4)' }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '92%',
          zIndex: 61,
          background: 'color-mix(in srgb, var(--glass-base) 94%, transparent)',
          borderLeft: '1px solid var(--hairline-strong)',
          boxShadow: 'var(--shadow-raised)',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
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
            <ReportIcon name="search" size={16} />
          </span>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
            {create ? t('agents.search.newTitle') : t('agents.search.configTitle', { title })}
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
            {/* enable */}
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
                  {t('agents.config.enable')}
                </div>
                <div style={{ fontSize: 12, color: 'rgb(var(--ink-fg-3))', marginTop: 2 }}>
                  {t('agents.search.sectionHint')}
                </div>
              </div>
              <Switch on={enabled} onChange={setEnabled} />
            </div>

            {/* title */}
            <Field label={t('agents.search.titleLabel')}>
              <input
                type="text"
                value={title}
                placeholder={t('agents.search.titlePlaceholder')}
                onChange={(e) => setTitle(e.target.value)}
                style={inputStyle}
              />
            </Field>

            {/* prompt */}
            <Field label={t('agents.search.promptLabel')} hint={t('agents.search.promptHint')}>
              <textarea
                value={prompt}
                placeholder={t('agents.search.promptPlaceholder')}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setPromptDirty(true)
                }}
                rows={9}
                className="scrollbar-thin"
                style={{
                  ...inputStyle,
                  resize: 'vertical',
                  lineHeight: 1.6,
                  fontSize: 13,
                  minHeight: 160
                }}
              />
            </Field>

            {/* model（抄 ConfigDrawer 的 enabledModels + orphan 兜底） */}
            <Field label={t('agents.config.model')}>
              <Select value={model || undefined} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder={t('agents.config.model')} />
                </SelectTrigger>
                <SelectContent className="z-[70]">
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

            {/* tools — MVP 只有 email_search_fulltext，多选 chip（存 patch.tools） */}
            <Field label={t('agents.search.tools')} hint={t('agents.search.toolsHint')}>
              <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
                {SEARCH_TOOLS.map((tool) => {
                  const on = tools.includes(tool)
                  return (
                    <button
                      key={tool}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleTool(tool)}
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
                      {t(`agents.search.tool.${tool}`)}
                    </button>
                  )
                })}
              </div>
            </Field>

            {errKey && (
              <div
                style={{
                  fontSize: 12.5,
                  color: 'rgb(var(--c-fail))',
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: 'rgb(var(--c-fail) / 0.10)',
                  border: '1px solid rgb(var(--c-fail) / 0.25)'
                }}
              >
                {t(`agents.search.${errKey}`)}
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
            flexShrink: 0
          }}
        >
          {/* 删除：仅编辑既有时显示；两步确认（同 ReportsTab/SessionsPage 风格）。 */}
          {!create &&
            cfg &&
            (confirming ? (
              <span className="flex items-center" style={{ gap: 6 }}>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={busy}
                  className="flex items-center"
                  style={{
                    gap: 6,
                    fontFamily: 'inherit',
                    fontSize: 13,
                    padding: '7px 12px',
                    borderRadius: 8,
                    cursor: busy ? 'wait' : 'pointer',
                    color: 'rgb(var(--c-fail))',
                    background: 'rgb(var(--c-fail) / 0.12)',
                    border: '1px solid rgb(var(--c-fail) / 0.3)',
                    transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
                  }}
                  {...pressHandlers()}
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
                style={{
                  gap: 6,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  padding: '8px 14px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: 'rgb(var(--c-fail))',
                  background: 'transparent',
                  border: '1px solid rgb(var(--c-fail) / 0.3)',
                  transition: 'transform 120ms cubic-bezier(0.4,0,0.2,1)'
                }}
                {...pressHandlers()}
              >
                <ReportIcon name="x" size={14} />
                {t('agents.search.delete')}
              </button>
            ))}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost"
            style={{ fontFamily: 'inherit' }}
          >
            {t('agents.config.cancel')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            style={{
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              padding: '8px 18px',
              borderRadius: 8,
              cursor: busy ? 'wait' : 'pointer',
              color: 'rgb(var(--c-cta-fg))',
              background: 'rgb(var(--c-cta-bg))',
              border: 0,
              transition:
                'background-color 120ms cubic-bezier(0.4,0,0.2,1), transform 120ms cubic-bezier(0.4,0,0.2,1)'
            }}
            onMouseEnter={(e) => {
              if (!busy) e.currentTarget.style.background = 'rgb(var(--c-cta-bg-hover))'
            }}
            onMouseDown={(e) => {
              if (!busy) e.currentTarget.style.transform = PRESS_SCALE
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'none'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgb(var(--c-cta-bg))'
              e.currentTarget.style.transform = 'none'
            }}
          >
            {create ? t('agents.search.create') : t('agents.config.save')}
          </button>
        </footer>
      </aside>
    </div>
  )
}
