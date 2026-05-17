// Sprint 3 — module-level keyboard shortcuts that should fire regardless of
// what currently has focus (with the usual editable-target skip). DESIGN.md
// §9.5 lists the full set; this hook covers ⌘K (search) and ⌥T (translate)
// for V1; CommandPalette + Sprint 7 fuzzy search will replace ⌘K.
//
// Both shortcuts are wired through callback props so the layout can decide
// what "open search" means in context (navigate vs in-place panel switch).

import { useEffect } from 'react'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

interface Shortcuts {
  /** ⌘K / Ctrl+K — typically navigate to /search. */
  onSearch?: () => void
  /** ⌥T / Alt+T — typically translate the active email body. */
  onTranslate?: () => void
}

export function useGlobalShortcuts({ onSearch, onTranslate }: Shortcuts): void {
  useEffect(() => {
    function onKeyDown(evt: KeyboardEvent): void {
      // ⌘K / Ctrl+K — search. Fires even inside <input> so the user can
      // pivot from filter input → search.
      if ((evt.metaKey || evt.ctrlKey) && (evt.key === 'k' || evt.key === 'K')) {
        if (onSearch) {
          evt.preventDefault()
          onSearch()
        }
        return
      }
      // ⌥T — translate. Skipped in editable contexts so the user can still
      // type "t" in inputs.
      if (
        evt.altKey &&
        !evt.metaKey &&
        !evt.ctrlKey &&
        (evt.key === 't' || evt.key === 'T' || evt.key === '†')
      ) {
        if (isEditableTarget(evt.target)) return
        if (onTranslate) {
          evt.preventDefault()
          onTranslate()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onSearch, onTranslate])
}
