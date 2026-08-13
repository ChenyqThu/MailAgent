// 0813 主 Agent 配置卡（Agents 页顶部）：默认助手的名字 + 头像。
// 持久层 = owner_settings `assistant_identity`（GET/PUT /api/agent/assistant-identity），
// 消费点 = TurnPresence（「{{name}} 思考中…」+ 回合头像）/ AiChatPanel 标题 / 面板头像。
//
// 0813 dogfood：本卡是**纯展示**——点整卡开 MainAssistantDrawer（与其余五张 agent 卡同一个
// 交互范式：卡根 role=button + onClick，不再有独立「配置」按钮、不再卡内内嵌展开）。
// 名字 / 头像 / 系统提示词（SOUL/AGENT/RULES/USER 身份文档）三样都在那个抽屉里编辑。

import { useTranslation } from 'react-i18next'

import { useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { AgentAvatar } from './AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from './agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED } from './shared'
import { useAvatarHoverShowcase } from './useAvatarHoverShowcase'

export function MainAssistantCard({ onConfig }: { onConfig: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const identity = useAssistantIdentity()
  const showcase = useAvatarHoverShowcase()

  const displayName = identity.name ?? t('chat.title')

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="main-assistant-card"
      aria-label={t('agents.mainAgent.configure')}
      onClick={onConfig}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfig()
        }
      }}
      className="flex items-center"
      {...showcase.hoverProps}
      style={{
        gap: 13,
        padding: '18px 20px',
        borderRadius: 14,
        cursor: 'pointer',
        textAlign: 'left',
        background: 'rgb(var(--ink-2) / 0.55)',
        border: '1px solid rgb(var(--ink-border))'
      }}
    >
      <AgentAvatar
        agentId={MAIN_ASSISTANT_SEED}
        config={identity.avatar ?? OFFICIAL_ASSISTANT_AVATAR}
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
    </div>
  )
}
