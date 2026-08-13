// 0813 dogfood — 主 Agent 配置抽屉。
//
// 收的是 owner 的三条反馈：①「不要单独配置按钮了，点击就直接弹出抽屉，要和其他 agent 配置
// 交互一致」→ 本抽屉复刻既有五抽屉的三段式脚手架（header / scrollbar-thin body / footer），
// 卡片降级为纯展示 + 整卡点击开抽屉；②「默认助手名字为什么不显示在配置上」→ 名字草稿
// 回显**当前生效名**（未配置时 = t('chat.title')，即 chat 里真正显示的那个），不再是空输入框
// + 一句 placeholder；③「提示词相关的注入可以也显示在侧边抽屉配置中，可以复用 settings 里的
// 配置」→ 内联 <StandingDocsSection />（PreprocessConfigDrawer 已有先例）。
//
// 🔴 身份文档「单一可写面」纪律：这里内联的就是 设置 → AI → Custom AI 里那个 **同一个组件**
// （零 props、自渲染标题、自 flag 门控、同一 react-query key），不是复制一份编辑 UI ——
// 两个入口写的是同一份数据，不存在各改各的。
//
// 保存语义（与卡片即时保存的旧行为的差异是有意的，抽屉范式 = 草稿 + footer 显式保存）：
//   - 名字回显了默认名但 **未编辑不落库**（nameDirty=false → 仍写 identity.name，可能是 null）
//     —— 抄 SearchConfigDrawer 的 promptDirty 纪律：回显默认 ≠ 把默认快照写死进库，
//     否则以后换语言/换默认名，这行就被钉在旧字面量上了。
//   - 头像 value 恒非 null（喂官方形象），draft=null 表示「回落官方形象」，与服务端 canonical
//     的 null 语义一一对应 —— 点「重置」后预览显示的就是保存后实际会渲染的那只。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig, AssistantIdentity } from '@shared/api/types'
import { Drawer } from '@shared/components/ui/drawer'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { useMailApi } from '@shared/hooks/useMailApi'
import { primeAssistantIdentity, useAssistantIdentity } from '@shared/assistant/assistantIdentity'
// 内联复用 Settings 的身份文档编辑器（同组件、同数据源，见文件头「单一可写面」纪律）。
import { StandingDocsSection } from '@shared/components/settings/CustomAiSection'
import { ReportIcon } from '../primitives'
import { AgentIdentityHeader } from '../AgentAvatar'
import { OFFICIAL_ASSISTANT_AVATAR } from '../agentAvatarIdentity'
import { MAIN_ASSISTANT_SEED } from '../shared'
import { Field } from './Field'

/** 名字上限（后端同款截断，PUT 前本地先切） */
const NAME_MAX = 40

export function MainAssistantDrawer({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const identity = useAssistantIdentity()

  // 当前生效名 —— 未配置时就是 chat 里真正显示的那个（不是空串）。
  const effectiveName = identity.name ?? t('chat.title')

  const [name, setName] = useState(effectiveName)
  const [nameDirty, setNameDirty] = useState(false)
  const [avatar, setAvatar] = useState<AgentAvatarConfig | null>(identity.avatar)
  const [avatarDirty, setAvatarDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  // 按服务端身份预填（镜像其余抽屉的 [open, cfg] effect；同款豁免理由：模态打开按服务端值
  // 预填多字段表单，真重构需父组件 key 重置 remount，等价性风险高于收益）。
  // 🔴 与那几个抽屉的唯一差异 = **已经动过的字段不覆盖**：assistantIdentity 是模块级 store，
  // 别处任何一个消费点挂载都可能触发一次复取 → 换出新对象 → 无条件预填会在用户正打字时
  // 把草稿清回服务端值。草稿态在关闭时丢弃（下面第二个 effect），故下次打开必重新预填。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    if (!nameDirty) setName(identity.name ?? t('chat.title'))
    if (!avatarDirty) setAvatar(identity.avatar)
  }, [open, identity, t, nameDirty, avatarDirty])

  // 关闭即丢草稿（取消 = 不保存；保存成功也走这条，因为 onSave 会 onClose）。
  useEffect(() => {
    if (open) return
    setNameDirty(false)
    setAvatarDirty(false)
    setSaving(false)
    setSaveFailed(false)
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  const onSave = (): void => {
    const trimmed = name.trim()
    const next: AssistantIdentity = {
      // 未编辑过 → 保持服务端原值（可能是 null = 跟随默认名，不把默认字面量写死）。
      name: nameDirty ? (trimmed ? trimmed.slice(0, NAME_MAX) : null) : identity.name,
      avatar
    }
    setSaving(true)
    setSaveFailed(false)
    api.chat
      .setAssistantIdentity(next)
      .then((canonical) => {
        primeAssistantIdentity(canonical)
        onClose()
      })
      .catch((err: unknown) => {
        console.error('[main-assistant] save identity failed', err)
        setSaveFailed(true)
      })
      .finally(() => setSaving(false))
  }

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
          <ReportIcon name="sparkles" size={16} />
        </span>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'rgb(var(--ink-fg))', flex: 1 }}>
          {t('agents.mainAgent.configTitle', { name: effectiveName })}
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
          {/* 名称 + 头像：与其余五抽屉同一个 AgentIdentityHeader（48px 头像 + 「更换」折叠编辑器）。 */}
          <Field
            label={t('agents.avatar.identityLabel')}
            hint={t('agents.mainAgent.identityHint')}
          >
            <AgentIdentityHeader
              agentId={MAIN_ASSISTANT_SEED}
              // 恒非 null：喂官方形象让预览/网格高亮与 chat 实际渲染一致；draft null = 回落官方形象。
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
              inputStyle={inputStyle}
            />
          </Field>

          {/* 提示词注入（owner：「提示词相关的注入可以也显示在侧边抽屉配置中，可以复用 settings
              里的配置」）——内联 Settings 那个 StandingDocsSection 本体（自渲染标题 + 自 flag
              门控，flag-off / 未加载返回 null 不留空占位）。 */}
          <div style={{ fontSize: 11.5, color: 'rgb(var(--ink-fg-3))', lineHeight: 1.5 }}>
            {t('agents.mainAgent.docsHint')}
          </div>
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
          onClick={onSave}
          disabled={saving}
          state={saving ? 'loading' : saveFailed ? 'error' : 'idle'}
        >
          {t('agents.config.save')}
        </StatefulButton>
      </footer>
    </Drawer>
  )
}
