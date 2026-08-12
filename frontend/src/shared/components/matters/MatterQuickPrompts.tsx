// 0812 —— 事项对话的快捷 prompt。
//
// 设计稿明说位置与全局面板的快捷动作**一致**（AgentThread 的 quickActions 槽），事项只是换掉那一组
// 内容 —— 不是删掉。autoSend 走 thread（绕过 composer form），因此与全局快捷动作遵守同一条
// sendDisabled 闸（审批 decide 持有 run lease 时不许发）。
//
// 单独成文件：useMatterConversation 是 hook 模块，混一个组件进去会破 react-refresh 的
// only-export-components。

import { useTranslation } from 'react-i18next'
import { ThreadPrimitive } from '@assistant-ui/react'

import { useChatComposerControls } from '@shared/assistant/components/composerControlsContext'

const QUICK_PROMPT_KEYS = ['status', 'nextStep', 'draftFollowup', 'updateSummary'] as const

/** 事项快捷 prompt —— 位置与全局面板的快捷动作一致（AgentThread 的 quickActions 槽），
 *  只是换成事项这一组。autoSend 走 thread（绕过 composer form），因此与全局快捷动作一样
 *  遵守同一条 sendDisabled 闸。 */
export function MatterQuickPrompts({ contextCount }: { contextCount: number }): React.JSX.Element {
  const { t } = useTranslation()
  const controls = useChatComposerControls()
  const sendDisabled = controls?.sendDisabled === true
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-1.5" data-testid="matter-chat-prompts">
        {QUICK_PROMPT_KEYS.map((key) => {
          const prompt = t(`matters.chat.prompts.${key}`)
          return (
            <ThreadPrimitive.Suggestion
              key={key}
              prompt={prompt}
              autoSend
              disabled={sendDisabled}
              className={
                'inline-flex h-auto items-center whitespace-nowrap rounded-full border border-ink-border-soft px-3.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3' +
                (sendDisabled ? ' cursor-not-allowed opacity-50' : '')
              }
            >
              {prompt}
            </ThreadPrimitive.Suggestion>
          )
        })}
      </div>
      <p className="text-meta text-ink-fg-3">
        {t('matters.chat.empty.hint', { count: contextCount })}
      </p>
    </div>
  )
}
