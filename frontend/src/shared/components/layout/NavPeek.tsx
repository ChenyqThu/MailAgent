// 折叠态 peek 浮层（task 09-01-sidebar-fluid-optimization，design.md §3「全域 peek」）。
//
// Sidebar 在折叠态 hover / 聚焦导轨格 150ms 后把 `peekDomain` 写进 store，本组件挂载；
// 离开导轨与浮层 300ms 后 Sidebar 清掉它，本组件卸载。这里只管：
//   · 几何与材质（index.css `.nav-peek` = fixed 脱流 + .glass-pop；宽 = 该域记忆宽 px）；
//   · 内容分派：nav 域 = `DomainPanel` 的 peek 变体；page 域 = 六个 lazy 清单
//     （同一组件或只读投影，走各域 react-query 缓存 —— 访问过零请求，没访问过先骨架）；
//   · 关闭时机：Esc / 路由变化（DomainPanel 行点击导航后）/ page 清单显式 onNavigate。
// 🔴 不改 --app-nav-w：浮层脱流，左列边界纹丝不动。

import { lazy, Suspense, useEffect, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import {
  NAV_DOMAINS,
  navDomainLabel,
  type NavDomain,
  type NavEntry
} from '@shared/navigation/registry'

import { DomainPanel } from './DomainPanel'
import { PeekSkeleton, type PeekListProps } from './peek/PeekChrome'

type PeekList = React.LazyExoticComponent<(props: PeekListProps) => React.ReactElement>

/** page 域 → 懒加载清单（事项页 chunk 591KB，别拖进壳的首包）。 */
const PAGE_LISTS: Partial<Record<NavDomain, PeekList>> = {
  mail: lazy(() => import('./peek/MailPeekList')),
  matters: lazy(() => import('./peek/MattersPeekList')),
  contacts: lazy(() => import('./peek/ContactsPeekList')),
  chats: lazy(() => import('./peek/ChatsPeekList')),
  agents: lazy(() => import('./peek/TeamPeekList')),
  reports: lazy(() => import('./peek/ReportsPeekList'))
}

export interface NavPeekProps {
  domain: NavDomain
  /** 该域记忆的第二列宽（px）—— 折叠态 --app-second-w 是 0，不能读它。 */
  width: number
  entries: readonly NavEntry[]
  onEntryClick(entry: NavEntry): void
  onEntryHover(entry: NavEntry): void
  onClose(): void
  onPointerEnter(): void
  onPointerLeave(): void
}

export function NavPeek({
  domain,
  width,
  entries,
  onEntryClick,
  onEntryHover,
  onClose,
  onPointerEnter,
  onPointerLeave
}: NavPeekProps): React.ReactElement {
  const { t } = useTranslation()
  // 入场：挂载后下一帧翻 data-open，让 opacity / translate 过渡跑起来。
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Esc 关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 路由变了（DomainPanel 行 / 设置 tab 行导航）→ 关。首次挂载那一拍不算。
  const href = useRouterState({ select: (s) => s.location.href })
  const [hrefAtMount] = useState(href)
  useEffect(() => {
    if (href !== hrefAtMount) onClose()
  }, [href, hrefAtMount, onClose])

  const second = NAV_DOMAINS[domain].second
  const PageList = PAGE_LISTS[domain]

  return (
    <div
      className="nav-peek glass-pop"
      data-nav-peek={domain}
      data-open={entered ? 'true' : 'false'}
      role="dialog"
      aria-label={t('nav.peekTitle', { domain: navDomainLabel(domain, t) })}
      style={{ width }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="nav-peek-body">
        {second === 'nav' || PageList === undefined ? (
          <DomainPanel
            domain={domain}
            entries={entries}
            onEntryClick={onEntryClick}
            onEntryHover={onEntryHover}
            peek
          />
        ) : (
          <Suspense fallback={<PeekSkeleton />}>
            <PageList onNavigate={onClose} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
