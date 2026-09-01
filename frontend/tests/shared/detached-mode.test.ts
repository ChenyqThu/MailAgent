// @vitest-environment happy-dom
//
// task 08-27 P5「拖出成独立窗口」形态 B —— 轻窗的模式 store + boot 解析 + 入口门控 +
// ElectronApi 的 IPC 载体。
//
// `bootDetachedModeFromQuery` 与 popout 的同名解析器同样跑在 React.render 之前，
// 所以对手敲 URL 的各种坏形状都得防：缺 detach / 缺 id / 不认识的 kind / 非数字或负数的
// 邮件 id。报告 id 是字符串主键，除了非空没有别的形状约束（含 `-` 的 daily-YYYY-MM-DD
// 是最常见的一种，必须原样穿过）。

import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  bootDetachedModeFromQuery,
  canOpenDetachedWindow,
  useDetachedMode
} from '../../src/shared/state/detached-mode'
import { ElectronApi } from '../../src/shared/api/ElectronApi'

function setSearch(search: string): void {
  // happy-dom：mirror main-process 的 URL hand-off（同 popout-mode.test.ts）。
  window.history.replaceState({}, '', `${window.location.pathname}${search}`)
}

beforeEach(() => {
  setSearch('')
  // 只复位数据槽 —— 传 true 会连 setDetached 动作一起换掉。
  useDetachedMode.setState({ isDetached: false, target: null })
  delete (window as unknown as { electron?: unknown }).electron
})

describe('bootDetachedModeFromQuery', () => {
  test('无 query → 不是轻窗，store 不动', () => {
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
    expect(useDetachedMode.getState().target).toBeNull()
  })

  test('detach=email&id=N → 落 email 目标', () => {
    setSearch('?detach=email&id=53675')
    expect(bootDetachedModeFromQuery()).toEqual({ kind: 'email', emailId: 53675 })
    expect(useDetachedMode.getState().isDetached).toBe(true)
    expect(useDetachedMode.getState().target).toEqual({ kind: 'email', emailId: 53675 })
  })

  test('detach=email&id=0 被接受（0 是合法 internal_id）', () => {
    setSearch('?detach=email&id=0')
    expect(bootDetachedModeFromQuery()).toEqual({ kind: 'email', emailId: 0 })
  })

  test('detach=report&id=<报告 id> → 原样穿过（含连字符的日报 id）', () => {
    setSearch('?detach=report&id=daily-2026-08-30')
    expect(bootDetachedModeFromQuery()).toEqual({
      kind: 'report',
      reportId: 'daily-2026-08-30'
    })
    expect(useDetachedMode.getState().isDetached).toBe(true)
  })

  test('报告 id 里的特殊字符经 URL 转义后仍还原', () => {
    setSearch(`?detach=report&id=${encodeURIComponent('a b/c&d')}`)
    expect(bootDetachedModeFromQuery()).toEqual({ kind: 'report', reportId: 'a b/c&d' })
  })

  test('不认识的 kind → 静默拒', () => {
    setSearch('?detach=matter&id=7')
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
  })

  test('有 detach 无 id → 静默拒', () => {
    setSearch('?detach=email')
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
  })

  test('email id 非数字 → 静默拒', () => {
    setSearch('?detach=email&id=abc')
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
  })

  test('email id 为负 → 静默拒', () => {
    setSearch('?detach=email&id=-1')
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
  })

  test('popout 的 query 不会被误认成轻窗', () => {
    setSearch('?popout=1&email=53675')
    expect(bootDetachedModeFromQuery()).toBeNull()
    expect(useDetachedMode.getState().isDetached).toBe(false)
  })
})

describe('canOpenDetachedWindow —— 入口门控', () => {
  test('没有 preload 注入的 ipcRenderer（远程 web / 测试）→ false', () => {
    expect(canOpenDetachedWindow()).toBe(false)
  })

  test('ipcRenderer.send 在场（Electron renderer）→ true', () => {
    ;(window as unknown as { electron: unknown }).electron = { ipcRenderer: { send: vi.fn() } }
    expect(canOpenDetachedWindow()).toBe(true)
  })

  test('只有 invoke 没有 send → false（openDetached 走的是 send）', () => {
    ;(window as unknown as { electron: unknown }).electron = { ipcRenderer: { invoke: vi.fn() } }
    expect(canOpenDetachedWindow()).toBe(false)
  })
})

describe('ElectronApi.openDetached —— IPC 载体', () => {
  function stubSend(): ReturnType<typeof vi.fn> {
    const send = vi.fn()
    ;(window as unknown as { electron: unknown }).electron = { ipcRenderer: { send } }
    return send
  }

  test('email 侧发 window:openDetached，id 收敛成字符串', () => {
    const send = stubSend()
    new ElectronApi().email.openDetached(53675)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('window:openDetached', 'email', '53675')
  })

  test('report 侧发同一个通道，report id 原样传', () => {
    const send = stubSend()
    new ElectronApi().report.openDetached('daily-2026-08-30')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('window:openDetached', 'report', 'daily-2026-08-30')
  })

  test('坏 id 就地丢弃，不发 IPC', () => {
    const send = stubSend()
    new ElectronApi().email.openDetached(-1)
    new ElectronApi().email.openDetached(1.5)
    new ElectronApi().report.openDetached('')
    expect(send).not.toHaveBeenCalled()
  })
})
