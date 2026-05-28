// reduced-motion 全局策略（JS 层）。
//
// GSAP 经 JS 直接操作 DOM .style，绕过了 index.css 里的
// `@media (prefers-reduced-motion: reduce)` 保护 —— 一旦 GSAP 接管某元素，
// CSS 媒体查询对它失效。所以凡是用 GSAP 的动画都必须在 JS 层读这个 hook，
// 在 reduce 时把 duration 归零或直接切换状态。useExitAnimation 已内置短路。

import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true
  )

  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent): void => setReduce(e.matches)
    mq.addEventListener('change', onChange)
    setReduce(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduce
}
