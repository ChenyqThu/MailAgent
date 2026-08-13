// 0813 主 Agent 配置卡（Agents 页顶部）：默认助手的名字 + 头像终于有了配置面。
// 持久层 = owner_settings `assistant_identity`（GET/PUT /api/agent/assistant-identity），
// 消费点 = TurnPresence（「{{name}} 思考中…」+ 回合头像）/ AiChatPanel 标题 / 面板头像。
// 系统提示词（SOUL/AGENT/RULES/USER 身份文档）已有专属编辑器（设置 → AI → 身份文档），
// 这里只挂一行指路文案 —— 同一份数据只有一个可写面（/connectors 收敛的同款纪律）。
//
// 头像编辑复用 AgentAvatarEditor：value 恒非 null（未配置时喂官方形象 sphere/orange，
// 让预览/网格高亮与 chat 实际渲染一致）；编辑器「重置」回调 null → PUT null →
// 服务端 canonical 仍是 null → 本卡再次喂官方形象（重置 = 回官方脸，语义自洽）。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, AssistantIdentity } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { primeAssistantIdentity, useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { AgentAvatar } from './AgentAvatar'
import { AgentAvatarEditor } from './AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from './agentAvatarIdentity'
import { useAvatarHoverShowcase } from './useAvatarHoverShowcase'

/** 编辑器的派生/换一换种子（主 agent 不走 id 派生外观，种子只喂 shuffle 递进）。 */
const MAIN_ASSISTANT_SEED = 'main-assistant'

export function MainAssistantCard(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const identity = useAssistantIdentity()
  const [editing, setEditing] = useState(false)
  // 名字草稿：null = 未在编辑（显示服务端值）。blur/Enter 提交。
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const showcase = useAvatarHoverShowcase()

  const avatarValue: AgentAvatarConfig = identity.avatar ?? OFFICIAL_ASSISTANT_AVATAR
  const displayName = identity.name ?? t('chat.title')

  const save = (next: AssistantIdentity): void => {
    api.chat
      .setAssistantIdentity(next)
      .then((canonical) => primeAssistantIdentity(canonical))
      .catch((err: unknown) => {
        // 显示型配置：失败不弹层，保持服务端旧值（草稿已清，输入框回读旧值即自解释）
        console.error('[main-assistant] save identity failed', err)
      })
  }

  const commitName = (): void => {
    if (nameDraft === null) return
    const trimmed = nameDraft.trim()
    setNameDraft(null)
    const nextName = trimmed ? trimmed.slice(0, 40) : null
    if (nextName === identity.name) return
    save({ name: nextName, avatar: identity.avatar })
  }

  const onAvatarChange = (value: AgentAvatarConfig | null): void => {
    save({ name: identity.name, avatar: value })
  }

  return (
    <div
      {...showcase.hoverProps}
      style={{
        borderRadius: 14,
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))',
        overflow: 'hidden'
      }}
    >
      <div className="flex items-center" style={{ gap: 13, padding: '18px 20px 16px' }}>
        <AgentAvatar
          agentId={MAIN_ASSISTANT_SEED}
          config={avatarValue}
          size={42}
          title={displayName}
          state={showcase.state}
          animated={showcase.animated}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: 9 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: 'rgb(var(--ink-fg))' }}>
              {displayName}
            </h3>
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 5,
                color: 'rgb(var(--c-accent))',
                background: 'rgb(var(--c-accent) / 0.1)',
                border: '1px solid rgb(var(--c-accent) / 0.25)'
              }}
            >
              {t('agents.mainAgent.badge')}
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11.5, color: 'rgb(var(--ink-fg-2))' }}>
            {t('agents.mainAgent.hint')}
          </div>
        </div>
        <button
          type="button"
          aria-expanded={editing}
          data-testid="main-assistant-configure"
          onClick={() => setEditing((prev) => !prev)}
          className="h-8 shrink-0 rounded-[var(--r-ctl)] border border-ink-border px-3 text-meta font-medium text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg-1 motion-reduce:transition-none"
        >
          {editing ? t('agents.mainAgent.collapse') : t('agents.mainAgent.configure')}
        </button>
      </div>

      {editing && (
        <div className="flex flex-col gap-3" style={{ padding: '0 20px 18px' }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-micro font-medium uppercase tracking-wider text-ink-fg-3">
              {t('agents.mainAgent.nameLabel')}
            </span>
            <input
              type="text"
              data-testid="main-assistant-name"
              value={nameDraft ?? identity.name ?? ''}
              placeholder={t('agents.mainAgent.namePlaceholder')}
              maxLength={40}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className="h-8 rounded-[var(--r-ctl)] border border-ink-border bg-ink-1/60 px-2.5 text-aux text-ink-fg-1 outline-none focus:border-coral/60"
            />
          </label>
          <AgentAvatarEditor
            agentId={MAIN_ASSISTANT_SEED}
            value={avatarValue}
            onChange={onAvatarChange}
          />
          <div className="text-meta text-ink-fg-3">{t('agents.mainAgent.docsHint')}</div>
        </div>
      )}
    </div>
  )
}
