// @vitest-environment node
//
// V2.1 阶段 3 — 3c-2：ChatStreamEmitter 单测。进程内 sink fan-out（cutover 后取代
// electron webContents.send）：emit/subscribe/unsubscribe + 快照遍历 + handler 隔离。

import { describe, expect, test, vi } from 'vitest'

import { ChatStreamEmitter } from '@shared/chat/emitter'
import type { ChatStreamEnvelope } from '@shared/chat/types'

function env(messageId: number): ChatStreamEnvelope {
  return { sessionId: 1, messageId, event: { type: 'chunk', delta: 'x' } }
}

describe('ChatStreamEmitter', () => {
  test('emit 投递给所有订阅者', () => {
    const e = new ChatStreamEmitter()
    const a = vi.fn()
    const b = vi.fn()
    e.subscribe(a)
    e.subscribe(b)
    e.emit(env(7))
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(env(7))
    expect(b).toHaveBeenCalledTimes(1)
    expect(e.size()).toBe(2)
  })

  test('unsubscribe 后不再收到 + size 递减', () => {
    const e = new ChatStreamEmitter()
    const a = vi.fn()
    const off = e.subscribe(a)
    off()
    e.emit(env(1))
    expect(a).not.toHaveBeenCalled()
    expect(e.size()).toBe(0)
  })

  test('unsubscribe 幂等（双调安全，不抛）', () => {
    const e = new ChatStreamEmitter()
    const off = e.subscribe(vi.fn())
    off()
    off()
    expect(e.size()).toBe(0)
  })

  test('一个 handler 抛不影响其他（隔离 + 不向 emit 传播）', () => {
    const e = new ChatStreamEmitter()
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    const good = vi.fn()
    e.subscribe(bad)
    e.subscribe(good)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => e.emit(env(1))).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('emit 遍历快照：handler 内退订他人不扰动本次 emit', () => {
    const e = new ChatStreamEmitter()
    const calls: string[] = []
    let off2 = (): void => undefined
    e.subscribe(() => {
      calls.push('a')
      off2() // a 内退订 b：本次 emit 仍应投递 b（快照），下次起 b 不再收到
    })
    off2 = e.subscribe(() => {
      calls.push('b')
    })
    e.emit(env(1))
    expect(calls).toEqual(['a', 'b'])
    e.emit(env(2))
    expect(calls).toEqual(['a', 'b', 'a']) // 第二次只剩 a
  })
})
