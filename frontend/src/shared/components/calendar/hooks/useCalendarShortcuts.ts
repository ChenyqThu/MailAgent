// mockup-calendar.html §keyboard shortcuts 实现 —
// G+D/W/M/A (G prefix 800ms 内接视图键) / T 跳今天 / ← → step / ⌘R (或 Ctrl+R)
// 触发 sync / ? 开 help modal / Esc 关弹层.
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
}

export function useCalendarShortcuts(opts: ShortcutOpts): void {
  const { onView, onToday, onPrev, onNext, onSync, onHelp, onEsc } = opts

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

      // G prefix: 800ms 内接 d/w/m/a
      if (gPressed) {
        clearG()
        const k = e.key.toLowerCase()
        if (k === 'd') onView('today')
        else if (k === 'w') onView('week')
        else if (k === 'm') onView('month')
        else if (k === 'a') onView('agenda')
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
  }, [onView, onToday, onPrev, onNext, onSync, onHelp, onEsc])
}
