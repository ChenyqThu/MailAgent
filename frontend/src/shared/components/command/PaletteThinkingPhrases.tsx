// PaletteThinkingPhrases — agentic 搜索进行态的一行 phrase 轮播（不展开 thinking /
// 工具过程，只一行短语 + 字形流光）。
//
// 复用 ThinkingPhrases 的轮播 cycle 思路 + ShimmerText neutral（非 AI 紫，纯加载
// 语境）。短语据 runSearchAgent 的真实 phase 切换组（G-A7 ③）：
//   'searching'    → palette.ai.searchingPhrases（检索阶段）
//   'summarizing'  → palette.ai.summarizingPhrases（整理阶段）
// 切换 phase 时 phrase 组换组 + idx 复位，让进行态 UI 反映真实阶段而非固定假进度。
// reduce：停在当前组第一句 + ShimmerText 自身退化静态（thinking-phrases-item enter
// 动画也由 index.css 的 @media reduce 关闭）。
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { ShimmerText } from '@shared/components/ShimmerText'
import type { SearchAgentPhase } from '@shared/api/types'

const CYCLE_MS = 2600

export function PaletteThinkingPhrases({
  phase = 'searching'
}: {
  phase?: SearchAgentPhase
}): React.ReactElement {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const key =
    phase === 'summarizing' ? 'palette.ai.summarizingPhrases' : 'palette.ai.searchingPhrases'
  const raw = t(key, { returnObjects: true })
  const phrases =
    Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : [t('palette.searching')]
  const [idx, setIdx] = React.useState(0)
  // phase 切换 → render 期复位轮播到新组首句（否则旧组的 idx 可能越界到新组）。
  // adjust-on-prop-change（react.dev）而非 effect setState，避免级联渲染。
  const [prevPhase, setPrevPhase] = React.useState(phase)
  if (prevPhase !== phase) {
    setPrevPhase(phase)
    setIdx(0)
  }
  React.useEffect(() => {
    if (reduce || phrases.length <= 1) return
    const id = window.setInterval(() => setIdx((i) => (i + 1) % phrases.length), CYCLE_MS)
    return () => window.clearInterval(id)
  }, [reduce, phrases.length])
  // key={safe} 让切换时重新 mount → 触发 .thinking-phrases-item 的 enter 动画。
  const safe = idx < phrases.length ? idx : 0
  return (
    <span className="thinking-phrases">
      <ShimmerText
        key={`${phase}-${safe}`}
        text={phrases[safe] ?? ''}
        neutral
        className="thinking-phrases-item"
      />
    </span>
  )
}
