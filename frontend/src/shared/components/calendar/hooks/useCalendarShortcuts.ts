// mockup-calendar.html §keyboard shortcuts 实现 —
// G+D/W/M/A/R (G prefix 800ms 内接视图键) / T 跳今天 / ← → step / ⌘R (或 Ctrl+R)
// 触发 sync / ? 开 help modal / Esc 关弹层.
// 阶段2·2.7 (F18/UX-P0④) — N 新建 / J·K 巡航选中 / Enter 打开选中.
//
// 排除 INPUT / TEXTAREA / contentEditable target, 避免劫持表单输入.
// CalendarLayout mount 一次, view-agnostic.

import { useEffect } from 'react'

import type { CalendarView } from '@shared/router-instance'

interface ShortcutOpts {
  onView: (v: CalendarView) => void
  onToday: () => void
  onPrev: () => void
  onNext: () => void
  onSync: () => void
  onHelp: () => void
  onEsc: () => void
  /** 2.7 — n 新建事件; 远程 web (IS_WEB_BUILD 写入口门控) 由 caller 不传关掉. */
  onNew?: () => void
  /** 2.7 — j 选中下一个事件 (只动锚点, 不开抽屉). */
  onNextEvent?: () => void
  /** 2.7 — k 选中上一个事件. */
  onPrevEvent?: () => void
  /** 2.7 — Enter 打开当前选中事件的 drawer. */
  onOpenSelected?: () => void
}

export function useCalendarShortcuts(opts: ShortcutOpts): void {
  const { onView, onToday, onPrev, onNext, onSync, onHelp, onEsc } = opts
  const { onNew, onNextEvent, onPrevEvent, onOpenSelected } = opts

  useEffect(() => {
    let gPressed = false
    let gTimer: ReturnType<typeof setTimeout> | null = null
    const clearG = (): void => {
      gPressed = false
      if (gTimer) {
        clearTimeout(gTimer)
        gTimer = null
      }
    }

    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const editable = target?.isContentEditable
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return

      // ⌘R / Ctrl+R = sync
      if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        onSync()
        return
      }

      // Esc = close modal/drawer/popover
      if (e.key === 'Escape') {
        onEsc()
        clearG()
        return
      }

      // ? = help (Shift+/)
      if (e.key === '?') {
        e.preventDefault()
        onHelp()
        clearG()
        return
      }

      // G prefix: 800ms 内接 d/w/m/a/r
      if (gPressed) {
        clearG()
        const k = e.key.toLowerCase()
        if (k === 'd') onView('today')
        else if (k === 'w') onView('week')
        else if (k === 'm') onView('month')
        else if (k === 'a') onView('agenda')
        // 阶段1·1.9 (F18/Q12) — recurring 视图此前无键达
        else if (k === 'r') onView('recurring')
        return
      }
      if (e.key === 'g' || e.key === 'G') {
        gPressed = true
        gTimer = setTimeout(() => {
          gPressed = false
          gTimer = null
        }, 800)
        return
      }

      // T = today
      if (e.key === 't' || e.key === 'T') {
        onToday()
        return
      }

      // 阶段2·2.7 — N 新建 / J·K 巡航 / Enter 打开选中. 带 ⌘/Ctrl/⌥ 时让位
      // (⌘J chat modal / ⌘N compose 等全局绑定同键, 不可劫持).
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      if (plain && (e.key === 'n' || e.key === 'N')) {
        onNew?.()
        return
      }
      if (plain && (e.key === 'j' || e.key === 'J')) {
        onNextEvent?.()
        return
      }
      if (plain && (e.key === 'k' || e.key === 'K')) {
        onPrevEvent?.()
        return
      }
      if (plain && e.key === 'Enter') {
        // 焦点在按钮/链接等可交互元素上时让位原生激活 (Enter=click), 只在
        // 无焦点语境 (body / 容器) 下打开选中事件.
        if (
          tag === 'BUTTON' ||
          tag === 'A' ||
          tag === 'SELECT' ||
          target?.getAttribute?.('role') === 'button'
        ) {
          return
        }
        onOpenSelected?.()
        return
      }

      // ← / → = step
      if (e.key === 'ArrowLeft') {
        onPrev()
        return
      }
      if (e.key === 'ArrowRight') {
        onNext()
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      clearG()
    }
  }, [
    onView,
    onToday,
    onPrev,
    onNext,
    onSync,
    onHelp,
    onEsc,
    onNew,
    onNextEvent,
    onPrevEvent,
    onOpenSelected
  ])
}
