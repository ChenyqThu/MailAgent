// 右键菜单的锚点：`ui/Popmenu` 按 `triggerRef` 的实测矩形定位（portal 档），右键没有触发按钮，
// 就在光标处放一个 1×1 的 fixed 空元素当触发器。只管坐标与开合，菜单项由调用方给。

import { useCallback, useRef, useState, type CSSProperties, type RefObject } from 'react'

export interface CursorMenu<T> {
  open: boolean
  payload: T | null
  openAt(event: { clientX: number; clientY: number; preventDefault(): void }, payload: T): void
  close(): void
  anchorRef: RefObject<HTMLSpanElement | null>
  /** 摊到 `<span {...anchorProps} />` 上；恒渲染，位置随最后一次右键走。 */
  anchorProps: { ref: RefObject<HTMLSpanElement | null>; 'aria-hidden': true; style: CSSProperties }
}

export function useCursorMenu<T>(): CursorMenu<T> {
  const [state, setState] = useState<{ x: number; y: number; payload: T } | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const openAt = useCallback(
    (event: { clientX: number; clientY: number; preventDefault(): void }, payload: T): void => {
      event.preventDefault()
      setState({ x: event.clientX, y: event.clientY, payload })
    },
    []
  )
  const close = useCallback((): void => setState(null), [])
  return {
    open: state !== null,
    payload: state?.payload ?? null,
    openAt,
    close,
    anchorRef,
    anchorProps: {
      ref: anchorRef,
      'aria-hidden': true,
      style: {
        position: 'fixed',
        left: state?.x ?? 0,
        top: state?.y ?? 0,
        width: 1,
        height: 1,
        pointerEvents: 'none'
      }
    }
  }
}
