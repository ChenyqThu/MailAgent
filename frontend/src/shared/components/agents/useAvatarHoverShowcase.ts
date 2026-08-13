// Agents 页卡片的 hover 巡演接线（0813 dogfood）：hover 卡片 → 头像 animated +
// 随机换动作；离开 → 回静态档。hover 一次至多一张卡在动（鼠标只有一个），
// 不违反「animated 位点须过性能评估」的纪律（评估结论随本 hook 记录在
// frontend/docs/bot-avatar.md 渲染档位节）。
// 用法：卡片根元素挂 {...hoverProps}，AgentAvatar 传 state={state} animated={animated}。

import { useState } from 'react'

import { useShowcaseState } from '@shared/bot-avatar/useShowcaseState'
import type { BotState } from '@shared/bot-avatar/types'

export interface AvatarHoverShowcase {
  hoverProps: {
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
  state: BotState
  animated: boolean
}

export function useAvatarHoverShowcase(): AvatarHoverShowcase {
  const [hover, setHover] = useState(false)
  const state = useShowcaseState(hover)
  return {
    hoverProps: {
      onMouseEnter: (): void => setHover(true),
      onMouseLeave: (): void => setHover(false)
    },
    state,
    animated: hover
  }
}
