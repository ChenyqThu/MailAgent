// 响应式断点 hook（JS 层）。
//
// 纯样式降级（列宽、隐藏次要段）走 Tailwind 的 `lg:`/`md:` 前缀即可；
// 但 shell 的"详情覆盖列表""侧栏抽屉化"这类需要条件渲染 + 组件状态的
// 降级，必须在 JS 层读 matchMedia 才能分支。同 useReducedMotion 的
// matchMedia 模式：SSR / 非 renderer 导入上下文用 typeof window 兜底，
// 监听 `change` 跟随窗口 resize。
//
// 断点对齐 Tailwind 默认 screens（tailwind.config.ts 经核实无 override）：
// md=768 / lg=1024 / xl=1280。语义 hook 返回"是否窄于某档"，shell 据此降级。

import { useCallback, useSyncExternalStore } from 'react'

function read(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
}

export function useMediaQuery(query: string): boolean {
  // useSyncExternalStore：matchMedia 是典型外部 store。subscribe 监听 change，
  // getSnapshot 每次 render 读当前值——天然消除旧实现 useEffect 内 `setMatches(mq.matches)`
  // 对齐首帧的级联 render（react-hooks/set-state-in-effect）。getServerSnapshot 兜
  // SSR / 非 renderer 导入（typeof window === undefined）。
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onStoreChange)
      return () => mq.removeEventListener('change', onStoreChange)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => read(query),
    () => false
  )
}

// Tailwind 默认断点（px）。max-width 查询用 BP-1 避免与 min-width 前缀
// （Tailwind `lg:` = min-width:1024）在边界像素重叠。
const BP = { md: 768, lg: 1024, xl: 1280 } as const

/** <1024：列表/详情单栏切换 + 侧栏 auto-collapse + AI panel 抽屉化。 */
export function useIsBelowLg(): boolean {
  return useMediaQuery(`(max-width: ${BP.lg - 1}px)`)
}

/** <768：侧栏 off-canvas 抽屉 + chrome 砍次要段。 */
export function useIsBelowMd(): boolean {
  return useMediaQuery(`(max-width: ${BP.md - 1}px)`)
}

/** <1280：AI panel 由挤压列改 drawer overlay（避免把正文挤到 <320px）。 */
export function useIsBelowXl(): boolean {
  return useMediaQuery(`(max-width: ${BP.xl - 1}px)`)
}
