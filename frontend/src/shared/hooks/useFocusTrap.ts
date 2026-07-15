// Sprint 9 D4.1 (Sprint 7 review LOW carry-forward) — shared focus-trap
// hook. Three modals were duplicating the same `querySelectorAll(FOCUSABLE)`
// + Tab/Shift-Tab boundary handling: KeyboardHelpModal, CommandPalette,
// ResyncConfirmDialog. The duplicated code was ~40 lines per modal with
// subtle drift (KeyboardHelpModal lacked the `!root.contains(active)` wrap
// guard that CommandPalette has, so a focus that escaped the dialog mid-
// session would not snap back on Tab). Centralising here normalises the
// behaviour and fixes the drift.
//
// Usage:
//   const { dialogRef, handleTab } = useFocusTrap({ open, fallbackRef })
//   <div ref={dialogRef} onKeyDown={(e) => {
//     if (e.key === 'Escape') { ...; return }
//     handleTab(e)  // returns true if it consumed a Tab event
//   }}>
//
// Notes:
//   - The hook does NOT install a global keydown listener. The dialog's
//     own onKeyDown handler routes events; this keeps SSR + multiple
//     modals nested-safe.
//   - `fallbackRef` is the backdrop or outer dialog div. When the dialog
//     has zero focusable descendants (e.g. a modal with only static text),
//     mount-time focus lands there so subsequent onKeyDown still fires.
//     The fallback element must carry `tabIndex={-1}` on the JSX.

import { useCallback, useEffect, useRef } from 'react'

/** W3C-aligned focusable selector. Mirrors the EmailToolbar /
 *  KeyboardHelpModal / CommandPalette duplicated constants pre-Sprint 9. */
export const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export interface UseFocusTrapOpts {
  /** Activate the trap when true; the hook is a no-op when false. */
  open: boolean
  /** Element to focus when the dialog has no focusable descendants. Must
   *  carry `tabIndex={-1}` on the JSX so it's programmatically focusable
   *  but not part of the Tab order. Usually the backdrop ref. */
  fallbackRef?: React.RefObject<HTMLElement | null>
}

export interface UseFocusTrapReturn {
  /** Attach to the inner dialog `<div>`. */
  dialogRef: React.RefObject<HTMLDivElement | null>
  /** Tab/Shift-Tab cycle handler. Call from the dialog's onKeyDown.
   *  Returns true when it consumed the event (so callers can early-return). */
  handleTab(e: React.KeyboardEvent<HTMLDivElement>): boolean
}

export function useFocusTrap({ open, fallbackRef }: UseFocusTrapOpts): UseFocusTrapReturn {
  const dialogRef = useRef<HTMLDivElement>(null)

  // Initial focus on open. The fallback path keeps onKeyDown alive even
  // for content-only modals — React's synthetic onKeyDown only fires from
  // focused descendants, so without a focused element the dialog goes dark.
  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    // 对话框内已有焦点 (子组件 autoFocus, 如 compose-new 的 To 字段) → 不抢。
    // 子组件 effect 先于父级 effect 执行, 此守卫判定是确定性的。
    if (root && root.contains(document.activeElement)) return
    // 跳过 disabled / tabindex=-1 (与下方 handleTab 的过滤一致): 首个 selector 命中
    // 可能是 disabled 控件 (如 compose-new 打开时收件人为空→发送按钮 disabled),
    // 对它 .focus() 无效会让焦点留在 dialog 外、onKeyDown 收不到 Tab。取首个真正
    // 可聚焦元素, 无则落 fallback。
    const first = root
      ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
          (el) => !(el as HTMLButtonElement).disabled && el.tabIndex !== -1
        )
      : undefined
    if (first) {
      first.focus()
    } else {
      fallbackRef?.current?.focus()
    }
  }, [open, fallbackRef])

  const handleTab = useCallback((e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (e.key !== 'Tab') return false
    const root = dialogRef.current
    if (!root) return false
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.tabIndex !== -1
    )
    if (focusables.length === 0) return false
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    // `!root.contains(active)` snaps focus back into the dialog when it
    // escaped the trap (e.g. user clicked outside then tabbed). Both ends
    // wrap to keep Tab and Shift-Tab symmetric — previously
    // KeyboardHelpModal lacked the shift-side guard and a stranded focus
    // would not return.
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault()
        last.focus()
        return true
      }
    } else {
      if (active === last || !root.contains(active)) {
        e.preventDefault()
        first.focus()
        return true
      }
    }
    return false
  }, [])

  return { dialogRef, handleTab }
}
