// 主题信号 = documentElement 的 data-theme attribute（appearance.ts applyResolvedTheme
// 的唯一 DOM 落点）。不订阅 useAppearance store：本模块域无关，远程 web 与任何
// 未挂 zustand 的宿主里也要能跟主题。缺席（boot 前/测试）按 dark —— index.css
// :root 默认即暗色。只有 body fill 需要 JS 侧分主题；eye fill 是 CSS 变量回退串，
// 浏览器在 paint 时自行解析，无需 JS 参与。
// 独立成文件（而不是留在 BotAvatar.tsx）：组件文件只导出组件（react-refresh 约束）。

import { useSyncExternalStore } from 'react'

function subscribeTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

function getThemeSnapshot(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

/** 主题快照（BotAvatar 与编辑器 swatch 等外围 UI 共用同一信号源，避免各处再抄一份
 *  MutationObserver 订阅）。 */
export function useBotAvatarTheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => 'dark' as const)
}
