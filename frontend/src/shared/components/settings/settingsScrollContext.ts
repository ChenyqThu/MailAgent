// Settings 内容区滚动容器的 ref 通道（08-01 PR4 · T2 lane）。
//
// 为什么需要它：SectionAnchorNav 的 active 追踪挂在**传入的滚动容器**上（Settings 的
// 唯一滚动容器是 SettingsShell 的 `<section aria-label="settings content">`，不是
// window）。锚点导航渲染在 AiTab 里，而那个 section 在 SettingsShell 里 —— 中间隔着
// Radix Tabs 的 TabsContent，prop 穿不下去，故走 context。
//
// 默认值是一个**模块级的常量 null-ref**（不是 `null`）：消费方永远拿得到一个合法的
// RefObject，不用为"没有 Provider"（单测直接渲染某个 tab / 未来别处复用）分支。此时
// nav 照常渲染，只是不追踪 active —— 组件对 `current == null` 已有处理。

import * as React from 'react'

/** 无 Provider 时的稳定占位 ref（模块级常量：每次读到的是同一个对象，不会让消费方的
 *  effect 依赖每帧变化）。 */
const NULL_SCROLL_REF: React.RefObject<HTMLElement | null> = { current: null }

export const SettingsScrollContext =
  React.createContext<React.RefObject<HTMLElement | null>>(NULL_SCROLL_REF)

/** Settings 内容区滚动容器的 ref。无 Provider → 稳定的 `{current: null}`。 */
export function useSettingsScrollRef(): React.RefObject<HTMLElement | null> {
  return React.useContext(SettingsScrollContext)
}
