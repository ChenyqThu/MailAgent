// PaletteThinkingPhrases — agentic 搜索进行态的一行 phrase 轮播（不展开 thinking /
// 工具过程，只一行短语 + 字形流光）。
//
// 复用 ThinkingPhrases 的轮播 cycle 思路 + ShimmerText neutral（非 AI 紫，纯加载
// 语境）。短语取自 i18n palette.ai.searchingPhrases（数组，returnObjects）。
// reduce：停在第一句 + ShimmerText 自身退化静态（thinking-phrases-item enter
// 动画也由 index.css 的 @media reduce 关闭）。
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { ShimmerText } from '@shared/components/ShimmerText'

const CYCLE_MS = 2600

export function PaletteThinkingPhrases(): React.ReactElement {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const raw = t('palette.ai.searchingPhrases', { returnObjects: true })
  const phrases =
    Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : [t('palette.searching')]
  const [idx, setIdx] = React.useState(0)
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
        key={safe}
        text={phrases[safe] ?? ''}
        neutral
        className="thinking-phrases-item"
      />
    </span>
  )
}
