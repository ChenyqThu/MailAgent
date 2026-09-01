// P4a agent-config lane — 搜索 Agent 配置页（编辑既有行）。保存 / 删除语义：prompt 默认态
// 回传 / 头像未触碰不发 / 两步确认删。
// ⚠️ 本页没有「新建搜索 Agent」—— 旧卡片网格时期的创建态
// （`setSearchDrawer({ mode: 'create' })`）在退役前的 AgentsTab 里就已经零调用点，
// 用 `git show HEAD:frontend/src/shared/components/agents/AgentsTab.tsx` 可复核；
// 不是本批弄丢的。删掉播种那行之后没有回头路这件事是**预存缺口**，要补得先决定新建入口放哪。
// 唯一一个内置里能删的成员 —— 能力区是真实的多选工具，不渲染「写死」一句话。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, ReportAgentConfig, ReportConfigPatch } from '@shared/api/types'
import { DEFAULT_SEARCH_AGENT_PROMPT } from '@shared/assistant/searchAgentClient'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@shared/components/ui/select'
import { useEnabledModels } from '@shared/hooks/useLlmModels'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { ReportIcon } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { useDeleteAgent, useSetConfig } from '../hooks'
import { pressHandlers } from '../shared'
import { Field } from '../drawers/Field'
import { ModelSelectItems } from '../drawers/ModelSelectItems'
import { SettingsScaffold } from './sections'
import { ChoiceChip, ModelGroup } from './controls'
import { INPUT_STYLE } from './inputStyle'

const SEARCH_TOOLS = ['email_search_fulltext'] as const

export function SearchAgentSettings({ cfg }: { cfg: ReportAgentConfig }): React.ReactElement {
  const { t } = useTranslation()
  const { save, isSaving } = useSetConfig()
  const { remove, isDeleting } = useDeleteAgent()
  const { models: enabledModels } = useEnabledModels()

  const [enabled, setEnabled] = useState(cfg.enabled)
  const [title, setTitle] = useState(cfg.title)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(cfg.avatar ?? null)
  const [avatarDirty, setAvatarDirty] = useState(false)
  // prompt_is_default 的行后端返回空串 → 回显内置默认供查看/覆写；已自定义则回显自定义。
  const [prompt, setPrompt] = useState(
    cfg.prompt_is_default ? DEFAULT_SEARCH_AGENT_PROMPT : cfg.prompt
  )
  const [promptDirty, setPromptDirty] = useState(false)
  const [model, setModel] = useState<string>(cfg.model || '')
  const [tools, setTools] = useState<string[]>(
    cfg.tools_json?.length ? cfg.tools_json : [...SEARCH_TOOLS]
  )
  const [errKey, setErrKey] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [saveDone, setSaveDone] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const busy = isSaving || isDeleting
  const saveState: StatefulButtonState = busy
    ? 'loading'
    : saveFailed
      ? 'error'
      : saveDone
        ? 'success'
        : 'idle'

  const onSave = (): void => {
    setErrKey(null)
    setSaveFailed(false)
    const patch: ReportConfigPatch = {
      enabled,
      title: title.trim() || cfg.title,
      // prompt 未改且仍是默认态 → null 保持「用默认」；改过 → 文本。
      prompt: promptDirty ? prompt : cfg.prompt_is_default ? null : cfg.prompt,
      model,
      tools
    }
    if (avatarDirty) patch.avatar = avatar
    void save(cfg.id, patch)
      .then(() => {
        setSaveDone(true)
        window.setTimeout(() => setSaveDone(false), 1600)
      })
      .catch((e: unknown) => {
        console.warn('search agent save failed', e)
        setErrKey('errGeneric')
        setSaveFailed(true)
      })
  }

  const onDelete = (): void => {
    setErrKey(null)
    void remove(cfg.id).catch((e: unknown) => {
      console.warn('search agent delete failed', e)
      setErrKey('errGeneric')
    })
  }

  return (
    <SettingsScaffold
      title={title || cfg.title}
      subtitle={t('agentSettings.role.builtin')}
      enable={{ on: enabled, onChange: setEnabled }}
      save={{ state: saveState, onSave, disabled: busy }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.identityLabel')} hint={t('agents.avatar.hint')}>
            <AgentIdentityHeader
              agentId={cfg.id}
              value={avatar}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={title}
              onNameChange={setTitle}
              namePlaceholder={t('agents.search.titlePlaceholder')}
              inputStyle={INPUT_STYLE}
            />
          </Field>
        ),
        instructions: (
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
                ...INPUT_STYLE,
                resize: 'vertical',
                lineHeight: 1.6,
                fontSize: 13,
                minHeight: 160
              }}
            />
          </Field>
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
        capabilities: (
          <Field label={t('agents.search.tools')} hint={t('agents.search.toolsHint')}>
            <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
              {SEARCH_TOOLS.map((tool) => (
                <ChoiceChip
                  key={tool}
                  on={tools.includes(tool)}
                  onClick={() =>
                    setTools((prev) =>
                      prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]
                    )
                  }
                >
                  {t(`agents.search.tool.${tool}`)}
                </ChoiceChip>
              ))}
            </div>
          </Field>
        ),
        danger: (
          <>
            {confirming ? (
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
                  alignSelf: 'flex-start',
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
            )}
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
          </>
        )
      }}
    />
  )
}
