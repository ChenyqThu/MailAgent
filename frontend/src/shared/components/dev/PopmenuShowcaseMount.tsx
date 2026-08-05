// Popmenu showcase 的 dev-only 挂载点。
//
// 接线只有一处：`router-instance.tsx` 的 RootLayout 里 `import.meta.env.DEV` 门控地
// lazy 挂本组件。生产构建时 Vite 把 `import.meta.env.DEV` 直接替换成 `false`，那个
// 三元折成 `null`，动态 import 不可达 → 打包产物零渲染、也不会进 chunk 图。
//
// 打开方式（两种，任选）：
//   1. ⌃⇧P（Control + Shift + P，非 ⌘）—— 任意界面直接开/关。
//   2. DevTools console：`__popmenuShowcase()` 开，再敲一次或按 Esc 关。
// 关闭：Esc（弹层开着时 Esc 先关弹层 —— Popmenu 的 document 监听会 stopPropagation，
// 而本组件挂在 window 上，天然是「先关内层」的顺序）、或右上角 ×、或再按一次 ⌃⇧P。
//
// 刻意**不用** location.hash 当入口：本页活在 TanStack Router 的 browser history 里，
// 改 hash 会和路由抢地址栏。

import { Suspense, lazy, useEffect, useState } from 'react'

const Showcase = lazy(() => import('./popmenu-showcase'))

declare global {
  interface Window {
    __popmenuShowcase?: () => void
  }
}

export default function PopmenuShowcaseMount(): React.ReactElement | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const toggle = (): void => setOpen((o) => !o)
    window.__popmenuShowcase = toggle
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        toggle()
        return
      }
      // Esc 只有在没有弹层张开时才走到这里 —— Popmenu 在 document 上 stopPropagation，
      // window 监听排在 document 之后，于是「Esc 先关菜单、再按一次关本页」是免费的。
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      delete window.__popmenuShowcase
    }
  }, [])

  if (!open) return null
  return (
    <Suspense fallback={null}>
      <Showcase onClose={() => setOpen(false)} />
    </Suspense>
  )
}
