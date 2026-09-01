// P4a agent-config lane — 主 Agent 配置页。
//
// 🔴 主 Agent 不是 report_agent 的一行：身份走 chat.setAssistantIdentity（agent_config.db
// profile），身份文档走 StandingDocsSection（同一份数据、单一可写面）。**绝不**把它塞进
// PUT /api/report-agents 的 patch 通道（r8 §B.1 的唯一例外）。
//
// 保存语义：名字回显当前生效名但未编辑不落库（nameDirty=false → 仍写 identity.name，
// 可能是 null = 跟随默认名，不把默认字面量写死进库）。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, AssistantIdentity } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { primeAssistantIdentity, useAssistantIdentity } from '@shared/assistant/assistantIdentity'
import { StandingDocsSection } from '@shared/components/settings/CustomAiSection'
import type { StatefulButtonState } from '@shared/components/ui/stateful-button'

import { AgentIdentityHeader } from '../AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED } from '../shared'
import { Field } from '../drawers/Field'
import { ReadonlyCard, SettingsScaffold } from './sections'

/** 名字上限（后端同款截断，PUT 前本地先切）。 */
const NAME_MAX = 40

export function MainAssistantSettings(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const identity = useAssistantIdentity()

  const effectiveName = identity.name ?? t('chat.title')

  const [name, setName] = useState(effectiveName)
  const [nameDirty, setNameDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(identity.avatar)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [saveState, setSaveState] = useState<StatefulButtonState>('idle')

  // 服务端身份落定后回填 —— 仅未 dirty 的字段（assistantIdentity 是模块级 store，别处
  // 消费点挂载会触发复取换新对象，无条件回填会把正在编辑的草稿清掉）。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!nameDirty) setName(identity.name ?? t('chat.title'))
    if (!avatarDirty) setAvatar(identity.avatar)
  }, [identity, t, nameDirty, avatarDirty])
  /* eslint-enable react-hooks/set-state-in-effect */

  const onSave = (): void => {
    const trimmed = name.trim()
    const next: AssistantIdentity = {
      name: nameDirty ? (trimmed ? trimmed.slice(0, NAME_MAX) : null) : identity.name,
      avatar
    }
    setSaveState('loading')
    api.chat
      .setAssistantIdentity(next)
      .then((canonical) => {
        primeAssistantIdentity(canonical)
        setNameDirty(false)
        setAvatarDirty(false)
        setSaveState('success')
        window.setTimeout(() => setSaveState('idle'), 1600)
      })
      .catch((err: unknown) => {
        console.error('[main-assistant] save identity failed', err)
        setSaveState('error')
      })
  }

  return (
    <SettingsScaffold
      title={effectiveName}
      subtitle={t('agentSettings.main.role')}
      save={{ state: saveState, onSave }}
      sections={{
        identity: (
          <Field label={t('agents.avatar.identityLabel')} hint={t('agents.mainAgent.identityHint')}>
            <AgentIdentityHeader
              agentId={MAIN_ASSISTANT_SEED}
              // 恒非 null：喂官方形象让预览与 chat 实际渲染一致；draft null = 回落官方形象。
              value={avatar ?? OFFICIAL_ASSISTANT_AVATAR}
              onChange={(next) => {
                setAvatar(next)
                setAvatarDirty(true)
              }}
              name={name}
              onNameChange={(next) => {
                setName(next)
                setNameDirty(true)
              }}
              namePlaceholder={t('agents.mainAgent.namePlaceholder')}
            />
          </Field>
        ),
        instructions: (
          <>
            {/* r7 §二：与 设置 → AI → 身份文档 是同一份，改哪边都一样 —— 这条要写在面上。 */}
            <ReadonlyCard title={t('agentSettings.docs.injected')}>
              {t('agentSettings.docs.sameSource')}
            </ReadonlyCard>
            {/* 单一可写面纪律：内联的就是 设置 → AI 里那个同一个组件（同 react-query key）。 */}
            <StandingDocsSection />
          </>
        )
      }}
    />
  )
}
