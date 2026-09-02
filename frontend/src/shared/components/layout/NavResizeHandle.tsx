// 左列拖宽手柄（task 09-01-sidebar-fluid-optimization）。
//
// 贴在 `--app-nav-w` 那条线上的 7px 热区（几何在 index.css `.nav-resize-handle`）：pointer
// 拖动写该域的记忆宽（store clamp 280–420），双击复位 336，键盘 ←/→ 每次 8px（a11y）。
// 拖拽期间 store 给 html 挂 `data-nav-dragging`，关掉 :root 的变量过渡跟手。
// page 域时 .app-nav 自身只有 56 宽，手柄靠绝对定位仍落在清单列右缘。

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { NavDomain } from '@shared/navigation/registry'
import { SECOND_W_MAX, SECOND_W_MIN, useDomainWidth, useNavShell } from '@shared/state/nav-shell'

const KEY_STEP = 8

export function NavResizeHandle({ domain }: { domain: NavDomain }): React.ReactElement {
  const { t } = useTranslation()
  const width = useDomainWidth(domain)
  const drag = useRef<{ x0: number; w0: number } | null>(null)

  const end = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    drag.current = null
    useNavShell.getState().setDragging(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  return (
    <div
      className="nav-resize-handle"
      data-nav-resize
      role="separator"
      aria-orientation="vertical"
      aria-label={t('nav.resize')}
      aria-valuemin={SECOND_W_MIN}
      aria-valuemax={SECOND_W_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title={t('nav.resize')}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = { x0: e.clientX, w0: width }
        useNavShell.getState().setDragging(true)
        e.currentTarget.setPointerCapture?.(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return
        useNavShell.getState().setWidth(domain, drag.current.w0 + e.clientX - drag.current.x0)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => useNavShell.getState().resetWidth(domain)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          useNavShell
            .getState()
            .setWidth(domain, width + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP))
        } else if (e.key === 'Home') {
          e.preventDefault()
          useNavShell.getState().resetWidth(domain)
        }
      }}
    />
  )
}
