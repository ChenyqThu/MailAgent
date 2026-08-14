// 通讯录列表 j/k + ↑/↓ 导航（照 useEmailKeyboardNav 的 document 级监听与跳过
// 规则；contacts 无全局 active store，选中态由 workspace 持有，经回调驱动）。

import { useEffect } from 'react'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return false
}

export function useContactKeyboardNav(
  orderedIds: ReadonlyArray<number>,
  selectedId: number | null,
  onSelect: (id: number) => void
): void {
  useEffect(() => {
    function onKeyDown(evt: KeyboardEvent): void {
      if (evt.metaKey || evt.ctrlKey || evt.altKey) return
      if (isEditableTarget(evt.target)) return

      const key = evt.key
      const forward = key === 'j' || key === 'J' || key === 'ArrowDown'
      const backward = key === 'k' || key === 'K' || key === 'ArrowUp'
      if (!forward && !backward) return
      if (orderedIds.length === 0) return

      const index = selectedId === null ? -1 : orderedIds.indexOf(selectedId)
      let next: number | null = null
      if (forward) {
        next = index < 0 ? orderedIds[0]! : (orderedIds[index + 1] ?? null)
      } else {
        next = index <= 0 ? (index < 0 ? orderedIds[0]! : null) : orderedIds[index - 1]!
      }
      if (next !== null && next !== selectedId) {
        evt.preventDefault()
        onSelect(next)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [orderedIds, selectedId, onSelect])
}
