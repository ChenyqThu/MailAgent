// @vitest-environment happy-dom
//
// L0 — 全局文件拖拽导航守卫: 拖文件脱靶到 composer 外时, document 层 preventDefault
// 阻断 Chromium 默认 file:// 导航 (毁掉 app); 文本拖拽不拦; 卸载后不再拦截。

import { describe, expect, test } from 'vitest'

import { installFileDropGuard } from '@shared/lib/fileDropGuard'

function dispatchDrag(type: 'dragover' | 'drop', types: string[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { types } })
  document.dispatchEvent(e)
  return e
}

describe('installFileDropGuard', () => {
  test('文件拖拽 dragover/drop → document 层 preventDefault (阻断 file:// 导航)', () => {
    const uninstall = installFileDropGuard()
    try {
      expect(dispatchDrag('dragover', ['Files']).defaultPrevented).toBe(true)
      expect(dispatchDrag('drop', ['Files']).defaultPrevented).toBe(true)
    } finally {
      uninstall()
    }
  })

  test('文本/HTML 拖拽 (不含 Files) 不拦截 — TipTap 原生拖放不受影响', () => {
    const uninstall = installFileDropGuard()
    try {
      expect(dispatchDrag('dragover', ['text/plain']).defaultPrevented).toBe(false)
      expect(dispatchDrag('drop', ['text/html']).defaultPrevented).toBe(false)
    } finally {
      uninstall()
    }
  })

  test('卸载后不再拦截 (effect cleanup 语义)', () => {
    const uninstall = installFileDropGuard()
    uninstall()
    expect(dispatchDrag('drop', ['Files']).defaultPrevented).toBe(false)
  })
})
