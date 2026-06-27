// ThinkingPhrases — AI 思考态的多段 phrase 轮播（elevenlabs ShimmeringText 风格）。
//
// 每隔 ~2.6s 切换一句 i18n 短语，每句用 ShimmerText 做字形流光；切换走 CSS enter
// 动画（fade + 上移，transform/opacity 合成器属性，合成层内可靠）。phrases 取自
// i18n chat.thinkingPhrases（数组，returnObjects），贴合本应用的邮件 + KOS 能力。
// reduce：不轮播（停在第一句）+ ShimmerText 自身退化静态，phrase-in 由 CSS 关闭。
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { ShimmerText } from '@shared/components/ShimmerText'

// 用户反馈：轮换时间加长 ≥+50%（2600 → 4000ms），让每句流光看得更从容。
const CYCLE_MS = 4000

export function ThinkingPhrases(): React.ReactElement {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const raw = t('chat.thinkingPhrases', { returnObjects: true })
  const phrases =
    Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : [t('chat.status.thinking')]
  const [idx, setIdx] = React.useState(0)
  React.useEffect(() => {
    if (reduce || phrases.length <= 1) return
    const id = window.setInterval(() => setIdx((i) => (i + 1) % phrases.length), CYCLE_MS)
    return () => window.clearInterval(id)
  }, [reduce, phrases.length])
  // key={idx} 让切换时重新 mount → 触发 .thinking-phrases-item 的 enter 动画。
  const safe = idx < phrases.length ? idx : 0
  return (
    <span className="thinking-phrases">
      <ShimmerText key={safe} text={phrases[safe] ?? ''} className="thinking-phrases-item" />
    </span>
  )
}
