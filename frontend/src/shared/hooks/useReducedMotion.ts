// reduced-motion 全局策略（JS 层）。
//
// GSAP 经 JS 直接操作 DOM .style，绕过了 index.css 里的
// `@media (prefers-reduced-motion: reduce)` 保护 —— 一旦 GSAP 接管某元素，
// CSS 媒体查询对它失效。所以凡是用 GSAP 的动画都必须在 JS 层读这个 hook，
// 在 reduce 时把 duration 归零或直接切换状态。useExitAnimation 已内置短路。

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onStoreChange)
  return () => mq.removeEventListener('change', onStoreChange)
}

function getSnapshot(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true
}

function getServerSnapshot(): boolean {
  return false
}

// useSyncExternalStore：matchMedia 外部 store，消除旧实现 effect 内 `setReduce(mq.matches)`
// 对齐首帧的级联 render。QUERY 固定 → subscribe/getSnapshot 提到模块级保持引用稳定。
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
