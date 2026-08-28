// Sprint 20 — /agents 搜索 agent 配置抽屉：机械抽自 AgentsTab.tsx（原样搬迁，零行为变化）。
// export 供 component tests 直接渲染（tests/components/AgentsSearchTab.test.tsx）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { DEFAULT_SEARCH_AGENT_PROMPT } from '@shared/assistant/searchAgentClient'
import { ReportIcon, Switch } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useCreateAgent, useDeleteAgent, useSetConfig } from '../hooks'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@shared/components/ui/select'
import { pressHandlers } from '../shared'
import { ModelSelectItems } from './ModelSelectItems'
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

  const [enabled, setEnabled] = useState(true)
  const [title, setTitle] = useState('')
  // 头像身份（0804 dogfood 3d）：avatarDirty 才写 patch（未触碰的 NULL 行保持 NULL → 继续
  // 按 id 派生）。createAgent 不收 avatar 列，故新建路径在建行成功后补一次 setConfig。
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  // 新建两段式的第一段成果：建行成功即记 id —— 第二段（头像 patch）失败后原地重试直接走
  // setConfig，不再重复 createAgent（同 id 撞 409）。镜像 CustomAgentDrawer.createdId。
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const { models: enabledModels } = useEnabledModels()
  const [model, setModel] = useState<string>('')
  // 选中的工具集合（MVP 只有 email_search_fulltext）。
  const [tools, setTools] = useState<string[]>([...SEARCH_TOOLS])
  const [errKey, setErrKey] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // 打开时按 cfg（编辑）/ 空态（新建）预填。依赖 [open, cfg, create]。同 ConfigDrawer 既有
  // 豁免理由：模态打开按 cfg/空态预填多字段表单，React Compiler 迁移债（真重构需父组件 key
  // 重置 remount + 预填搬 useState initializer，等价性风险高于收益），effect 合理保留。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setErrKey(null)
    setSaveFailed(false)
    setConfirming(false)
    setAvatarDirty(false)
    setCreatedId(null)
    if (create || !cfg) {
      setEnabled(true)
      setTitle('')
      setAvatar(null)
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
    setAvatar(cfg.avatar ?? null)
    // prompt_is_default 的行后端返回空串 → 回显内置默认供查看/覆写；已自定义则回显自定义。
    setPrompt(cfg.prompt_is_default ? DEFAULT_SEARCH_AGENT_PROMPT : cfg.prompt)
    setPromptDirty(false)
    setModel(cfg.model || '')
    setTools(cfg.tools_json?.length ? cfg.tools_json : [...SEARCH_TOOLS])
  }, [open, cfg, create])
  /* eslint-enable react-hooks/set-state-in-effect */

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
    setSaveFailed(false)
    if (create) {
      const id = createdId ?? slugifyTitle(title)
      // 两段式的第一段失败与否 —— 只有它能产生「id 已存在」；第二段是 PATCH 既有行，
      // 同一个 E_INVALID_ARG 是别的校验失败（如头像值域），不能复用冲突文案叫人改名。
      let createFailed = false
      // createAgent 的入参没有 avatar 列 —— 用户在新建时挑了头像就补一次 setConfig
      // （未挑则一次请求都不多发，路径与改动前逐字节相同）。
      const ensureCreated: Promise<unknown> =
        createdId !== null
          ? Promise.resolve()
          : createAgent({
              id,
              type: 'search',
              title: title.trim() || id,
              enabled,
              model: model || null,
              // prompt 已回显内置默认；未改（promptDirty=false）→ null 走默认不写死快照，改过 → 存文本。
              prompt: promptDirty ? prompt : null,
              tools
            }).then(
              () => setCreatedId(id),
              (e: unknown) => {
                createFailed = true
                throw e
              }
            )
      void ensureCreated
        .then(() =>
          avatarDirty
            ? // 第二段带**全字段**（镜像 CustomAgentDrawer 的两段式）：首次成功路径是同值幂等
              // 覆写；重试路径（第一段成功、第二段失败后原地重试）则把重试间隙用户改过的
              // 名称/模型/prompt/工具一并落库 —— 只发 { avatar } 会把这些改动静默丢掉，
              // 因为 createAgent 不会再跑第二次。id 仍用首次落库的（不因改名重新 slugify）。
              save(id, {
                enabled,
                title: title.trim() || id,
                prompt: promptDirty ? prompt : null,
                model,
                tools,
                avatar
              })
            : undefined
        )
        .then(onClose)
        .catch((e: unknown) => {
          // 真实 Electron 路径错误码挂在 err.code（message 是人话不含码串）。
          const code = (e as { code?: string })?.code
          setErrKey(createFailed && code === 'E_INVALID_ARG' ? 'errConflict' : 'errGeneric')
          setSaveFailed(true)
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
    // 头像：未触碰不发（PATCH 缺席 = 不动列）。
    if (avatarDirty) patch.avatar = avatar
    void save(cfg.id, patch)
      .then(onClose)
      .catch((e: unknown) => {
        console.warn('search agent save failed', e)
        setErrKey('errGeneric')
        setSaveFailed(true)
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

          {/* 名称 + 头像并排（0804 dogfood 3d/3e）；头像编辑器默认折叠在「更换」后面。 */}
          <Field label={t('agents.avatar.identityLabel')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={cfg?.id ?? slugifyTitle(title)}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={title}
              onNameChange={setTitle}
              namePlaceholder={t('agents.search.titlePlaceholder')}
              inputStyle={inputStyle}
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
                <ModelSelectItems models={enabledModels} current={model || null} />
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
        {/* 删除：仅编辑既有时显示；两步确认（同 ReportsPage/SessionsPage 风格）。 */}
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
        <StatefulButton
          type="button"
          onClick={onSave}
          disabled={busy}
          state={busy ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {create ? t('agents.search.create') : t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
