// J/K row navigation per DESIGN.md §9.5 keyboard shortcuts. Listens at the
// document level so the hotkeys work whether or not EmailList currently has
// focus — that's the mockup contract (Mimestream / Linear style).
//
// Skip rules:
//   - typing in an <input> / <textarea> / contenteditable element → don't hijack
//   - modifier keys (cmd/ctrl/alt/meta) → don't fire (preserve cmd+K etc.)
//
// Caller wires the live ordered id list (post-filter, post-sort), so J/K
// always walks the *currently displayed* rows, not a stale snapshot.

import { useEffect } from 'react'

import { pickNext, pickPrev, useActiveEmail } from '../state/active-email'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export function useEmailKeyboardNav(orderedIds: ReadonlyArray<number>): void {
  useEffect(() => {
    function onKeyDown(evt: KeyboardEvent): void {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return
      if (isEditableTarget(evt.target)) return

      const key = evt.key
      if (key !== 'j' && key !== 'J' && key !== 'k' && key !== 'K') return

      const current = useActiveEmail.getState().activeInternalId
      const next =
        key === 'j' || key === 'J' ? pickNext(orderedIds, current) : pickPrev(orderedIds, current)

      if (next !== null && next !== current) {
        evt.preventDefault()
        useActiveEmail.getState().setActive(next)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [orderedIds])
}
