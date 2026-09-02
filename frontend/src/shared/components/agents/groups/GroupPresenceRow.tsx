// L4 群聊 UX 批 → T2 在场态 — 消息流末尾的在场行，两半各说一件事：
//   · 写者半边 = AI Chat 那条 `TurnPresenceRow`（成员的动效头像 + shimmer 文案 + 回合秒表），
//     阶段由 `groupTurnStage` 从事件事实派生，调用方传进来（本组件是纯展示）。
//   · 排队半边 = 「A、B 排队中」（≥ 4：「A、B 等 N 位排队中」）+ 三点 opacity 脉冲，原样保留
//     —— AI Chat 里没有这件事（DESIGN.md §8 禁 bounce 位移；motion-reduce 静止）。
// 🔴 在场态只来自事件 / 探针（红线 1）：props 为空就渲染 null，不会自己编一个。
// 🔴 两半分两行：shimmer（写者）与脉冲点（排队）不同行（prd「motion 纪律」）。

import { useTranslation } from 'react-i18next'

import type { AgentAvatarConfig } from '@shared/api/types'
import { TurnPresenceRow } from '@shared/assistant/components/TurnPresence'
import type { StallLevel, TurnStage } from '@shared/assistant/runtime/useTurnStage'

import { isAgentAvatarImage, resolveAgentAvatar } from '../agentAvatarIdentity'

/** 在写者：谁 + 此刻处在哪个阶段。stage / stallLevel 由调用方经 `groupTurnStage` 派生 ——
 *  本组件不碰事实，只负责把它画出来。 */
export interface GroupPresenceWriter {
  agentId: string
  name: string
  avatar?: AgentAvatarConfig | null
  stage: TurnStage
  stallLevel: StallLevel
}

export function GroupPresenceRow({
  writer,
  queuedNames
}: {
  writer: GroupPresenceWriter | null
  queuedNames: readonly string[]
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (writer == null && queuedNames.length === 0) return null
  const avatar = writer?.avatar ?? null
  const queuedText =
    queuedNames.length === 0
      ? null
      : queuedNames.length <= 3
        ? t('groupChat.queuedOne', { name: queuedNames.join('、') })
        : t('groupChat.queuedMany', {
            names: queuedNames.slice(0, 2).join('、'),
            count: queuedNames.length
          })
  return (
    <div className="flex flex-col gap-0.5" aria-live="polite">
      {writer != null && (
        <TurnPresenceRow
          stage={writer.stage}
          stallLevel={writer.stallLevel}
          // 群里不庆祝：一条链上多个成员轮流说话，「完成」没有单一时刻；且三元组一空整行就
          // 卸载，celebrate 连宿主都没有。
          completed={false}
          config={resolveAgentAvatar(writer.agentId, avatar)}
          imageSrc={isAgentAvatarImage(avatar) ? avatar.data : undefined}
          // 名字只进 thinking / calling-tool 两支的文案，而群侧恒不产这两态（见 groupTurnStage）
          // —— 传真值是为了让共享组件永远拿到事实，而不是回落到那句对群毫无意义的「AI」。
          assistantName={writer.name}
        />
      )}
      {queuedText != null && (
        <div className="flex items-center gap-2 py-0.5 text-meta text-ink-fg-3">
          <span>{queuedText}</span>
          <span className="flex items-center gap-0.5" aria-hidden>
            <span className="size-1 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
            <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms] motion-reduce:animate-none" />
            <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms] motion-reduce:animate-none" />
          </span>
        </div>
      )}
    </div>
  )
}
