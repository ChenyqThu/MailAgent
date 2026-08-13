// 灵动 bot 头像 —— showcase 巡演 hook（0813 dogfood：hover 卡片 / 编辑器预览的
// 「随机换动作」展示态）。active 时每隔 SHOWCASE_INTERVAL_MS 从表现力池随机换一个
// 状态（永不连续重复），交给 <BotAvatar animated state={…}> 播放；inactive 或
// reduced-motion 恒返回 'idle'（列表静态纪律不被 showcase 绕过）。
// 首个动作经 0ms timer 触发（不在 effect 体内同步 setState —— 仓规避免
// react-hooks/set-state-in-effect 级联渲染）。

import { useEffect, useState } from 'react'

import { useReducedMotion } from '../hooks/useReducedMotion'
import type { BotState } from './states'

/** 表现力池：只挑「演起来好看」的反应/认知态（不含 sleeping/loading 等低表达态）。
 *  celebrate/laughing 带 shake，混在池里当高光帧。 */
export const SHOWCASE_STATES: readonly BotState[] = [
  'happy',
  'curious',
  'excited',
  'surprised',
  'playful',
  'laughing',
  'thinking',
  'searching',
  'proud',
  'shy',
  'suspicious',
  'celebrate'
]

/** 巡演节拍：比过渡（500ms）+ 一两次眨眼长，短于看腻的阈值 */
export const SHOWCASE_INTERVAL_MS = 2400

export function useShowcaseState(active: boolean): BotState {
  const reduce = useReducedMotion()
  const enabled = active && !reduce
  const [state, setState] = useState<BotState>('idle')

  useEffect(() => {
    if (!enabled) return
    let current: BotState = 'idle'
    const advance = (): void => {
      const pool = SHOWCASE_STATES.filter((candidate) => candidate !== current)
      current = pool[Math.floor(Math.random() * pool.length)]
      setState(current)
    }
    // 立即换第一个动作（0ms timer；卸载/失活时一并清掉）
    const kickoff = window.setTimeout(advance, 0)
    const interval = window.setInterval(advance, SHOWCASE_INTERVAL_MS)
    return (): void => {
      window.clearTimeout(kickoff)
      window.clearInterval(interval)
    }
  }, [enabled])

  // 失活即回 idle（不清内部 state —— 重新激活时从 0ms timer 立刻换新动作）
  return enabled ? state : 'idle'
}
